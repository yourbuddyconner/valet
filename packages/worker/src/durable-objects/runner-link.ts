/**
 * RunnerLink — manages the runner WebSocket connection, send path,
 * and incoming message dispatch.
 *
 * Owns:
 * - Runner send path (`send()`)
 * - Runner connection state: `isConnected`, `isReady`, `token`
 * - Message dispatch: routes incoming runner messages to typed handlers
 *
 * Does NOT own:
 * - WebSocket primitives (ctx.acceptWebSocket, webSocketMessage) — DO APIs
 * - Handler bodies — those stay in the DO (they need DO dependencies)
 * - `runnerBusy` — owned by PromptQueue
 * - `errorSafetyNetAt` — owned by PromptQueue
 */

import type {
  RunnerToDOMessage,
  DOToRunnerMessage,
  RunnerMessageOf,
  DOMessageOf,
  PromptAttachment,
  AgentStatus,
  ToolCallStatus,
} from '@valet/shared';

export type {
  RunnerToDOMessage,
  DOToRunnerMessage,
  RunnerMessageOf,
  DOMessageOf,
  PromptAttachment,
  AgentStatus,
  ToolCallStatus,
};

// ─── Handler Types ────────────────────────────────────────────────────────────

/**
 * Handler for a specific runner message type.
 * The message is narrowed to the exact variant matching that type.
 */
export type RunnerMessageHandler<T extends RunnerToDOMessage['type'] = RunnerToDOMessage['type']> =
  (msg: RunnerMessageOf<T>) => Promise<void> | void;

/**
 * Map of runner message types to their handler functions.
 * The DO populates this with handler methods/lambdas.
 * Unhandled types log a warning.
 *
 * Each handler receives the narrowed message type for its key. At the dispatch
 * boundary (`handleMessage`), we cast to the generic handler signature since
 * TypeScript can't prove the correlation between the runtime key and the
 * extracted type in a `Partial<Record<...>>`.
 */
export type RunnerMessageHandlers = {
  [T in RunnerToDOMessage['type']]?: RunnerMessageHandler<T>;
};

// ─── Activity Detection ───────────────────────────────────────────────────────

/**
 * Message types that indicate active agent work.
 * These reset the idle timer when received.
 */
const ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  'agentStatus',
  'message.create',
  'message.part.text-delta',
  'message.part.tool-update',
  'message.finalize',
]);

// Match the client large-payload cutoff: above this, avoid sending base64
// attachment data through another WebSocket frame to the sandbox runner.
const MAX_RUNNER_WS_PAYLOAD_CHARS = 800_000;

function promptAttachmentRef(messageId: string, index: number): string {
  return `valet-prompt-attachment://${encodeURIComponent(messageId)}/${index}`;
}

function serializeForRunner(message: DOToRunnerMessage): string {
  const payload = JSON.stringify(message);
  if (message.type === 'prompt') {
    console.log(
      `[RunnerLink] prompt payload: messageId=${message.messageId} ` +
      `attachments=${message.attachments?.length ?? 0} payloadChars=${payload.length}`,
    );
  }
  if (message.type !== 'prompt' || !message.attachments?.length || payload.length <= MAX_RUNNER_WS_PAYLOAD_CHARS) {
    return payload;
  }

  const referencedMessage: DOMessageOf<'prompt'> = {
    ...message,
    attachments: message.attachments.map((attachment, index) => ({
      ...attachment,
      url: promptAttachmentRef(message.messageId, index),
    })),
  };
  const referencedPayload = JSON.stringify(referencedMessage);
  console.log(
    `[RunnerLink] Replaced ${message.attachments.length} attachment payload(s) with runner-fetch refs ` +
    `for prompt ${message.messageId}: ${payload.length} chars → ${referencedPayload.length} chars`,
  );
  return referencedPayload;
}

// ─── RunnerLink Class ─────────────────────────────────────────────────────────

export interface RunnerLinkDeps {
  /** Returns all WebSockets tagged as 'runner'. */
  getRunnerSockets: () => WebSocket[];
  /** Read a value from the DO state table. */
  getState: (key: string) => string | undefined;
  /** Write a value to the DO state table. */
  setState: (key: string, value: string) => void;
}

export class RunnerLink {
  private deps: RunnerLinkDeps;

  constructor(deps: RunnerLinkDeps) {
    this.deps = deps;
  }

  // ─── Connection State ───────────────────────────────────────────────

  /** Whether any runner WebSocket is currently connected. */
  get isConnected(): boolean {
    return this.deps.getRunnerSockets().length > 0;
  }

  /**
   * Whether the runner is ready to accept prompts.
   * Set to false on connect, true when runner signals first `agentStatus: idle`.
   */
  get isReady(): boolean {
    return this.deps.getState('runnerReady') !== 'false' && this.isConnected;
  }

  set ready(val: boolean) {
    this.deps.setState('runnerReady', String(val));
  }

  /** The authentication token for runner WebSocket connections. */
  get token(): string | undefined {
    return this.deps.getState('runnerToken') || undefined;
  }

  set token(val: string) {
    this.deps.setState('runnerToken', val);
  }

  /** Timestamp (ms since epoch) when the runner WebSocket last connected, or null if never. */
  get connectedAt(): number | null {
    const val = this.deps.getState('runnerConnectedAt');
    return val ? parseInt(val, 10) : null;
  }

  set connectedAt(ms: number | null) {
    this.deps.setState('runnerConnectedAt', ms ? String(ms) : '');
  }

  // ─── Send ───────────────────────────────────────────────────────────

  /**
   * Send a message to the runner. Returns false if no runner is connected
   * or all sends fail.
   */
  send(message: DOToRunnerMessage): boolean {
    if (message.type === 'prompt') {
      console.log(`[RunnerLink] sendToRunner prompt: messageId=${message.messageId}`);
    }
    const runners = this.deps.getRunnerSockets();
    if (runners.length === 0) {
      console.warn(`[RunnerLink] sendToRunner: no runner sockets available for type=${message.type}`);
      return false;
    }
    const payload = serializeForRunner(message);
    let sent = false;
    for (const ws of runners) {
      try {
        ws.send(payload);
        sent = true;
      } catch {
        // Runner may have disconnected
      }
    }
    if (!sent) {
      console.warn(`[RunnerLink] sendToRunner: all sends failed for type=${message.type}`);
    }
    return sent;
  }

  // ─── Message Dispatch ───────────────────────────────────────────────

  /**
   * Dispatch an incoming runner message to the appropriate handler.
   *
   * @param msg - The parsed runner message
   * @param handlers - Map of message types to handler functions (provided by DO)
   * @param onActivity - Optional callback invoked when the message indicates agent activity
   */
  async handleMessage(
    msg: RunnerToDOMessage,
    handlers: RunnerMessageHandlers,
    onActivity?: () => void,
  ): Promise<void> {
    console.log(`[RunnerLink] Runner message: type=${msg.type}`);

    // Reset idle timer on agent activity messages
    if (ACTIVITY_TYPES.has(msg.type) && onActivity) {
      onActivity();
    }

    // Look up the handler for this message type.
    // The cast is safe: at runtime, msg.type selects the matching handler,
    // which expects exactly that narrowed variant.
    const handler = handlers[msg.type] as ((msg: RunnerToDOMessage) => Promise<void> | void) | undefined;
    if (handler) {
      await handler(msg);
    } else {
      console.warn(`[RunnerLink] Unhandled runner message type: ${msg.type}`);
    }
  }

  // ─── Connection Lifecycle ───────────────────────────────────────────

  /**
   * Called when a runner WebSocket connects.
   * Marks the runner as not-yet-ready (it needs to initialize before accepting prompts).
   */
  onConnect(): void {
    this.ready = false;
    console.log('[RunnerLink] Runner connected — waiting for ready signal');
  }

  /**
   * Called when the runner WebSocket disconnects.
   * Marks the runner as not ready.
   */
  onDisconnect(): void {
    this.ready = false;
    console.log('[RunnerLink] Runner disconnected');
  }
}

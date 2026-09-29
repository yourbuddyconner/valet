/**
 * `valet chat [--session <id>] [--thread <id>]`
 *
 * Interactive REPL against the orchestrator (default) or an explicit session.
 * Read a line → send it → stream the reply (tokens inline, compact tool lines);
 * on a decision gate, render the numbered options, read a selection, resolve it,
 * and CONTINUE consuming the same stream (the turn resumes). WS reconnect/resume
 * is handled inside `streamSession`.
 *
 * Structure (for testability):
 *   - `run` is a thin I/O shell: resolve instance, wire `node:readline`, handle
 *     Ctrl-C / Ctrl-D, and delegate the loop to `chatRepl`.
 *   - `chatRepl(deps)` is the REPL control flow over injected `readLine`/`runTurn`
 *     — so `/exit` and EOF (null) both return `ExitCode.OK` without touching a tty.
 *   - `chatTurn(deps, input)` sends one prompt and consumes the stream to a
 *     terminal, driving a gate round-trip through injected `write`/`readSelection`.
 *   - `renderGatePrompt` / `parseGateSelection` are pure — the option numbering
 *     and the (number→actionId / free-text→value) parsing are unit-tested directly.
 *
 * REUSE: the compact tool-line renderers and the settle→exit mapping come from
 * `send.ts` (T6). We do NOT reuse `send.ts`'s `renderGate` — that one emits a
 * `valet gates resolve …` hint for the non-interactive command; chat needs a
 * numbered, selectable prompt instead, so the gate render/parse live here.
 *
 * TUI deps (`node:readline`) are lazy-imported INSIDE `run` so `valet serve` and
 * every other command never pay for them.
 */
import type { Interface as ReadlineInterface } from "node:readline";
import { InstanceClient } from "../client.js";
import { ExitCode } from "../exit.js";
import { parseGlobalFlags, printErr, printLine } from "../output.js";
import { resolveInstance } from "../resolve.js";
import { streamSession } from "../stream.js";
import type { CliContext } from "../types.js";
import { outcomeToExit, renderToolEnd, renderToolStart, type StreamFn } from "./send.js";
import type {
  DecisionGate,
  ResolveDecisionRequest,
  SendPromptRequest,
  SendPromptResponse,
} from "../../wire/types.js";

const PROMPT = "you › ";

// ── pure gate render + selection parsing ────────────────────────────────────

/**
 * Numbered, human render of a blocking gate. `question` gates take free text;
 * `approval` / `credential_request` gates present numbered actions. No leading
 * or trailing newline — the caller frames it.
 */
export function renderGatePrompt(gate: DecisionGate): string {
  const lines = [`decision required: ${gate.title} [${gate.type}]`];
  if (gate.body) lines.push(gate.body);
  if (gate.type === "question") {
    lines.push("(type your answer)");
  } else {
    gate.actions.forEach((a, i) => {
      const tag = a.style === "danger" ? " (danger)" : a.style === "primary" ? " (primary)" : "";
      lines.push(`  ${i + 1}. ${a.label}${tag}  [${a.id}]`);
    });
    lines.push("(enter a number or an action id)");
  }
  return lines.join("\n");
}

/** The parsed intent of a user's gate answer. */
export type GateSelection =
  | { kind: "resolve"; resolution: ResolveDecisionRequest }
  | { kind: "invalid"; message: string }
  | { kind: "cancel" };

/**
 * Parse a raw gate answer against the gate's type.
 *
 * - `null` (EOF / abort) → `cancel`.
 * - `question` gate: any non-empty text → `{ value }`; empty → `cancel`.
 * - `approval` / `credential_request`: a 1-based index into `actions`, OR a
 *   literal `actionId` → `{ actionId }`; anything else → `invalid`.
 */
export function parseGateSelection(gate: DecisionGate, raw: string | null): GateSelection {
  if (raw === null) return { kind: "cancel" };
  const input = raw.trim();

  if (gate.type === "question") {
    if (input === "") return { kind: "cancel" };
    return { kind: "resolve", resolution: { value: input } };
  }

  if (input === "") return { kind: "invalid", message: "enter a number or an action id" };

  // A bare positive integer selects by 1-based position.
  if (/^\d+$/.test(input)) {
    const n = Number.parseInt(input, 10);
    if (n >= 1 && n <= gate.actions.length) {
      return { kind: "resolve", resolution: { actionId: gate.actions[n - 1].id } };
    }
    return { kind: "invalid", message: `no option ${n} (choose 1-${gate.actions.length})` };
  }

  // Otherwise match a literal action id.
  const byId = gate.actions.find((a) => a.id === input);
  if (byId) return { kind: "resolve", resolution: { actionId: byId.id } };
  return { kind: "invalid", message: `no such option: ${input}` };
}

// ── one turn: send + consume the stream to a terminal ───────────────────────

/** The subset of `InstanceClient` a chat turn needs. */
export interface ChatClient {
  sendPrompt(id: string, body: SendPromptRequest): Promise<SendPromptResponse>;
  resolveDecision(id: string, gateId: string, body: ResolveDecisionRequest): Promise<void>;
}

export interface ChatTurnDeps {
  client: ChatClient;
  stream: StreamFn;
  url: string;
  apiKey?: string;
  /** Aborts the in-flight stream (and any pending gate read) on Ctrl-C. */
  signal?: AbortSignal;
  /** Sink for rendered output (real stdout, or a capture buffer in tests). */
  write(s: string): void;
  /** Read the user's answer to a blocking gate; `null` = EOF / cancelled. */
  readSelection(gate: DecisionGate): Promise<string | null>;
}

export interface ChatTurnInput {
  sessionId: string;
  /** Active thread (undefined for the first send → server picks the default). */
  threadId?: string;
  text: string;
}

export interface ChatTurnResult {
  /** The turn's exit intent (informational for the REPL; not the process code). */
  exit: ExitCode;
  /** The resolved thread id — the REPL tracks this for subsequent sends. */
  threadId: string;
}

/**
 * Drive a gate to resolution: read selections until one resolves (calling
 * `resolveDecision`) or the user cancels. Returns `true` when resolved (the
 * turn should resume), `false` on cancel (the turn ends, back to the prompt).
 */
async function driveGate(deps: ChatTurnDeps, sessionId: string, gate: DecisionGate): Promise<boolean> {
  for (;;) {
    const raw = await deps.readSelection(gate);
    const sel = parseGateSelection(gate, raw);
    if (sel.kind === "cancel") return false;
    if (sel.kind === "invalid") {
      deps.write(`${sel.message}\n`);
      continue;
    }
    await deps.client.resolveDecision(sessionId, gate.id, sel.resolution);
    return true;
  }
}

/**
 * Send one prompt and consume the session stream until the turn reaches a
 * terminal: our `submission.settled` (queueItemId === our messageId), a
 * `turn_end` on our thread, an `error`, a cancelled gate, or the stream closing
 * (clean close / abort). A `decision_gate` on our thread pauses rendering,
 * reads a selection, resolves it, and resumes the SAME stream.
 */
export async function chatTurn(deps: ChatTurnDeps, input: ChatTurnInput): Promise<ChatTurnResult> {
  const sent = await deps.client.sendPrompt(input.sessionId, { text: input.text, threadId: input.threadId });
  const { threadId, messageId } = sent;

  const stream = deps.stream({
    url: deps.url,
    apiKey: deps.apiKey,
    sessionId: input.sessionId,
    signal: deps.signal,
  });

  for await (const ev of stream) {
    switch (ev.type) {
      case "text_delta":
        if (ev.threadId === threadId) deps.write(ev.delta);
        break;
      case "tool_start":
        if (ev.threadId === threadId) deps.write(`${renderToolStart(ev.toolName)}\n`);
        break;
      case "tool_end":
        if (ev.threadId === threadId) deps.write(`${renderToolEnd(ev.toolName, ev.isError)}\n`);
        break;
      case "decision_gate": {
        if (ev.threadId !== threadId) break;
        deps.write(`\n${renderGatePrompt(ev.gate)}\n`);
        const resolved = await driveGate(deps, input.sessionId, ev.gate);
        if (!resolved) {
          deps.write("\n");
          return { exit: ExitCode.GatePending, threadId };
        }
        break; // resolved → keep consuming; the turn resumes on the same stream.
      }
      case "error":
        deps.write(`\nerror: ${ev.message}\n`);
        return { exit: ExitCode.TurnError, threadId };
      case "submission.settled":
        if (ev.queueItemId === messageId) {
          deps.write("\n");
          return { exit: outcomeToExit(ev.outcome), threadId };
        }
        break;
      case "turn_end":
        // Fallback terminal: the REPL is sequential per thread, so a turn_end on
        // our thread ends our turn even if the settle frame is missed.
        if (ev.threadId === threadId) {
          deps.write("\n");
          return { exit: ExitCode.OK, threadId };
        }
        break;
      default:
        break;
    }
  }

  // Stream ended (clean close / abort) with no explicit terminal — back to prompt.
  return { exit: ExitCode.OK, threadId };
}

// ── REPL control flow (injectable line reader) ──────────────────────────────

export interface ReplDeps {
  /** Read a line; `null` = EOF (Ctrl-D). */
  readLine(prompt: string): Promise<string | null>;
  /** Run one turn for the given text (wraps `chatTurn` + thread tracking). */
  runTurn(text: string): Promise<void>;
}

/**
 * The REPL loop, pure over its injected reader/runner. Terminates OK on `/exit`
 * (or `/quit`) and on EOF (`readLine` → null). Empty lines re-prompt.
 */
export async function chatRepl(deps: ReplDeps): Promise<ExitCode> {
  for (;;) {
    const line = await deps.readLine(PROMPT);
    if (line === null) return ExitCode.OK; // Ctrl-D
    const text = line.trim();
    if (text === "") continue;
    if (text === "/exit" || text === "/quit") return ExitCode.OK;
    await deps.runTurn(text);
  }
}

// ── I/O shell: readline wiring + Ctrl-C handling ────────────────────────────

/**
 * Read one line from a readline interface; resolve `null` on EOF (`close`),
 * abort, or an already-closed interface. Exported so the readline/abort
 * lifecycle is unit-testable over PassThrough streams (a plain closure isn't).
 *
 * The `signal` is passed INTO `rl.question` so Node clears its internal pending
 * callback on abort — without that, an aborted question leaves the callback set
 * and the NEXT `rl.question` silently drops its callback, wedging the following
 * prompt (it would never resolve). We still keep our own `abort` listener
 * because Node cancels the callback but never invokes it.
 */
export function askLine(
  rl: ReadlineInterface,
  prompt: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (v: string | null): void => {
      if (done) return;
      done = true;
      rl.removeListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
      resolve(v);
    };
    const onClose = (): void => finish(null);
    const onAbort = (): void => finish(null);
    rl.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal) rl.question(prompt, { signal }, (answer) => finish(answer));
      else rl.question(prompt, (answer) => finish(answer));
    } catch {
      // An already-closed interface (e.g. Ctrl-D during a prior gate read)
      // throws ERR_USE_AFTER_CLOSE synchronously → report EOF so the REPL
      // exits cleanly rather than rejecting out of run().
      finish(null);
    }
  });
}

/** Build the startup banner (instance + session + how to exit). */
export function chatBanner(instanceName: string, sessionId: string): string {
  return [
    `valet chat — instance "${instanceName}", session ${sessionId}`,
    "type a message and press Enter. Ctrl-D or /exit to quit; Ctrl-C cancels a turn.",
  ].join("\n");
}

export async function run(args: string[], ctx: CliContext): Promise<number> {
  const readline = await import("node:readline");

  const flags = parseGlobalFlags(args);
  const instance = resolveInstance({
    flag: typeof flags.flags.instance === "string" ? flags.flags.instance : undefined,
    env: process.env.VALET_INSTANCE,
    config: ctx.config,
  });
  const client = new InstanceClient({ url: instance.url, apiKey: instance.apiKey });

  let threadId = typeof flags.flags.thread === "string" ? flags.flags.thread : undefined;
  const resolved = threadId ? await client.getThread(threadId) : undefined;
  if (resolved && typeof flags.flags.session === "string" && flags.flags.session !== resolved.sessionId) {
    printErr("The thread does not belong to the specified runtime.");
    return ExitCode.Usage;
  }
  const sessionId = resolved?.sessionId ?? (typeof flags.flags.session === "string" ? flags.flags.session : (await client.ensureOrchestrator()).sessionId);

  printLine(chatBanner(instance.name, sessionId));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Ctrl-C: mid-turn → abort the turn (back to prompt); at the prompt → one
  // warning, a second exits. `currentController` is set only while a turn runs.
  let currentController: AbortController | null = null;
  let exitArmed = false;
  rl.on("SIGINT", () => {
    if (currentController) {
      currentController.abort();
      return;
    }
    if (exitArmed) {
      rl.close();
      return;
    }
    exitArmed = true;
    process.stdout.write("\n(^C again — or /exit — to quit)\n");
  });

  const question = (prompt: string, signal?: AbortSignal): Promise<string | null> =>
    askLine(rl, prompt, signal);

  const runTurn = async (text: string): Promise<void> => {
    exitArmed = false;
    const controller = new AbortController();
    currentController = controller;
    try {
      const result = await chatTurn(
        {
          client,
          stream: streamSession,
          url: instance.url,
          apiKey: instance.apiKey,
          signal: controller.signal,
          write: (s) => process.stdout.write(s),
          readSelection: (gate) => question(`resolve ${gate.id} › `, controller.signal),
        },
        { sessionId, threadId, text },
      );
      threadId = result.threadId; // track the (possibly server-assigned) thread.
    } catch (err) {
      printErr(`valet chat: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      currentController = null;
    }
  };

  const code = await chatRepl({
    readLine: (prompt) => question(prompt),
    runTurn,
  });

  rl.close();
  return code;
}

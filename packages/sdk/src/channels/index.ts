// ─── Inbound Types ───────────────────────────────────────────────────────────

export interface InboundAttachment {
  type: 'image' | 'audio' | 'video' | 'file';
  url: string;
  mimeType: string;
  fileName?: string;
  size?: number;
  duration?: number;
}

export interface InboundMessage {
  channelType: string;
  channelId: string;
  senderId: string;
  senderName: string;
  text: string;
  attachments: InboundAttachment[];
  command?: string;
  commandArgs?: string;
  messageId?: string;
  metadata?: Record<string, unknown>;
}

// ─── Outbound Types ──────────────────────────────────────────────────────────

export interface OutboundAttachment {
  type: 'image' | 'file';
  url: string;
  mimeType: string;
  fileName?: string;
  caption?: string;
}

export interface OutboundMessage {
  markdown?: string;
  text?: string;
  attachments?: OutboundAttachment[];
  replyToMessageId?: string;
  platformOptions?: Record<string, unknown>;
}

// ─── Routing Types ───────────────────────────────────────────────────────────

export interface ChannelTarget {
  channelType: string;
  channelId: string;
  threadId?: string;
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

// ─── Transport Context ───────────────────────────────────────────────────────

export interface ChannelContext {
  token: string;
  userId: string;
  orgId?: string;
  platformCache?: Record<string, unknown>;
}

// ─── Interactive Prompt Types ───────────────────────────────────────────────

export interface InteractivePrompt {
  id: string;
  sessionId: string;
  type: 'approval' | 'question' | (string & {});
  title: string;
  body?: string;
  actions: InteractiveAction[];
  expiresAt?: number;
  context?: Record<string, unknown>;
}

export interface InteractiveAction {
  id: string;
  label: string;
  style?: 'primary' | 'danger';
}

export interface InteractivePromptRef {
  messageId: string;
  channelId: string;
  [key: string]: unknown;
}

export interface InteractiveResolution {
  actionId?: string;
  value?: string;
  resolvedBy: string;
}

// ─── Routing Metadata (passed to parseInbound) ──────────────────────────────

export interface RoutingMetadata {
  userId: string;
  botToken?: string;
  [key: string]: unknown;
}

// ─── Channel Transport Contract ──────────────────────────────────────────────

export interface ChannelTransport {
  readonly channelType: string;

  /** Verify the inbound request signature (return true if valid). */
  verifySignature(rawHeaders: Record<string, string>, rawBody: string, secret?: string): boolean;

  /** Parse a raw inbound webhook into an InboundMessage (or null to skip). */
  parseInbound(
    rawHeaders: Record<string, string>,
    rawBody: string,
    routing: RoutingMetadata,
  ): Promise<InboundMessage | null>;

  /** Return scope key parts for channel-binding lookup. */
  scopeKeyParts(message: InboundMessage, userId: string): { channelType: string; channelId: string };

  /** Convert markdown to platform-native format. */
  formatMarkdown(markdown: string): string;

  /** Send a message to a channel. */
  sendMessage(target: ChannelTarget, message: OutboundMessage, ctx: ChannelContext): Promise<SendResult>;

  /** Edit a previously sent message (enables post+edit streaming pattern). */
  editMessage?(target: ChannelTarget, messageId: string, message: OutboundMessage, ctx: ChannelContext): Promise<SendResult>;

  /** Delete a previously sent message (cleanup of transient/progress messages). */
  deleteMessage?(target: ChannelTarget, messageId: string, ctx: ChannelContext): Promise<boolean>;

  /** Resolve a composite channelId to a human-readable label for display. */
  resolveLabel?(channelId: string, ctx: ChannelContext): Promise<string>;

  /** Send a typing/activity indicator. */
  sendTypingIndicator?(target: ChannelTarget, ctx: ChannelContext): Promise<void>;

  /** Register a webhook URL with the platform. */
  registerWebhook?(webhookUrl: string, ctx: ChannelContext): Promise<boolean>;

  /** Unregister the webhook from the platform. */
  unregisterWebhook?(ctx: ChannelContext): Promise<boolean>;

  /** Send an interactive prompt to a channel (e.g. Slack Block Kit buttons, or plain text for free-text questions). */
  sendInteractivePrompt?(target: ChannelTarget, prompt: InteractivePrompt, ctx: ChannelContext): Promise<InteractivePromptRef | null>;

  /** Update a previously sent interactive prompt with resolution status. */
  updateInteractivePrompt?(target: ChannelTarget, ref: InteractivePromptRef, resolution: InteractiveResolution, ctx: ChannelContext): Promise<void>;
}

// ─── Integration Provider (re-exported from integrations module) ─────────────

export type { IntegrationProvider } from '../integrations/index.js';

// ─── Channel Package Manifest ────────────────────────────────────────────────

export interface ChannelPackage {
  name: string;
  version: string;
  channelType: string;
  createTransport(): ChannelTransport;
  provider?: import('../integrations/index.js').IntegrationProvider;
}

---
# valet-ch4t
title: Pluggable Channel Transports
status: todo
type: epic
priority: high
tags:
    - integrations
    - architecture
    - messaging
    - channels
    - packages
created_at: 2026-02-24T00:00:00Z
updated_at: 2026-02-24T00:00:00Z
---

Define a `ChannelTransport` contract for bidirectional messaging platforms (Telegram, Slack, Discord, WhatsApp, etc.) and ship it as `@valet/channel-sdk`. Each messaging platform is a standalone npm package (`@valet/channel-telegram`, `@valet/channel-slack`) that handles inbound webhook parsing, outbound message formatting/delivery, signature verification, and optionally connection setup and platform-specific agent actions. The gateway loads installed channel packages and routes through them without hardcoding any platform specifics.

## Problem

Bidirectional messaging is fundamentally different from one-directional actions. When an agent creates a GitHub issue, that's an explicit outbound operation — the agent decides to do it. When a user sends a Telegram message and the agent replies, the system handles the routing — the agent doesn't call `run_action("telegram.send_message")`.

Currently, Telegram messaging is hardcoded throughout the gateway:

### Inbound (webhook → session)

`routes/telegram.ts` (POST `/telegram/webhook/:userId`):
- Decrypts bot token from `user_telegram_config`
- Creates a Grammy `Bot` instance with cached `botInfo`
- Handles slash commands (`/start`, `/help`, `/status`, `/stop`, `/clear`, `/refresh`, `/sessions`)
- Handles text messages: formats with attribution + quote blocks
- Handles photos: downloads, converts to base64 data URL, sends as attachment
- Handles voice notes: downloads as `audio/ogg`, sends with duration metadata
- Handles audio: full support with MIME type detection
- Routes to session DO or orchestrator via scope key lookup

All of this is Telegram-specific code living in the gateway core.

### Outbound (session → user)

`services/telegram.ts`:
- `markdownToTelegramHtml()` — converts markdown to Telegram HTML (code blocks, bold, italic, links)
- `sendTelegramMessage()` — calls Telegram Bot API with HTML parse mode
- `sendTelegramPhoto()` — sends photos via multipart with caption

These are called from SessionAgentDO and the orchestrator when they need to reply to a Telegram user.

### What happens when we add Slack

Without this bean, adding Slack means:
1. Write `routes/slack.ts` with slash commands, Events API handler, interactive components
2. Write `services/slack.ts` with Block Kit formatting, `chat.postMessage`, thread replies
3. Update SessionAgentDO to know about Slack message formatting
4. Update the orchestrator to know about Slack message formatting
5. Hardcode Slack-specific scope key generation in `scope-key.ts`
6. Add Slack-specific columns to channel bindings
7. Repeat for every messaging platform

Each new platform doubles the platform-specific code in the gateway. The gateway becomes a collection of messaging SDKs instead of a routing layer.

### The scope key system is already channel-agnostic

The existing channel binding and routing system (`scope-key.ts`, `routes/channels.ts`) is already generic:

```typescript
// These are already just string templates — no platform logic
webManualScopeKey(userId, sessionId)        → 'user:{userId}:manual:{sessionId}'
telegramScopeKey(userId, chatId)            → 'user:{userId}:telegram:{chatId}'
slackScopeKey(userId, teamId, channelId, ts) → 'user:{userId}:slack:{teamId}:{channelId}:{ts}'
```

The routing in `routes/channels.ts` (POST `/api/prompt`) already uses `channelType` + `channelId` to compute a scope key and look up a binding. It doesn't contain Telegram or Slack logic — it's a generic router. The platform-specific work (parsing webhooks, formatting replies) is what needs to be extracted.

## Design

### Channel SDK Contract (`@valet/channel-sdk`)

```typescript
// packages/channel-sdk/src/index.ts

// ─── Inbound ──────────────────────────────────────────────────────────────────

export interface InboundMessage {
  /** Channel type (e.g., 'telegram', 'slack') */
  channelType: string;
  /** Platform-specific channel identifier (chat ID, channel+thread, etc.) */
  channelId: string;
  /** Platform-specific sender identifier */
  senderId?: string;
  /** Sender display name */
  senderName?: string;
  /** Plain text content */
  text?: string;
  /** Attachments (images, files, audio) */
  attachments?: InboundAttachment[];
  /** Slash command (if the message is a command) */
  command?: { name: string; args: string };
  /** Platform message ID (for replies/threading) */
  messageId?: string;
  /** Platform-specific metadata (thread_ts, chat_type, forward_from, etc.) */
  metadata?: Record<string, unknown>;
}

export interface InboundAttachment {
  type: 'image' | 'audio' | 'video' | 'file';
  /** Data URL (base64) or remote URL */
  url: string;
  mimeType?: string;
  fileName?: string;
  /** Size in bytes */
  size?: number;
  /** Duration in seconds (for audio/video) */
  duration?: number;
}

// ─── Outbound ─────────────────────────────────────────────────────────────────

export interface OutboundMessage {
  /** Markdown text (will be formatted per-channel by the transport) */
  markdown?: string;
  /** Plain text fallback */
  text?: string;
  /** Attachments to send */
  attachments?: OutboundAttachment[];
  /** Reply to a specific message ID */
  replyToMessageId?: string;
  /** Platform-specific options (inline keyboards, Block Kit blocks, etc.) */
  platformOptions?: Record<string, unknown>;
}

export interface OutboundAttachment {
  type: 'image' | 'file';
  url: string;       // URL or data URL
  fileName?: string;
  caption?: string;
}

export interface ChannelTarget {
  channelType: string;
  channelId: string;
  threadId?: string;
}

export interface SendResult {
  messageId?: string;
  success: boolean;
  error?: string;
}

// ─── Transport ────────────────────────────────────────────────────────────────

export interface ChannelContext {
  /** Resolved credential for this channel (bot token, OAuth token, etc.) */
  token: string;
  userId: string;
  orgId?: string;
  /** Platform-specific cached data (botInfo for Telegram, team metadata for Slack) */
  platformCache?: Record<string, unknown>;
}

export interface ChannelTransport {
  readonly channelType: string;

  /** Verify webhook signature. Return true if valid or if no verification is needed. */
  verifySignature(rawBody: string, headers: Record<string, string>, secret: string): Promise<boolean>;

  /** Parse a raw webhook payload into a normalized inbound message. Return null to skip. */
  parseInbound(
    rawHeaders: Record<string, string>,
    rawBody: string,
    routingMetadata?: Record<string, unknown>,
  ): Promise<InboundMessage | null>;

  /** Compute the scope key components for routing. */
  scopeKeyParts(message: InboundMessage, userId: string): { channelType: string; channelId: string };

  /** Format markdown for this channel's native format (Telegram HTML, Slack mrkdwn, etc.) */
  formatMarkdown(markdown: string): string;

  /** Send a message through this channel. */
  sendMessage(target: ChannelTarget, message: OutboundMessage, ctx: ChannelContext): Promise<SendResult>;

  /** Send a typing indicator (optional). */
  sendTypingIndicator?(target: ChannelTarget, ctx: ChannelContext): Promise<void>;

  /** Register the webhook URL with the platform (optional — some platforms need this). */
  registerWebhook?(webhookUrl: string, ctx: ChannelContext): Promise<void>;

  /** Unregister the webhook URL (optional — for disconnect). */
  unregisterWebhook?(ctx: ChannelContext): Promise<void>;
}

// ─── Package ──────────────────────────────────────────────────────────────────

export interface ChannelPackage {
  /** Package name (e.g., 'telegram', 'slack') */
  name: string;
  /** Package version */
  version: string;
  /** Channel type identifier (used in scope keys, channel bindings, webhook routes) */
  channelType: string;

  /** Factory: create a transport instance */
  createTransport(config?: Record<string, unknown>): ChannelTransport;

  /** Connection setup (bot token entry, OAuth flow, webhook registration).
   *  Optional — some channels might not need user-facing setup. */
  provider?: IntegrationProvider;

  /** Platform-specific actions the agent can explicitly invoke
   *  (pin message, create poll, set topic, etc.).
   *  Optional — not all channels have explicit agent actions. */
  actionPackage?: ActionPackage;
}
```

### Core Channel Packages

#### `@valet/channel-telegram`

Extracts the current `routes/telegram.ts` + `services/telegram.ts` code into a package:

```typescript
// packages/channel-telegram/src/index.ts
import type { ChannelPackage } from '@valet/channel-sdk';
import { TelegramTransport } from './transport.js';
import { telegramProvider } from './provider.js';
import { telegramActions } from './actions.js';

export default {
  name: 'telegram',
  version: '1.0.0',
  channelType: 'telegram',
  createTransport: (config) => new TelegramTransport(config),
  provider: telegramProvider,
  actionPackage: telegramActions,
} satisfies ChannelPackage;
```

```typescript
// packages/channel-telegram/src/transport.ts
import type { ChannelTransport, InboundMessage, OutboundMessage, ... } from '@valet/channel-sdk';

export class TelegramTransport implements ChannelTransport {
  readonly channelType = 'telegram';

  async verifySignature(rawBody: string, headers: Record<string, string>, secret: string): Promise<boolean> {
    // Telegram doesn't use webhook signatures — it uses the secret token in the URL path.
    // Or, if using the X-Telegram-Bot-Api-Secret-Token header (Telegram Bot API 6.1+):
    return headers['x-telegram-bot-api-secret-token'] === secret;
  }

  async parseInbound(rawHeaders, rawBody, routingMetadata): Promise<InboundMessage | null> {
    const update = JSON.parse(rawBody);
    const message = update.message || update.edited_message;
    if (!message) return null;

    const result: InboundMessage = {
      channelType: 'telegram',
      channelId: String(message.chat.id),
      senderId: String(message.from?.id),
      senderName: [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' '),
      messageId: String(message.message_id),
      metadata: { chatType: message.chat.type, updateId: update.update_id },
    };

    // Slash commands
    if (message.text?.startsWith('/')) {
      const [cmd, ...args] = message.text.split(' ');
      result.command = { name: cmd.slice(1).split('@')[0], args: args.join(' ') };
    }

    // Text
    if (message.text && !result.command) {
      result.text = message.text;
      // Handle forwarded messages with attribution
      if (message.forward_from || message.forward_sender_name) {
        const forwardName = message.forward_from
          ? [message.forward_from.first_name, message.forward_from.last_name].filter(Boolean).join(' ')
          : message.forward_sender_name;
        result.text = `[Forwarded from ${forwardName}]\n> ${message.text}`;
      }
    }

    // Photos
    if (message.photo?.length) {
      const largest = message.photo[message.photo.length - 1];
      // Download and convert to data URL (needs bot token from ctx)
      result.attachments = [{
        type: 'image',
        url: largest.file_id, // Will be resolved by transport.sendMessage context
        mimeType: 'image/jpeg',
      }];
    }

    // Voice
    if (message.voice) {
      result.attachments = [{
        type: 'audio',
        url: message.voice.file_id,
        mimeType: message.voice.mime_type || 'audio/ogg',
        duration: message.voice.duration,
      }];
    }

    return result;
  }

  scopeKeyParts(message: InboundMessage, userId: string) {
    return { channelType: 'telegram', channelId: message.channelId };
  }

  formatMarkdown(markdown: string): string {
    // The existing markdownToTelegramHtml() logic from services/telegram.ts
    return markdown
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\*(.+?)\*/g, '<i>$1</i>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  }

  async sendMessage(target, message, ctx): Promise<SendResult> {
    const text = message.markdown ? this.formatMarkdown(message.markdown) : message.text || '';

    const res = await fetch(`https://api.telegram.org/bot${ctx.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: target.channelId,
        text,
        parse_mode: message.markdown ? 'HTML' : undefined,
        reply_to_message_id: message.replyToMessageId ? Number(message.replyToMessageId) : undefined,
      }),
    });

    const result = await res.json() as any;
    return {
      success: result.ok,
      messageId: result.result?.message_id ? String(result.result.message_id) : undefined,
      error: result.ok ? undefined : result.description,
    };
  }

  async sendTypingIndicator(target, ctx): Promise<void> {
    await fetch(`https://api.telegram.org/bot${ctx.token}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: target.channelId, action: 'typing' }),
    });
  }

  async registerWebhook(webhookUrl: string, ctx: ChannelContext): Promise<void> {
    await fetch(`https://api.telegram.org/bot${ctx.token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    });
  }

  async unregisterWebhook(ctx: ChannelContext): Promise<void> {
    await fetch(`https://api.telegram.org/bot${ctx.token}/deleteWebhook`, {
      method: 'POST',
    });
  }
}
```

```typescript
// packages/channel-telegram/src/provider.ts — connection setup
import type { IntegrationProvider } from '@valet/action-sdk';

export const telegramProvider: IntegrationProvider = {
  service: 'telegram',
  displayName: 'Telegram Bot',
  authType: 'bot_token',
  validateCredentials: (creds) => !!creds.bot_token,
  testConnection: async (creds) => {
    const res = await fetch(`https://api.telegram.org/bot${creds.bot_token}/getMe`);
    return res.ok;
  },
};
```

```typescript
// packages/channel-telegram/src/actions.ts — explicit agent actions
import type { ActionPackage } from '@valet/action-sdk';
import { z } from 'zod';

export const telegramActions: ActionPackage = {
  name: 'telegram',
  version: '1.0.0',
  createActionSource: () => ({
    sourceId: 'telegram',
    async listActions() {
      return [
        {
          id: 'telegram.pin_message',
          name: 'Pin Telegram Message',
          description: 'Pin a message in a Telegram chat',
          risk: 'write' as const,
          params: z.object({ chatId: z.string(), messageId: z.string() }),
        },
        {
          id: 'telegram.create_poll',
          name: 'Create Telegram Poll',
          description: 'Create a poll in a Telegram chat',
          risk: 'write' as const,
          params: z.object({
            chatId: z.string(),
            question: z.string(),
            options: z.array(z.string()).min(2).max(10),
          }),
        },
      ];
    },
    async execute(actionId, params, ctx) {
      // dispatch to Telegram Bot API based on actionId
      // ...
      return { data: {}, executed: true };
    },
  }),
};
```

#### `@valet/channel-slack` (future)

Same pattern but with Slack-specific transport:

```typescript
// packages/channel-slack/src/transport.ts
export class SlackTransport implements ChannelTransport {
  readonly channelType = 'slack';

  async verifySignature(rawBody, headers, secret): Promise<boolean> {
    // Slack signing secret verification (HMAC-SHA256 of timestamp:body)
    const timestamp = headers['x-slack-request-timestamp'];
    const sig = headers['x-slack-signature'];
    const baseString = `v0:${timestamp}:${rawBody}`;
    // ... HMAC verification
  }

  async parseInbound(rawHeaders, rawBody, routingMetadata): Promise<InboundMessage | null> {
    const payload = JSON.parse(rawBody);
    // Handle Events API (message, app_mention)
    // Handle slash commands
    // Handle interactive components (button clicks, modal submissions)
    // ...
  }

  formatMarkdown(markdown: string): string {
    // Convert to Slack mrkdwn format
    // **bold** → *bold*
    // [link](url) → <url|link>
    // ```code``` → ```code```
    // etc.
  }

  async sendMessage(target, message, ctx): Promise<SendResult> {
    // Slack chat.postMessage with optional Block Kit
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: target.channelId,
        text: message.text || this.formatMarkdown(message.markdown || ''),
        thread_ts: target.threadId,
        blocks: message.platformOptions?.blocks, // Block Kit
      }),
    });
    const result = await res.json() as any;
    return { success: result.ok, messageId: result.ts, error: result.error };
  }
}
```

### Gateway Integration

#### Channel Package Loading

Parallel to the action package manifest:

```typescript
// packages/worker/src/channels/packages.ts
import telegram from '@valet/channel-telegram';
// import slack from '@valet/channel-slack';  // when ready
import type { ChannelPackage } from '@valet/channel-sdk';

export const installedChannels: ChannelPackage[] = [
  telegram,
  // slack,
];
```

#### Channel Registry

```typescript
// packages/worker/src/channels/registry.ts
import type { ChannelTransport, ChannelPackage } from '@valet/channel-sdk';
import { installedChannels } from './packages.js';

export class ChannelRegistry {
  private transports = new Map<string, ChannelTransport>();
  private packages = new Map<string, ChannelPackage>();

  init(): void {
    for (const pkg of installedChannels) {
      const transport = pkg.createTransport();
      this.transports.set(pkg.channelType, transport);
      this.packages.set(pkg.channelType, pkg);
    }
  }

  getTransport(channelType: string): ChannelTransport | null {
    return this.transports.get(channelType) || null;
  }

  getPackage(channelType: string): ChannelPackage | null {
    return this.packages.get(channelType) || null;
  }

  listChannelTypes(): string[] {
    return Array.from(this.transports.keys());
  }
}

export const channelRegistry = new ChannelRegistry();
```

#### Inbound: Webhook Inbox Integration

The webhook inbox (bean wh8d) dispatches to channel transports instead of hardcoded handlers:

```typescript
// In services/webhook-inbox.ts:processInboxRow()

async function processInboxRow(env: Env, row: WebhookInboxRow): Promise<void> {
  const headers = JSON.parse(row.raw_headers);
  const routingMetadata = row.routing_metadata ? JSON.parse(row.routing_metadata) : {};

  // Check if this is a channel message (vs. a service webhook like GitHub PR events)
  const transport = channelRegistry.getTransport(row.provider);
  if (transport) {
    return processChannelWebhook(env, transport, row, headers, routingMetadata);
  }

  // Fall back to non-channel webhook processing (GitHub, generic triggers, etc.)
  switch (row.provider) {
    case 'github':
      await processGitHubWebhook(env, headers, row.raw_body, row.event_type);
      break;
    case 'generic':
      await processGenericWebhook(env, headers, row.raw_body, routingMetadata);
      break;
    default:
      throw new Error(`Unknown provider: ${row.provider}`);
  }
}

async function processChannelWebhook(
  env: Env,
  transport: ChannelTransport,
  row: WebhookInboxRow,
  headers: Record<string, string>,
  routingMetadata: Record<string, unknown>,
): Promise<void> {
  // 1. Verify signature (transport knows how)
  // Secret comes from the user's credential via token boundary
  // ...

  // 2. Parse into normalized message
  const message = await transport.parseInbound(headers, row.raw_body, routingMetadata);
  if (!message) return; // Transport decided to skip this update

  // 3. Handle slash commands (universal)
  if (message.command) {
    await handleChannelCommand(env, transport, message, routingMetadata);
    return;
  }

  // 4. Compute scope key and route
  const userId = routingMetadata.userId as string;
  const { channelType, channelId } = transport.scopeKeyParts(message, userId);
  const scopeKey = `user:${userId}:${channelType}:${channelId}`;

  // 5. Look up channel binding
  const binding = await db.getChannelBindingByScopeKey(env.DB, scopeKey);

  if (binding) {
    // Route to bound session
    await routeToSession(env, binding.sessionId, message, transport);
  } else {
    // Route to orchestrator
    await routeToOrchestrator(env, userId, message, transport);
  }
}
```

#### Outbound: Session Reply Path

When a session needs to reply to the user, it uses the channel transport:

```typescript
// In session agent or orchestrator reply logic

async function replyToChannel(
  env: Env,
  channelType: string,
  channelId: string,
  markdown: string,
  userId: string,
): Promise<void> {
  const transport = channelRegistry.getTransport(channelType);
  if (!transport) {
    console.error(`No transport for channel type: ${channelType}`);
    return;
  }

  const credResult = await getCredential(env, userId, channelType);
  if (!credResult.ok) {
    console.error(`No credential for ${channelType}: ${credResult.error.message}`);
    return;
  }

  const target: ChannelTarget = { channelType, channelId };
  const message: OutboundMessage = { markdown };
  const ctx: ChannelContext = {
    token: credResult.credential.accessToken,
    userId,
  };

  await transport.sendMessage(target, message, ctx);
}
```

### Scope Key Generalization

The current `scope-key.ts` has hardcoded functions per channel type. With pluggable channels, the scope key generation should be generic:

```typescript
// packages/shared/src/scope-key.ts

// Keep the existing specific functions for backwards compatibility,
// but add a generic one that channel transports use:

export function channelScopeKey(userId: string, channelType: string, channelId: string): string {
  return `user:${userId}:${channelType}:${channelId}`;
}

// Existing functions become thin wrappers:
export function telegramScopeKey(userId: string, chatId: string): string {
  return channelScopeKey(userId, 'telegram', chatId);
}

export function slackScopeKey(userId: string, teamId: string, channelId: string, threadTs: string): string {
  return channelScopeKey(userId, 'slack', `${teamId}:${channelId}:${threadTs}`);
}
```

### Universal Webhook Route

Instead of per-platform webhook routes, one generic route handles all channel webhooks:

```typescript
// packages/worker/src/routes/channel-webhooks.ts

channelWebhooksRouter.post('/:channelType/webhook/:userId', async (c) => {
  const channelType = c.req.param('channelType');
  const userId = c.req.param('userId');

  // Verify channel type is registered
  const transport = channelRegistry.getTransport(channelType);
  if (!transport) {
    return c.json({ error: 'Unknown channel type' }, 404);
  }

  // Fast-ack: persist to webhook inbox, return 200
  const rawBody = await c.req.text();
  const rawHeaders: Record<string, string> = {};
  for (const [key, value] of c.req.raw.headers.entries()) {
    rawHeaders[key.toLowerCase()] = value;
  }

  await ingestWebhook(c.env.DB, {
    provider: channelType,
    rawHeaders,
    rawBody,
    routingMetadata: { userId, channelType },
  });

  return c.json({ ok: true });
});
```

This replaces the current `POST /telegram/webhook/:userId` route. Adding Slack means the route automatically works at `POST /slack/webhook/:userId` — no new route code needed.

## What Gets Deleted from Gateway

| File/Code | Lines | Moves To |
|---|---|---|
| `routes/telegram.ts` webhook handler | ~200 | `@valet/channel-telegram` transport |
| `services/telegram.ts` send functions | ~80 | `@valet/channel-telegram` transport |
| `services/telegram.ts` `markdownToTelegramHtml()` | ~30 | `@valet/channel-telegram` transport |
| Grammy dependency in worker `package.json` | — | `@valet/channel-telegram` package.json |
| Telegram-specific slash command handling | ~100 | Universal command handler + transport |

The gateway retains:
- Channel registry and package loading
- Universal webhook route
- Generic inbound routing (scope key → binding → session/orchestrator)
- Generic outbound reply path (session → transport → send)
- Channel binding CRUD

## Migration Plan

### Phase 1: Create `@valet/channel-sdk`

1. Create `packages/channel-sdk/` with all interfaces: `ChannelTransport`, `ChannelPackage`, `InboundMessage`, `OutboundMessage`, `ChannelTarget`, `ChannelContext`, `SendResult`
2. Pure types package, no runtime dependencies

### Phase 2: Create `@valet/channel-telegram`

1. Extract `TelegramTransport` from `routes/telegram.ts` and `services/telegram.ts`
2. Extract `telegramProvider` from `services/telegram.ts` setup flow
3. Define `telegramActions` for explicit agent actions (pin, poll, etc.)
4. Move Grammy dependency to this package
5. Package exports `ChannelPackage`

### Phase 3: Gateway channel infrastructure

1. Create `channels/packages.ts` manifest
2. Create `channels/registry.ts` with `ChannelRegistry`
3. Create `routes/channel-webhooks.ts` universal webhook route
4. Create generic inbound processing in `services/webhook-inbox.ts` (integrates with bean wh8d)
5. Create generic outbound reply path
6. Generalize scope key generation

### Phase 4: Migrate Telegram to use channel infrastructure

1. Update webhook inbox to dispatch Telegram webhooks through `TelegramTransport.parseInbound()`
2. Update session reply path to use `TelegramTransport.sendMessage()`
3. Delete `routes/telegram.ts` webhook handler (replaced by universal route)
4. Delete `services/telegram.ts` send functions (replaced by transport)
5. Keep `routes/telegram.ts` setup endpoints (POST/GET/DELETE `/api/me/telegram`) — these use the provider from the channel package

### Phase 5: Slash command framework

Extract slash command handling into a universal framework:

```typescript
interface ChannelCommand {
  name: string;
  description: string;
  handler: (env: Env, userId: string, args: string, replyFn: ReplyFunction) => Promise<void>;
}

// Built-in commands available on all channels
const universalCommands: ChannelCommand[] = [
  { name: 'start', description: 'Welcome message', handler: handleStart },
  { name: 'help', description: 'List commands', handler: handleHelp },
  { name: 'status', description: 'Orchestrator status', handler: handleStatus },
  { name: 'stop', description: 'Stop current work', handler: handleStop },
  { name: 'sessions', description: 'List child sessions', handler: handleSessions },
];
```

Commands are channel-agnostic. The reply function uses the transport.

### Phase 6: Build `@valet/channel-slack` (separate bean)

Follow the same pattern. This would be its own bean since Slack has significant scope (OAuth, Events API, slash commands, interactive components, Block Kit, app home).

## Files to Create

| File | Purpose |
|---|---|
| `packages/channel-sdk/package.json` | `@valet/channel-sdk` package |
| `packages/channel-sdk/src/index.ts` | All channel interfaces |
| `packages/channel-telegram/package.json` | `@valet/channel-telegram` package |
| `packages/channel-telegram/src/index.ts` | ChannelPackage export |
| `packages/channel-telegram/src/transport.ts` | TelegramTransport |
| `packages/channel-telegram/src/provider.ts` | IntegrationProvider for bot setup |
| `packages/channel-telegram/src/actions.ts` | Explicit Telegram actions |
| `packages/worker/src/channels/packages.ts` | Channel package manifest |
| `packages/worker/src/channels/registry.ts` | ChannelRegistry |
| `packages/worker/src/routes/channel-webhooks.ts` | Universal webhook route |

## Files to Delete

| File | Reason |
|---|---|
| `packages/worker/src/routes/telegram.ts` (webhook handler portion) | Replaced by universal webhook route + transport |
| `packages/worker/src/services/telegram.ts` (send/format functions) | Moved to channel-telegram package |

## Files to Modify

| File | Change |
|---|---|
| `packages/worker/src/services/webhook-inbox.ts` | Add channel transport dispatch path |
| `packages/worker/src/index.ts` | Mount universal webhook route, initialize channel registry |
| `packages/shared/src/scope-key.ts` | Add generic `channelScopeKey()`, keep existing functions as wrappers |
| `packages/worker/src/routes/telegram.ts` | Keep only setup endpoints (POST/GET/DELETE `/api/me/telegram`) |
| `packages/worker/src/durable-objects/session-agent.ts` | Use generic `replyToChannel()` instead of Telegram-specific send |

## Relationship to Other Beans

- **valet-cp7w (Control Plane / Execution Plane Split)** — Channel packages can include an `IntegrationProvider` for connection setup (bot token, OAuth) and an `ActionPackage` for explicit agent actions. Both use the contracts defined in cp7w.
- **valet-pa5m (Polymorphic Action Sources)** — Channel packages that include an `actionPackage` property get their actions registered in the `UnifiedActionRegistry` alongside regular action packages and MCP connectors.
- **valet-tk3n (Unified Credential Boundary)** — The outbound reply path calls `getCredential(env, userId, channelType)` to resolve the bot credential or OAuth credential for sending messages.
- **valet-wh8d (Durable Webhook Inbox)** — Inbound channel webhooks flow through the inbox. The inbox processor uses the channel transport to parse and route messages.
- **valet-pg9a (Policy-Gated Actions)** — Explicit agent actions from channel packages (e.g., `telegram.pin_message`) go through the policy gate like any other action. The bidirectional messaging path (system-routed replies) does NOT go through the policy gate — it's a system operation, not an agent-initiated action.

## Open Questions

1. **Approval prompts per channel.** When an action requires approval (bean pg9a), the prompt needs to render in the user's channel. Telegram needs inline keyboard buttons. Slack needs Block Kit interactive components. Should approval rendering be part of `ChannelTransport` (e.g., `sendApprovalPrompt(action, target, ctx)`)? Or should it use `platformOptions` on `OutboundMessage`?

2. **Media download in parseInbound.** Telegram photos/voice require a second API call to download the file. Should `parseInbound()` handle this (making it async and slow), or should it return file IDs that a separate step resolves? The current Telegram code downloads inline during webhook processing.

3. **Channel-specific metadata on sessions.** The `channel_bindings` table has Telegram/Slack-specific columns (`slackChannelId`, `githubRepoFullName`). With pluggable channels, should these be a generic JSON `metadata` column instead?

4. **Bot setup flow differences.** Telegram uses a bot token + `setWebhook()`. Slack uses OAuth + Event Subscriptions configured in the Slack App dashboard. These are fundamentally different setup experiences. The `provider` field on `ChannelPackage` handles the credential part, but the full setup UX (especially for Slack) may need custom UI components.

5. **Typing indicators.** Should the session automatically send typing indicators while the agent is working? The transport supports it (`sendTypingIndicator`), but the timing and frequency need to be coordinated with the session's processing state.

## Acceptance Criteria

- [ ] `packages/channel-sdk/` exists with all interfaces (`ChannelTransport`, `ChannelPackage`, `InboundMessage`, `OutboundMessage`, etc.)
- [ ] `packages/channel-telegram/` exists implementing `ChannelPackage` with full transport
- [ ] `ChannelRegistry` loads installed channel packages at startup
- [ ] Universal webhook route handles all channel types at `/:channelType/webhook/:userId`
- [ ] Inbound Telegram messages parsed via `TelegramTransport.parseInbound()`
- [ ] Outbound replies sent via `TelegramTransport.sendMessage()`
- [ ] Markdown formatting handled by transport (`formatMarkdown()`)
- [ ] Scope key generation uses generic `channelScopeKey()` function
- [ ] Slash commands handled by universal framework, not per-channel code
- [ ] Gateway has zero Telegram-specific imports (all in the package)
- [ ] Grammy dependency moved from worker to channel-telegram package
- [ ] Adding a new messaging platform requires only: create package, add to manifest, redeploy
- [ ] `pnpm typecheck` passes

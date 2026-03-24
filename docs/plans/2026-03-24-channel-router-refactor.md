# Channel Router Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the auto-reply code path and consolidate all outbound channel dispatch into ChannelRouter.

**Architecture:** ChannelRouter becomes a helper class with injected deps (`resolveToken`, `resolvePersona`, `onReplySent`) that owns transport dispatch for replies, interactive prompts, and interactive prompt updates. The DO keeps SQLite bookkeeping, runner communication, and web UI side-effects. Slack-specific concerns (composite channelId parsing, shimmer clearing) move into the Slack transport.

**Tech Stack:** TypeScript, Cloudflare Durable Objects, Hono, Vitest

**Spec:** `docs/specs/2026-03-24-channel-router-refactor-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/sdk/src/channels/index.ts` | Add `parseTarget` to `ChannelTransport` interface |
| `packages/plugin-slack/src/channels/transport.ts` | Implement `parseTarget`, add shimmer clear to `sendMessage` |
| `packages/plugin-slack/src/channels/transport.test.ts` | Tests for `parseTarget` and shimmer-on-send |
| `packages/worker/src/durable-objects/channel-router.ts` | Rewrite: deps injection, `sendReply`, `sendInteractivePrompt`, `updateInteractivePrompt`, active channel tracking |
| `packages/worker/src/durable-objects/channel-router.test.ts` | Rewrite: unit tests for new ChannelRouter |
| `packages/worker/src/durable-objects/session-agent.ts` | Wire ChannelRouter deps, remove auto-reply, delegate dispatch |
| `packages/worker/src/durable-objects/message-store.ts` | Remove dead code |
| `packages/worker/src/services/channel-reply.ts` | Delete |
| `packages/client/src/components/chat/message-list.tsx` | Remove ChannelSentBadge |
| `packages/sdk/src/ui/channel-badge.tsx` | Remove ChannelSentBadge component |
| `packages/sdk/src/ui/index.ts` | Remove ChannelSentBadge export |

---

### Task 1: Add `parseTarget` to ChannelTransport Interface

**Files:**
- Modify: `packages/sdk/src/channels/index.ts:160` (add method before closing brace of ChannelTransport)

- [ ] **Step 1: Add `parseTarget` to the interface**

In `packages/sdk/src/channels/index.ts`, add this optional method to `ChannelTransport` after line 160 (before the closing `}`):

```ts
  /** Parse a composite channelId into a ChannelTarget. Transports with encoded IDs (e.g. Slack channel:thread_ts) implement this. */
  parseTarget?(channelId: string): ChannelTarget;
```

- [ ] **Step 2: Verify typecheck**

Run: `cd packages/sdk && pnpm typecheck`
Expected: PASS (optional method, no consumers yet)

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/channels/index.ts
git commit -m "feat: add parseTarget optional method to ChannelTransport interface"
```

---

### Task 2: Implement `parseTarget` and Shimmer Clearing in Slack Transport

**Files:**
- Modify: `packages/plugin-slack/src/channels/transport.ts:417-476,520`
- Modify: `packages/plugin-slack/src/channels/transport.test.ts`

- [ ] **Step 1: Write failing test for `parseTarget`**

In `packages/plugin-slack/src/channels/transport.test.ts`, add a new describe block:

```ts
describe('parseTarget', () => {
  it('splits composite channel:thread_ts into channelId and threadId', () => {
    const result = transport.parseTarget('C123ABC:1234567890.123456');
    expect(result).toEqual({
      channelType: 'slack',
      channelId: 'C123ABC',
      threadId: '1234567890.123456',
    });
  });

  it('returns bare channelId when no colon present', () => {
    const result = transport.parseTarget('C123ABC');
    expect(result).toEqual({
      channelType: 'slack',
      channelId: 'C123ABC',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/plugin-slack && pnpm test -- --run -t "parseTarget"`
Expected: FAIL — `transport.parseTarget is not a function`

- [ ] **Step 3: Implement `parseTarget` on SlackTransport**

In `packages/plugin-slack/src/channels/transport.ts`, add this method to the `SlackTransport` class (before `sendMessage` at line 417):

```ts
  parseTarget(channelId: string): ChannelTarget {
    if (channelId.includes(':')) {
      const idx = channelId.indexOf(':');
      return { channelType: 'slack', channelId: channelId.slice(0, idx), threadId: channelId.slice(idx + 1) };
    }
    return { channelType: 'slack', channelId };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/plugin-slack && pnpm test -- --run -t "parseTarget"`
Expected: PASS

- [ ] **Step 5: Write failing test for shimmer clear on sendMessage**

In the existing `sendMessage` describe block in `transport.test.ts`, add:

```ts
  it('clears shimmer after successful threaded sendMessage', async () => {
    const threadTarget = { channelType: 'slack', channelId: 'C123', threadId: '1234.5678' };
    // Mock chat.postMessage success
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ts: '9999' })));
    // Mock setThreadStatus (shimmer clear)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

    await transport.sendMessage(threadTarget, { text: 'hello' }, ctx);

    // Second fetch call should be assistant.threads.setStatus with empty status
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const shimmerCall = fetchMock.mock.calls[1];
    const shimmerBody = JSON.parse(shimmerCall[1]?.body as string);
    expect(shimmerBody.status).toBe('');
    expect(shimmerBody.channel_id).toBe('C123');
    expect(shimmerBody.thread_ts).toBe('1234.5678');
  });

  it('does not clear shimmer for non-threaded sendMessage', async () => {
    const channelTarget = { channelType: 'slack', channelId: 'C123' };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ts: '9999' })));

    await transport.sendMessage(channelTarget, { text: 'hello' }, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1); // Only chat.postMessage, no shimmer clear
  });
```

Adapt `fetchMock` and `ctx` to match the existing test setup in the file.

- [ ] **Step 6: Run test to verify it fails**

Run: `cd packages/plugin-slack && pnpm test -- --run -t "shimmer"`
Expected: FAIL — second fetch call not made

- [ ] **Step 7: Implement shimmer clearing in `sendMessage`**

In `packages/plugin-slack/src/channels/transport.ts`, in the `sendMessage` method, after the successful return at line 476, change the end of the method to:

```ts
    // Clear shimmer after successful send to threaded target
    if (target.threadId) {
      this.setThreadStatus(target, '', ctx).catch(err =>
        console.warn('[SlackTransport] Failed to clear shimmer after send:', err)
      );
    }

    return { success: true, messageId: result.ts };
  }
```

Note: place the shimmer clear BEFORE the `return` statement, after the `!result.ok` check. The `.catch()` makes it fire-and-forget — shimmer failure doesn't block the successful return.

- [ ] **Step 8: Run test to verify it passes**

Run: `cd packages/plugin-slack && pnpm test -- --run -t "shimmer"`
Expected: PASS

- [ ] **Step 9: Run full Slack transport test suite**

Run: `cd packages/plugin-slack && pnpm test -- --run`
Expected: All PASS

- [ ] **Step 10: Commit**

```bash
git add packages/plugin-slack/src/channels/transport.ts packages/plugin-slack/src/channels/transport.test.ts
git commit -m "feat: implement parseTarget and shimmer-on-send in Slack transport"
```

---

### Task 3: Rewrite ChannelRouter

**Files:**
- Rewrite: `packages/worker/src/durable-objects/channel-router.ts`
- Rewrite: `packages/worker/src/durable-objects/channel-router.test.ts`

- [ ] **Step 1: Write failing tests for ChannelRouter**

Rewrite `packages/worker/src/durable-objects/channel-router.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelRouter, type ChannelRouterDeps } from './channel-router.js';

function mockDeps(overrides?: Partial<ChannelRouterDeps>): ChannelRouterDeps {
  return {
    resolveToken: vi.fn().mockResolvedValue('mock-token'),
    resolvePersona: vi.fn().mockResolvedValue(undefined),
    onReplySent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// Mock channelRegistry
const mockTransport = {
  channelType: 'slack',
  sendMessage: vi.fn().mockResolvedValue({ success: true, messageId: 'ts123' }),
  sendInteractivePrompt: vi.fn().mockResolvedValue({ channelId: 'C123', messageId: 'msg1' }),
  updateInteractivePrompt: vi.fn().mockResolvedValue(undefined),
  parseTarget: vi.fn((channelId: string) => {
    if (channelId.includes(':')) {
      const idx = channelId.indexOf(':');
      return { channelType: 'slack', channelId: channelId.slice(0, idx), threadId: channelId.slice(idx + 1) };
    }
    return { channelType: 'slack', channelId };
  }),
};

vi.mock('../channels/registry.js', () => ({
  channelRegistry: {
    getTransport: vi.fn((type: string) => type === 'slack' ? mockTransport : null),
  },
}));

describe('ChannelRouter', () => {
  let router: ChannelRouter;
  let deps: ChannelRouterDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = mockDeps();
    router = new ChannelRouter(deps);
  });

  // ─── Active Channel Tracking ───────────────────────────────────

  describe('activeChannel', () => {
    it('returns null initially', () => {
      expect(router.activeChannel).toBeNull();
    });

    it('returns channel after setActiveChannel', () => {
      router.setActiveChannel({ channelType: 'slack', channelId: 'C123' });
      expect(router.activeChannel).toEqual({ channelType: 'slack', channelId: 'C123' });
    });

    it('atomically replaces previous value', () => {
      router.setActiveChannel({ channelType: 'slack', channelId: 'C123' });
      router.setActiveChannel({ channelType: 'telegram', channelId: 'T456' });
      expect(router.activeChannel).toEqual({ channelType: 'telegram', channelId: 'T456' });
    });

    it('returns null after clearActiveChannel', () => {
      router.setActiveChannel({ channelType: 'slack', channelId: 'C123' });
      router.clearActiveChannel();
      expect(router.activeChannel).toBeNull();
    });

    it('recovers from hibernation', () => {
      router.recoverActiveChannel('slack', 'C123');
      expect(router.activeChannel).toEqual({ channelType: 'slack', channelId: 'C123' });
    });
  });

  // ─── sendReply ─────────────────────────────────────────────────

  describe('sendReply', () => {
    it('resolves transport, token, persona and sends', async () => {
      const result = await router.sendReply({
        userId: 'u1',
        channelType: 'slack',
        channelId: 'C123:1234.5678',
        message: 'hello',
      });

      expect(result).toEqual({ success: true });
      expect(deps.resolveToken).toHaveBeenCalledWith('slack', 'u1');
      expect(deps.resolvePersona).toHaveBeenCalledWith('u1');
      expect(mockTransport.parseTarget).toHaveBeenCalledWith('C123:1234.5678');
      expect(mockTransport.sendMessage).toHaveBeenCalledWith(
        { channelType: 'slack', channelId: 'C123', threadId: '1234.5678' },
        { markdown: 'hello' },
        expect.objectContaining({ token: 'mock-token', userId: 'u1' }),
      );
    });

    it('calls onReplySent on success when followUp is not false', async () => {
      await router.sendReply({
        userId: 'u1', channelType: 'slack', channelId: 'C123', message: 'hi',
      });
      expect(deps.onReplySent).toHaveBeenCalledWith('slack', 'C123');
    });

    it('does not call onReplySent when followUp is false', async () => {
      await router.sendReply({
        userId: 'u1', channelType: 'slack', channelId: 'C123', message: 'hi', followUp: false,
      });
      expect(deps.onReplySent).not.toHaveBeenCalled();
    });

    it('returns error for unknown channel type', async () => {
      const result = await router.sendReply({
        userId: 'u1', channelType: 'unknown', channelId: 'X', message: 'hi',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported channel type');
    });

    it('returns error when no token available', async () => {
      deps = mockDeps({ resolveToken: vi.fn().mockResolvedValue(undefined) });
      router = new ChannelRouter(deps);
      const result = await router.sendReply({
        userId: 'u1', channelType: 'slack', channelId: 'C123', message: 'hi',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('No');
    });

    it('builds outbound with file attachment', async () => {
      await router.sendReply({
        userId: 'u1', channelType: 'slack', channelId: 'C123', message: 'see file',
        fileBase64: 'abc123', fileMimeType: 'application/pdf', fileName: 'doc.pdf',
      });
      const outbound = mockTransport.sendMessage.mock.calls[0][1];
      expect(outbound.attachments).toHaveLength(1);
      expect(outbound.attachments[0].type).toBe('file');
      expect(outbound.attachments[0].fileName).toBe('doc.pdf');
    });

    it('normalizes legacy imageBase64 to file attachment', async () => {
      await router.sendReply({
        userId: 'u1', channelType: 'slack', channelId: 'C123', message: 'see image',
        imageBase64: 'img123', imageMimeType: 'image/png',
      });
      const outbound = mockTransport.sendMessage.mock.calls[0][1];
      expect(outbound.attachments).toHaveLength(1);
      expect(outbound.attachments[0].type).toBe('image');
    });

    it('sends successfully even if resolvePersona throws', async () => {
      deps = mockDeps({ resolvePersona: vi.fn().mockRejectedValue(new Error('no slack')) });
      router = new ChannelRouter(deps);
      const result = await router.sendReply({
        userId: 'u1', channelType: 'slack', channelId: 'C123', message: 'hi',
      });
      // Should still succeed — persona failure is non-fatal
      expect(result).toEqual({ success: true });
      // sendMessage should have been called with persona: undefined
      expect(mockTransport.sendMessage).toHaveBeenCalled();
    });

    it('prefers fileBase64 over imageBase64', async () => {
      await router.sendReply({
        userId: 'u1', channelType: 'slack', channelId: 'C123', message: 'both',
        fileBase64: 'file', fileMimeType: 'application/pdf',
        imageBase64: 'img', imageMimeType: 'image/png',
      });
      const outbound = mockTransport.sendMessage.mock.calls[0][1];
      expect(outbound.attachments).toHaveLength(1);
      expect(outbound.attachments[0].mimeType).toBe('application/pdf');
    });
  });

  // ─── sendInteractivePrompt ─────────────────────────────────────

  describe('sendInteractivePrompt', () => {
    it('dispatches to each target and returns refs with channelType', async () => {
      const prompt = { id: 'p1', sessionId: 's1', type: 'approval' as const, title: 'ok?', actions: [] };
      const refs = await router.sendInteractivePrompt({
        userId: 'u1',
        targets: [{ channelType: 'slack', channelId: 'C123:ts' }],
        prompt,
      });
      expect(refs).toHaveLength(1);
      expect(refs[0].channelType).toBe('slack');
      expect(refs[0].ref).toEqual({ channelId: 'C123', messageId: 'msg1' });
    });

    it('skips targets with no transport', async () => {
      const prompt = { id: 'p1', sessionId: 's1', type: 'approval' as const, title: 'ok?', actions: [] };
      const refs = await router.sendInteractivePrompt({
        userId: 'u1',
        targets: [{ channelType: 'unknown', channelId: 'X' }],
        prompt,
      });
      expect(refs).toHaveLength(0);
    });
  });

  // ─── updateInteractivePrompt ───────────────────────────────────

  describe('updateInteractivePrompt', () => {
    it('dispatches update to each ref', async () => {
      const resolution = { actionId: 'approve', resolvedBy: 'user' };
      await router.updateInteractivePrompt({
        userId: 'u1',
        refs: [{ channelType: 'slack', ref: { channelId: 'C123', messageId: 'msg1' } }],
        resolution,
      });
      expect(mockTransport.updateInteractivePrompt).toHaveBeenCalledTimes(1);
    });

    it('swallows errors per-ref', async () => {
      mockTransport.updateInteractivePrompt.mockRejectedValueOnce(new Error('fail'));
      const resolution = { actionId: 'approve', resolvedBy: 'user' };
      // Should not throw
      await router.updateInteractivePrompt({
        userId: 'u1',
        refs: [{ channelType: 'slack', ref: { channelId: 'C123', messageId: 'msg1' } }],
        resolution,
      });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/worker && pnpm test -- --run src/durable-objects/channel-router.test.ts`
Expected: FAIL — old ChannelRouter has none of the new methods

- [ ] **Step 3: Implement new ChannelRouter**

Rewrite `packages/worker/src/durable-objects/channel-router.ts`:

```ts
/**
 * ChannelRouter — outbound channel dispatch service.
 *
 * Owns: active channel tracking, transport resolution, token resolution,
 * outbound message building, interactive prompt dispatch, and follow-up
 * lifecycle notifications.
 *
 * Helper class scoped to one SessionAgentDO instance. Constructed with
 * injected deps for testability.
 */

import type { ChannelTarget, ChannelContext, OutboundMessage, InteractivePrompt, InteractivePromptRef, InteractiveResolution } from '@valet/sdk';
import { channelRegistry } from '../channels/registry.js';

// Minimal persona type matching what ChannelContext.persona expects
export type Persona = { name?: string; avatar?: string; metadata?: Record<string, unknown> };

export interface ChannelRouterDeps {
  resolveToken(channelType: string, userId: string): Promise<string | undefined>;
  resolvePersona(userId: string): Promise<Persona | undefined>;
  onReplySent(channelType: string, channelId: string): Promise<void>;
}

export interface SendReplyOpts {
  userId: string;
  channelType: string;
  channelId: string;
  message: string;
  fileBase64?: string;
  fileMimeType?: string;
  fileName?: string;
  imageBase64?: string;
  imageMimeType?: string;
  followUp?: boolean;
}

export interface SendReplyResult {
  success: boolean;
  error?: string;
}

export interface SendInteractivePromptOpts {
  userId: string;
  targets: Array<{ channelType: string; channelId: string }>;
  prompt: InteractivePrompt;
}

export interface UpdateInteractivePromptOpts {
  userId: string | undefined;
  refs: Array<{ channelType: string; ref: InteractivePromptRef }>;
  resolution: InteractiveResolution;
}

export class ChannelRouter {
  private _activeChannel: { channelType: string; channelId: string } | null = null;

  constructor(private deps: ChannelRouterDeps) {}

  // ─── Active Channel Tracking ───────────────────────────────────

  setActiveChannel(channel: { channelType: string; channelId: string }): void {
    this._activeChannel = { ...channel };
  }

  clearActiveChannel(): void {
    this._activeChannel = null;
  }

  get activeChannel(): { channelType: string; channelId: string } | null {
    return this._activeChannel ? { ...this._activeChannel } : null;
  }

  recoverActiveChannel(channelType: string, channelId: string): void {
    this._activeChannel = { channelType, channelId };
  }

  // ─── Reply Dispatch ────────────────────────────────────────────

  async sendReply(opts: SendReplyOpts): Promise<SendReplyResult> {
    const { userId, channelType, channelId, message, followUp } = opts;

    const transport = channelRegistry.getTransport(channelType);
    if (!transport) {
      return { success: false, error: `Unsupported channel type: ${channelType}` };
    }

    const token = await this.deps.resolveToken(channelType, userId);
    if (!token) {
      return { success: false, error: `No ${channelType} config for user` };
    }

    const target: ChannelTarget = transport.parseTarget?.(channelId) ?? { channelType, channelId };
    const outbound = this.buildOutboundMessage(opts);
    // Defensive: resolvePersona must not throw per contract, but guard anyway
    const persona = await this.deps.resolvePersona(userId).catch(() => undefined);
    const ctx: ChannelContext = { token, userId, persona };

    try {
      const result = await transport.sendMessage(target, outbound, ctx);
      if (!result.success) {
        return { success: false, error: result.error || `${channelType} API error` };
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (followUp !== false) {
      await this.deps.onReplySent(channelType, channelId);
    }

    return { success: true };
  }

  // ─── Interactive Prompt Dispatch ───────────────────────────────

  async sendInteractivePrompt(
    opts: SendInteractivePromptOpts,
  ): Promise<Array<{ channelType: string; ref: InteractivePromptRef }>> {
    const { userId, targets, prompt } = opts;
    const refs: Array<{ channelType: string; ref: InteractivePromptRef }> = [];

    for (const t of targets) {
      const transport = channelRegistry.getTransport(t.channelType);
      if (!transport?.sendInteractivePrompt) continue;

      const token = await this.deps.resolveToken(t.channelType, userId);
      if (!token) continue;

      const target: ChannelTarget = transport.parseTarget?.(t.channelId) ?? { channelType: t.channelType, channelId: t.channelId };
      const ctx: ChannelContext = { token, userId };

      const ref = await transport.sendInteractivePrompt(target, prompt, ctx);
      if (ref) {
        refs.push({ channelType: t.channelType, ref });
      }
    }

    return refs;
  }

  async updateInteractivePrompt(opts: UpdateInteractivePromptOpts): Promise<void> {
    const { userId, refs, resolution } = opts;

    for (const { channelType, ref } of refs) {
      const transport = channelRegistry.getTransport(channelType);
      if (!transport?.updateInteractivePrompt) continue;

      const token = await this.deps.resolveToken(channelType, userId || '');
      if (!token) continue;

      const target: ChannelTarget = transport.parseTarget?.(ref.channelId) ?? { channelType, channelId: ref.channelId };
      const ctx: ChannelContext = { token, userId: userId || '' };

      try {
        await transport.updateInteractivePrompt(target, ref, resolution, ctx);
      } catch (err) {
        console.error(`[ChannelRouter] updateInteractivePrompt failed for ${channelType}:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────

  private buildOutboundMessage(opts: SendReplyOpts): OutboundMessage {
    const attachBase64 = opts.fileBase64 || opts.imageBase64;
    const attachMime = opts.fileMimeType || opts.imageMimeType || 'application/octet-stream';
    const attachName = opts.fileName;

    if (attachBase64) {
      return {
        markdown: opts.message || undefined,
        attachments: [{
          type: (attachMime.startsWith('image/') ? 'image' : 'file') as 'image' | 'file',
          url: `data:${attachMime};base64,${attachBase64}`,
          mimeType: attachMime,
          fileName: attachName,
          caption: opts.message || undefined,
        }],
      };
    }

    return { markdown: opts.message };
  }
}
```

Note: check the exact `Persona` type from `@valet/sdk` — if `ChannelContext.persona` has a specific type, import it instead of defining `Persona` locally. Grep for `persona` in `packages/sdk/src/channels/index.ts` to find the correct type.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/worker && pnpm test -- --run src/durable-objects/channel-router.test.ts`
Expected: All PASS

- [ ] **Step 5: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS (ChannelRouter is imported by session-agent.ts but the old API is still referenced — this will fail until Task 4. If it fails, that's expected; proceed to Task 4.)

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/durable-objects/channel-router.ts packages/worker/src/durable-objects/channel-router.test.ts
git commit -m "feat: rewrite ChannelRouter with deps injection and consolidated dispatch"
```

---

### Task 4: Wire ChannelRouter in SessionAgentDO and Remove Auto-Reply

This is the largest task — it modifies session-agent.ts in several places. Work through each sub-section carefully.

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts`

- [ ] **Step 1: Update imports**

At the top of session-agent.ts (~lines 20, 26):
- Line 20: `import { ChannelRouter } from './channel-router.js';` — keep as-is (same file, new shape)
- Line 26: Remove `import { sendChannelReply } from '../services/channel-reply.js';`
- Line 11: Remove `import { channelRegistry } from '../channels/registry.js';`

Check: `channelRegistry` must have NO other usage in the file after the refactor. If it does (e.g., in interactive prompt code that hasn't been updated yet), leave the import until those usages are removed in later steps.

- [ ] **Step 2: Update ChannelRouter construction with deps injection**

Find `private channelRouter = new ChannelRouter();` (~line 232). Replace with:

```ts
  private channelRouter = new ChannelRouter({
    resolveToken: async (channelType, userId) => {
      if (channelType === 'slack') {
        return await getSlackBotToken(this.env) ?? undefined;
      }
      const credResult = await getCredential(this.env, 'user', userId, channelType);
      return credResult.ok ? credResult.credential.accessToken : undefined;
    },
    resolvePersona: (userId) =>
      resolveOrchestratorPersona(this.appDb, userId).catch(() => undefined),
    onReplySent: async (channelType, channelId) => {
      this.resolveChannelFollowups(channelType, channelId);
    },
  });
```

- [ ] **Step 3: Simplify the `activeChannel` getter**

Replace the `activeChannel` getter (~lines 248-259) with:

```ts
  private get activeChannel(): { channelType: string; channelId: string } | null {
    const current = this.channelRouter.activeChannel;
    if (current) return current;
    // Hibernation recovery: check prompt_queue for processing row with channel metadata
    const recovered = this.promptQueue.getProcessingChannelContext();
    if (recovered) {
      console.log(`[SessionAgentDO] Recovered activeChannel from prompt_queue: ${recovered.channelType}:${recovered.channelId}`);
      this.channelRouter.recoverActiveChannel(recovered.channelType, recovered.channelId);
    }
    return recovered;
  }
```

- [ ] **Step 4: Update `handlePrompt()` — replace trackReply with setActiveChannel**

Find the block at ~lines 1505-1518 that calls `this.channelRouter.clear()` and `this.channelRouter.trackReply()`. Replace with:

```ts
    // Track active channel for this prompt cycle.
    if (effectiveReplyTo) {
      this.channelRouter.setActiveChannel(effectiveReplyTo);
      this.insertChannelFollowup(effectiveReplyTo.channelType, effectiveReplyTo.channelId, content);
    } else if (threadId) {
      const origin = await getThreadOriginChannel(this.env.DB, threadId);
      if (origin && origin.channelType !== 'web' && origin.channelType !== 'thread') {
        this.channelRouter.setActiveChannel({ channelType: origin.channelType, channelId: origin.channelId });
        this.insertChannelFollowup(origin.channelType, origin.channelId, content);
      }
    }
```

Note: `channelRouter.clear()` is removed — `setActiveChannel` atomically replaces.

- [ ] **Step 5: Update `sendNextQueuedPrompt()` — replace trackReply with setActiveChannel**

Find the block at ~lines 3903-3919. Replace with:

```ts
    // Track active channel for this prompt cycle using the ORIGINAL channel
    const queueReplyChannelType = prompt.replyChannelType || undefined;
    const queueReplyChannelId = prompt.replyChannelId || undefined;
    if (queueReplyChannelType && queueReplyChannelId) {
      this.channelRouter.setActiveChannel({ channelType: queueReplyChannelType, channelId: queueReplyChannelId });
      this.insertChannelFollowup(queueReplyChannelType, queueReplyChannelId, prompt.content);
    } else if (queueThreadId) {
      const origin = await getThreadOriginChannel(this.env.DB, queueThreadId);
      if (origin && origin.channelType !== 'web' && origin.channelType !== 'thread') {
        this.channelRouter.setActiveChannel({ channelType: origin.channelType, channelId: origin.channelId });
        this.insertChannelFollowup(origin.channelType, origin.channelId, prompt.content);
      }
    }
```

- [ ] **Step 5b: Migrate remaining `channelRouter.clear()` calls to `clearActiveChannel()`**

There are 3 additional `channelRouter.clear()` call sites in error/failure paths:

1. **~line 1556** (dispatch failure in `handlePrompt`): `this.channelRouter.clear()` → `this.channelRouter.clearActiveChannel()`
2. **~line 3861** (before `stampDispatched` in `sendNextQueuedPrompt`): This `clear()` is before the `trackReply` block — remove it since `setActiveChannel` in Step 5 atomically replaces.
3. **~line 3955** (queue dispatch failure in `sendNextQueuedPrompt`): `this.channelRouter.clear()` → `this.channelRouter.clearActiveChannel()`

Search the file for `channelRouter.clear()` to confirm all 5 sites are handled (2 in Steps 4-5, 3 here).

- [ ] **Step 6: Remove `channelRouter.setResult()` from finalize handler**

Find lines ~2104-2107 in the `'final'` handler:
```ts
        // Track result content for auto channel reply
        if (final.content) {
          this.channelRouter.setResult(final.content, turnId);
        }
```
Delete these 4 lines.

- [ ] **Step 7: Remove auto-reply from `complete` handler**

Replace the `'complete'` handler (~lines 2115-2125) with:

```ts
      'complete': async (msg) => {
        console.log(`[SessionAgentDO] Complete received: queueLength=${this.promptQueue.length} runnerBusy=${this.promptQueue.runnerBusy}`);
        await this.handlePromptComplete();
        this.ctx.waitUntil(this.flushMetrics());
      },
```

- [ ] **Step 8: Remove auto-reply flush from watchdog alarm handler**

Find ~line 928: `await this.flushPendingChannelReply();`
Delete this single line. The surrounding code (revertProcessingToQueued, broadcast, audit) stays.

- [ ] **Step 9: Remove auto-reply flush from error safety-net handler**

Find ~lines 966-968:
```ts
        await this.flushPendingChannelReply();
        await this.handlePromptComplete();
```
Remove the `flushPendingChannelReply` line. Keep `await this.handlePromptComplete();`.

- [ ] **Step 10: Rewrite `handleChannelReply()` as thin wrapper**

Replace the entire `handleChannelReply` method (~lines 4753-4882) with:

```ts
  private async handleChannelReply(
    requestId: string,
    channelType: string,
    channelId: string,
    message: string,
    imageBase64?: string,
    imageMimeType?: string,
    followUp?: boolean,
    fileBase64?: string,
    fileMimeType?: string,
    fileName?: string,
  ) {
    const userId = this.sessionState.userId;
    if (!userId) {
      this.runnerLink.send({ type: 'channel-reply-result', requestId, error: 'No userId on session' } as any);
      return;
    }

    const result = await this.channelRouter.sendReply({
      userId, channelType, channelId, message,
      fileBase64, fileMimeType, fileName,
      imageBase64, imageMimeType, followUp,
    });

    if (!result.success) {
      this.runnerLink.send({ type: 'channel-reply-result', requestId, error: result.error } as any);
      return;
    }

    this.runnerLink.send({ type: 'channel-reply-result', requestId, success: true } as any);

    // Store image as a system message for web UI visibility
    // TODO: Treat web UI as a channel — this is the primary remaining coupling
    // between channel dispatch and the DO's message/broadcast layer
    if (imageBase64) {
      const msgId = crypto.randomUUID();
      const channelLabel = `Sent image to ${channelType}`;
      this.messageStore.writeMessage({
        id: msgId,
        role: 'system',
        content: message || channelLabel,
        parts: JSON.stringify({ type: 'image', data: imageBase64, mimeType: imageMimeType || 'image/jpeg' }),
        channelType,
        channelId,
      });
      this.broadcastToClients({
        type: 'message',
        data: {
          id: msgId,
          role: 'system',
          content: message || channelLabel,
          parts: { type: 'image', data: imageBase64, mimeType: imageMimeType || 'image/jpeg' },
          createdAt: Math.floor(Date.now() / 1000),
          channelType,
          channelId,
        },
      });
    }
  }
```

- [ ] **Step 11: Rewrite `sendChannelInteractivePrompts()` as thin wrapper**

Find the method (~lines 5327-5428). Keep the target-collection preamble (everything before the `for (const target of targets)` loop at ~line 5384) and replace the dispatch loop + storage with:

```ts
      const refs = await this.channelRouter.sendInteractivePrompt({ userId, targets, prompt });

      if (refs.length > 0) {
        this.ctx.storage.sql.exec(
          'UPDATE interactive_prompts SET channel_refs = ? WHERE id = ?',
          JSON.stringify(refs),
          promptId,
        );
      }
    } catch (err) {
      console.error('[SessionAgentDO] sendChannelInteractivePrompts failed:', err instanceof Error ? err.message : String(err));
    }
  }
```

Remove all the duplicated token resolution, `parseSlackChannelId`, transport lookup, and per-target iteration that was inside the `for` loop.

- [ ] **Step 12: Rewrite `updateChannelInteractivePrompts()` as thin wrapper**

Replace the method (~lines 5430-5471) with:

```ts
  private async updateChannelInteractivePrompts(
    channelRefsJson: string | null,
    resolution: InteractiveResolution,
  ) {
    if (!channelRefsJson) return;

    let refs: Array<{ channelType: string; ref: InteractivePromptRef }>;
    try {
      refs = JSON.parse(channelRefsJson);
    } catch {
      return;
    }

    await this.channelRouter.updateInteractivePrompt({
      userId: this.sessionState.userId,
      refs,
      resolution,
    });
  }
```

- [ ] **Step 13: Remove `parseSlackChannelId()` private method**

Find and delete the `parseSlackChannelId` method (~lines 4741-4751). It should now have zero callers.

- [ ] **Step 14: Delete `flushPendingChannelReply()` method**

Find and delete the entire `flushPendingChannelReply` method (~lines 5491-5558). It should have zero callers after steps 7-9.

- [ ] **Step 15: Remove the auto-reply tracking comment block**

Find and delete the comment block at ~lines 218-222:
```ts
  // ─── Auto Channel Reply Tracking ─────────────────────────────────────
  // When a prompt arrives from an external channel (e.g. Telegram), we track
  // the channel context so we can auto-send the agent's response back to it.
  // If the agent explicitly calls channel_reply for that channel, we mark it
  // handled so we don't double-send.
```

- [ ] **Step 16: Clean up unused imports**

Remove these imports if they have no remaining callers:
- `sendChannelReply` from `../services/channel-reply.js` (line 26)
- `channelRegistry` from `../channels/registry.js` (line 11) — verify no remaining callers first by searching the file

- [ ] **Step 17: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS. If there are type errors, fix them — likely related to ChannelRouter API changes or missing imports.

- [ ] **Step 18: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts
git commit -m "feat: wire ChannelRouter deps, remove auto-reply, delegate all channel dispatch"
```

---

### Task 5: Delete `services/channel-reply.ts`

**Files:**
- Delete: `packages/worker/src/services/channel-reply.ts`

- [ ] **Step 1: Verify no remaining imports**

Run: `grep -r "channel-reply" packages/worker/src/ --include="*.ts" -l`
Expected: Only `channel-reply.ts` itself (if the import was already removed from session-agent.ts in Task 4).

- [ ] **Step 2: Delete the file**

```bash
rm packages/worker/src/services/channel-reply.ts
```

- [ ] **Step 3: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add -u packages/worker/src/services/channel-reply.ts
git commit -m "chore: delete channel-reply service (dead code after auto-reply removal)"
```

---

### Task 6: Remove Dead Code from MessageStore

**Files:**
- Modify: `packages/worker/src/durable-objects/message-store.ts`

- [ ] **Step 1: Verify no remaining callers**

Run: `grep -r "stampChannelDelivery\|getLatestAssistantForChannel" packages/worker/src/ --include="*.ts"`
Expected: Only hits in `message-store.ts` itself.

- [ ] **Step 2: Remove `stampChannelDelivery` method**

Delete the `stampChannelDelivery` method (~lines 476-486 of message-store.ts).

- [ ] **Step 3: Remove `getLatestAssistantForChannel` method**

Delete the `getLatestAssistantForChannel` method (~lines 533-540 of message-store.ts).

- [ ] **Step 4: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/durable-objects/message-store.ts
git commit -m "chore: remove stampChannelDelivery and getLatestAssistantForChannel (dead code)"
```

---

### Task 7: Remove ChannelSentBadge from UI

**Files:**
- Modify: `packages/client/src/components/chat/message-list.tsx:13,184,203`
- Modify: `packages/sdk/src/ui/channel-badge.tsx:22-33`
- Modify: `packages/sdk/src/ui/index.ts:15`

- [ ] **Step 1: Remove ChannelSentBadge from message-list.tsx**

In `packages/client/src/components/chat/message-list.tsx`:
- Line 13: Remove `ChannelSentBadge` from the import: `import { ChannelSentBadge } from '@valet/sdk/ui';` → delete this import entirely (or remove just `ChannelSentBadge` if `ChannelBadge` is also imported on this line)
- Line 184: Remove `const sentToChannel = message.channelType ? message : undefined;`
- Line 203: Remove `{sentToChannel && <ChannelSentBadge channelType={sentToChannel.channelType!} />}`

- [ ] **Step 2: Remove ChannelSentBadge from SDK**

In `packages/sdk/src/ui/channel-badge.tsx`, delete the `ChannelSentBadge` function (lines 22-33). Keep `ChannelBadge`.

In `packages/sdk/src/ui/index.ts`, remove `ChannelSentBadge` from the export (line 15):
```ts
export {
  ChannelBadge,
} from './channel-badge.js';
```

Also remove the `SendIcon` import/export if it's only used by `ChannelSentBadge`. Check by grepping for `SendIcon` across the client.

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck` (from root — checks all packages)
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/components/chat/message-list.tsx packages/sdk/src/ui/channel-badge.tsx packages/sdk/src/ui/index.ts
git commit -m "chore: remove ChannelSentBadge (dead code after auto-reply removal)"
```

---

### Task 8: Final Verification

- [ ] **Step 1: Full typecheck**

Run: `pnpm typecheck`
Expected: PASS across all packages

- [ ] **Step 2: Run all tests**

Run: `pnpm test`
Expected: All PASS

- [ ] **Step 3: Verify no references to removed code**

Run these greps to confirm clean removal:
```bash
grep -r "flushPendingChannelReply\|stampChannelDelivery\|getLatestAssistantForChannel\|ChannelSentBadge\|sendChannelReply\|parseSlackChannelId" packages/ --include="*.ts" -l
```
Expected: No hits (except possibly test snapshots or this plan file).

Also verify:
```bash
grep -r "channelRouter\.trackReply\|channelRouter\.setResult\|channelRouter\.markHandled\|channelRouter\.consumePendingReply\|channelRouter\.pendingSnapshot\|channelRouter\.hasPending\|channelRouter\.recover\b\|channelRouter\.clear\b" packages/worker/src/ --include="*.ts"
```
Expected: No hits.

- [ ] **Step 4: Verify channelRegistry not imported in session-agent.ts**

Run: `grep "channelRegistry" packages/worker/src/durable-objects/session-agent.ts`
Expected: No hits.

- [ ] **Step 5: Commit any remaining fixes**

If any verification steps found issues, fix and commit.

- [ ] **Step 6: Final commit message**

If all tasks were committed individually, no additional commit needed. Verify with `git log --oneline -10` that the commit history tells a clear story.

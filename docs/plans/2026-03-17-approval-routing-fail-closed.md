# Fail-Closed Approval Routing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent approval requests from broadcasting to all user channel bindings; route only to the thread's origin channel + most recent caller channel, and error loudly if neither can be determined.

**Architecture:** Add a reverse lookup (`getThreadOriginChannel`) from threadId → origin channelType+channelId in the channel-threads DB module. Use this as a fallback when `pendingChannelReply` is null (web UI steering). Replace the all-bindings broadcast in `sendChannelInteractivePrompts` with targeted origin+caller routing and a fail-closed error path.

**Tech Stack:** TypeScript, Cloudflare D1, Durable Objects

**Spec:** `docs/specs/2026-03-17-approval-routing-design.md`

---

## Chunk 1: Add reverse thread origin lookup

### Task 1: Add `getThreadOriginChannel` to channel-threads DB module

**Files:**
- Modify: `packages/worker/src/lib/db/channel-threads.ts`

- [ ] **Step 1: Add the `getThreadOriginChannel` function**

This is a reverse lookup: given a threadId, return the origin channel. A thread may have multiple channel mappings (multiple Slack threads pointing to same orchestrator thread), so we return the earliest one (the original creator). Add this at the end of the file, before the closing:

```typescript
/**
 * Reverse lookup: given an internal threadId, return the origin channel
 * (the channel that first created this thread). Returns the earliest mapping.
 */
export async function getThreadOriginChannel(
  db: D1Database,
  threadId: string,
): Promise<{ channelType: string; channelId: string } | null> {
  const row = await db
    .prepare(
      'SELECT channel_type, channel_id FROM channel_thread_mappings WHERE thread_id = ? ORDER BY created_at ASC LIMIT 1'
    )
    .bind(threadId)
    .first();

  if (!row) return null;
  return {
    channelType: row.channel_type as string,
    channelId: row.channel_id as string,
  };
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS

The function is automatically re-exported via the barrel at `packages/worker/src/lib/db.ts` (line 35: `export * from './db/channel-threads.js'`), so no barrel changes needed.

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/lib/db/channel-threads.ts
git commit -m "feat: add getThreadOriginChannel reverse lookup for thread→channel mapping"
```

---

## Chunk 2: Thread-aware `pendingChannelReply` fallback

### Task 2: Add thread origin fallback in direct prompt dispatch

When `pendingChannelReply` would be null (web UI message) but the prompt has a `threadId`, look up the thread's origin channel from `channel_thread_mappings` and use it.

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts:1969-1979`

- [ ] **Step 1: Add import for `getThreadOriginChannel`**

At the top of session-agent.ts, add the import. Since the barrel at `../lib/db.js` already re-exports `channel-threads.ts`, import from the barrel to match the existing convention in this file:

```typescript
import { getThreadOriginChannel } from '../lib/db.js';
```

If there's already an import block from `'../lib/db.js'`, add `getThreadOriginChannel` to the existing named imports.

- [ ] **Step 2: Add thread origin fallback in direct dispatch path**

Replace lines 1969-1979 (the `pendingChannelReply` assignment block in `handlePrompt`):

**Before:**
```typescript
    // Track channel context for auto-reply on completion using the ORIGINAL channel
    // (e.g., slack:C123:thread_ts), not the normalized thread routing key.
    // This ensures the agent is prompted to reply via the originating channel.
    if (replyChannelType && replyChannelId && this.requiresExplicitChannelReply(replyChannelType)) {
      this.pendingChannelReply = { channelType: replyChannelType, channelId: replyChannelId, resultContent: null, resultMessageId: null, handled: false };

      // Record a follow-up reminder so the agent gets nudged if it doesn't send a substantive reply
      this.insertChannelFollowup(replyChannelType, replyChannelId, content);
    } else {
      this.pendingChannelReply = null;
    }
```

**After:**
```typescript
    // Track channel context for auto-reply on completion using the ORIGINAL channel
    // (e.g., slack:C123:thread_ts), not the normalized thread routing key.
    // This ensures the agent is prompted to reply via the originating channel.
    if (replyChannelType && replyChannelId && this.requiresExplicitChannelReply(replyChannelType)) {
      this.pendingChannelReply = { channelType: replyChannelType, channelId: replyChannelId, resultContent: null, resultMessageId: null, handled: false };

      // Record a follow-up reminder so the agent gets nudged if it doesn't send a substantive reply
      this.insertChannelFollowup(replyChannelType, replyChannelId, content);
    } else if (threadId) {
      // Web UI steering of a thread — recover the thread's origin channel so
      // downstream code (approvals, auto-reply) knows where to route on Slack.
      const origin = await getThreadOriginChannel(this.env.DB, threadId);
      if (origin && this.requiresExplicitChannelReply(origin.channelType)) {
        this.pendingChannelReply = { channelType: origin.channelType, channelId: origin.channelId, resultContent: null, resultMessageId: null, handled: false };
        this.insertChannelFollowup(origin.channelType, origin.channelId, content);
      } else {
        this.pendingChannelReply = null;
      }
    } else {
      this.pendingChannelReply = null;
    }
```

- [ ] **Step 3: Verify typecheck passes**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts
git commit -m "feat: recover thread origin channel as pendingChannelReply fallback for web UI steering"
```

### Task 3: Add same thread origin fallback in queue dispatch path

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts:7026-7050`

- [ ] **Step 1: Add thread origin fallback in queue dispatch path**

Replace lines 7026-7050 (the `pendingChannelReply` assignment block AND the `queueThreadId` declaration in `sendNextQueuedPrompt`). The key change: `queueThreadId` must be declared BEFORE the `pendingChannelReply` block since the new fallback branch references it.

**Before (lines 7026-7050):**
```typescript
    // Track channel context for auto-reply on completion using the ORIGINAL channel
    // (e.g., slack:C123:thread_ts), not the normalized thread routing key.
    const queueChannelType = (prompt.channel_type as string) || undefined;
    const queueChannelId = (prompt.channel_id as string) || undefined;
    // Only use reply_channel columns if they exist — do NOT fall back to the
    // normalized channel_type ('thread') which always fails requiresExplicitChannelReply.
    const queueReplyChannelType = (prompt.reply_channel_type as string) || undefined;
    const queueReplyChannelId = (prompt.reply_channel_id as string) || undefined;
    if (queueReplyChannelType && queueReplyChannelId && this.requiresExplicitChannelReply(queueReplyChannelType)) {
      this.pendingChannelReply = { channelType: queueReplyChannelType, channelId: queueReplyChannelId, resultContent: null, resultMessageId: null, handled: false };

      // Record a follow-up reminder so the agent gets nudged if it doesn't send a substantive reply
      this.insertChannelFollowup(queueReplyChannelType, queueReplyChannelId, prompt.content as string);
    } else {
      this.pendingChannelReply = null;
    }

    // Resolve model preferences from session owner (with org fallback)
    const queueOwnerId = this.getStateValue('userId');
    const queueOwnerDetails = queueOwnerId ? await this.getUserDetails(queueOwnerId) : undefined;
    const queueModelPrefs = await this.resolveModelPreferences(queueOwnerDetails);
    const queueChannelKey = this.channelKeyFrom(queueChannelType, queueChannelId);
    const queueOcSessionId = this.getChannelOcSessionId(queueChannelKey);
    const queueThreadId = (prompt.thread_id as string) || undefined;
    const queueContinuationContext = (prompt.continuation_context as string) || undefined;
```

**After (lines 7026-7050):**
```typescript
    // Track channel context for auto-reply on completion using the ORIGINAL channel
    // (e.g., slack:C123:thread_ts), not the normalized thread routing key.
    const queueChannelType = (prompt.channel_type as string) || undefined;
    const queueChannelId = (prompt.channel_id as string) || undefined;
    const queueThreadId = (prompt.thread_id as string) || undefined;
    // Only use reply_channel columns if they exist — do NOT fall back to the
    // normalized channel_type ('thread') which always fails requiresExplicitChannelReply.
    const queueReplyChannelType = (prompt.reply_channel_type as string) || undefined;
    const queueReplyChannelId = (prompt.reply_channel_id as string) || undefined;
    if (queueReplyChannelType && queueReplyChannelId && this.requiresExplicitChannelReply(queueReplyChannelType)) {
      this.pendingChannelReply = { channelType: queueReplyChannelType, channelId: queueReplyChannelId, resultContent: null, resultMessageId: null, handled: false };

      // Record a follow-up reminder so the agent gets nudged if it doesn't send a substantive reply
      this.insertChannelFollowup(queueReplyChannelType, queueReplyChannelId, prompt.content as string);
    } else if (queueThreadId) {
      // Web UI steering of a thread — recover origin channel (same as direct dispatch path)
      const origin = await getThreadOriginChannel(this.env.DB, queueThreadId);
      if (origin && this.requiresExplicitChannelReply(origin.channelType)) {
        this.pendingChannelReply = { channelType: origin.channelType, channelId: origin.channelId, resultContent: null, resultMessageId: null, handled: false };
        this.insertChannelFollowup(origin.channelType, origin.channelId, prompt.content as string);
      } else {
        this.pendingChannelReply = null;
      }
    } else {
      this.pendingChannelReply = null;
    }

    // Resolve model preferences from session owner (with org fallback)
    const queueOwnerId = this.getStateValue('userId');
    const queueOwnerDetails = queueOwnerId ? await this.getUserDetails(queueOwnerId) : undefined;
    const queueModelPrefs = await this.resolveModelPreferences(queueOwnerDetails);
    const queueChannelKey = this.channelKeyFrom(queueChannelType, queueChannelId);
    const queueOcSessionId = this.getChannelOcSessionId(queueChannelKey);
    const queueContinuationContext = (prompt.continuation_context as string) || undefined;
```

Note: `queueThreadId` is moved up from line 7049 to line 7028 so it's available for the `else if` branch. The subsequent code that referenced `queueThreadId` (line 7066) still works because the variable is now declared earlier in the same scope.

- [ ] **Step 2: Verify typecheck passes**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts
git commit -m "feat: add thread origin fallback in queue dispatch path"
```

---

## Chunk 3: Fail-closed `sendChannelInteractivePrompts`

### Task 4: Replace all-bindings broadcast with origin+caller targeting

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts:9384-9474`

- [ ] **Step 1: Rewrite `sendChannelInteractivePrompts`**

Replace the entire method body (lines 9384-9474):

```typescript
  private async sendChannelInteractivePrompts(promptId: string, prompt: InteractivePrompt) {
    try {
      const sessionId = this.getStateValue('sessionId');
      const userId = this.getStateValue('userId');
      if (!sessionId || !userId) return;

      const targets: Array<{ channelType: string; channelId: string }> = [];
      const seen = new Set<string>();

      // 1. Origin target: the channel stored in the approval context at creation time
      //    (set from activeChannel when the approval was created)
      const originTarget = this.getPromptOriginTarget(prompt.context);
      if (originTarget && originTarget.channelType !== 'web') {
        const key = `${originTarget.channelType}:${originTarget.channelId}`;
        seen.add(key);
        targets.push(originTarget);
      }

      // 2. Caller target: the currently active channel (may differ from origin
      //    if a different Slack thread is subscribed to the same orchestrator thread)
      const callerTarget = this.activeChannel;
      if (callerTarget && callerTarget.channelType !== 'web') {
        const key = `${callerTarget.channelType}:${callerTarget.channelId}`;
        if (!seen.has(key)) {
          seen.add(key);
          targets.push(callerTarget);
        }
      }

      // Fail closed: if we have no non-web channel targets, check whether this
      // session even has external channel bindings. If it does, something went
      // wrong with channel context propagation — log loudly and surface an error
      // to the web UI. If it doesn't (pure web-only session), this is expected
      // and we return silently — the approval is already visible in the web UI
      // via broadcastToClients (called before this method).
      if (targets.length === 0) {
        const hasExternalBindings = (await listUserChannelBindings(this.appDb, userId))
          .some(b => b.channelType !== 'web');
        if (hasExternalBindings) {
          console.error(
            `[SessionAgentDO] sendChannelInteractivePrompts: No origin or caller channel for prompt ${promptId} — refusing to broadcast. ` +
            `Session has external channel bindings but no channel context was propagated. ` +
            `Approval is visible in web UI only. sessionId=${sessionId} userId=${userId}`
          );
          this.broadcastToClients({
            type: 'error',
            data: {
              message: 'Approval could not be delivered to Slack: no origin channel context. Please approve via the web dashboard.',
              promptId,
            },
          });
        }
        return;
      }

      const refs: Array<{ channelType: string; ref: InteractivePromptRef }> = [];

      for (const target of targets) {
        const transport = channelRegistry.getTransport(target.channelType);
        if (!transport?.sendInteractivePrompt) continue;

        // Resolve token (same pattern as handleChannelReply)
        let token: string | undefined;
        if (target.channelType === 'slack') {
          token = await getSlackBotToken(this.env) ?? undefined;
        } else {
          const credResult = await getCredential(this.env, 'user', userId, target.channelType);
          if (credResult.ok) token = credResult.credential.accessToken;
        }
        if (!token) continue;

        // Build target from binding
        const parsed = this.parseSlackChannelId(target.channelType, target.channelId);
        const channelTarget: ChannelTarget = {
          channelType: target.channelType,
          channelId: parsed.channelId,
          threadId: parsed.threadId,
        };
        const ctx: ChannelContext = { token, userId };

        const ref = await transport.sendInteractivePrompt(channelTarget, prompt, ctx);
        if (ref) {
          refs.push({ channelType: target.channelType, ref });
        }
      }

      // Store refs in local SQLite for later status updates.
      // Note: There is a race window here — if the prompt is resolved before this
      // UPDATE runs, the row will already be deleted and channel refs are lost.
      // In that case the Slack message won't be updated with resolution status.
      // This is acceptable since the user already saw the resolution in the UI.
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

- [ ] **Step 2: Verify typecheck passes**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Check for unused imports**

Search for `getSessionChannelBindings` usages in session-agent.ts. If it's no longer used anywhere in the file, remove the import. `listUserChannelBindings` is still used in the fail-closed check above, so keep it.

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts
git commit -m "fix: fail-closed approval routing — send to origin+caller only, never broadcast to all bindings"
```

---

## Chunk 4: Verification

### Task 5: End-to-end typecheck and test

- [ ] **Step 1: Run full typecheck**

Run: `pnpm typecheck`
Expected: PASS across all packages

- [ ] **Step 2: Run tests**

Run: `pnpm test`
Expected: All existing tests pass (no behavioral regressions)

- [ ] **Step 3: Final commit if any cleanup was needed**

```bash
git add -A
git commit -m "chore: cleanup after approval routing fix"
```

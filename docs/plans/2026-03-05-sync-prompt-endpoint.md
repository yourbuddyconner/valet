# Sync Prompt Endpoint — Fix "Model Did Not Respond"

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the fire-and-forget `prompt_async` pattern with synchronous prompt calls so the HTTP response is the authoritative completion signal, eliminating the "model did not respond" bug caused by missed SSE events.

**Architecture:** The Runner currently sends prompts via `POST /session/:id/prompt_async` (returns 204 immediately) and relies entirely on the SSE event stream for completion detection. When SSE events are missed, the Runner has no way to know the prompt completed. The fix: use OpenCode's existing sync endpoint `POST /session/:id/message` which awaits `SessionPrompt.prompt()` and returns the assistant message as JSON. The sync HTTP response becomes the source of truth for completion; SSE continues for real-time streaming to the UI but is no longer required for correctness.

**Tech Stack:** TypeScript, Bun (Runner), OpenCode HTTP API

**Key discovery:** OpenCode **already has** a sync prompt endpoint at `POST /:sessionID/message` (lines 730-769 in `/tmp/opencode/packages/opencode/src/server/routes/session.ts`). It awaits `SessionPrompt.prompt()` and returns `{ info: MessageV2.Assistant, parts: MessageV2.Part[] }`. No OpenCode changes needed.

---

### Task 1: Add `sendPromptSync` method

**Files:**
- Modify: `packages/runner/src/prompt.ts` (add new method near existing `sendPromptAsync` at line ~2404)

**Step 1: Add the `sendPromptSync` method after `sendPromptAsync`**

Add a new method that calls the sync endpoint and returns the parsed response. This method mirrors `sendPromptAsync` for body construction but awaits the response:

```typescript
private async sendPromptSync(
  sessionId: string,
  content: string,
  model?: string,
  attachments?: PromptAttachment[],
  author?: PromptAuthor,
  channelType?: string,
  channelId?: string,
): Promise<{ info: OpenCodeMessageInfo; parts: unknown[] } | null> {
  const url = `${this.opencodeUrl}/session/${sessionId}/message`;
  console.log(`[PromptHandler] POST ${url} (sync)${model ? ` (model: ${model})` : ''}${attachments?.length ? ` (attachments: ${attachments.length})` : ''}`);

  const promptParts: Array<Record<string, unknown>> = [];
  for (const attachment of attachments ?? []) {
    promptParts.push({
      type: "file",
      mime: attachment.mime,
      url: attachment.url,
      ...(attachment.filename ? { filename: attachment.filename } : {}),
    });
  }
  let attributedContent = content;
  if (channelType && channelId) {
    attributedContent = `[via ${channelType} | chatId: ${channelId}] ${attributedContent}`;
  }
  if (author?.authorName || author?.authorEmail) {
    const name = author.authorName || 'Unknown';
    const email = author.authorEmail ? ` <${author.authorEmail}>` : '';
    const userId = author.authorId ? ` (userId: ${author.authorId})` : '';
    attributedContent = `[User: ${name}${email}${userId}] ${attributedContent}`;
  }
  if (attributedContent) {
    promptParts.push({ type: "text", text: attributedContent });
  }
  if (promptParts.length === 0) {
    throw new Error("Cannot send empty prompt: no text or attachments");
  }
  const body: Record<string, unknown> = { parts: promptParts };
  if (model) {
    const slashIdx = model.indexOf("/");
    if (slashIdx !== -1) {
      body.model = { providerID: model.slice(0, slashIdx), modelID: model.slice(slashIdx + 1) };
    } else {
      body.model = { providerID: "", modelID: model };
    }
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  console.log(`[PromptHandler] prompt sync response: ${res.status} ${res.statusText}`);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const error = new Error(`OpenCode prompt sync failed: ${res.status} — ${text}`);
    (error as { status?: number }).status = res.status;
    throw error;
  }

  try {
    const result = await res.json() as { info?: OpenCodeMessageInfo; parts?: unknown[] } | null;
    if (!result || !result.info) return null;
    return { info: result.info, parts: result.parts ?? [] };
  } catch {
    console.warn("[PromptHandler] Failed to parse sync prompt response");
    return null;
  }
}
```

**Step 2: Add `sendPromptSyncWithRecovery` wrapper**

Add this right after `sendPromptSync`, mirroring the existing `sendPromptToChannelWithRecovery` pattern but for sync calls:

```typescript
private async sendPromptSyncWithRecovery(
  channel: ChannelSession,
  content: string,
  options?: {
    model?: string;
    attachments?: PromptAttachment[];
    author?: PromptAuthor;
    channelType?: string;
    channelId?: string;
  },
): Promise<{ sessionId: string; result: { info: OpenCodeMessageInfo; parts: unknown[] } | null }> {
  let currentSessionId = await this.ensureChannelOpenCodeSession(channel);
  currentSessionId = await this.resyncAdoptedSession(channel, currentSessionId);
  try {
    const result = await this.sendPromptSync(
      currentSessionId,
      content,
      options?.model,
      options?.attachments,
      options?.author,
      options?.channelType,
      options?.channelId,
    );
    return { sessionId: currentSessionId, result };
  } catch (err) {
    if (!this.isSessionGone(err)) {
      throw err;
    }
    console.warn("[PromptHandler] OpenCode session missing; recreating session and retrying prompt (sync)");
    const recreatedSessionId = await this.recreateChannelOpenCodeSession(channel);
    const result = await this.sendPromptSync(
      recreatedSessionId,
      content,
      options?.model,
      options?.attachments,
      options?.author,
      options?.channelType,
      options?.channelId,
    );
    return { sessionId: recreatedSessionId, result };
  }
}
```

**Step 3: Run typecheck**

Run: `cd packages/runner && pnpm typecheck`
Expected: PASS (new methods are private and unused — no callers yet)

**Step 4: Commit**

```bash
git add packages/runner/src/prompt.ts
git commit -m "feat: add sendPromptSync method for synchronous OpenCode prompts"
```

---

### Task 2: Extract shared prompt body builder

The body construction logic is duplicated between `sendPromptAsync` and `sendPromptSync`. Extract it to reduce duplication before wiring up the new flow.

**Files:**
- Modify: `packages/runner/src/prompt.ts`

**Step 1: Add `buildPromptBody` helper**

Add a private method near `sendPromptAsync` (~line 2404):

```typescript
private buildPromptBody(
  content: string,
  model?: string,
  attachments?: PromptAttachment[],
  author?: PromptAuthor,
  channelType?: string,
  channelId?: string,
): Record<string, unknown> {
  const promptParts: Array<Record<string, unknown>> = [];
  for (const attachment of attachments ?? []) {
    promptParts.push({
      type: "file",
      mime: attachment.mime,
      url: attachment.url,
      ...(attachment.filename ? { filename: attachment.filename } : {}),
    });
  }
  let attributedContent = content;
  if (channelType && channelId) {
    attributedContent = `[via ${channelType} | chatId: ${channelId}] ${attributedContent}`;
  }
  if (author?.authorName || author?.authorEmail) {
    const name = author.authorName || 'Unknown';
    const email = author.authorEmail ? ` <${author.authorEmail}>` : '';
    const userId = author.authorId ? ` (userId: ${author.authorId})` : '';
    attributedContent = `[User: ${name}${email}${userId}] ${attributedContent}`;
  }
  if (attributedContent) {
    promptParts.push({ type: "text", text: attributedContent });
  }
  if (promptParts.length === 0) {
    throw new Error("Cannot send empty prompt: no text or attachments");
  }
  const body: Record<string, unknown> = { parts: promptParts };
  if (model) {
    const slashIdx = model.indexOf("/");
    if (slashIdx !== -1) {
      body.model = { providerID: model.slice(0, slashIdx), modelID: model.slice(slashIdx + 1) };
    } else {
      body.model = { providerID: "", modelID: model };
    }
  }
  return body;
}
```

**Step 2: Refactor `sendPromptAsync` and `sendPromptSync` to use it**

Replace the duplicated body construction in both methods with:

```typescript
const body = this.buildPromptBody(content, model, attachments, author, channelType, channelId);
```

**Step 3: Run typecheck**

Run: `cd packages/runner && pnpm typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/runner/src/prompt.ts
git commit -m "refactor: extract buildPromptBody to deduplicate prompt construction"
```

---

### Task 3: Rewrite `handlePrompt` to use sync prompt with model failover loop

This is the core change. Replace the fire-and-forget pattern with a synchronous prompt loop that handles model failover inline.

**Files:**
- Modify: `packages/runner/src/prompt.ts` — rewrite `handlePrompt` (line ~1245)

**Step 1: Rewrite `handlePrompt`**

The new flow:
1. Prepare content, attachments, failover chain (same as before)
2. SSE stream stays running for real-time UI updates (text deltas, tool calls)
3. Loop over failover chain, calling `sendPromptSyncWithRecovery` for each model
4. When the sync call returns, extract the result from the HTTP response (authoritative)
5. Use SSE-streamed content if available (richer), fall back to sync response content
6. Finalize the turn

```typescript
async handlePrompt(messageId: string, content: string, model?: string, author?: { authorId?: string; gitName?: string; gitEmail?: string; authorName?: string; authorEmail?: string }, modelPreferences?: string[], attachments?: PromptAttachment[], channelType?: string, channelId?: string, opencodeSessionId?: string): Promise<void> {
  console.log(`[PromptHandler] Handling prompt ${messageId}: "${content.slice(0, 80)}"${model ? ` (model: ${model})` : ''}${author?.authorName ? ` (by: ${author.authorName})` : ''}${modelPreferences?.length ? ` (prefs: ${modelPreferences.length})` : ''}${attachments?.length ? ` (attachments: ${attachments.length})` : ''}${channelType ? ` (channel: ${channelType})` : ''}`);

  // Resolve per-channel session
  const channel = this.getOrCreateChannel(channelType, channelId);
  this.activeChannel = channel;
  this.applyPersistedOpenCodeSessionId(channel, opencodeSessionId);

  try {
    // Set git config for author attribution before processing
    if (author?.gitName || author?.authorName) {
      const name = author.gitName || author.authorName;
      const email = author.gitEmail || author.authorEmail;
      try {
        const nameProc = Bun.spawn(['git', 'config', '--global', 'user.name', name!]);
        await nameProc.exited;
        if (email) {
          const emailProc = Bun.spawn(['git', 'config', '--global', 'user.email', email]);
          await emailProc.exited;
        }
      } catch (err) {
        console.warn('[PromptHandler] Failed to set git config:', err);
      }
    }

    // If there's a pending response from a previous prompt on this channel, finalize it first
    if (channel.activeMessageId && channel.hasActivity) {
      console.log(`[PromptHandler] Finalizing previous response before new prompt`);
      this.finalizeResponse();
    }

    // Clear any pending timeout from previous prompt
    this.clearResponseTimeout();
    this.clearFirstResponseTimeout();

    // Ensure this channel has an OpenCode session and active SSE stream.
    await this.ensureChannelOpenCodeSession(channel);

    channel.activeMessageId = messageId;
    channel.resetPromptState();

    // Build failover chain with explicit model first (if provided), then user preferences.
    const failoverChain = this.buildModelFailoverChain(model, modelPreferences);

    // Transcribe audio attachments before sending to OpenCode
    let effectiveContent = content;
    let effectiveAttachments = attachments ?? [];
    const hasAudio = effectiveAttachments.some(a => a.mime.startsWith('audio/'));
    if (hasAudio) {
      let transcribed = false;
      try {
        const { transcriptions, remaining } = await this.transcribeAudioAttachments(effectiveAttachments);
        if (transcriptions.length > 0) {
          transcribed = true;
          const transcriptBlock = transcriptions.map(t => `[Transcribed voice note]\n${t}`).join('\n\n');
          effectiveContent = effectiveContent
            ? `${transcriptBlock}\n\n${effectiveContent}`
            : transcriptBlock;
          this.agentClient.sendAudioTranscript(messageId, transcriptions.join('\n\n'));
        }
        effectiveAttachments = remaining;
      } catch (err) {
        console.error('[PromptHandler] Failed to transcribe audio:', err);
      }
      effectiveAttachments = effectiveAttachments.filter(a => !a.mime.startsWith('audio/'));
      if (!transcribed && !effectiveContent?.trim()) {
        effectiveContent = '[The user sent a voice note but transcription is unavailable. Please ask them to type their message instead.]';
      }
    }

    // Store failover state for reference during SSE event handling
    this.currentModelPreferences = failoverChain.length > 0 ? failoverChain : undefined;
    this.currentModelIndex = 0;
    this.pendingRetryContent = effectiveContent;
    this.pendingRetryAttachments = effectiveAttachments;
    this.pendingRetryAuthor = author;

    // Notify client that agent is thinking
    this.agentClient.sendAgentStatus("thinking");

    // === Synchronous prompt loop with model failover ===
    const channelContext = this.extractChannelContext(channel);
    let lastError: string | null = null;

    for (let i = 0; i < failoverChain.length || i === 0; i++) {
      const currentModel = failoverChain[i];
      this.currentModelIndex = i;

      if (i > 0) {
        // Notify DO about model switch
        const fromModel = failoverChain[i - 1] || "default";
        this.agentClient.sendModelSwitched(messageId, fromModel, currentModel, lastError || "unknown");
        channel.resetForRetry();
        this.agentClient.sendAgentStatus("thinking");
      }

      console.log(`[PromptHandler] Sending sync prompt for ${messageId}${currentModel ? ` (model: ${currentModel})` : ''} [attempt ${i + 1}/${failoverChain.length || 1}]`);

      try {
        const { result } = await this.sendPromptSyncWithRecovery(channel, effectiveContent, {
          model: currentModel,
          attachments: effectiveAttachments,
          author,
          channelType: channelContext.channelType ?? channelType,
          channelId: channelContext.channelId ?? channelId,
        });

        // Sync call returned — this is the authoritative completion signal.
        // SSE may have already streamed content to the UI in parallel.
        console.log(`[PromptHandler] Sync prompt returned for ${messageId}`);

        // Extract result from the sync response
        const syncText = result ? this.extractAssistantTextFromMessageInfo(result.info as Record<string, unknown>) : null;
        const syncError = result?.info?.error ? openCodeErrorToMessage(result.info.error) : null;
        const syncFinish = result?.info && typeof (result.info as Record<string, unknown>).finish === "string"
          ? (result.info as Record<string, unknown>).finish as string
          : null;

        // Check for errors in the sync response
        if (syncError && isRetriableProviderError(syncError)) {
          lastError = syncError;
          console.log(`[PromptHandler] Retriable error from sync response: ${syncError}`);
          continue; // Try next model in failover chain
        }

        // Check for empty response (model returned nothing)
        if (!syncText && !syncError && !this.streamedContent && !this.hasActivity) {
          lastError = `Model ${currentModel || "unknown"} returned an empty response`;
          console.log(`[PromptHandler] Empty sync response — ${lastError}`);
          continue; // Try next model
        }

        // Success — finalize with whatever we have
        // Prefer SSE-streamed content (already sent as deltas) over sync response
        const finalContent = this.streamedContent || syncText;

        if (syncError) {
          // Non-retriable error
          this.lastError = syncError;
        }

        this.finalizeSyncResponse(messageId, finalContent, syncError, syncFinish);
        return;

      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (isRetriableProviderError(errorMsg)) {
          lastError = errorMsg;
          console.log(`[PromptHandler] Retriable exception on sync prompt: ${errorMsg}`);
          continue; // Try next model
        }
        // Non-retriable error — finalize with error
        console.error(`[PromptHandler] Non-retriable sync prompt error: ${errorMsg}`);
        this.ensureTurnCreated();
        this.agentClient.sendTurnFinalize(this.turnId!, "error", undefined, errorMsg);
        this.agentClient.sendComplete();
        this.agentClient.sendAgentStatus("idle");
        this.cleanupAfterFinalize();
        return;
      }
    }

    // All models exhausted
    const exhaustedError = this.buildFailoverExhaustedError(lastError || "The model did not respond.");
    console.log(`[PromptHandler] All models exhausted: ${exhaustedError}`);
    this.ensureTurnCreated();
    this.agentClient.sendTurnFinalize(this.turnId!, "error", undefined, exhaustedError);
    this.agentClient.sendComplete();
    this.agentClient.sendAgentStatus("idle");
    this.cleanupAfterFinalize();

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[PromptHandler] Error processing prompt:", errorMsg);
    this.agentClient.sendError(messageId, errorMsg);
    this.agentClient.sendComplete();
    this.agentClient.sendAgentStatus("idle");
  }
}
```

**Step 2: Add `finalizeSyncResponse` helper**

This replaces the complex `finalizeResponse` for the sync code path. Add near `finalizeResponse`:

```typescript
/**
 * Finalize a prompt that completed via the sync HTTP response.
 * SSE-streamed content has already been sent to the UI as deltas;
 * this method sends the turn finalization to the DO.
 */
private finalizeSyncResponse(
  messageId: string,
  content: string | null,
  error: string | null,
  finish: string | null,
): void {
  this.clearResponseTimeout();
  this.clearFirstResponseTimeout();

  if (error) {
    console.log(`[PromptHandler] Sync finalize error for ${messageId}: ${error}`);
    this.ensureTurnCreated();
    this.agentClient.sendTurnFinalize(this.turnId!, "error", undefined, error);
  } else if (content) {
    console.log(`[PromptHandler] Sync finalize success for ${messageId} (${content.length} chars)`);
    this.ensureTurnCreated();
    this.agentClient.sendTurnFinalize(this.turnId!, finish || "end_turn", content);
  } else if (this.toolStates.size > 0) {
    console.log(`[PromptHandler] Sync finalize tools-only for ${messageId}`);
    this.ensureTurnCreated();
    this.agentClient.sendTurnFinalize(this.turnId!, finish || "end_turn");
  } else {
    console.log(`[PromptHandler] Sync finalize empty for ${messageId}`);
    this.ensureTurnCreated();
    this.agentClient.sendTurnFinalize(this.turnId!, "error", undefined, "The model did not respond.");
  }

  // Flush stuck tools
  for (const [callID, { status, toolName }] of this.toolStates) {
    if (status === "pending" || status === "running") {
      this.agentClient.sendToolUpdate(this.turnId!, callID, toolName, "completed");
    }
  }

  this.agentClient.sendComplete();
  this.agentClient.sendAgentStatus("idle");

  // Usage report
  const usageChannel = this.activeChannel;
  if (usageChannel && usageChannel.usageEntries.size > 0 && usageChannel.turnId) {
    const entries = Array.from(usageChannel.usageEntries.entries()).map(
      ([ocMessageId, data]) => ({
        ocMessageId,
        model: data.model,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
      })
    );
    this.agentClient.sendUsageReport(usageChannel.turnId, entries);
    usageChannel.usageEntries.clear();
  }

  // Memory flush check
  const flushChannel = this.activeChannel;
  if (flushChannel && !flushChannel.memoryFlushInProgress) {
    flushChannel.turnCount++;
    this.checkAndTriggerMemoryFlush(flushChannel).catch(err =>
      console.warn("[PromptHandler] Memory flush check failed:", err)
    );
  }

  // Report files changed
  this.reportFilesChanged().catch((err) =>
    console.error("[PromptHandler] Error reporting files changed:", err)
  );

  this.cleanupAfterFinalize();
}
```

**Step 3: Add `cleanupAfterFinalize` helper**

Extract the state cleanup from `finalizeResponse` into a shared helper:

```typescript
private cleanupAfterFinalize(): void {
  this.streamedContent = "";
  this.hasActivity = false;
  this.hadToolSinceLastText = false;
  this.activeMessageId = null;
  this.lastChunkTime = 0;
  this.lastError = null;
  this.toolStates.clear();
  this.textPartSnapshots.clear();
  this.messageTextSnapshots.clear();
  this.messageRoles.clear();
  this.activeAssistantMessageIds.clear();
  this.latestAssistantTextSnapshot = "";
  this.recentEventTrace = [];
  this.awaitingAssistantForAttempt = false;
  this.turnCreated = false;
  this.turnId = null;
  this.currentModelPreferences = undefined;
  this.currentModelIndex = 0;
  this.pendingRetryContent = null;
  this.pendingRetryAttachments = [];
  this.pendingRetryAuthor = undefined;
  this.retryPending = false;
  this.finalizeInFlight = false;
  console.log(`[PromptHandler] Response finalized`);
}
```

**Step 4: Update `finalizeResponse` to use `cleanupAfterFinalize`**

Replace the duplicated cleanup block at the end of `finalizeResponse` (lines ~3400-3432) with a call to `this.cleanupAfterFinalize()`. The existing `finalizeResponse` is still needed for SSE-driven finalization paths (ephemeral sessions, `wait_for_event`, legacy callers).

**Step 5: Update `session.idle` handler to be no-op during sync prompts**

The `session.idle` SSE event handler (line ~2733) currently triggers `finalizeResponse()`. With sync prompts, finalization happens via the HTTP response. But we still need `session.idle` for:
- Ephemeral sessions (workflow agent steps)
- `wait_for_event` tool handling

Add a guard at the top of the `session.idle` handler:

```typescript
case "session.idle": {
  console.log(`[PromptHandler] session.idle (channel: ${eventChannel?.channelKey ?? 'unknown'}, activeMessageId: ${this.activeMessageId ? 'yes' : 'no'}, hasActivity: ${this.hasActivity})`);
  // With sync prompts, the main handlePrompt flow handles finalization via HTTP response.
  // session.idle is still used for: ephemeral sessions, wait_for_event, idle status notification.
  if (!this.idleNotified) {
    this.agentClient.sendAgentStatus("idle");
    this.idleNotified = true;
  }
  break;
}
```

**Step 6: Update `session.error` handler to just record the error**

The `session.error` handler (line ~2790) currently triggers model failover directly. With sync prompts, the error will surface in the sync response. Simplify to just record it:

```typescript
case "session.error": {
  const rawError = props.error ?? props.message ?? props.description;
  const errorMsg = openCodeErrorToMessage(rawError) ?? "Unknown agent error";
  console.error(`[PromptHandler] session.error: ${errorMsg}`);
  console.error(`[PromptHandler] session.error raw:`, JSON.stringify(props));
  // Record error — sync prompt response is authoritative for handling it
  this.lastError = errorMsg;
  this.hasActivity = true;
  break;
}
```

**Step 7: Run typecheck**

Run: `cd packages/runner && pnpm typecheck`
Expected: PASS

**Step 8: Commit**

```bash
git add packages/runner/src/prompt.ts
git commit -m "feat: rewrite handlePrompt to use sync prompt endpoint with inline failover"
```

---

### Task 4: Remove dead code from async prompt path

Now that `handlePrompt` uses sync, several methods and fields are only used by legacy paths (ephemeral sessions, workflows). Clean up code that's fully dead.

**Files:**
- Modify: `packages/runner/src/prompt.ts`

**Step 1: Remove `attemptModelFailover` method**

The method at line ~1389 is no longer called — failover is now inline in the `handlePrompt` loop. Delete it entirely.

**Step 2: Remove `recoverAssistantOutcomeFromApi` and `recoverAssistantTextOrError`**

Lines ~2031-2051. The sync response is authoritative — no recovery needed.

**Step 3: Remove `fetchAssistantMessageDetail`**

The method that fetches individual message details for recovery. Only called by `recoverAssistantOutcomeFromApi` which is now deleted.

**Step 4: Remove `startFirstResponseTimeout` and `clearFirstResponseTimeout`**

Lines ~3460-3512. The sync HTTP call has its own timeout (Bun's fetch timeout). No need for a separate timer.

**Step 5: Remove `firstResponseTimeoutId` field**

Line ~528. No longer needed.

**Step 6: Remove `FIRST_RESPONSE_TIMEOUT_MS` constant**

Line ~198. No longer needed.

**Step 7: Run typecheck**

Run: `cd packages/runner && pnpm typecheck`
Expected: PASS (verify no remaining references to deleted methods)

**Step 8: Commit**

```bash
git add packages/runner/src/prompt.ts
git commit -m "fix: remove dead async prompt recovery code replaced by sync approach"
```

---

### Task 5: Update `attemptModelFailover` callers in `wait_for_event` path

The `wait_for_event` tool handling in `handleToolPart` calls `finalizeResponse(true)` which is a force-finalize. Verify this path still works with the new code. Since `wait_for_event` aborts the OpenCode session, the sync `sendPromptSync` call will return (because `SessionPrompt.prompt()` → `loop()` exits when abort fires). The `finalizeSyncResponse` in the main `handlePrompt` loop will handle this correctly.

**Files:**
- Modify: `packages/runner/src/prompt.ts`

**Step 1: Verify `wait_for_event` handling**

Read the `wait_for_event` code path in `handleToolPart` (line ~3004). With sync prompts, when `wait_for_event` fires:
1. SSE handler sees the tool, sends `abort` to OpenCode
2. The abort causes `SessionPrompt.prompt()` to return
3. The sync HTTP response returns to `handlePrompt`
4. `handlePrompt` finalizes normally

The SSE-side `finalizeResponse(true)` call will now be a no-op (because `activeMessageId` will be cleared by the sync path). But there's a race: the SSE handler may try to finalize while the sync response is still being processed.

Add a flag `syncPromptInFlight` to prevent SSE-side finalization:

```typescript
// In ChannelSession class:
syncPromptInFlight = false;

// In handleToolPart wait_for_event handling, replace finalizeResponse(true) with:
if (!this.activeChannel?.syncPromptInFlight) {
  this.finalizeResponse(true);
}
// The abort will cause the sync call to return, and handlePrompt will finalize.
```

**Step 2: Set `syncPromptInFlight` in handlePrompt**

At the start of the sync loop:
```typescript
channel.syncPromptInFlight = true;
```

At cleanup (in `cleanupAfterFinalize`):
```typescript
if (this.activeChannel) this.activeChannel.syncPromptInFlight = false;
```

**Step 3: Add to `resetPromptState`, `resetForRetry`, `resetForAbort`**

Add `this.syncPromptInFlight = false;` to each reset method.

**Step 4: Run typecheck**

Run: `cd packages/runner && pnpm typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/runner/src/prompt.ts
git commit -m "fix: prevent SSE-side finalization race during sync prompt"
```

---

### Task 6: Manual smoke test

**Step 1: Deploy and test**

1. Build the runner: the runner runs in the sandbox, so test by deploying
2. Start a new session
3. Send "Hi" with various models (OpenAI, Anthropic, Google)
4. Verify: response arrives, no "model did not respond"
5. Verify: real-time streaming still works (text appears incrementally)
6. Verify: tool calls still display in the UI
7. Test model failover: use a known-bad model as primary with a good model as preference

**Step 2: Test abort**

1. Send a long prompt
2. Click stop/abort while agent is working
3. Verify: session returns to idle cleanly

**Step 3: Test channel sessions**

1. Send a message via Slack/Telegram channel
2. Verify: response arrives correctly
3. Verify: channel session isolation still works

**Step 4: Commit final state**

```bash
git add -A
git commit -m "bean: sync prompt endpoint to fix model-not-responding bug"
```

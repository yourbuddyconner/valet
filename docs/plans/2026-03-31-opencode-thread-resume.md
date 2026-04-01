# OpenCode Thread Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make orchestrator thread resume reuse persisted OpenCode sessions from the workspace volume, with prompt-based continuation only as a last-resort fallback.

**Architecture:** Pin OpenCode's SQLite database into `/workspace/.opencode/state/opencode.db` so session rows survive orchestrator hibernation/restore. Treat `session_threads.opencode_session_id` as the primary runtime binding for a Valet thread, have the runner adopt that persisted session on resume, and remove the separate “continue thread creates new thread” behavior in favor of resuming the existing thread.

**Tech Stack:** TypeScript, Bun, Cloudflare Worker + Durable Objects, Modal sandbox volumes, OpenCode HTTP API, Vitest

---

## File Structure

**Modify:**
- `docker/start.sh`
  Responsibility: export stable OpenCode persistence env vars before the runner starts.
- `packages/runner/src/opencode-manager.ts`
  Responsibility: spawn `opencode serve` with explicit environment that points persistence into `/workspace`.
- `packages/runner/src/prompt.ts`
  Responsibility: reuse/adopt persisted OpenCode sessions per thread, verify missing sessions, and unify resume behavior.
- `packages/runner/src/opencode-manager.test.ts`
  Responsibility: cover `OPENCODE_DB`/spawn env regression.
- `packages/worker/src/routes/threads.ts`
  Responsibility: stop creating a new thread for “continue”; return resume metadata for the same thread.
- `packages/worker/src/routes/threads.test.ts`
  Responsibility: verify “continue” resumes the same thread rather than minting a new one.
- `packages/client/src/routes/sessions/$sessionId/threads/$threadId.tsx`
  Responsibility: change “Continue Thread” navigation to reopen the existing thread in chat.
- `packages/client/src/components/chat/chat-container.tsx`
  Responsibility: honor resume search params for same-thread resume if needed.
- `packages/client/src/routes/sessions/$sessionId/index.tsx`
  Responsibility: accept any new search params used for same-thread resume.
- `docs/specs/sessions.md`
  Responsibility: document thread resume semantics and persisted OpenCode session reuse.
- `docs/specs/sandbox-runtime.md`
  Responsibility: document OpenCode DB placement under `/workspace` and the runner adoption path.

**Reuse without major changes:**
- `packages/worker/src/durable-objects/session-agent.ts`
  Responsibility: already persists `thread.created` / `opencodeSessionId` linkage.
- `packages/worker/src/lib/db/threads.ts`
  Responsibility: already stores `session_threads.opencode_session_id`.
- `packages/client/src/hooks/use-chat.ts`
  Responsibility: already loads historical thread messages for UI display.

## Task 1: Pin OpenCode SQLite Into The Workspace Volume

**Files:**
- Modify: `docker/start.sh`
- Modify: `packages/runner/src/opencode-manager.ts`
- Test: `packages/runner/src/opencode-manager.test.ts`

- [ ] **Step 1: Write the failing test**

Add a runner test that starts `OpenCodeManager`, inspects the spawn options, and asserts the child process environment includes `OPENCODE_DB=/workspace/.opencode/state/opencode.db`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/runner/src/opencode-manager.test.ts`
Expected: FAIL because the spawned OpenCode process does not currently set `OPENCODE_DB`.

- [ ] **Step 3: Write minimal implementation**

Update startup/spawn so:
- `/workspace/.opencode/state` exists before launch
- `opencode serve` gets `OPENCODE_DB=/workspace/.opencode/state/opencode.db`
- no existing auth/config paths regress

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/runner/src/opencode-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Run targeted verification**

Run: `pnpm --filter @valet/runner typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add docker/start.sh packages/runner/src/opencode-manager.ts packages/runner/src/opencode-manager.test.ts
git commit -m "Persist opencode db in workspace volume"
```

## Task 2: Reuse Persisted OpenCode Sessions When Resuming A Thread

**Files:**
- Modify: `packages/runner/src/prompt.ts`
- Test: `packages/runner/src/prompt.test.ts` or add a focused new test file if coverage is clearer

- [ ] **Step 1: Write the failing test**

Add a runner prompt test covering:
- thread has persisted `opencodeSessionId`
- runner restarts cold
- first prompt for `threadId` adopts the persisted OpenCode session instead of creating a new one

Also add a second test for:
- persisted `opencodeSessionId` is missing from OpenCode
- runner recreates the thread session once and updates the DO via `thread.created`

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/runner/src/prompt.test.ts`
Expected: FAIL because current logic only opportunistically adopts the session and still leaves “continue”/fallback paths divergent.

- [ ] **Step 3: Write minimal implementation**

In `PromptHandler`:
- make thread resume always prefer the stored `opencodeSessionId`
- verify `GET /session/:id` before first resumed prompt
- if missing, recreate the thread’s OpenCode session once and emit updated `thread.created`
- keep continuation prompt injection as fallback-only, behind the missing-session path

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/runner/src/prompt.test.ts`
Expected: PASS

- [ ] **Step 5: Run targeted verification**

Run: `pnpm --filter @valet/runner typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/runner/src/prompt.ts packages/runner/src/prompt.test.ts
git commit -m "Reuse persisted opencode sessions for thread resume"
```

## Task 3: Unify “Continue Thread” With Same-Thread Resume

**Files:**
- Modify: `packages/worker/src/routes/threads.ts`
- Modify: `packages/client/src/routes/sessions/$sessionId/threads/$threadId.tsx`
- Modify: `packages/client/src/components/chat/chat-container.tsx`
- Modify: `packages/client/src/routes/sessions/$sessionId/index.tsx`
- Test: `packages/worker/src/routes/threads.test.ts`

- [ ] **Step 1: Write the failing test**

Add a worker route test asserting `POST /api/sessions/:sessionId/threads/:threadId/continue` no longer creates a new thread row and instead returns the original thread ID with resume metadata.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/worker/src/routes/threads.test.ts`
Expected: FAIL because the route currently creates a new thread and returns it.

- [ ] **Step 3: Write minimal implementation**

Change the route/UI contract so:
- “Continue Thread” targets the same `threadId`
- navigation returns to `/sessions/:sessionId?threadId=<same-thread>`
- any continuation context is used only when the runner determines the thread cannot directly reuse its OpenCode session

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/worker/src/routes/threads.test.ts`
Expected: PASS

- [ ] **Step 5: Run client/worker verification**

Run: `pnpm --filter @valet/worker typecheck`
Expected: PASS

Run: `pnpm --filter @valet/client typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/routes/threads.ts packages/worker/src/routes/threads.test.ts packages/client/src/routes/sessions/\$sessionId/threads/\$threadId.tsx packages/client/src/components/chat/chat-container.tsx packages/client/src/routes/sessions/\$sessionId/index.tsx
git commit -m "Unify continue thread with same-thread resume"
```

## Task 4: Update Specs And Regression Coverage

**Files:**
- Modify: `docs/specs/sessions.md`
- Modify: `docs/specs/sandbox-runtime.md`

- [ ] **Step 1: Update specs**

Document:
- OpenCode DB location under `/workspace/.opencode/state/opencode.db`
- persisted `session_threads.opencode_session_id` as the primary resume binding
- same-thread resume semantics after orchestrator rotation/hibernation
- continuation-prompt injection as fallback-only

- [ ] **Step 2: Run verification**

Run: `pnpm --filter @valet/worker typecheck`
Expected: PASS

Run: `pnpm --filter @valet/runner typecheck`
Expected: PASS

Run: `pnpm vitest run packages/worker/src/routes/sessions.test.ts packages/worker/src/routes/threads.test.ts packages/runner/src/opencode-manager.test.ts packages/runner/src/prompt.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add docs/specs/sessions.md docs/specs/sandbox-runtime.md
git commit -m "Document persisted opencode thread resume"
```

## Task 5: End-To-End Validation

**Files:**
- Modify: none unless a bug is found

- [ ] **Step 1: Start local services**

Run: `make dev-all`
Expected: worker, runner container, and client start successfully

- [ ] **Step 2: Manual validation**

Verify this flow:
1. Create/use orchestrator thread
2. Send messages so thread gets an OpenCode session
3. Restart the runner / simulate orchestrator restore
4. Reopen old thread in UI
5. Send a new message in the same thread
6. Confirm the same OpenCode session is adopted when available, and no synthetic continuation message is injected on the happy path

- [ ] **Step 3: Fallback validation**

Force the persisted OpenCode session to be missing while keeping the workspace DB present.
Expected:
- same `threadId` is reused
- fallback recreate path runs once
- UI still shows the historical thread and accepts the new prompt

- [ ] **Step 4: Final verification**

Run: `pnpm --filter @valet/client typecheck`
Expected: PASS

Run: `pnpm --filter @valet/worker typecheck`
Expected: PASS

Run: `pnpm --filter @valet/runner typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git status
git add -A
git commit -m "Finish opencode-backed thread resume"
```

## Notes

- Avoid introducing a parallel “rehydrated thread” state machine in the DO unless runner-side session adoption proves insufficient.
- Keep `continuationContext` support temporarily for compatibility, but stop treating it as the primary resume mechanism.
- If a focused `threads.test.ts` or `prompt.test.ts` file does not exist yet, create one rather than overloading an unrelated test file.

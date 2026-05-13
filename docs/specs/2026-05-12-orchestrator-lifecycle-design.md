# Orchestrator Lifecycle Redesign

## Problem

The orchestrator lifecycle has three independent problems that compound:

1. **Session ID rotation on every restart.** Each restart creates a new session (`orchestrator:{userId}:{uuid}`), which means a new DO, channel binding migration, thread migration, and lost in-flight state. This was a holdover from before orchestrators existed.

2. **External restart triggers race.** Three independent systems detect dead orchestrators and restart them: a minutely cron job, message dispatch auto-restart, and slash commands. They share no locking, can race, and all go through `restartOrchestratorSession` which has only a weak D1-based TOCTOU guard.

3. **`sandbox_lost` terminates instead of recovering.** When the Runner WebSocket drops and doesn't reconnect within the 60-second grace period, the DO calls `handleStop('sandbox_lost')`, which terminates the session, clears the prompt queue, and destroys all in-flight state. External restart then creates an entirely new session. This is the actual root cause of orchestrators "randomly dying."

Auto-restart (cron, message-triggered, slash command) papers over all three problems without fixing any of them.

## Solution

Make the orchestrator DO stable and long-lived. One DO per user, keyed by `orchestrator:{userId}`, forever. The DO owns its sandbox lifecycle internally — spawn, hibernate, restore, recover — without creating new sessions. External callers ask the DO to "ensure it's running" via a single serialized endpoint, eliminating all races.

## Identity Model

Two layers:

- **Orchestrator identity** — D1 `orchestrator_identities` table. The user's configuration: name, handle, custom instructions, persona. Created during onboarding. Source of truth for "does this user have an orchestrator."

- **Orchestrator DO** — Cloudflare Durable Object keyed by `orchestrator:{userId}`. One per user, created lazily during onboarding. Manages its own sandbox lifecycle. Never destroyed (unless the user deletes their orchestrator).

The D1 `sessions` table has a single stable row with ID `orchestrator:{userId}`. This row is a projection of the DO's state — used for dashboard queries, access control, and status display. The DO is the source of truth.

### What Goes Away

- `restartOrchestratorSession` (creates new session, migrates bindings)
- Channel binding migration on restart
- Thread migration on restart
- `getOrchestratorSession` finding "the newest orchestrator session" — there's only one
- Session ID rotation for orchestrators

## State Machine

The DO tracks sandbox lifecycle state. Agent activity (busy, queued prompts) is orthogonal and already tracked by `PromptQueue` and `RunnerLink`.

### Lifecycle States

| State | Meaning |
|---|---|
| `stopped` | No sandbox. Initial state before first use. Once the orchestrator starts, it never returns to `stopped` — crash recovery goes through `recovering`, not `stopped`. |
| `starting` | Sandbox spawn requested to Modal. Prompts queue in the DO. |
| `waiting_runner` | Sandbox is up, waiting for Runner WebSocket + first `agentStatus: idle`. |
| `ready` | Runner connected and idle. Prompts can be dispatched. |
| `hibernating` | Idle timeout fired. Snapshotting sandbox before terminating compute. |
| `hibernated` | Snapshot saved, sandbox terminated. DO is dormant. Inbound prompt triggers restore. |
| `restoring` | Restoring sandbox from snapshot via Modal. |
| `recovering` | Sandbox died unexpectedly. Reverting in-flight prompts, about to spawn fresh. |
| `backoff` | Too many consecutive recovery failures. Retry timer active. |

### Transitions

```
stopped → starting → waiting_runner → ready
                                       ↓ (idle timeout)
                                  hibernating → hibernated
                                                    ↓ (prompt/wake)
                                               restoring → waiting_runner → ready

ready/waiting_runner → recovering (sandbox_lost, spawn failure)
recovering → starting (retry)
recovering → backoff (circuit breaker: 3 failures in 10 min)
backoff → starting (cooldown elapsed or manual retry)
```

### Changes From Current Model

| Current | New | Notes |
|---|---|---|
| `initializing` | `starting` + `waiting_runner` | Split: "spawning" vs "waiting for Runner" |
| `running` | `ready` | Means "ready to accept work," not "sandbox process exists" |
| `terminated` | Gone for orchestrators | Replaced by `recovering` → `starting` or `backoff` |
| `error` | `backoff` (recoverable) or `error` (config) | `error` reserved for truly unrecoverable config problems |
| `idle` (unused) | Removed | |

### `/stop` Slash Command

Interrupts the current agent turn and clears the prompt queue. Does NOT change sandbox lifecycle state. The sandbox stays in `ready`. This is "stop what you're doing," not "shut down."

## DO `ensureRunning` Endpoint

Single entry point for all "make sure this orchestrator is available" requests. Replaces the three independent external restart triggers.

### `POST /ensure-running`

| Current State | Action | Response |
|---|---|---|
| `ready` | No-op | `200 {status: 'ready'}` |
| `starting`, `waiting_runner`, `restoring` | No-op (already booting) | `202 {status: 'starting'}` |
| `recovering` | No-op (already recovering) | `202 {status: 'recovering'}` |
| `backoff` | Check cooldown. Elapsed → `starting`. Not elapsed → return retry timing. | `503 {status: 'backoff', retryAfterMs}` or `202` |
| `hibernated` | `performWake` (restore from snapshot) | `202 {status: 'restoring'}` |
| `stopped` | Spawn fresh sandbox | `202 {status: 'starting'}` |

The DO serializes all calls — no race between concurrent `ensureRunning` requests. This is the key advantage over the current external restart approach.

### `POST /refresh`

New DO endpoint for explicit "restart my sandbox." Terminates current sandbox, rotates runner token, spawns fresh. Used by the `/refresh` slash command. Today's version (`POST /stop` then `POST /start` from outside) is broken — `/start` requires a full JSON body that the slash command doesn't have.

## Sandbox Recovery

### Planned Shutdown (Hibernation)

Unchanged from today:
1. Idle timeout fires in alarm handler
2. Status → `hibernating`
3. Snapshot sandbox via Modal
4. Terminate sandbox compute
5. Status → `hibernated`
6. Inbound prompt → `performWake` → restore from snapshot → `waiting_runner` → `ready`

### Unplanned Death (`sandbox_lost`)

Today: `handleStop('sandbox_lost')` → terminate session → external restart creates new session.

New — DO-internal recovery:
1. Status → `recovering`
2. Revert any in-flight prompt from `processing` back to `queued`
3. Rotate runner token (stale Runners rejected by `upgradeRunner` on token mismatch)
4. Increment `sandboxGeneration`
5. Clear runner readiness state
6. Check circuit breaker (see below)
7. If circuit open → `backoff`. Otherwise → `starting` → spawn fresh sandbox
8. When new Runner connects and signals idle → `ready`, drain prompt queue, reset recovery counters

### Circuit Breaker

Tracks in DO storage:
- `recoveryAttemptCount` — consecutive failures without reaching healthy `ready`
- `lastRecoveryAt` — timestamp of last attempt
- `backoffUntil` — when next attempt is allowed
- `lastFailureReason` — why the last recovery failed

After 3 failures within 10 minutes:
- Status → `backoff`
- Exponential cooldown: 1 min, 5 min, 15 min cap
- DO writes a system message visible in the UI: "Orchestrator failed to start 3 times. Retrying at {time}. Last error: {reason}"
- `ensureRunning` during `backoff` returns `503 {status: 'backoff', retryAfterMs}`
- When cooldown elapses (checked via alarm or next `ensureRunning`), status → `starting`
- Counters reset after Runner reaches `ready` and stays healthy

## Caller Changes

### `dispatchOrchestratorPrompt`

```
1. Check orchestrator identity exists → if not, return 'not_configured'
2. sessionId = `orchestrator:{userId}`
3. Call DO /ensure-running
4. If 503 (backoff) → return {dispatched: false, reason: 'backoff', retryAfterMs}
5. Call DO /prompt (queues the prompt — DO drains when ready)
6. Return {dispatched: true}
```

No restart logic. No identity lookup for restart. No request URL concerns.

### Slash Commands

| Command | Behavior |
|---|---|
| `/start` | Call `ensureRunning`. Report: "already running" / "starting up..." / "in backoff, retrying at {time}" / "not configured" |
| `/status` | Call DO `/status`. Report sandbox lifecycle state, agent activity, sandbox ID. No restart. |
| `/stop` | Call DO `/prompt {interrupt: true}` + `/clear-queue`. Does NOT touch sandbox lifecycle. |
| `/clear` | Call DO `/clear-queue`. |
| `/refresh` | Call DO `/refresh`. "Restarting your orchestrator..." |
| `/sessions` | Call DO `/children`. |
| `/help` | List commands. |

### Slack/Telegram Message Handlers

`!result.dispatched` responses:

| Reason | Message |
|---|---|
| `not_configured` | "Your orchestrator is not configured. Set it up from the Valet dashboard." |
| `backoff` | "Your orchestrator is temporarily unavailable. Retrying at {time}." |
| `empty_prompt` | (silently ignore) |
| Other | "Failed to reach your orchestrator. Try again in a moment." |

### Cron Handler

Changes from "restart all dead orchestrators" to reconciliation-only:
- Find orchestrator sessions where D1 status disagrees with DO state
- Find sessions stuck in `starting` or `recovering` beyond expected timeouts
- Ping the DO's `ensureRunning` for stuck cases
- Log all inconsistencies at `console.error` with structured `[OrchestratorReconcile]` prefix for alerting
- Does NOT create new sessions or call `restartOrchestratorSession`

### WebSocket URL Problem

Disappears entirely. The DO stores the `spawnRequest` (including `doWsUrl`) from the original onboarding `/start` call. Every subsequent sandbox spawn reuses it. No more deriving the URL from request context, `FRONTEND_URL`, or `API_PUBLIC_URL`.

## Data Model Changes

### D1 `sessions` Table

The orchestrator's session row becomes stable:
- ID: `orchestrator:{userId}` (no UUID suffix)
- Created once during onboarding, never deleted
- `status` updated by the DO as a state projection
- `sandbox_id` updated on each spawn/restore
- No schema changes needed — existing columns accommodate this

### D1 Foreign Keys

`channel_bindings`, `channel_thread_mappings`, `session_threads` reference the stable session ID forever. No migration on restart.

### DO SQLite Storage

New fields via existing `getState`/`setState` pattern:

| Field | Type | Purpose |
|---|---|---|
| `recoveryAttemptCount` | int | Consecutive failures without reaching `ready` |
| `lastRecoveryAt` | timestamp | When recovery was last attempted |
| `backoffUntil` | timestamp | When next attempt is allowed |
| `lastFailureReason` | string | Why the last recovery failed |
| `sandboxGeneration` | int | Incremented on each spawn, used to reject stale Runners |

### Runner Token Rotation

The runner token lives in DO storage (`runnerLink.token`). Rotated on each sandbox spawn. Included in `spawnRequest` env vars sent to Modal. Stale Runners from a previous generation are rejected by `upgradeRunner` (token mismatch → 401).

### Sandbox ID in UI

The DO's `/status` response includes `sandboxId`. Surfaced in:
- Dashboard session details panel
- `/status` slash command response
- Allows users to share their sandbox ID for debugging

## Migration

### D1 Migration (SQL)

Numbered migration file, idempotent:

1. For each user with an orchestrator identity, find their newest active orchestrator session
2. Insert a session row with ID `orchestrator:{userId}` (copy relevant fields from source row)
3. Update `channel_bindings` to point to the stable ID
4. Update `channel_thread_mappings` to point to the stable ID
5. Update `session_threads` to point to the stable ID
6. Mark old rotated orchestrator sessions as `archived`

Skip users who already have a stable-ID row.

### Deployment

Code changes and migration deploy together (single `make deploy` release). Migrations run before the worker deploy — the system tolerates the brief window.

### In-Flight Sessions

Active sandboxes from the old model lose their DO (the old rotated-ID DO won't receive new prompts). The sandbox Runner will eventually disconnect, and the sandbox will idle-terminate. The new stable DO spawns a fresh sandbox on the next inbound message. Users may experience a brief interruption (~10-30s) during deploy. Acceptable since deploys are already disruptive.

### Rollback

- Old rotated session rows are archived, not deleted — unarchive to restore
- The stable DO is a new DO instance (different `idFromName` input) — old DOs still exist
- Revert code deploy, unarchive old sessions → system returns to rotation model

## `sandbox_lost` Recovery for All Session Types

The `sandbox_lost` recovery logic is shared between orchestrator and regular sessions. Both use the same code path: revert in-flight prompts, rotate runner token, increment generation, attempt up to 3 respawns. The only difference is the terminal behavior when the circuit breaker opens:

| | Orchestrator | Regular Session |
|---|---|---|
| Recovery attempts | 3 | 3 |
| Prompt requeue | Yes | Yes |
| Runner token rotation | Yes | Yes |
| On circuit breaker open | `backoff` (keeps retrying on cooldown) | `terminated` (gives up) |
| Error message | "Failed to start 3 times. Retrying at {time}." | "Your sandbox lost its connection and couldn't recover." |

This replaces the current `handleStop('sandbox_lost')` path for all sessions. Today, `sandbox_lost` immediately terminates the session and clears all in-flight state. The new behavior gives both session types a chance to recover transparently.

## Scope Boundary

The stable DO identity, `ensureRunning` endpoint, and hibernation lifecycle changes are orchestrator-only. The `sandbox_lost` recovery improvement applies to all session types. The `SessionAgentDO` class handles both — the recovery logic is shared, with the circuit breaker's terminal state gated on `isOrchestrator`.

### Not Covered

- Org-level orchestrator changes (same stable-DO pattern applies but is a separate effort)
- OpenCode agent internals (tool execution, model selection)
- Runner process management (OpenCode lifecycle within the sandbox)

/**
 * Bounded polling helper for `session` and `orchestrator` nodes that
 * use `wait.mode = "until_idle"`.
 *
 * Per spec §"Hibernation And Long-Running Waits", we poll the session's
 * status with exponential backoff (capped at 5min, total bounded by
 * timeout) rather than blocking on one long sleep. `getStatus` reads
 * the row from D1, which doesn't force-wake a hibernated session.
 */

import type { WorkflowStep } from 'cloudflare:workers';
import { getDb } from '../lib/drizzle.js';
import { getSession } from '../lib/db/sessions.js';
import type { Env } from '../env.js';

export interface PollUntilIdleOptions {
  sessionId: string;
  /** Unique key prefix for the polling step.do calls. */
  pollKey: string;
  /** Total time budget in ms. */
  timeoutMs: number;
  /** Optional initial interval (default 5s). */
  initialIntervalMs?: number;
  /** Optional maximum interval (default 5min). */
  maxIntervalMs?: number;
}

export interface PollThreadUntilIdleOptions extends PollUntilIdleOptions {
  threadId: string;
}

interface ThreadStatusPayload {
  status: 'idle' | 'working';
  queuedPrompts: number;
  processingPrompts: number;
}

// Defaults chosen to stay well under Cloudflare Workflows' per-instance
// step cap (~1024). For a 24h timeout: 30s initial × 2 ramp ramp ... up
// to 15min cap → ~5 ramp checks + ~95 capped checks = ~100 polls × 2
// step boundaries each = ~200 steps. Plus the outer node trace/exec
// boundaries, the whole long-wait workflow comfortably fits.
const DEFAULT_INITIAL_INTERVAL_MS = 30_000;
const DEFAULT_MAX_INTERVAL_MS = 15 * 60_000;

// Statuses that resolve the wait successfully. The real SessionStatus
// enum (packages/shared/src/types/index.ts) is:
//   initializing | running | idle | waiting_runner | recovering |
//   backoff | hibernating | hibernated | restoring | terminated |
//   archived | error
//
// Per spec §"Hibernation": the wait resolves on a terminal session
// state, including `terminated` (user cleanup, idle TTL, programmatic
// stop). `terminated` is the NORMAL end-of-life status; failing the
// workflow on it would be wrong.
const IDLE_STATUSES = new Set(['idle', 'hibernated', 'terminated']);
// archived + error are catastrophic — the session can't resume.
// We throw so downstream nodes don't have to defensively check.
const FAILED_STATUSES = new Set(['archived', 'error']);

/**
 * Poll the session's `status` column until it reaches a terminal value
 * or the timeout elapses. Returns the observed idle status.
 *
 * Throws when the session is deleted ('not_found') or reaches a failure
 * state (terminated / archived / error) — the workflow author should
 * not have to write `if status === 'idle' || status === 'terminated'`
 * to detect "the session went away".
 */
export async function pollSessionUntilIdle(
  env: Env,
  step: WorkflowStep,
  opts: PollUntilIdleOptions,
): Promise<string> {
  const initial = opts.initialIntervalMs ?? DEFAULT_INITIAL_INTERVAL_MS;
  const max = opts.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;

  let elapsed = 0;
  let tick = 0;
  let interval = initial;
  while (elapsed < opts.timeoutMs) {
    const stepName = `${opts.pollKey}:check:${tick}`;
    const status = await step.do(stepName, async () => {
      const db = getDb(env.DB);
      const session = await getSession(db, opts.sessionId);
      if (!session) return 'not_found';
      return session.status;
    });

    if (status === 'not_found') {
      throw new Error(`session ${opts.sessionId} no longer exists`);
    }
    if (FAILED_STATUSES.has(status)) {
      throw new Error(`session ${opts.sessionId} reached terminal failure state: ${status}`);
    }
    if (IDLE_STATUSES.has(status)) return status;

    const sleepMs = Math.min(interval, opts.timeoutMs - elapsed);
    if (sleepMs <= 0) break;
    await step.sleep(`${opts.pollKey}:sleep:${tick}`, sleepMs);
    elapsed += sleepMs;
    tick++;
    interval = Math.min(interval * 2, max);
  }

  return 'timed_out';
}

function readThreadStatusPayload(value: unknown): ThreadStatusPayload {
  if (!value || typeof value !== 'object') {
    throw new Error('thread status check returned an invalid payload');
  }
  const record = value as Record<string, unknown>;
  const queuedPrompts = typeof record.queuedPrompts === 'number' ? record.queuedPrompts : 0;
  const processingPrompts = typeof record.processingPrompts === 'number' ? record.processingPrompts : 0;
  const status = record.status === 'idle' || (queuedPrompts === 0 && processingPrompts === 0)
    ? 'idle'
    : 'working';
  return { status, queuedPrompts, processingPrompts };
}

/**
 * Poll a specific orchestrator thread until that thread has no queued or
 * processing prompts. This is intentionally narrower than session lifecycle
 * polling: orchestrator sessions are long-lived and usually remain `running`
 * after an automated workflow prompt completes.
 */
export async function pollThreadUntilIdle(
  env: Env,
  step: WorkflowStep,
  opts: PollThreadUntilIdleOptions,
): Promise<string> {
  const initial = opts.initialIntervalMs ?? DEFAULT_INITIAL_INTERVAL_MS;
  const max = opts.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;

  let elapsed = 0;
  let tick = 0;
  let interval = initial;
  while (elapsed < opts.timeoutMs) {
    const stepName = `${opts.pollKey}:check:${tick}`;
    const status = await step.do(stepName, async () => {
      const doId = env.SESSIONS.idFromName(opts.sessionId);
      const sessionDO = env.SESSIONS.get(doId);
      const res = await sessionDO.fetch(
        new Request(`http://do/thread-status?threadId=${encodeURIComponent(opts.threadId)}`),
      );
      if (!res.ok) {
        throw new Error(`thread status check failed for ${opts.threadId}: ${res.status}`);
      }
      return readThreadStatusPayload(await res.json());
    });

    if (status.status === 'idle') return status.status;

    const sleepMs = Math.min(interval, opts.timeoutMs - elapsed);
    if (sleepMs <= 0) break;
    await step.sleep(`${opts.pollKey}:sleep:${tick}`, sleepMs);
    elapsed += sleepMs;
    tick++;
    interval = Math.min(interval * 2, max);
  }

  return 'timed_out';
}

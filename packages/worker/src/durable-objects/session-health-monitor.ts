/**
 * SessionHealthMonitor — pure evaluator for session health watchdog conditions.
 *
 * Owns:
 * - All watchdog condition evaluation (stuck processing, stuck queue, idle queue, ready timeout, error safety-net)
 * - Recovery action and analytics event generation
 *
 * Does NOT own: executing recovery actions, broadcasting, alarm scheduling.
 * The DO calls check() and executes the returned actions.
 */

export interface HealthSnapshot {
  now: number;
  runnerConnected: boolean;
  runnerReady: boolean;
  runnerBusy: boolean;
  queuedCount: number;
  processingCount: number;
  /** OLDEST dispatched_at across all processing rows. Required so a wedged
   *  channel can be detected even while siblings keep firing fresh dispatches
   *  (using MAX would let newer activity mask the wedge indefinitely). */
  oldestProcessingDispatchedAt: number;
  /** messageId of the OLDEST processing row whose dispatched_at exceeds the
   *  stuck timeout, when one exists. Lets recovery actions target the
   *  specific wedged row instead of nuking all processing rows. */
  stuckProcessingMessageId: string | null;
  /** Earliest per-channel idle_queued_since (across all channels) so the
   *  watchdog deadline is set for the most stuck channel. */
  idleQueuedSince: number;
  /** channelKey whose idle_queued_since is the earliest, when armed. */
  idleQueuedChannelKey: string | null;
  /** Earliest per-channel error_safety_net_at (across all channels). */
  errorSafetyNetAt: number;
  /** channelKey whose error_safety_net_at is the earliest, when armed. */
  errorSafetyNetChannelKey: string | null;
  sessionStatus: string;
  runnerDisconnectedAt: number | null;
  runnerConnectedAt: number | null;
  sandboxWakeStartedAt: number;
}

/** Recovery actions carry the specific row/channel they target so the DO
 *  can act surgically. `revert_and_drain` reverts a single row; `force_complete`
 *  completes a specific messageId; `clear_safety_net` and `mark_not_busy`
 *  target one channelKey. */
export type RecoveryAction =
  | { type: 'revert_and_drain'; reason: string; messageId: string | null }
  | { type: 'drain_queue'; reason: string }
  | { type: 'force_complete'; reason: string; messageId: string | null; channelKey: string | null }
  | { type: 'mark_not_busy'; reason: string; channelKey: string | null }
  | { type: 'clear_safety_net'; reason: string; channelKey: string | null }
  | { type: 'perform_recovery'; reason: string }

export interface RecoveryEvent {
  eventType: 'session.recovery';
  cause: string;
  properties: Record<string, unknown>;
}

export interface RecoveryResult {
  actions: RecoveryAction[];
  events: RecoveryEvent[];
}

export const DISCONNECT_GRACE_MS = 5_000;
const STUCK_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_QUEUE_STUCK_TIMEOUT_MS = 60 * 1000;
const READY_TIMEOUT_MS = 2 * 60 * 1000;
export const SANDBOX_WAKE_TIMEOUT_MS = 3 * 60 * 1000;

export class SessionHealthMonitor {
  check(snapshot: HealthSnapshot): RecoveryResult {
    const actions: RecoveryAction[] = [];
    const events: RecoveryEvent[] = [];

    // Skip terminal/hibernated states — but allow 'running', 'hibernating',
    // 'restoring', 'initializing' so watchdogs still fire during transitions.
    const skip = new Set(['terminated', 'archived', 'error', 'hibernated']);
    if (skip.has(snapshot.sessionStatus)) {
      return { actions, events };
    }

    this.checkStuckProcessing(snapshot, actions, events);
    this.checkStuckQueue(snapshot, actions, events);
    this.checkErrorSafetyNet(snapshot, actions, events);
    this.checkIdleQueueStuck(snapshot, actions, events);
    this.checkReadyTimeout(snapshot, events);
    this.checkSandboxWakeTimeout(snapshot, actions, events);

    return { actions, events };
  }

  private buildProperties(snapshot: HealthSnapshot, extra?: Record<string, unknown>): Record<string, unknown> {
    return {
      runnerConnected: snapshot.runnerConnected,
      runnerReady: snapshot.runnerReady,
      runnerBusy: snapshot.runnerBusy,
      queuedCount: snapshot.queuedCount,
      processingCount: snapshot.processingCount,
      oldestProcessingDispatchedAt: snapshot.oldestProcessingDispatchedAt,
      sessionStatus: snapshot.sessionStatus,
      ...extra,
    };
  }

  private checkStuckProcessing(s: HealthSnapshot, actions: RecoveryAction[], events: RecoveryEvent[]): void {
    if (!s.runnerBusy) return;
    if (s.processingCount === 0) return;
    if (s.runnerConnected) return;
    // Don't revert during disconnect grace period — runner may reconnect
    if (s.runnerDisconnectedAt && (s.now - s.runnerDisconnectedAt) < DISCONNECT_GRACE_MS) return;
    if (!s.oldestProcessingDispatchedAt) return;
    const elapsed = s.now - s.oldestProcessingDispatchedAt;
    if (elapsed < STUCK_PROCESSING_TIMEOUT_MS) return;

    const reason = `Prompt stuck in processing for ${Math.round(elapsed / 1000)}s with no runner`;
    // Revert ONLY the wedged row; healthy concurrent in-flight rows stay
    // processing so they don't get re-dispatched as duplicates.
    actions.push({ type: 'revert_and_drain', reason, messageId: s.stuckProcessingMessageId });
    events.push({ eventType: 'session.recovery', cause: 'stuck_processing', properties: this.buildProperties(s, { staleDurationMs: elapsed, messageId: s.stuckProcessingMessageId }) });
  }

  private checkStuckQueue(s: HealthSnapshot, actions: RecoveryAction[], events: RecoveryEvent[]): void {
    if (!s.runnerBusy) return;
    if (s.processingCount > 0) return;
    if (s.queuedCount === 0) return;

    const reason = `runnerBusy=true with ${s.queuedCount} queued items but 0 processing`;
    // mark_not_busy carries no per-channel scope: there are no processing
    // rows, so no channel can be specifically "stuck busy" — this clears
    // the session-wide runnerBusy flag only. Per-channel busy flags will
    // be cleared by the DO's drain on reconnect.
    actions.push({ type: 'mark_not_busy', reason, channelKey: null });
    if (s.runnerConnected) {
      actions.push({ type: 'drain_queue', reason });
    }
    events.push({ eventType: 'session.recovery', cause: 'stuck_queue_busy_no_processing', properties: this.buildProperties(s) });
  }

  private checkErrorSafetyNet(s: HealthSnapshot, actions: RecoveryAction[], events: RecoveryEvent[]): void {
    if (!s.errorSafetyNetAt) return;
    if (s.now < s.errorSafetyNetAt) return;

    // Always clear the expired safety-net to prevent repeated events.
    // Both branches carry the specific channelKey so per-channel clear is
    // surgical — clearing all channels' nets en masse would corrupt sibling
    // channels that armed their own error safety nets independently.
    if (s.runnerBusy) {
      // Pass channelKey only. The DO looks up THIS channel's processing
      // row to decide which messageId to complete — using
      // stuckProcessingMessageId here would mis-target because that field
      // is gated on the 5-minute STUCK_PROCESSING_TIMEOUT_MS, but the
      // error safety net fires at 60s, so the two timers don't align.
      actions.push({
        type: 'force_complete',
        reason: 'Forced prompt complete after error safety-net timeout',
        messageId: null,
        channelKey: s.errorSafetyNetChannelKey,
      });
    } else {
      actions.push({
        type: 'clear_safety_net',
        reason: 'Cleared expired error safety-net (runner not busy)',
        channelKey: s.errorSafetyNetChannelKey,
      });
    }
    events.push({ eventType: 'session.recovery', cause: 'error_safety_net', properties: this.buildProperties(s, { errorSafetyNetAt: s.errorSafetyNetAt, errorSafetyNetChannelKey: s.errorSafetyNetChannelKey, staleDurationMs: s.now - s.errorSafetyNetAt }) });
  }

  private checkIdleQueueStuck(s: HealthSnapshot, actions: RecoveryAction[], events: RecoveryEvent[]): void {
    if (s.runnerBusy) return;
    if (s.queuedCount === 0) return;
    if (!s.runnerConnected) return;
    if (!s.idleQueuedSince) return;
    const elapsed = s.now - s.idleQueuedSince;
    if (elapsed < IDLE_QUEUE_STUCK_TIMEOUT_MS) return;

    const reason = `${s.queuedCount} items queued for ${Math.round(elapsed / 1000)}s with runner idle`;
    actions.push({ type: 'drain_queue', reason });
    events.push({ eventType: 'session.recovery', cause: 'idle_queue_stuck', properties: this.buildProperties(s, { staleDurationMs: elapsed, idleQueuedSince: s.idleQueuedSince }) });
  }

  private checkReadyTimeout(s: HealthSnapshot, events: RecoveryEvent[]): void {
    if (!s.runnerConnected) return;
    if (s.runnerReady) return;
    if (!s.runnerConnectedAt) return;
    const elapsed = s.now - s.runnerConnectedAt;
    if (elapsed < READY_TIMEOUT_MS) return;

    events.push({ eventType: 'session.recovery', cause: 'ready_timeout', properties: this.buildProperties(s, { staleDurationMs: elapsed, runnerConnectedAt: s.runnerConnectedAt }) });
  }

  private checkSandboxWakeTimeout(s: HealthSnapshot, actions: RecoveryAction[], events: RecoveryEvent[]): void {
    if (s.sessionStatus !== 'restoring' && s.sessionStatus !== 'waiting_runner') return;
    if (!s.sandboxWakeStartedAt) return;
    const elapsed = s.now - s.sandboxWakeStartedAt;
    if (elapsed < SANDBOX_WAKE_TIMEOUT_MS) return;

    const reason = `Sandbox wake stuck for ${Math.round(elapsed / 1000)}s in ${s.sessionStatus}`;
    actions.push({ type: 'perform_recovery', reason });
    events.push({ eventType: 'session.recovery', cause: 'sandbox_wake_timeout', properties: this.buildProperties(s, { staleDurationMs: elapsed, sandboxWakeStartedAt: s.sandboxWakeStartedAt }) });
  }
}

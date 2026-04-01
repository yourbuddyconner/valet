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
  lastDispatchedAt: number;
  idleQueuedSince: number;
  errorSafetyNetAt: number;
  sessionStatus: string;
  runnerDisconnectedAt: number | null;
  runnerConnectedAt: number | null;
}

export type RecoveryAction =
  | { type: 'revert_and_drain'; reason: string }
  | { type: 'drain_queue'; reason: string }
  | { type: 'force_complete'; reason: string }
  | { type: 'mark_not_busy'; reason: string }
  | { type: 'clear_safety_net'; reason: string }

export interface RecoveryEvent {
  eventType: 'session.recovery';
  cause: string;
  properties: Record<string, unknown>;
}

export interface RecoveryResult {
  actions: RecoveryAction[];
  events: RecoveryEvent[];
}

const STUCK_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_QUEUE_STUCK_TIMEOUT_MS = 60 * 1000;
const READY_TIMEOUT_MS = 2 * 60 * 1000;

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

    return { actions, events };
  }

  private buildProperties(snapshot: HealthSnapshot, extra?: Record<string, unknown>): Record<string, unknown> {
    return {
      runnerConnected: snapshot.runnerConnected,
      runnerReady: snapshot.runnerReady,
      runnerBusy: snapshot.runnerBusy,
      queuedCount: snapshot.queuedCount,
      processingCount: snapshot.processingCount,
      lastDispatchedAt: snapshot.lastDispatchedAt,
      sessionStatus: snapshot.sessionStatus,
      ...extra,
    };
  }

  private checkStuckProcessing(s: HealthSnapshot, actions: RecoveryAction[], events: RecoveryEvent[]): void {
    if (!s.runnerBusy) return;
    if (s.processingCount === 0) return;
    if (s.runnerConnected) return;
    if (!s.lastDispatchedAt) return;
    const elapsed = s.now - s.lastDispatchedAt;
    if (elapsed < STUCK_PROCESSING_TIMEOUT_MS) return;

    const reason = `Prompt stuck in processing for ${Math.round(elapsed / 1000)}s with no runner`;
    actions.push({ type: 'revert_and_drain', reason });
    events.push({ eventType: 'session.recovery', cause: 'stuck_processing', properties: this.buildProperties(s, { staleDurationMs: elapsed }) });
  }

  private checkStuckQueue(s: HealthSnapshot, actions: RecoveryAction[], events: RecoveryEvent[]): void {
    if (!s.runnerBusy) return;
    if (s.processingCount > 0) return;
    if (s.queuedCount === 0) return;

    const reason = `runnerBusy=true with ${s.queuedCount} queued items but 0 processing`;
    actions.push({ type: 'mark_not_busy', reason });
    if (s.runnerConnected) {
      actions.push({ type: 'drain_queue', reason });
    }
    events.push({ eventType: 'session.recovery', cause: 'stuck_queue_busy_no_processing', properties: this.buildProperties(s) });
  }

  private checkErrorSafetyNet(s: HealthSnapshot, actions: RecoveryAction[], events: RecoveryEvent[]): void {
    if (!s.errorSafetyNetAt) return;
    if (s.now < s.errorSafetyNetAt) return;

    // Always clear the expired safety-net to prevent repeated events.
    // force_complete also clears it, but when runner isn't busy we still
    // need the clear_safety_net action.
    if (s.runnerBusy) {
      actions.push({ type: 'force_complete', reason: 'Forced prompt complete after error safety-net timeout' });
    } else {
      actions.push({ type: 'clear_safety_net', reason: 'Cleared expired error safety-net (runner not busy)' });
    }
    events.push({ eventType: 'session.recovery', cause: 'error_safety_net', properties: this.buildProperties(s, { errorSafetyNetAt: s.errorSafetyNetAt, staleDurationMs: s.now - s.errorSafetyNetAt }) });
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
}

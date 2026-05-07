import { describe, it, expect } from 'vitest';
import { SessionHealthMonitor, type HealthSnapshot } from './session-health-monitor.js';

function baseSnapshot(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    now: Date.now(),
    runnerConnected: true,
    runnerReady: true,
    runnerBusy: false,
    queuedCount: 0,
    processingCount: 0,
    lastDispatchedAt: 0,
    idleQueuedSince: 0,
    errorSafetyNetAt: 0,
    sessionStatus: 'running',
    runnerDisconnectedAt: null,
    runnerConnectedAt: Date.now() - 10_000,
    ...overrides,
  };
}

describe('SessionHealthMonitor', () => {
  const monitor = new SessionHealthMonitor();

  it('returns nothing for a healthy session', () => {
    const result = monitor.check(baseSnapshot());
    expect(result.actions).toHaveLength(0);
    expect(result.events).toHaveLength(0);
  });

  it('returns nothing for terminal/hibernated sessions', () => {
    for (const sessionStatus of ['terminated', 'archived', 'error', 'hibernated']) {
      const result = monitor.check(baseSnapshot({ sessionStatus, queuedCount: 5, idleQueuedSince: 1 }));
      expect(result.actions).toHaveLength(0);
      expect(result.events).toHaveLength(0);
    }
  });

  it('still evaluates during hibernating/restoring/initializing', () => {
    const now = Date.now();
    for (const sessionStatus of ['hibernating', 'restoring', 'initializing']) {
      const result = monitor.check(baseSnapshot({
        sessionStatus,
        now,
        runnerBusy: false,
        runnerConnected: true,
        queuedCount: 2,
        idleQueuedSince: now - 65_000,
      }));
      expect(result.actions.length).toBeGreaterThan(0);
    }
  });

  describe('stuck processing', () => {
    it('reverts when processing is stuck and runner disconnected', () => {
      const now = Date.now();
      const result = monitor.check(baseSnapshot({ now, runnerBusy: true, runnerConnected: false, processingCount: 1, lastDispatchedAt: now - 6 * 60 * 1000 }));
      expect(result.actions).toEqual([{ type: 'revert_and_drain', reason: expect.stringContaining('stuck in processing') }]);
      expect(result.events[0].cause).toBe('stuck_processing');
    });

    it('does not fire when runner is connected', () => {
      const now = Date.now();
      const result = monitor.check(baseSnapshot({ now, runnerBusy: true, runnerConnected: true, processingCount: 1, lastDispatchedAt: now - 6 * 60 * 1000 }));
      expect(result.actions).toHaveLength(0);
    });

    it('does not fire before timeout', () => {
      const now = Date.now();
      const result = monitor.check(baseSnapshot({ now, runnerBusy: true, runnerConnected: false, processingCount: 1, lastDispatchedAt: now - 60 * 1000 }));
      expect(result.actions).toHaveLength(0);
    });

    it('does not fire during disconnect grace period', () => {
      const now = Date.now();
      const result = monitor.check(baseSnapshot({
        now,
        runnerBusy: true,
        runnerConnected: false,
        processingCount: 1,
        lastDispatchedAt: now - 6 * 60 * 1000,
        runnerDisconnectedAt: now - 3_000,
      }));
      expect(result.actions).toHaveLength(0);
    });
  });

  describe('stuck queue (busy, 0 processing)', () => {
    it('clears busy and drains when runner connected', () => {
      const result = monitor.check(baseSnapshot({ runnerBusy: true, runnerConnected: true, processingCount: 0, queuedCount: 3 }));
      expect(result.actions).toEqual([
        { type: 'mark_not_busy', reason: expect.any(String) },
        { type: 'drain_queue', reason: expect.any(String) },
      ]);
      expect(result.events[0].cause).toBe('stuck_queue_busy_no_processing');
    });

    it('clears busy without drain when runner disconnected', () => {
      const result = monitor.check(baseSnapshot({ runnerBusy: true, runnerConnected: false, processingCount: 0, queuedCount: 3 }));
      expect(result.actions).toEqual([{ type: 'mark_not_busy', reason: expect.any(String) }]);
    });
  });

  describe('error safety-net', () => {
    it('forces complete when expired and runner busy', () => {
      const now = Date.now();
      const result = monitor.check(baseSnapshot({ now, runnerBusy: true, errorSafetyNetAt: now - 1000 }));
      expect(result.actions).toEqual([{ type: 'force_complete', reason: expect.any(String) }]);
      expect(result.events[0].cause).toBe('error_safety_net');
    });

    it('clears safety-net and emits event when not busy', () => {
      const now = Date.now();
      const result = monitor.check(baseSnapshot({ now, runnerBusy: false, errorSafetyNetAt: now - 1000 }));
      expect(result.actions).toEqual([{ type: 'clear_safety_net', reason: expect.any(String) }]);
      expect(result.events[0].cause).toBe('error_safety_net');
    });

    it('does not fire before expiry', () => {
      const now = Date.now();
      const result = monitor.check(baseSnapshot({ now, runnerBusy: true, errorSafetyNetAt: now + 30_000 }));
      const safetyEvents = result.events.filter(e => e.cause === 'error_safety_net');
      expect(safetyEvents).toHaveLength(0);
    });
  });

  describe('idle queue stuck', () => {
    it('drains when queue idle for >60s with runner connected', () => {
      const now = Date.now();
      const result = monitor.check(baseSnapshot({ now, runnerBusy: false, runnerConnected: true, queuedCount: 2, idleQueuedSince: now - 65_000 }));
      expect(result.actions).toEqual([{ type: 'drain_queue', reason: expect.stringContaining('items queued') }]);
      expect(result.events[0].cause).toBe('idle_queue_stuck');
    });

    it('does not fire before 60s', () => {
      const now = Date.now();
      const result = monitor.check(baseSnapshot({ now, runnerBusy: false, runnerConnected: true, queuedCount: 2, idleQueuedSince: now - 30_000 }));
      expect(result.actions).toHaveLength(0);
    });

    it('does not fire when runner disconnected', () => {
      const now = Date.now();
      const result = monitor.check(baseSnapshot({ now, runnerBusy: false, runnerConnected: false, queuedCount: 2, idleQueuedSince: now - 65_000 }));
      expect(result.actions).toHaveLength(0);
    });

    it('does not fire when runnerBusy', () => {
      const now = Date.now();
      const result = monitor.check(baseSnapshot({ now, runnerBusy: true, runnerConnected: true, queuedCount: 2, idleQueuedSince: now - 65_000 }));
      const idleEvents = result.events.filter(e => e.cause === 'idle_queue_stuck');
      expect(idleEvents).toHaveLength(0);
    });
  });

  describe('ready timeout', () => {
    it('emits event when connected but not ready for >2min', () => {
      const now = Date.now();
      const result = monitor.check(baseSnapshot({ now, runnerConnected: true, runnerReady: false, runnerConnectedAt: now - 3 * 60 * 1000 }));
      expect(result.actions).toHaveLength(0);
      expect(result.events[0].cause).toBe('ready_timeout');
    });

    it('does not fire before 2min', () => {
      const now = Date.now();
      const result = monitor.check(baseSnapshot({ now, runnerConnected: true, runnerReady: false, runnerConnectedAt: now - 60_000 }));
      const readyEvents = result.events.filter(e => e.cause === 'ready_timeout');
      expect(readyEvents).toHaveLength(0);
    });

    it('does not fire when already ready', () => {
      const now = Date.now();
      const result = monitor.check(baseSnapshot({ now, runnerConnected: true, runnerReady: true, runnerConnectedAt: now - 3 * 60 * 1000 }));
      const readyEvents = result.events.filter(e => e.cause === 'ready_timeout');
      expect(readyEvents).toHaveLength(0);
    });
  });
});

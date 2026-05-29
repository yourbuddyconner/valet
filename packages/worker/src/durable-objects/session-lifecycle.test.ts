import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionLifecycle, SandboxAlreadyExitedError, SandboxSnapshotFailedError } from './session-lifecycle.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('SessionLifecycle.snapshotSandbox', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  function makeLifecycle() {
    const state = {
      sandboxId: 'sb-123',
      hibernateUrl: 'https://backend/hibernate',
    } as any;
    return new SessionLifecycle(state, {} as DurableObjectState);
  }

  it('maps 409 already-finished responses to SandboxAlreadyExitedError', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'sandbox_already_finished' }), { status: 409 }),
    );

    await expect(makeLifecycle().snapshotSandbox()).rejects.toBeInstanceOf(SandboxAlreadyExitedError);
  });

  it('surfaces backend snapshot failures with a distinct error message', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: 'snapshot_failed', message: 'Failed to create image' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(makeLifecycle().snapshotSandbox()).rejects.toThrow(
      'Snapshot failed: Failed to create image',
    );
  });

  it('maps Modal snapshot timeout 500 responses to snapshot failures', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        "modal-http: internal error: status Failure: ExecutionError('Timed out waiting for image to be created')\n",
        { status: 500, headers: { 'Content-Type': 'text/plain' } },
      ),
    );

    const snapshot = makeLifecycle().snapshotSandbox();

    await expect(snapshot).rejects.toBeInstanceOf(SandboxSnapshotFailedError);
    await expect(snapshot).rejects.toThrow(
      'Snapshot failed: Timed out waiting for image to be created',
    );
  });
});

describe('SessionLifecycle.scheduleAlarm', () => {
  it('clamps past deadlines to at least 30s in the future', () => {
    const setAlarm = vi.fn();
    const state = {
      idleTimeoutMs: 0,
      lastUserActivityAt: 0,
    } as any;
    const ctx = { storage: { setAlarm } } as unknown as DurableObjectState;
    const lifecycle = new SessionLifecycle(state, ctx);

    const pastDeadline = Date.now() - 60_000; // 1 minute ago
    lifecycle.scheduleAlarm([pastDeadline]);

    expect(setAlarm).toHaveBeenCalledTimes(1);
    const scheduledTime = setAlarm.mock.calls[0][0] as number;
    // Should be at least 29s in the future (allowing 1s for test execution)
    expect(scheduledTime).toBeGreaterThan(Date.now() + 29_000);
    expect(scheduledTime).toBeLessThanOrEqual(Date.now() + 31_000);
  });

  it('does not clamp future deadlines', () => {
    const setAlarm = vi.fn();
    const state = {
      idleTimeoutMs: 0,
      lastUserActivityAt: 0,
    } as any;
    const ctx = { storage: { setAlarm } } as unknown as DurableObjectState;
    const lifecycle = new SessionLifecycle(state, ctx);

    const futureDeadline = Date.now() + 120_000; // 2 minutes from now
    lifecycle.scheduleAlarm([futureDeadline]);

    expect(setAlarm).toHaveBeenCalledWith(futureDeadline);
  });
});

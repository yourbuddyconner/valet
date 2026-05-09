import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionLifecycle, SandboxAlreadyExitedError } from './session-lifecycle.js';

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
});

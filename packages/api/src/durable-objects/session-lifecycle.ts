/**
 * SessionLifecycle — pure HTTP interactions with the Modal backend
 * and timing/alarm logic extracted from SessionAgentDO.
 *
 * This class owns:
 * - Sandbox spawn / terminate / snapshot / restore (HTTP calls)
 * - Idle timeout detection
 * - Alarm scheduling (combining idle timeout with external deadlines)
 * - Running-time accumulation (markRunningStarted / flushActiveSeconds)
 * - Activity touch (lastUserActivityAt)
 */

import type { SessionState } from './session-state.js';

// ─── Error Types ──────────────────────────────────────────────────────────────

/** Thrown when a sandbox operation receives a 409 — sandbox already exited. */
export class SandboxAlreadyExitedError extends Error {
  constructor(message?: string) {
    super(message ?? 'Sandbox has already exited');
    this.name = 'SandboxAlreadyExitedError';
  }
}

/** Thrown when the backend cannot create a snapshot image for hibernation. */
export class SandboxSnapshotFailedError extends Error {
  constructor(message?: string) {
    super(message ?? 'Snapshot failed');
    this.name = 'SandboxSnapshotFailedError';
  }
}

// ─── Result Types ─────────────────────────────────────────────────────────────

export interface SpawnResult {
  sandboxId: string;
  tunnelUrls: Record<string, string>;
  durationMs: number;
}

export interface SnapshotResult {
  snapshotImageId: string;
}

export interface RestoreResult {
  sandboxId: string;
  tunnelUrls: Record<string, string>;
  durationMs: number;
}

// ─── SessionLifecycle ─────────────────────────────────────────────────────────

export class SessionLifecycle {
  private readonly state: SessionState;
  private readonly ctx: DurableObjectState;

  constructor(state: SessionState, ctx: DurableObjectState) {
    this.state = state;
    this.ctx = ctx;
  }

  // ─── Sandbox Operations (pure HTTP) ─────────────────────────────────

  /** Spawn a new sandbox via the Modal backend. */
  async spawnSandbox(
    backendUrl: string,
    spawnRequest: Record<string, unknown>,
  ): Promise<SpawnResult> {
    const start = Date.now();
    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spawnRequest),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Backend returned ${response.status}: ${err}`);
    }

    const result = await response.json() as {
      sandboxId: string;
      tunnelUrls: Record<string, string>;
    };

    return {
      sandboxId: result.sandboxId,
      tunnelUrls: result.tunnelUrls,
      durationMs: Date.now() - start,
    };
  }

  /** Terminate the current sandbox via the backend. Best-effort, never throws. */
  async terminateSandbox(): Promise<void> {
    const sandboxId = this.state.sandboxId;
    const terminateUrl = this.state.terminateUrl;
    if (!sandboxId || !terminateUrl) return;

    try {
      await fetch(terminateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxId }),
      });
    } catch (err) {
      console.error('Failed to terminate sandbox:', err);
    }
  }

  /**
   * Snapshot the current sandbox filesystem for hibernation.
   * Throws SandboxAlreadyExitedError on 409 so the caller can route
   * through proper termination instead.
   */
  async snapshotSandbox(): Promise<SnapshotResult> {
    const sandboxId = this.state.sandboxId;
    const hibernateUrl = this.state.hibernateUrl;

    if (!sandboxId || !hibernateUrl) {
      throw new Error('Cannot snapshot: missing sandboxId or hibernateUrl');
    }

    const response = await fetch(hibernateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sandboxId }),
    });

    if (response.status === 409) {
      throw new SandboxAlreadyExitedError();
    }

    if (response.status === 503) {
      let message = 'Snapshot failed';
      try {
        const body = await response.json() as { error?: string; message?: string };
        if (body.error === 'snapshot_failed') {
          message = body.message ? `Snapshot failed: ${body.message}` : message;
        }
      } catch {
        // Ignore parse failure and fall back to generic error below.
      }
      throw new SandboxSnapshotFailedError(message);
    }

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Backend returned ${response.status}: ${err}`);
    }

    const result = await response.json() as { snapshotImageId: string };
    return { snapshotImageId: result.snapshotImageId };
  }

  /** Restore a sandbox from a snapshot. */
  async restoreSandbox(): Promise<RestoreResult> {
    const snapshotImageId = this.state.snapshotImageId;
    const restoreUrl = this.state.restoreUrl;
    const spawnRequest = this.state.spawnRequest;

    if (!snapshotImageId || !restoreUrl || !spawnRequest) {
      throw new Error('Cannot restore: missing snapshotImageId, restoreUrl, or spawnRequest');
    }

    const start = Date.now();
    const response = await fetch(restoreUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...spawnRequest,
        snapshotImageId,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Backend returned ${response.status}: ${err}`);
    }

    const result = await response.json() as {
      sandboxId: string;
      tunnelUrls: Record<string, string>;
    };

    return {
      sandboxId: result.sandboxId,
      tunnelUrls: result.tunnelUrls,
      durationMs: Date.now() - start,
    };
  }

  // ─── Idle Timeout ───────────────────────────────────────────────────

  /** Returns true if the session has been idle long enough to hibernate. */
  checkIdleTimeout(): boolean {
    const status = this.state.status;
    const idleTimeoutMs = this.state.idleTimeoutMs;
    const lastActivity = this.state.lastUserActivityAt;

    if (status !== 'running' || !idleTimeoutMs || !lastActivity) {
      return false;
    }

    return Date.now() - lastActivity >= idleTimeoutMs;
  }

  /** Update last activity timestamp. */
  touchActivity(): void {
    this.state.lastUserActivityAt = Date.now();
  }

  // ─── Running-Time Tracking ─────────────────────────────────────────

  /** Record that the sandbox entered the 'running' state. */
  markRunningStarted(): void {
    this.state.runningStartedAt = Date.now();
  }

  /**
   * Compute elapsed active seconds since markRunningStarted() and reset
   * the marker. Returns 0 if no marker was set. The caller is responsible
   * for persisting the returned value to D1.
   */
  flushActiveSeconds(): number {
    const startMs = this.state.runningStartedAt;
    if (!startMs) return 0;

    const elapsed = Math.floor((Date.now() - startMs) / 1000);
    // Reset to now so we don't double-count on next flush
    this.state.runningStartedAt = Date.now();
    return elapsed;
  }

  /** Clear the running start marker (leaving running state permanently). */
  clearRunningStarted(): void {
    this.state.runningStartedAt = 0;
    this.state.sandboxWakeStartedAt = 0;
  }

  // ─── Alarm Scheduling ──────────────────────────────────────────────

  /**
   * Schedule the next alarm from a set of candidate deadlines.
   * Automatically includes the idle timeout deadline if configured.
   * Pass additional deadlines from subsystems (prompt expiry, followups, etc.).
   */
  scheduleAlarm(externalDeadlines: (number | null)[]): void {
    let earliest = Infinity;

    // Idle timeout deadline
    const idleTimeoutMs = this.state.idleTimeoutMs;
    const lastActivity = this.state.lastUserActivityAt;
    if (idleTimeoutMs > 0 && lastActivity > 0) {
      const idleDeadline = lastActivity + idleTimeoutMs;
      if (idleDeadline < earliest) earliest = idleDeadline;
    }

    // External deadlines from caller
    for (const deadline of externalDeadlines) {
      if (deadline != null && deadline > 0 && deadline < earliest) {
        earliest = deadline;
      }
    }

    if (earliest < Infinity) {
      this.ctx.storage.setAlarm(earliest);
    }
  }
}

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenCodeManager, type OpenCodeConfig } from "./opencode-manager.js";

// ─── Mock Subprocess ──────────────────────────────────────────────────────────

function createMockProcess(opts: { exitCode?: number; exitAfterMs?: number } = {}): {
  proc: any;
  triggerExit: (code: number) => void;
} {
  let exitResolve!: (code: number) => void;
  const exitPromise = new Promise<number>((r) => {
    exitResolve = r;
  });

  if (opts.exitAfterMs !== undefined) {
    setTimeout(() => exitResolve(opts.exitCode ?? 0), opts.exitAfterMs);
  }

  const proc = {
    exitCode: null as number | null,
    exited: exitPromise.then((code) => {
      proc.exitCode = code;
      return code;
    }),
    kill: vi.fn(),
    pid: Math.floor(Math.random() * 10000),
  };

  return {
    proc,
    triggerExit: (code: number) => {
      proc.exitCode = code;
      exitResolve(code);
    },
  };
}

// ─── Test Manager Factory ─────────────────────────────────────────────────────

/**
 * The fetchFn is used by both ensurePortFree (wants "Connection refused" = port free)
 * and checkHealth/waitForHealth (wants 200 = healthy). We track state via
 * `spawned` to know which phase we're in: before spawn → port check,
 * after spawn → health check.
 */
function createTestManager(
  opts: {
    healthyAfterPolls?: number;
    neverHealthy?: boolean;
    killTriggersExit?: boolean;
    crashDuringHealth?: boolean;
  } = {}
) {
  const {
    healthyAfterPolls = 1,
    neverHealthy = false,
    killTriggersExit = false,
    crashDuringHealth = false,
  } = opts;
  let healthPollCount = 0;
  let currentMock: ReturnType<typeof createMockProcess> | null = null;
  const spawnCalls: any[] = [];
  let spawned = false;

  const manager = new OpenCodeManager({
    workspaceDir: "/workspace",
    port: 4096,
    configSourceDir: "/opencode-config",
    authJsonPath: "/root/.local/share/opencode/auth.json",
    configWriter: { write: vi.fn() },
    spawnFn: (_cmd: string[], _opts: any) => {
      currentMock = createMockProcess();
      if (killTriggersExit) {
        const mock = currentMock;
        currentMock.proc.kill = vi.fn(() => {
          mock.triggerExit(143);
        });
      }
      if (crashDuringHealth) {
        // Process crashes shortly after spawn (during health poll phase)
        const mock = currentMock;
        setTimeout(() => mock.triggerExit(1), 5);
      }
      spawnCalls.push({ cmd: _cmd, opts: _opts });
      spawned = true;
      healthPollCount = 0;
      return currentMock.proc as any;
    },
    spawnSyncFn: () => ({ exitCode: 1 }), // fuser -k: nothing to kill
    fetchFn: async (_url: string) => {
      // Before spawn: ensurePortFree calls fetch to check if port is occupied.
      // We want "Connection refused" so it thinks port is free.
      if (!spawned) {
        throw new Error("Connection refused");
      }

      // After spawn: health checks
      if (neverHealthy) throw new Error("Connection refused");
      healthPollCount++;
      if (healthPollCount >= healthyAfterPolls) {
        return new Response("OK", { status: 200 });
      }
      throw new Error("Connection refused");
    },
  });

  return {
    manager,
    get currentMock() {
      return currentMock;
    },
    get spawnCalls() {
      return spawnCalls;
    },
    resetHealthPolls: () => {
      healthPollCount = 0;
      spawned = false;
    },
  };
}

// ─── Test Config ──────────────────────────────────────────────────────────────

const testConfig: OpenCodeConfig = {
  tools: {},
  providerKeys: { anthropic: "test-key" },
  instructions: [],
  isOrchestrator: false,
};

const testConfig2: OpenCodeConfig = {
  tools: {},
  providerKeys: { anthropic: "test-key" },
  instructions: ["extra instruction"],
  isOrchestrator: false,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("OpenCodeManager", () => {
  beforeEach(() => {
    // Speed up tests
    (OpenCodeManager as any).HEALTH_POLL_MS = 1;
    (OpenCodeManager as any).HEALTH_MAX_RETRIES = 10;
    (OpenCodeManager as any).BACKOFF_BASE_MS = 1;
    (OpenCodeManager as any).BACKOFF_MAX_MS = 5;
    (OpenCodeManager as any).CRASH_RESET_MS = 100;
  });

  afterEach(() => {
    // Restore defaults
    (OpenCodeManager as any).HEALTH_POLL_MS = 200;
    (OpenCodeManager as any).HEALTH_MAX_RETRIES = 150;
    (OpenCodeManager as any).BACKOFF_BASE_MS = 2000;
    (OpenCodeManager as any).BACKOFF_MAX_MS = 32_000;
    (OpenCodeManager as any).CRASH_RESET_MS = 60_000;
  });

  it("setDesiredConfig starts process and resolves when healthy", async () => {
    const { manager, spawnCalls } = createTestManager({ killTriggersExit: true });

    const result = await manager.setDesiredConfig(testConfig);

    expect(result.restarted).toBe(true);
    expect(manager.isHealthy()).toBe(true);
    expect(spawnCalls.length).toBe(1);

    await manager.shutdown();
  });

  it("same config returns restarted: false", async () => {
    const { manager, spawnCalls } = createTestManager({ killTriggersExit: true });

    await manager.setDesiredConfig(testConfig);
    const result = await manager.setDesiredConfig(testConfig);

    expect(result.restarted).toBe(false);
    expect(spawnCalls.length).toBe(1);

    await manager.shutdown();
  });

  it("new config kills process and restarts", async () => {
    const { manager, spawnCalls, resetHealthPolls } = createTestManager({
      killTriggersExit: true,
    });

    await manager.setDesiredConfig(testConfig);
    expect(spawnCalls.length).toBe(1);

    resetHealthPolls();
    const result = await manager.setDesiredConfig(testConfig2);

    expect(result.restarted).toBe(true);
    expect(spawnCalls.length).toBe(2);
    expect(manager.isHealthy()).toBe(true);

    await manager.shutdown();
  });

  it("shutdown stops process and resolves", async () => {
    const { manager } = createTestManager({ killTriggersExit: true });

    await manager.setDesiredConfig(testConfig);
    expect(manager.isHealthy()).toBe(true);

    await manager.shutdown();
    expect(manager.isHealthy()).toBe(false);
  });

  it("crash count increments and reaches fatal", async () => {
    // Process crashes during health checks AND health never succeeds
    const { manager } = createTestManager({
      neverHealthy: true,
      crashDuringHealth: true,
      killTriggersExit: true,
    });

    let fatalCalled = false;
    manager.onFatal(() => {
      fatalCalled = true;
    });

    let crashCount = 0;
    manager.onCrashed(() => {
      crashCount++;
    });

    // setDesiredConfig will reject when fatal state is entered — catch it
    manager.setDesiredConfig(testConfig).catch(() => {});

    await vi.waitFor(
      () => {
        expect(fatalCalled).toBe(true);
      },
      { timeout: 5000 }
    );

    expect(crashCount).toBeGreaterThan(0);

    // Shutdown signals the loop to exit. The dangling nextHealthy() promise
    // will never resolve, but that's expected — the manager is done.
    await manager.shutdown();
  });

  it("config change during backoff restarts immediately", async () => {
    let spawnCount = 0;
    let currentMock: ReturnType<typeof createMockProcess> | null = null;
    let spawned = false;

    const manager = new OpenCodeManager({
      workspaceDir: "/workspace",
      port: 4096,
      configSourceDir: "/opencode-config",
      authJsonPath: "/root/.local/share/opencode/auth.json",
      configWriter: { write: vi.fn() },
      spawnFn: (_cmd: string[], _opts: any) => {
        spawnCount++;
        currentMock = createMockProcess();
        // First spawn: crash shortly after spawn
        if (spawnCount === 1) {
          const mock = currentMock;
          setTimeout(() => mock.triggerExit(1), 5);
        }
        currentMock.proc.kill = vi.fn(() => {
          currentMock!.triggerExit(143);
        });
        spawned = true;
        return currentMock.proc as any;
      },
      spawnSyncFn: () => ({ exitCode: 1 }),
      fetchFn: async () => {
        // ensurePortFree: port is free
        if (!spawned) throw new Error("Connection refused");
        // First spawn's health checks always fail (process is crashing)
        if (spawnCount <= 1) {
          throw new Error("Connection refused");
        }
        // Second spawn: healthy immediately
        spawned = false; // reset for next ensurePortFree cycle
        return new Response("OK", { status: 200 });
      },
    });

    // Speed up but use a large backoff to prove it gets interrupted
    (OpenCodeManager as any).HEALTH_POLL_MS = 1;
    (OpenCodeManager as any).HEALTH_MAX_RETRIES = 10;
    (OpenCodeManager as any).BACKOFF_BASE_MS = 30_000;
    (OpenCodeManager as any).BACKOFF_MAX_MS = 60_000;
    (OpenCodeManager as any).CRASH_RESET_MS = 100;

    // Start with config A — will crash and enter backoff
    const configAPromise = manager.setDesiredConfig(testConfig);

    // Wait for the first spawn to crash
    await vi.waitFor(
      () => {
        expect(spawnCount).toBe(1);
      },
      { timeout: 2000 }
    );

    // Small delay to let crash be processed and backoff to start
    await new Promise((r) => setTimeout(r, 50));

    // Now change config — should interrupt backoff and restart immediately
    const configBPromise = manager.setDesiredConfig(testConfig2);

    // configB should resolve quickly (not waiting for 30s backoff)
    const result = await Promise.race([
      configBPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timed out — backoff was not interrupted")), 3000)
      ),
    ]);

    expect(result.restarted).toBe(true);
    expect(spawnCount).toBe(2);

    await manager.shutdown();
    await configAPromise.catch(() => {});
  });
});

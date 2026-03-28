# OpenCodeManager Redesign — Supervisor Loop

## Problem

The current `OpenCodeManager` has cascading failure modes:

1. **Two imperative restart paths race each other.** Auto-restart (crash recovery) and config-restart (`applyConfig`) can spawn processes concurrently. The "promise lock" serialization is fragile and hard to reason about.
2. **Health check can't distinguish old vs new process.** `waitForHealth` polls `localhost:4096/health`, which may be answered by a stale process still holding the port. This resets the crash counter, creating an infinite restart loop.
3. **Crash counter never increments.** Because `waitForHealth` resets `consecutiveCrashes = 0` on any successful health response, the counter is always 1 and the manager never gives up.
4. **Config writing is tangled with process lifecycle.** ~160 lines of filesystem I/O (auth.json, opencode.json, tools, skills, plugins) lives inside the manager class, making it hard to follow the actual lifecycle logic.
5. **No structural invariant for "one process at a time."** The invariant is enforced by checking scattered flags (`this.process`, `this.stopping`, `this.healthy`) in the right order. Missing a check causes concurrent spawns.

## Design

### Architecture

Split into two units:

```
┌─────────────────────┐     ┌──────────────────────┐
│  OpenCodeManager    │────▶│  OpenCodeConfigWriter │
│  (supervisor loop)  │     │  (pure filesystem I/O)│
└─────────────────────┘     └──────────────────────┘
```

**OpenCodeConfigWriter** — extracted from the current class. Takes a full `OpenCodeConfig` and writes auth.json, opencode.json, copies tools/skills/plugins. Stateless. Called by the manager before spawning.

**OpenCodeManager** — a supervisor loop that maintains a single OpenCode process. Modeled after classic Unix process supervisors (runit, supervisord). The loop is the only thing that starts or stops the process, which structurally prevents concurrent spawns.

### External API

```typescript
setDesiredConfig(config: OpenCodeConfig): Promise<{ restarted: boolean }>
shutdown(): Promise<void>
```

`setDesiredConfig` — "I want OpenCode running with this config." Returns a promise that resolves when the process is healthy with the requested config (or a newer one that superseded it). Returns `{ restarted: false }` if the config is unchanged. First call starts the loop; subsequent calls update the desired config and interrupt the current cycle.

`shutdown` — "I want OpenCode stopped." Returns a promise that resolves when the process is dead and the loop has exited.

There is no `start()` vs `applyConfig()` distinction. The first `setDesiredConfig()` IS the initial start. Subsequent calls are config updates. The manager doesn't know or care which is which.

### The Supervisor Loop

The core is a single async loop. It's the only code path that spawns a process, which makes the "one process at a time" invariant structural rather than discipline-based.

```typescript
private async runLoop(): Promise<void> {
  while (this.desired === 'up') {
    const config = this.desiredConfig!;

    // 1. Write config files
    this.configWriter.write(config);

    // 2. Kill anything on the port, then spawn
    await this.ensurePortFree();
    const proc = this.spawn(config);
    this.runningConfig = config;

    // 3. Wait for healthy
    const healthy = await this.waitForHealth(proc);
    if (!healthy) {
      // Spawn failed or was interrupted
      if (this.desired !== 'up') break;
      if (this.configChanged()) continue; // new config arrived, restart immediately
      this.crashCount++;
      if (this.crashCount > MAX_CRASHES) {
        this.enterFatal();
        await this.wake.promise; // block until new setDesiredConfig
        this.crashCount = 0;
        continue;
      }
      await Promise.race([sleep(this.backoffMs()), this.wake.promise]);
      continue;
    }

    // 4. Notify waiters that process is healthy
    this.resolveHealthyWaiters();
    this.lastHealthyAt = Date.now();

    // 5. Block until process exits
    await proc.exited;

    // 6. Process died — check why
    if (this.desired !== 'up') break; // intentional shutdown
    if (this.configChanged()) continue; // config changed, restart immediately (no backoff)

    // 7. Genuine crash — backoff and retry
    this.crashCount = (Date.now() - this.lastHealthyAt > CRASH_RESET_MS) ? 1 : this.crashCount + 1;
    if (this.crashCount > MAX_CRASHES) {
      this.enterFatal();
      await this.wake.promise;
      this.crashCount = 0;
      continue;
    }
    await Promise.race([sleep(this.backoffMs()), this.wake.promise]);
  }
}
```

The loop reads top-to-bottom as a lifecycle: write config → spawn → wait healthy → run → handle exit. Every branch either `continue`s (retry) or `break`s (shutdown). No state enum, no dispatch table.

### Interruption via Wake Signal

External events (`setDesiredConfig`, `shutdown`) need to interrupt the loop when it's blocked in a backoff sleep or waiting for a fatal recovery. This uses a resettable promise called `wake`:

```typescript
private wake = createDeferred();  // { promise, resolve }

private signal(): void {
  this.wake.resolve();
  this.wake = createDeferred(); // reset for next wait
}
```

Any `Promise.race([sleep(...), this.wake.promise])` in the loop resolves immediately when `signal()` is called. The loop then re-checks `this.desired` and `this.desiredConfig` to decide what to do.

`setDesiredConfig` and `shutdown` both call `signal()` after updating state:

```typescript
async setDesiredConfig(config: OpenCodeConfig): Promise<{ restarted: boolean }> {
  if (this.runningConfig && configsEqual(this.runningConfig, config)) {
    return { restarted: false };
  }

  this.desiredConfig = config;
  this.desired = 'up';

  if (!this.loopRunning) {
    this.loopPromise = this.runLoop();
    this.loopRunning = true;
  } else {
    this.killProcess();  // interrupt running process so loop restarts with new config
    this.signal();       // wake from backoff/fatal sleep
  }

  await this.nextHealthy();
  return { restarted: true };
}

async shutdown(): Promise<void> {
  this.desired = 'down';
  this.killProcess();
  this.signal();
  if (this.loopPromise) await this.loopPromise;
  this.loopRunning = false;
}
```

### Waiting for Healthy

`setDesiredConfig` needs to return a promise that resolves when the process is healthy. This uses a list of waiters:

```typescript
private healthyWaiters: Array<() => void> = [];

private nextHealthy(): Promise<void> {
  return new Promise(resolve => this.healthyWaiters.push(resolve));
}

private resolveHealthyWaiters(): void {
  const waiters = this.healthyWaiters;
  this.healthyWaiters = [];
  for (const resolve of waiters) resolve();
}
```

The loop calls `resolveHealthyWaiters()` at step 4 after the health check passes. Multiple concurrent `setDesiredConfig` callers all await `nextHealthy()` — they all resolve at the same time when the loop reaches the healthy state.

### Process Identity

Health checks verify the spawned process is still alive before trusting the `/health` response:

```typescript
private async checkHealth(proc: Subprocess): Promise<boolean> {
  // Is our process still alive?
  if (proc.exitCode !== null) return false;

  // Does the health endpoint respond?
  try {
    const res = await fetch(`http://localhost:${this.port}/health`);
    return res.ok;
  } catch {
    return false;
  }
}
```

The `proc` reference is passed from the loop — it's always the process we just spawned. If that process has exited but a stale process is answering on the port, we return false.

`waitForHealth` passes the process through and also checks `this.desired` each iteration so shutdown can interrupt it:

```typescript
private async waitForHealth(proc: Subprocess): Promise<boolean> {
  for (let i = 0; i < 150; i++) {
    if (this.desired !== 'up') return false;
    if (this.configChanged()) return false; // new config, abort and restart
    if (await this.checkHealth(proc)) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}
```

### Crash Counter

- Incremented when the process exits unexpectedly.
- Reset to 1 (not 0) if the process was healthy for >60 seconds before crashing — single crash after stable operation gets the minimum backoff.
- Never reset by health checks.
- When counter exceeds 5 → enter fatal state (loop blocks on `wake.promise`).
- A new `setDesiredConfig()` during fatal resets the counter to 0 and wakes the loop. This is intentional — new config is a new attempt.

### Port Cleanup

Before spawning, the manager kills anything on the port via `fuser -k <port>/tcp` and waits up to 3 seconds for it to free. This is defensive — in normal operation, `killProcess()` ensures our process is dead before the loop continues. Port cleanup handles orphaned processes from previous sandbox runs.

### Config Merging

Config merging (`mergeConfig`, `configsEqual`) moves to `bin.ts`. The manager receives fully-assembled configs. Its comparison is `JSON.stringify(desired) === JSON.stringify(current)`. The `configChanged()` helper in the loop checks whether `desiredConfig` differs from the config used for the current iteration.

### OpenCodeConfigWriter

Extracted as a standalone class:

```typescript
class OpenCodeConfigWriter {
  constructor(
    private workspaceDir: string,
    private configSourceDir: string,
    private authJsonPath: string,
  ) {}

  write(config: OpenCodeConfig): void {
    this.writeAuthJson(config);
    this.writeOpenCodeJson(config);
    this.copyToolsAndSkills(config);
  }
}
```

Contains all the filesystem logic currently in `writeConfigFiles()` and `copyToolsAndSkills()`. No process lifecycle awareness.

### bin.ts Integration

```typescript
// Before (two code paths):
await openCodeManager.start(initialConfig);
// ... later ...
const result = await openCodeManager.applyConfig(partialConfig);
if (result.restarted) {
  await promptHandler.handleOpenCodeRestarted();
}
agentClient.sendOpenCodeConfigApplied(true, result.restarted);

// After (one code path):
const result = await openCodeManager.setDesiredConfig(initialConfig);
// ... later ...
const merged = mergeOpenCodeConfig(currentConfig, partial);
const result = await openCodeManager.setDesiredConfig(merged);
if (result.restarted) {
  await promptHandler.handleOpenCodeRestarted();
}
agentClient.sendOpenCodeConfigApplied(true, result.restarted);
```

The `mergeOpenCodeConfig` helper lives in bin.ts or a shared util. bin.ts tracks `currentConfig` and does the merge before passing to the manager.

`shutdown()` replaces `stop()`:
```typescript
await openCodeManager.shutdown();
```

### Events

The manager emits events for observability:

```typescript
interface OpenCodeManagerEvents {
  'crashed': (code: number) => void; // process crashed, auto-restart pending
  'fatal': () => void;              // gave up restarting
}
```

Config-driven restarts are coordinated through the `setDesiredConfig()` return promise. Crash-recovery restarts don't need PromptHandler coordination — the SSE stream reconnects automatically when OpenCode comes back.

## Why Not a State Machine

A state machine (with states like idle/starting/running/crashed/fatal and a reconcile loop) was considered and rejected:

1. **Solves a problem we don't have.** State machines shine with many states and complex event-driven transitions. We have one process with two desired states (up or down).
2. **Concurrent spawn prevention is discipline-based, not structural.** The state machine prevents concurrent spawns by checking state before acting. The supervisor loop prevents them structurally — there's one spawn point in a sequential loop.
3. **Reconcile loop requires its own concurrency machinery.** A `reconciling`/`reconcileQueued` mutex, cancellable timers outside the loop, cancellation flags for health polling. The supervisor loop needs none of this — `Promise.race` and a wake signal handle all interruption.
4. **The backoff wait splits transition logic.** In the state machine, backoff is a timer that fires outside the reconcile loop, meaning state transitions happen in two places. In the supervisor loop, backoff is `await sleep()` inline — the loop reads top-to-bottom.

## Files Changed

| File | Change |
|---|---|
| `packages/runner/src/opencode-manager.ts` | Rewrite: supervisor loop |
| `packages/runner/src/opencode-config-writer.ts` | New: extracted config file I/O |
| `packages/runner/src/bin.ts` | Update call sites, move config merging here |

## What This Does NOT Change

- The OpenCode binary itself (`opencode serve --port 4096`)
- The DO ↔ Runner WebSocket protocol
- How config is delivered from the DO
- The PromptHandler or AgentClient
- The gateway or any other Runner subsystem

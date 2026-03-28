# OpenCodeManager Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the buggy imperative OpenCodeManager with a supervisor-loop design that structurally prevents concurrent spawns, properly tracks crash counts, and separates config I/O from process lifecycle.

**Architecture:** A single async loop is the only code path that spawns/stops the OpenCode process. External callers update desired state and signal the loop. Config file writing is extracted to a standalone class.

**Tech Stack:** TypeScript, Bun (Subprocess, spawn), Vitest for tests

**Spec:** `docs/specs/2026-03-25-opencode-manager-redesign-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/runner/src/opencode-config-writer.ts` | **New.** Pure filesystem I/O — writes auth.json, opencode.json, copies tools/skills/plugins |
| `packages/runner/src/opencode-manager.ts` | **Rewrite.** Supervisor loop + wake signal + healthy waiters. ~150 lines. |
| `packages/runner/src/bin.ts` | **Modify.** Update call sites, move config merging here, update shutdown handler |

---

### Task 1: Extract OpenCodeConfigWriter

Move all filesystem I/O out of OpenCodeManager into a standalone class. This is a pure extract — no behavior changes.

**Files:**
- Create: `packages/runner/src/opencode-config-writer.ts`
- Modify: `packages/runner/src/opencode-manager.ts`

- [ ] **Step 1: Create `opencode-config-writer.ts`**

Copy `writeConfigFiles()`, `copyToolsAndSkills()`, and `copyDirRecursive()` from `opencode-manager.ts` into a new class. The constructor takes `workspaceDir`, `configSourceDir`, and `authJsonPath`. One public method: `write(config)`.

```typescript
// packages/runner/src/opencode-config-writer.ts
import { existsSync, mkdirSync, readdirSync, copyFileSync, unlinkSync, writeFileSync, readFileSync, statSync, symlinkSync } from "fs";
import { join } from "path";
import type { OpenCodeConfig } from "./opencode-manager.js";

export class OpenCodeConfigWriter {
  constructor(
    private readonly workspaceDir: string,
    private readonly configSourceDir: string,
    private readonly authJsonPath: string,
  ) {}

  write(config: OpenCodeConfig): void {
    this.writeAuthJson(config);
    this.writeOpenCodeJson(config);
    this.copyToolsAndSkills(config);
  }

  // ... paste writeConfigFiles internals as writeAuthJson + writeOpenCodeJson
  // ... paste copyToolsAndSkills and copyDirRecursive as-is
}
```

The methods are a direct copy from the current `opencode-manager.ts:176-336`. No logic changes — just move.

- [ ] **Step 2: Update OpenCodeManager to use ConfigWriter**

Replace the `writeConfigFiles()` and `copyToolsAndSkills()` calls in `start()` with `this.configWriter.write(config)`. Remove the moved methods and all `fs` imports that are no longer needed. Add a `configWriter` field initialized in the constructor.

- [ ] **Step 3: Typecheck**

Run: `cd packages/runner && pnpm typecheck`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add packages/runner/src/opencode-config-writer.ts packages/runner/src/opencode-manager.ts
git commit -m "refactor: extract OpenCodeConfigWriter from OpenCodeManager"
```

---

### Task 2: Rewrite OpenCodeManager as Supervisor Loop

Replace the entire OpenCodeManager class with the supervisor loop design from the spec. This is the core change.

**Files:**
- Rewrite: `packages/runner/src/opencode-manager.ts`

- [ ] **Step 1: Write the new OpenCodeManager**

Replace the full contents of `opencode-manager.ts` with the supervisor loop implementation. Keep the existing type exports (`OpenCodeConfig`, `CustomProviderConfig`, `OpenCodeManagerOptions`) unchanged so bin.ts still compiles.

Key pieces (all from the spec):

**Deferred helper:**
```typescript
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
```

**Class fields:**
```typescript
export class OpenCodeManager {
  private desired: 'up' | 'down' = 'down';
  private desiredConfig: OpenCodeConfig | null = null;
  private runningConfig: OpenCodeConfig | null = null;
  private process: Subprocess | null = null;
  private loopRunning = false;
  private loopPromise: Promise<void> | null = null;
  private crashCount = 0;
  private lastHealthyAt = 0;
  private wake = createDeferred();
  private healthyWaiters: Array<() => void> = [];
  private readonly configWriter: OpenCodeConfigWriter;
  private readonly port: number;

  static readonly MAX_CRASHES = 5;
  static readonly CRASH_RESET_MS = 60_000;
  static readonly HEALTH_POLL_MS = 200;
  static readonly HEALTH_MAX_RETRIES = 150;
  static readonly BACKOFF_BASE_MS = 2000;
  static readonly BACKOFF_MAX_MS = 32_000;
}
```

**Public API — `setDesiredConfig` and `shutdown`** — exactly as in the spec's "Interruption via Wake Signal" section.

**`runLoop()`** — exactly as in the spec's "The Supervisor Loop" section.

**`killProcess()`:**
```typescript
private killProcess(): void {
  if (!this.process) return;
  try { this.process.kill("SIGTERM"); } catch {}
  // Don't await — the loop's `await proc.exited` handles this
}
```

**`ensurePortFree()`** — `fuser -k` then poll up to 15 attempts (3s).

**`spawn()`:**
```typescript
private spawn(): Subprocess {
  const proc = Bun.spawn(["opencode", "serve", "--port", String(this.port)], {
    cwd: this.workspaceDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  this.process = proc;
  return proc;
}
```

**`checkHealth(proc)` and `waitForHealth(proc)`** — exactly as in spec.

**`signal()`, `nextHealthy()`, `resolveHealthyWaiters()`** — exactly as in spec.

**`configChanged()`:**
```typescript
private configChanged(): boolean {
  return JSON.stringify(this.desiredConfig) !== JSON.stringify(this.runningConfig);
}
```

**`backoffMs()`:**
```typescript
private backoffMs(): number {
  return Math.min(
    OpenCodeManager.BACKOFF_BASE_MS * Math.pow(2, this.crashCount - 1),
    OpenCodeManager.BACKOFF_MAX_MS,
  );
}
```

**`enterFatal()` + events:**
```typescript
private fatalCallback?: () => void;
private crashCallback?: (code: number) => void;

onFatal(cb: () => void): void { this.fatalCallback = cb; }
onCrashed(cb: (code: number) => void): void { this.crashCallback = cb; }

private enterFatal(): void {
  console.error(`[OpenCodeManager] ${this.crashCount} consecutive crashes, entering fatal state`);
  this.fatalCallback?.();
}
```

**`isHealthy()` and `getUrl()`** — keep as-is for bin.ts compatibility.

- [ ] **Step 2: Typecheck**

Run: `cd packages/runner && pnpm typecheck`
Expected: errors in `bin.ts` (call sites changed). That's expected — we fix those in Task 3.

- [ ] **Step 3: Commit (WIP)**

```bash
git add packages/runner/src/opencode-manager.ts
git commit -m "wip: rewrite OpenCodeManager as supervisor loop"
```

---

### Task 3: Update bin.ts Call Sites

Update bin.ts to use the new `setDesiredConfig`/`shutdown` API and move config merging into bin.ts.

**Files:**
- Modify: `packages/runner/src/bin.ts`

- [ ] **Step 1: Add `mergeOpenCodeConfig` helper**

Add a standalone function near the top of bin.ts (after imports):

```typescript
function mergeOpenCodeConfig(
  current: OpenCodeConfig,
  partial: Partial<OpenCodeConfig>,
): OpenCodeConfig {
  return {
    tools: partial.tools !== undefined
      ? { ...current.tools, ...partial.tools }
      : { ...current.tools },
    providerKeys: partial.providerKeys !== undefined
      ? { ...current.providerKeys, ...partial.providerKeys }
      : { ...current.providerKeys },
    instructions: partial.instructions !== undefined
      ? partial.instructions
      : [...current.instructions],
    isOrchestrator: partial.isOrchestrator !== undefined
      ? partial.isOrchestrator
      : current.isOrchestrator,
    customProviders: partial.customProviders !== undefined
      ? partial.customProviders
      : current.customProviders,
  };
}

function configsEqual(a: OpenCodeConfig, b: OpenCodeConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
```

- [ ] **Step 2: Update initial start (lines ~539-544)**

Replace:
```typescript
await openCodeManager.start(initialConfig);
console.log(`[Runner] OpenCode URL: ${openCodeManager.getUrl()}`);
agentClient.sendOpenCodeConfigApplied(true, false);
```

With:
```typescript
await openCodeManager.setDesiredConfig(initialConfig);
console.log(`[Runner] OpenCode URL: ${openCodeManager.getUrl()}`);
agentClient.sendOpenCodeConfigApplied(true, false);
```

- [ ] **Step 3: Update config hot-reload handler (lines ~400-427)**

Replace the `onOpenCodeConfig` handler body (the non-first-config path) with:

```typescript
try {
  promptHandler.setProviderModelConfigs(config.customProviders, config.builtInProviderModelConfigs);
  await promptHandler.handleOpenCodeRestart();
  const merged = mergeOpenCodeConfig(currentConfig, config);
  const result = await openCodeManager.setDesiredConfig(merged);
  if (result.restarted) {
    currentConfig = merged;
    await promptHandler.handleOpenCodeRestarted();
  }
  agentClient.sendOpenCodeConfigApplied(true, result.restarted);
  agentClient.sendAgentStatus("idle");
} catch (err) {
  const errorMsg = err instanceof Error ? err.message : String(err);
  console.error("[Runner] Failed to apply opencode config:", errorMsg);
  agentClient.sendOpenCodeConfigApplied(false, false, errorMsg);
}
```

Add a `let currentConfig: OpenCodeConfig` variable initialized after the initial config is built (~line 516), tracking the running config.

- [ ] **Step 4: Update shutdown handler (lines ~471-477)**

Replace:
```typescript
await openCodeManager.stop();
```

With:
```typescript
await openCodeManager.shutdown();
```

Do this in both the SIGTERM/SIGINT handler and the `agentClient.onStop` handler (~line 341).

- [ ] **Step 5: Typecheck**

Run: `cd packages/runner && pnpm typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add packages/runner/src/bin.ts
git commit -m "feat: wire bin.ts to new OpenCodeManager supervisor API"
```

---

### Task 4: Write Tests for Supervisor Loop

Test the core lifecycle behaviors. The OpenCodeManager spawns `opencode serve`, which isn't available in test — so tests mock the process spawning.

**Files:**
- Create: `packages/runner/src/opencode-manager.test.ts`

- [ ] **Step 1: Write test helpers**

Create the test file with a mock setup that replaces `Bun.spawn` and `fetch` (for health checks):

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We'll test the logic by creating the manager with a mock configWriter
// and verifying the sequence of operations. Since the loop spawns a real
// process, tests should use dependency injection for the spawn function.
```

The manager should accept an optional `spawnFn` in options for testability. If not provided, defaults to `Bun.spawn`. Add this to the constructor options interface in opencode-manager.ts.

- [ ] **Step 2: Test — setDesiredConfig starts process and resolves when healthy**

```typescript
it("starts process and resolves when healthy", async () => {
  const manager = createTestManager({ healthyAfter: 2 }); // healthy on 2nd poll
  const result = await manager.setDesiredConfig(testConfig);
  expect(result.restarted).toBe(true);
  expect(manager.isHealthy()).toBe(true);
});
```

- [ ] **Step 3: Test — same config returns restarted: false**

```typescript
it("returns restarted: false for unchanged config", async () => {
  const manager = createTestManager({ healthyAfter: 1 });
  await manager.setDesiredConfig(testConfig);
  const result = await manager.setDesiredConfig(testConfig);
  expect(result.restarted).toBe(false);
});
```

- [ ] **Step 4: Test — new config restarts process**

```typescript
it("restarts process when config changes", async () => {
  const manager = createTestManager({ healthyAfter: 1 });
  await manager.setDesiredConfig(testConfig);
  const result = await manager.setDesiredConfig({ ...testConfig, instructions: ["new"] });
  expect(result.restarted).toBe(true);
});
```

- [ ] **Step 5: Test — shutdown stops process and resolves**

```typescript
it("shutdown stops process and resolves", async () => {
  const manager = createTestManager({ healthyAfter: 1 });
  await manager.setDesiredConfig(testConfig);
  await manager.shutdown();
  expect(manager.isHealthy()).toBe(false);
});
```

- [ ] **Step 6: Test — crash counter increments and reaches fatal**

```typescript
it("enters fatal state after MAX_CRASHES", async () => {
  let fatalCalled = false;
  const manager = createTestManager({ alwaysCrash: true });
  manager.onFatal(() => { fatalCalled = true; });
  // Don't await — it will block in fatal state
  const configPromise = manager.setDesiredConfig(testConfig);
  // Wait for fatal to be reached
  await vi.waitFor(() => expect(fatalCalled).toBe(true));
  // Cleanup
  await manager.shutdown();
});
```

- [ ] **Step 7: Run tests**

Run: `cd packages/runner && pnpm test`
Expected: all tests pass

- [ ] **Step 8: Commit**

```bash
git add packages/runner/src/opencode-manager.test.ts packages/runner/src/opencode-manager.ts
git commit -m "test: add supervisor loop tests for OpenCodeManager"
```

---

### Task 5: Squash WIP and Final Cleanup

Combine the WIP commit from Task 2 with the final state.

- [ ] **Step 1: Interactive rebase to squash the WIP commit**

Squash the "wip: rewrite OpenCodeManager" commit into the "feat: wire bin.ts" commit so the history is clean. Or if the user prefers, leave commits as-is.

- [ ] **Step 2: Final typecheck**

Run: `cd packages/runner && pnpm typecheck`
Expected: no errors

- [ ] **Step 3: Final test run**

Run: `cd packages/runner && pnpm test`
Expected: all pass

- [ ] **Step 4: Verify no regressions in other packages**

Run: `pnpm typecheck` (from root)
Expected: no errors (the runner's exports haven't changed shape)

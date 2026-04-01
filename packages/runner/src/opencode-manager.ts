/**
 * OpenCodeManager — supervisor loop for the OpenCode process.
 *
 * A single async runLoop() is the ONLY code path that spawns a process,
 * structurally preventing concurrent spawns. Wake signal pattern handles
 * interruption for config changes and shutdown.
 */

import { Subprocess } from "bun";
import { OpenCodeConfigWriter } from "./opencode-config-writer.js";

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export interface CustomProviderConfig {
  providerId: string;
  displayName: string;
  baseUrl: string;
  apiKey?: string;
  models: Array<{ id: string; name?: string; contextLimit?: number; outputLimit?: number }>;
  showAllModels?: boolean;
}

export interface OpenCodeConfig {
  tools: Record<string, boolean>;        // tool name → enabled/disabled
  providerKeys: Record<string, string>;  // "anthropic"|"openai"|"google" → key
  instructions: string[];                // extra instruction lines to append
  isOrchestrator: boolean;               // controls tool removal
  customProviders?: CustomProviderConfig[];
}

export interface OpenCodeManagerOptions {
  workspaceDir: string;
  port: number;
  configSourceDir: string; // /opencode-config
  authJsonPath: string;    // /root/.local/share/opencode/auth.json
  // Test injection points
  spawnFn?: (cmd: string[], opts: any) => Subprocess;
  spawnSyncFn?: (cmd: string[], opts: any) => { exitCode: number };
  fetchFn?: (url: string, opts?: RequestInit) => Promise<Response>;
  configWriter?: { write(config: OpenCodeConfig): void };
}

export class OpenCodeManager {
  // ─── Constants ──────────────────────────────────────────────────────
  static readonly MAX_CRASHES = 5;
  static readonly CRASH_RESET_MS = 60_000;
  static readonly HEALTH_POLL_MS = 200;
  static readonly HEALTH_MAX_RETRIES = 150;
  static readonly BACKOFF_BASE_MS = 2000;
  static readonly BACKOFF_MAX_MS = 32_000;
  static readonly KILL_GRACE_MS = 2000;
  static readonly FETCH_TIMEOUT_MS = 2000;

  // ─── State ──────────────────────────────────────────────────────────
  private desired: 'up' | 'down' = 'down';
  private desiredConfig: OpenCodeConfig | null = null;
  private runningConfig: OpenCodeConfig | null = null;
  private process: Subprocess | null = null;
  private loopRunning = false;
  private loopPromise: Promise<void> | null = null;
  private crashCount = 0;
  private lastHealthyAt = 0;
  private wake = createDeferred();
  private healthyWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  private readonly configWriter: { write(config: OpenCodeConfig): void };
  private readonly port: number;
  private readonly workspaceDir: string;
  private readonly spawnFn: (cmd: string[], opts: any) => Subprocess;
  private readonly spawnSyncFn: (cmd: string[], opts: any) => { exitCode: number };
  private readonly fetchFn: (url: string, opts?: RequestInit) => Promise<Response>;

  // Event callbacks
  private fatalCallback?: () => void;
  private crashCallback?: (code: number, crashCount: number, healthTimeout: boolean) => void;

  constructor(options: OpenCodeManagerOptions) {
    this.workspaceDir = options.workspaceDir;
    this.port = options.port;
    this.spawnFn = options.spawnFn ?? ((cmd, opts) => Bun.spawn(cmd, opts));
    this.spawnSyncFn = options.spawnSyncFn ?? ((cmd, opts) => Bun.spawnSync(cmd, opts));
    this.fetchFn = options.fetchFn ?? ((url, opts?) => fetch(url, opts));
    this.configWriter = options.configWriter ?? new OpenCodeConfigWriter({
      workspaceDir: options.workspaceDir,
      configSourceDir: options.configSourceDir,
      authJsonPath: options.authJsonPath,
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────

  async setDesiredConfig(config: OpenCodeConfig): Promise<{ restarted: boolean }> {
    if (this.runningConfig && JSON.stringify(this.runningConfig) === JSON.stringify(config)) {
      return { restarted: false };
    }

    this.desiredConfig = config;
    this.desired = 'up';

    if (!this.loopRunning) {
      this.loopRunning = true;
      this.loopPromise = this.runLoop().finally(() => { this.loopRunning = false; });
    } else {
      await this.killProcess();
      this.signal();
    }

    await this.nextHealthy(); // throws if fatal or shutdown
    return { restarted: true };
  }

  async shutdown(): Promise<void> {
    if (!this.loopRunning) return;
    this.desired = 'down';
    await this.killProcess();
    this.signal();
    if (this.loopPromise) await this.loopPromise;
  }

  onFatal(cb: () => void): void { this.fatalCallback = cb; }
  onCrashed(cb: (code: number, crashCount: number, healthTimeout: boolean) => void): void { this.crashCallback = cb; }

  isHealthy(): boolean {
    return this.process !== null && this.desired === 'up' && this.runningConfig !== null;
  }

  getUrl(): string {
    return `http://localhost:${this.port}`;
  }

  // ─── Supervisor Loop ───────────────────────────────────────────────

  private async runLoop(): Promise<void> {
    while (this.desired === 'up') {
      const config = this.desiredConfig!;

      // 1. Write config files
      this.configWriter.write(config);

      // 2. Kill anything on the port, then spawn
      await this.ensurePortFree();
      const proc = this.spawn();
      this.runningConfig = config;

      // 3. Wait for healthy
      const healthy = await this.waitForHealth(proc);
      if (!healthy) {
        if (this.desired !== 'up') break;
        if (this.configChanged()) continue;
        this.crashCount++;
        this.crashCallback?.(proc.exitCode ?? 1, this.crashCount, true);
        if (this.crashCount > OpenCodeManager.MAX_CRASHES) {
          this.enterFatal();
          await this.wake.promise;
          this.crashCount = 0;
          continue;
        }
        await Promise.race([sleep(this.backoffMs()), this.wake.promise]);
        continue;
      }

      // 4. Notify waiters
      this.resolveHealthyWaiters();
      this.lastHealthyAt = Date.now();

      // 5. Block until process exits OR wake signal (config change / shutdown).
      //    Re-evaluate on each wake: a stale signal (from a prior killProcess)
      //    might resolve the wake promise after the loop already moved on.
      //    Without this loop, the stale signal would cause an immediate kill
      //    of the new healthy process.
      while (proc.exitCode === null && this.desired === 'up' && !this.configChanged()) {
        await Promise.race([proc.exited, this.wake.promise]);
      }

      // Kill the process if it's still alive (config change or shutdown)
      if (proc.exitCode === null) {
        await this.killProcess();
      }

      // 6. Check why
      if (this.desired !== 'up') break;
      if (this.configChanged()) continue;

      // 7. Genuine crash
      const exitCode = proc.exitCode ?? 1;
      console.error(`[OpenCodeManager] OpenCode exited unexpectedly with code ${exitCode}`);
      this.crashCount = (Date.now() - this.lastHealthyAt > OpenCodeManager.CRASH_RESET_MS) ? 1 : this.crashCount + 1;
      this.crashCallback?.(exitCode, this.crashCount, false);
      if (this.crashCount > OpenCodeManager.MAX_CRASHES) {
        this.enterFatal();
        await this.wake.promise;
        this.crashCount = 0;
        continue;
      }
      await Promise.race([sleep(this.backoffMs()), this.wake.promise]);
    }

    // Loop exited — clean up
    this.process = null;
    this.runningConfig = null;
    this.rejectHealthyWaiters("OpenCode manager shut down");
  }

  // ─── Private Helpers ────────────────────────────────────────────────

  private signal(): void {
    this.wake.resolve();
    this.wake = createDeferred();
  }

  private nextHealthy(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.healthyWaiters.push({ resolve, reject });
    });
  }

  private resolveHealthyWaiters(): void {
    const waiters = this.healthyWaiters;
    this.healthyWaiters = [];
    for (const w of waiters) w.resolve();
  }

  private rejectHealthyWaiters(reason: string): void {
    const waiters = this.healthyWaiters;
    this.healthyWaiters = [];
    for (const w of waiters) w.reject(new Error(reason));
  }

  private configChanged(): boolean {
    return JSON.stringify(this.desiredConfig) !== JSON.stringify(this.runningConfig);
  }

  private backoffMs(): number {
    return Math.min(
      OpenCodeManager.BACKOFF_BASE_MS * Math.pow(2, this.crashCount - 1),
      OpenCodeManager.BACKOFF_MAX_MS,
    );
  }

  private enterFatal(): void {
    console.error(`[OpenCodeManager] ${this.crashCount} consecutive crashes, entering fatal state`);
    this.rejectHealthyWaiters("OpenCode entered fatal state after too many crashes");
    this.fatalCallback?.();
  }

  /** Send SIGTERM, escalate to SIGKILL after grace period, wait for exit. */
  private async killProcess(): Promise<void> {
    if (!this.process) return;
    const proc = this.process;

    try { proc.kill("SIGTERM"); } catch {}

    // Wait for graceful exit or escalate to SIGKILL
    const exited = await Promise.race([
      proc.exited.then(() => true as const),
      sleep(OpenCodeManager.KILL_GRACE_MS).then(() => false as const),
    ]);

    if (!exited && proc.exitCode === null) {
      console.log("[OpenCodeManager] Grace period expired, sending SIGKILL");
      try { proc.kill("SIGKILL"); } catch {}
      await proc.exited;
    }

    // Only null the reference if it still points to the process we killed.
    // The run loop may have already spawned a replacement via spawn().
    if (this.process === proc) {
      this.process = null;
    }
  }

  private spawn(): Subprocess {
    console.log(`[OpenCodeManager] Spawning opencode serve --port ${this.port} (cwd: ${this.workspaceDir})`);
    const opencodeDb = `${this.workspaceDir}/.opencode/state/opencode.db`;
    const proc = this.spawnFn(["opencode", "serve", "--port", String(this.port)], {
      cwd: this.workspaceDir,
      env: {
        ...process.env,
        OPENCODE_DB: opencodeDb,
      },
      stdout: "inherit",
      stderr: "inherit",
    });
    this.process = proc;
    return proc;
  }

  private async ensurePortFree(): Promise<void> {
    // SIGKILL anything listening on the port
    try {
      const proc = this.spawnSyncFn(["fuser", "-k", "-KILL", `${this.port}/tcp`], { stderr: "pipe" });
      if (proc.exitCode === 0) {
        console.log(`[OpenCodeManager] Killed process(es) on port ${this.port}`);
      }
    } catch {}

    const maxAttempts = 15;
    for (let i = 0; i < maxAttempts; i++) {
      if (!await this.isPortListening()) return;
      if (i === 0) console.log(`[OpenCodeManager] Waiting for port ${this.port} to free...`);
      await sleep(200);
    }
    console.warn(`[OpenCodeManager] Port ${this.port} still occupied after ${maxAttempts} attempts, proceeding anyway`);
  }

  /** Check if anything is listening on the port using a time-bounded fetch. */
  private async isPortListening(): Promise<boolean> {
    try {
      await this.fetchFn(`http://localhost:${this.port}/health`, {
        signal: AbortSignal.timeout(OpenCodeManager.FETCH_TIMEOUT_MS),
      });
      return true; // got a response → something is listening
    } catch {
      return false; // connection refused or timeout → port is free
    }
  }

  private async checkHealth(proc: Subprocess): Promise<boolean> {
    if (proc.exitCode !== null) return false;
    try {
      const res = await this.fetchFn(`http://localhost:${this.port}/health`, {
        signal: AbortSignal.timeout(OpenCodeManager.FETCH_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async waitForHealth(proc: Subprocess): Promise<boolean> {
    console.log("[OpenCodeManager] Waiting for OpenCode health...");
    for (let i = 0; i < OpenCodeManager.HEALTH_MAX_RETRIES; i++) {
      if (this.desired !== 'up') return false;
      if (this.configChanged()) return false;
      if (await this.checkHealth(proc)) {
        console.log("[OpenCodeManager] OpenCode is healthy");
        return true;
      }
      await sleep(OpenCodeManager.HEALTH_POLL_MS);
    }
    return false;
  }
}

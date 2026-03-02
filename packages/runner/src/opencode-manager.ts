/**
 * OpenCodeManager — process lifecycle manager for OpenCode.
 *
 * Replaces the OpenCode auth/config/start sections of start.sh.
 * The Runner owns the OpenCode process and can restart it to apply
 * config changes pushed from the SessionAgent DO over WebSocket.
 */

import { Subprocess } from "bun";
import { existsSync, mkdirSync, readdirSync, copyFileSync, unlinkSync, writeFileSync, readFileSync, statSync, symlinkSync } from "fs";
import { join, basename } from "path";

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

interface OpenCodeManagerOptions {
  workspaceDir: string;
  port: number;
  configSourceDir: string; // /opencode-config
  authJsonPath: string;    // /root/.local/share/opencode/auth.json
}

export class OpenCodeManager {
  private process: Subprocess | null = null;
  private currentConfig: OpenCodeConfig | null = null;
  private healthy = false;
  private stopping = false;
  private configLock: Promise<void> = Promise.resolve();
  private configApplyCounter = 0;

  private readonly workspaceDir: string;
  private readonly port: number;
  private readonly configSourceDir: string;
  private readonly authJsonPath: string;

  constructor(options: OpenCodeManagerOptions) {
    this.workspaceDir = options.workspaceDir;
    this.port = options.port;
    this.configSourceDir = options.configSourceDir;
    this.authJsonPath = options.authJsonPath;
  }

  /**
   * Write config files, copy tools/skills, spawn OpenCode, wait for health.
   */
  async start(config: OpenCodeConfig): Promise<void> {
    this.currentConfig = config;
    this.stopping = false;

    this.writeConfigFiles(config);
    this.copyToolsAndSkills(config);
    await this.spawnProcess();
    await this.waitForHealth();

    console.log("[OpenCodeManager] OpenCode started and healthy");
  }

  /**
   * Gracefully stop OpenCode: SIGTERM → grace period → SIGKILL.
   */
  async stop(): Promise<void> {
    if (!this.process) return;
    this.stopping = true;
    this.healthy = false;

    const proc = this.process;
    this.process = null;

    console.log("[OpenCodeManager] Stopping OpenCode");

    try {
      proc.kill("SIGTERM");
    } catch {
      // Process may already be dead
    }

    // Wait up to 5s for graceful exit, then SIGKILL
    const exited = await Promise.race([
      proc.exited,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);

    if (exited === null) {
      console.log("[OpenCodeManager] Grace period expired, sending SIGKILL");
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      await proc.exited;
    }

    console.log("[OpenCodeManager] OpenCode stopped");
  }

  /**
   * Stop then start with new config. Serialized via promise lock.
   */
  async restart(config: OpenCodeConfig): Promise<void> {
    console.log("[OpenCodeManager] Restarting OpenCode with new config");
    await this.stop();
    await this.start(config);
  }

  /**
   * Merge partial config with current config. If anything changed, restart.
   * Returns whether a restart actually occurred.
   */
  applyConfig(partial: Partial<OpenCodeConfig>): Promise<{ restarted: boolean }> {
    const myNonce = ++this.configApplyCounter;

    const next = this.configLock.then(async () => {
      // If a newer applyConfig was queued behind us, skip — it has more recent config
      if (myNonce < this.configApplyCounter) {
        console.log("[OpenCodeManager] Skipping superseded config apply");
        return { restarted: false };
      }

      if (!this.currentConfig) {
        console.warn("[OpenCodeManager] applyConfig called before start, ignoring");
        return { restarted: false };
      }

      const merged = this.mergeConfig(this.currentConfig, partial);
      if (this.configsEqual(this.currentConfig, merged)) {
        console.log("[OpenCodeManager] Config unchanged, no restart needed");
        return { restarted: false };
      }

      await this.restart(merged);
      return { restarted: true };
    });

    // Chain for serialization
    this.configLock = next.then(() => {});
    return next;
  }

  isHealthy(): boolean {
    return this.healthy && this.process !== null;
  }

  getUrl(): string {
    return `http://localhost:${this.port}`;
  }

  // ─── Config File Writing ────────────────────────────────────────────

  private writeConfigFiles(config: OpenCodeConfig): void {
    // Write auth.json
    const authDir = join(this.authJsonPath, "..");
    if (!existsSync(authDir)) {
      mkdirSync(authDir, { recursive: true });
    }

    const authJson: Record<string, { type: string; key: string }> = {};
    for (const [provider, key] of Object.entries(config.providerKeys)) {
      if (key) {
        authJson[provider] = { type: "api", key };
      }
    }

    // Add custom provider keys to auth.json
    if (config.customProviders) {
      for (const cp of config.customProviders) {
        if (cp.apiKey) {
          authJson[cp.providerId] = { type: "api", key: cp.apiKey };
        }
      }
    }

    writeFileSync(this.authJsonPath, JSON.stringify(authJson, null, 2), { mode: 0o600 });
    console.log(`[OpenCodeManager] Wrote auth.json with ${Object.keys(authJson).length} provider(s)`);

    // Write opencode.json
    const opencodeDir = join(this.workspaceDir, ".opencode");
    if (!existsSync(opencodeDir)) {
      mkdirSync(opencodeDir, { recursive: true });
    }

    const baseConfigPath = join(this.configSourceDir, "opencode.json");
    let opencodeConfig: Record<string, unknown> = {};
    if (existsSync(baseConfigPath)) {
      opencodeConfig = JSON.parse(readFileSync(baseConfigPath, "utf-8"));
    }

    // Merge tool enable/disable settings
    if (Object.keys(config.tools).length > 0) {
      const existingTools = (opencodeConfig.tools as Record<string, unknown>) || {};
      opencodeConfig.tools = { ...existingTools, ...config.tools };
    }

    // Append instructions
    if (config.instructions.length > 0) {
      const existingInstructions = typeof opencodeConfig.instructions === "string"
        ? opencodeConfig.instructions
        : "";
      opencodeConfig.instructions = existingInstructions + "\n" + config.instructions.join("\n");
    }

    // Add custom providers to opencode.json provider block
    if (config.customProviders && config.customProviders.length > 0) {
      const providerBlock = (opencodeConfig.provider as Record<string, unknown>) || {};
      for (const cp of config.customProviders) {
        const models: Record<string, { name?: string; limit?: { context?: number; output?: number } }> = {};
        for (const m of cp.models) {
          const modelEntry: { name?: string; limit?: { context?: number; output?: number } } = {};
          if (m.name) modelEntry.name = m.name;
          if (m.contextLimit || m.outputLimit) {
            modelEntry.limit = {};
            if (m.contextLimit) modelEntry.limit.context = m.contextLimit;
            if (m.outputLimit) modelEntry.limit.output = m.outputLimit;
          }
          models[m.id] = modelEntry;
        }
        providerBlock[cp.providerId] = {
          npm: "@ai-sdk/openai-compatible",
          name: cp.displayName,
          options: { baseURL: cp.baseUrl },
          models,
        };
      }
      opencodeConfig.provider = providerBlock;
      console.log(`[OpenCodeManager] Added ${config.customProviders.length} custom provider(s) to opencode.json`);
    }

    writeFileSync(
      join(opencodeDir, "opencode.json"),
      JSON.stringify(opencodeConfig, null, 2),
    );
    console.log("[OpenCodeManager] Wrote opencode.json");
  }

  private copyToolsAndSkills(config: OpenCodeConfig): void {
    const toolsDir = join(this.workspaceDir, ".opencode", "tools");
    if (!existsSync(toolsDir)) {
      mkdirSync(toolsDir, { recursive: true });
    }

    // Copy tools from config source
    const sourceToolsDir = join(this.configSourceDir, "tools");
    if (existsSync(sourceToolsDir)) {
      for (const file of readdirSync(sourceToolsDir)) {
        copyFileSync(join(sourceToolsDir, file), join(toolsDir, file));
      }
    }

    // Symlink node_modules so tool imports (e.g. @toon-format/toon) resolve correctly.
    // The tools are copied as flat files from /opencode-config/tools/ but their
    // dependencies are installed in /opencode-config/node_modules/ during image build.
    const sourceNodeModules = join(this.configSourceDir, "node_modules");
    const targetNodeModules = join(toolsDir, "node_modules");
    if (existsSync(sourceNodeModules) && !existsSync(targetNodeModules)) {
      try {
        symlinkSync(sourceNodeModules, targetNodeModules, "dir");
      } catch (err) {
        console.warn("[OpenCodeManager] Failed to symlink node_modules for tools:", err);
      }
    }

    // Orchestrators should never self-terminate and have no parent
    if (config.isOrchestrator) {
      console.log("[OpenCodeManager] Orchestrator mode: removing complete_session and notify_parent tools");
      const removeTools = ["complete_session.ts", "notify_parent.ts"];
      for (const tool of removeTools) {
        const toolPath = join(toolsDir, tool);
        if (existsSync(toolPath)) {
          unlinkSync(toolPath);
        }
      }
    }

    // Copy skills (these are directories, not flat files)
    const skillsDir = join(this.workspaceDir, ".opencode", "skills");
    if (!existsSync(skillsDir)) {
      mkdirSync(skillsDir, { recursive: true });
    }

    const sourceSkillsDir = join(this.configSourceDir, "skills");
    if (existsSync(sourceSkillsDir)) {
      this.copyDirRecursive(sourceSkillsDir, skillsDir);
    }

    // Copy plugins
    const pluginsDir = join(this.workspaceDir, ".opencode", "plugins");
    if (!existsSync(pluginsDir)) mkdirSync(pluginsDir, { recursive: true });
    const sourcePluginsDir = join(this.configSourceDir, "plugins");
    if (existsSync(sourcePluginsDir)) {
      this.copyDirRecursive(sourcePluginsDir, pluginsDir);
    }
  }

  /**
   * Recursively copy a directory's contents into a destination directory.
   */
  private copyDirRecursive(src: string, dest: string): void {
    for (const entry of readdirSync(src)) {
      const srcPath = join(src, entry);
      const destPath = join(dest, entry);
      if (statSync(srcPath).isDirectory()) {
        if (!existsSync(destPath)) {
          mkdirSync(destPath, { recursive: true });
        }
        this.copyDirRecursive(srcPath, destPath);
      } else {
        copyFileSync(srcPath, destPath);
      }
    }
  }

  // ─── Process Management ─────────────────────────────────────────────

  private async spawnProcess(): Promise<void> {
    console.log(`[OpenCodeManager] Spawning opencode serve --port ${this.port} (cwd: ${this.workspaceDir})`);

    // Log version
    try {
      const versionProc = Bun.spawn(["opencode", "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const versionOut = await new Response(versionProc.stdout).text();
      console.log(`[OpenCodeManager] OpenCode version: ${versionOut.trim()}`);
    } catch {
      console.log("[OpenCodeManager] OpenCode version: unknown");
    }

    this.process = Bun.spawn(["opencode", "serve", "--port", String(this.port)], {
      cwd: this.workspaceDir,
      stdout: "inherit",
      stderr: "inherit",
    });

    // Monitor for unexpected exit
    this.process.exited.then((code) => {
      if (!this.stopping) {
        console.error(`[OpenCodeManager] OpenCode exited unexpectedly with code ${code}`);
        this.healthy = false;
        this.process = null;
      }
    });
  }

  private async waitForHealth(): Promise<void> {
    const url = `http://localhost:${this.port}/health`;
    const maxRetries = 60;
    let retry = 0;

    console.log("[OpenCodeManager] Waiting for OpenCode health...");

    while (retry < maxRetries) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          this.healthy = true;
          console.log("[OpenCodeManager] OpenCode is healthy");
          return;
        }
      } catch {
        // Not ready yet
      }
      retry++;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(`OpenCode failed to become healthy after ${maxRetries} retries`);
  }

  // ─── Config Comparison ──────────────────────────────────────────────

  private mergeConfig(current: OpenCodeConfig, partial: Partial<OpenCodeConfig>): OpenCodeConfig {
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

  private configsEqual(a: OpenCodeConfig, b: OpenCodeConfig): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }
}

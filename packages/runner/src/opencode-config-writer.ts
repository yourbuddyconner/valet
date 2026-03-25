/**
 * OpenCodeConfigWriter — handles all filesystem I/O for OpenCode configuration.
 *
 * Writes auth.json, opencode.json, and copies tools/skills/plugins from
 * the config source directory into the workspace .opencode directory.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
  statSync,
  symlinkSync,
} from "fs";
import { join } from "path";
import type { OpenCodeConfig } from "./opencode-manager.js";

export class OpenCodeConfigWriter {
  private readonly workspaceDir: string;
  private readonly configSourceDir: string;
  private readonly authJsonPath: string;

  constructor(options: {
    workspaceDir: string;
    configSourceDir: string;
    authJsonPath: string;
  }) {
    this.workspaceDir = options.workspaceDir;
    this.configSourceDir = options.configSourceDir;
    this.authJsonPath = options.authJsonPath;
  }

  /**
   * Write all config files and copy tools/skills/plugins to the workspace.
   */
  write(config: OpenCodeConfig): void {
    this.writeConfigFiles(config);
    this.copyToolsAndSkills(config);
  }

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
    console.log(`[OpenCodeConfigWriter] Wrote auth.json with ${Object.keys(authJson).length} provider(s)`);

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
      console.log(`[OpenCodeConfigWriter] Added ${config.customProviders.length} custom provider(s) to opencode.json`);
    }

    writeFileSync(
      join(opencodeDir, "opencode.json"),
      JSON.stringify(opencodeConfig, null, 2),
    );
    console.log("[OpenCodeConfigWriter] Wrote opencode.json");
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
        console.warn("[OpenCodeConfigWriter] Failed to symlink node_modules for tools:", err);
      }
    }

    // Orchestrators should never self-terminate and have no parent
    if (config.isOrchestrator) {
      console.log("[OpenCodeConfigWriter] Orchestrator mode: removing complete_session and notify_parent tools");
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
}

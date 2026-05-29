import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { OpenCodeConfigWriter } from "./opencode-config-writer.js";
import type { OpenCodeConfig } from "./opencode-manager.js";

const roots: string[] = [];

const config: OpenCodeConfig = {
  tools: {},
  providerKeys: {},
  instructions: [],
  isOrchestrator: false,
};

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "valet-opencode-config-writer-"));
  roots.push(root);
  return root;
}

describe("OpenCodeConfigWriter", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes generated OpenCode files to the runtime config dir instead of the workspace", () => {
    const root = makeRoot();
    const workspaceDir = join(root, "workspace");
    const configSourceDir = join(root, "opencode-config");
    const sourceToolsDir = join(configSourceDir, "tools");
    const sourceSkillsDir = join(configSourceDir, "skills", "browser");
    const runtimeConfigDir = join(root, "runtime", "config", "opencode");
    const personaDir = join(root, "runtime", "persona");
    const runtimeToolsDir = join(runtimeConfigDir, "tools");
    mkdirSync(sourceToolsDir, { recursive: true });
    mkdirSync(sourceSkillsDir, { recursive: true });
    mkdirSync(join(workspaceDir, ".opencode", "tools"), { recursive: true });
    writeFileSync(
      join(configSourceDir, "opencode.json"),
      JSON.stringify({
        instructions: [".valet/persona/*.md", "Keep edits focused."],
      }),
    );
    writeFileSync(join(sourceToolsDir, "_tool_warnings.ts"), "export const ok = true;\n");
    writeFileSync(join(sourceSkillsDir, "SKILL.md"), "---\nname: browser\n---\n");
    writeFileSync(join(workspaceDir, ".opencode", "tools", "_tool_warnings.test.ts"), "import { it } from 'vitest';\n");

    new OpenCodeConfigWriter({
      workspaceDir,
      configSourceDir,
      authJsonPath: join(root, "runtime", "data", "opencode", "auth.json"),
      opencodeConfigDir: runtimeConfigDir,
      personaDir,
    }).write(config);

    expect(existsSync(join(runtimeToolsDir, "_tool_warnings.ts"))).toBe(true);
    expect(existsSync(join(runtimeConfigDir, "skills", "browser", "SKILL.md"))).toBe(true);
    expect(existsSync(join(workspaceDir, ".opencode", "opencode.json"))).toBe(false);
    expect(existsSync(join(workspaceDir, ".agents", "skills", "browser", "SKILL.md"))).toBe(false);

    const runtimeConfig = JSON.parse(readFileSync(join(runtimeConfigDir, "opencode.json"), "utf-8"));
    expect(runtimeConfig.instructions[0]).toBe(join(personaDir, "*.md"));
  });
});

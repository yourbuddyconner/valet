#!/usr/bin/env -S node --import tsx
/**
 * End-to-end smoke REPL for @valet/engine.
 *
 * Wires up:
 *   - InMemorySessionStore + InMemoryEventBus
 *   - VirtualSandbox (default) or LocalSandbox (real host filesystem + shell)
 *   - The engine's built-in tools (read/write/edit/bash/thread_read)
 *   - A real Anthropic model via pi-ai (defaults to claude-haiku-4-5)
 *
 * Env:
 *   ANTHROPIC_API_KEY  required
 *   VALET_MODEL        pi-ai anthropic model id (default claude-haiku-4-5)
 *   VALET_SANDBOX      virtual | local (default virtual)
 *   VALET_WORKSPACE    workspace dir for local sandbox (default cwd)
 *   VALET_SYSTEM_PROMPT  override the system prompt
 *   GITHUB_TOKEN       when set, registers @valet/plugin-github actions via
 *                      the actionSourceToTools bridge (read/write GitHub)
 *   VALET_CONTEXT_WINDOW  override the model's local contextWindow (forces
 *                         compaction at a smaller budget for dogfooding)
 *   VALET_MAX_TOKENS   override the model's local maxTokens
 *   VALET_ROLE_FILE    path to a markdown role artifact (frontmatter:
 *                      name, description, optional model)
 *   VALET_ROLE_DEFAULT when "1", every prompt automatically uses the loaded role
 *
 * Usage:
 *
 *   # in-memory sandbox, single prompt:
 *   pnpm --filter @valet/engine repl "say hi"
 *
 *   # local sandbox pointed at the current repo, interactive:
 *   VALET_SANDBOX=local pnpm --filter @valet/engine repl
 *
 *   # local sandbox pointed at an explicit dir:
 *   VALET_SANDBOX=local VALET_WORKSPACE=/path/to/repo pnpm --filter @valet/engine repl "list the top-level files"
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { getModel } from "@mariozechner/pi-ai";
import { githubPlugin } from "@valet/plugin-github/actions";
import {
  pluginCatalogTools,
  Engine,
  InMemoryCredentialStore,
  InMemoryEventBus,
  InMemorySessionStore,
  LocalSandboxProvider,
  loadRoleFromMarkdown,
  VirtualSandboxProvider,
  type ActionPlugin,
  type BusEvent,
  type RoleSpec,
  type SandboxProvider,
  type Session,
  type ToolDef,
} from "../src/index.js";

const MODEL_ID = process.env.VALET_MODEL ?? "claude-haiku-4-5";
const SANDBOX_KIND = (process.env.VALET_SANDBOX ?? "virtual").toLowerCase();
const WORKSPACE =
  process.env.VALET_WORKSPACE ??
  (SANDBOX_KIND === "local" ? process.cwd() : "/");

const SYSTEM_PROMPT_VIRTUAL =
  "You are a helpful coding assistant running inside an in-memory virtual sandbox. " +
  "You have built-in tools: read, write, edit, bash, thread_read. " +
  "The sandbox starts empty at /. Be concise.";

const SYSTEM_PROMPT_LOCAL =
  `You are a helpful coding assistant running on a local developer machine. ` +
  `Your workspace is ${WORKSPACE}. Relative paths resolve there. ` +
  `You have built-in tools: read, write, edit, bash, thread_read. ` +
  `Be concise. Confirm with the user before making destructive changes.`;

const SYSTEM_PROMPT =
  process.env.VALET_SYSTEM_PROMPT ??
  (SANDBOX_KIND === "local" ? SYSTEM_PROMPT_LOCAL : SYSTEM_PROMPT_VIRTUAL);

function fail(message: string, code = 1): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

function loadPluginTools(): ToolDef[] {
  const plugins: ActionPlugin[] = [];
  if (process.env.GITHUB_TOKEN) plugins.push(githubPlugin);
  if (plugins.length === 0) return [];
  return pluginCatalogTools({ plugins });
}

async function buildSession(): Promise<{
  session: Session;
  bus: InMemoryEventBus;
  defaultRoleName?: string;
}> {
  if (!process.env.ANTHROPIC_API_KEY) {
    fail(
      "ANTHROPIC_API_KEY is not set. Export it in your shell before running this REPL.",
    );
  }
  // pi-ai's `getModel` is typed against MODELS at compile time; we cast the
  // env-supplied id at the boundary because it's user input.
  const baseModel = getModel("anthropic", MODEL_ID as "claude-haiku-4-5");
  if (!baseModel) {
    fail(
      `unknown anthropic model "${MODEL_ID}". Check VALET_MODEL or pi-ai's MODELS table.`,
    );
  }
  // VALET_CONTEXT_WINDOW + VALET_MAX_TOKENS let us force compaction at low
  // budgets for dogfooding — the engine uses these to compute `usable`,
  // while Anthropic's API still accepts the real (much larger) context.
  const overrideCtx = process.env.VALET_CONTEXT_WINDOW
    ? parseInt(process.env.VALET_CONTEXT_WINDOW, 10)
    : undefined;
  const overrideMax = process.env.VALET_MAX_TOKENS
    ? parseInt(process.env.VALET_MAX_TOKENS, 10)
    : undefined;
  const model =
    overrideCtx || overrideMax
      ? {
          ...baseModel,
          contextWindow: overrideCtx ?? baseModel.contextWindow,
          maxTokens: overrideMax ?? baseModel.maxTokens,
        }
      : baseModel;

  const store = new InMemorySessionStore();
  const bus = new InMemoryEventBus();
  const credentials = new InMemoryCredentialStore();
  const sandboxProvider: SandboxProvider =
    SANDBOX_KIND === "local"
      ? new LocalSandboxProvider()
      : new VirtualSandboxProvider();
  const engine = new Engine({
    providers: { store, bus, credentials, sandboxProvider },
  });

  const userId = "repl-user";
  const tools: ToolDef[] = [];

  // Plugin sources: when their respective env tokens are set, save the
  // credential and add the source to the bridge. The bridge then exposes
  // a single (list_tools, call_tool) pair regardless of how many sources
  // are wired in.
  if (process.env.GITHUB_TOKEN) {
    await credentials.save({ type: "user", id: userId }, "github", {
      type: "oauth2",
      accessToken: process.env.GITHUB_TOKEN,
    });
  }
  const pluginTools = loadPluginTools();
  if (pluginTools.length > 0) {
    tools.push(...pluginTools);
    stdout.write(
      `\x1b[90m[plugins] ${pluginTools.length} bridge tools (list_tools + call_tool)\x1b[0m\n`,
    );
  }

  // Optional: load a single role from VALET_ROLE_FILE. The role's name is
  // available for use via the `:role <name>` REPL meta-command (or
  // PromptOptions.role programmatically). When VALET_ROLE_DEFAULT=1 every
  // prompt automatically applies the role.
  const roles: RoleSpec[] = [];
  let defaultRoleName: string | undefined;
  if (process.env.VALET_ROLE_FILE) {
    const content = await readFile(process.env.VALET_ROLE_FILE, "utf8");
    const role = loadRoleFromMarkdown(content, "session");
    roles.push(role);
    if (process.env.VALET_ROLE_DEFAULT === "1") defaultRoleName = role.name;
    stdout.write(
      `\x1b[90m[role] loaded ${role.name}${defaultRoleName ? " (default)" : ""}\x1b[0m\n`,
    );
  }

  const workspace = SANDBOX_KIND === "local" ? resolve(WORKSPACE) : WORKSPACE;
  const session = await engine.createSession({
    userId,
    orgId: "repl-org",
    workspace,
    sandbox: { workspace },
    model,
    systemPrompt: SYSTEM_PROMPT,
    tools,
    roles,
  });

  return { session, bus, defaultRoleName };
}

function subscribePrinter(bus: InMemoryEventBus): void {
  bus.subscribe({}, (e: BusEvent) => {
    const ev = e.event;
    switch (ev.type) {
      case "text_delta":
        stdout.write(ev.text);
        break;
      case "tool_start":
        stdout.write(
          `\n\x1b[90m[tool] ${ev.tool}(${JSON.stringify(ev.args)})\x1b[0m\n`,
        );
        break;
      case "tool_end":
        stdout.write(
          `\x1b[90m[tool] ${ev.tool} -> ${ev.isError ? "ERROR" : "ok"}: ${truncate(ev.result, 200)}\x1b[0m\n`,
        );
        break;
      case "decision_gate":
        stdout.write(
          `\n\x1b[33m[gate] ${ev.gate.type}: ${ev.gate.title}\x1b[0m\n` +
            `  id=${ev.gate.id}\n  actions=${ev.gate.actions.map((a) => a.id).join(", ")}\n`,
        );
        break;
      case "decision_gate_resolved":
        stdout.write(`\x1b[33m[gate] resolved=${ev.resolution.actionId}\x1b[0m\n`);
        break;
      case "compaction_start":
        stdout.write(`\n\x1b[35m[compaction] started…\x1b[0m\n`);
        break;
      case "compaction_end":
        stdout.write(`\x1b[35m[compaction] done\x1b[0m\n`);
        break;
      case "turn_end":
        stdout.write(`\n\x1b[90m[turn ended: ${ev.reason}]\x1b[0m\n`);
        break;
      case "error":
        stdout.write(`\n\x1b[31m[error] ${ev.code}: ${ev.error}\x1b[0m\n`);
        break;
      default:
        if (process.env.VALET_DEBUG === "1") {
          stdout.write(`\x1b[90m[debug] ${ev.type}\x1b[0m\n`);
        }
        break;
    }
  });
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `…(+${s.length - max} chars)`;
}

async function waitForIdle(bus: InMemoryEventBus, threadId: string): Promise<void> {
  return new Promise((resolve) => {
    const unsub = bus.subscribe({}, (e) => {
      if (
        e.event.type === "status" &&
        e.event.threadId === threadId &&
        e.event.status === "idle"
      ) {
        unsub();
        resolve();
      }
    });
  });
}

async function runOneShot(prompt: string): Promise<void> {
  const { session, bus, defaultRoleName } = await buildSession();
  subscribePrinter(bus);
  const receipt = await session.prompt(prompt, { role: defaultRoleName });
  await waitForIdle(bus, receipt.threadId);
}

async function runInteractive(): Promise<void> {
  const { session, bus, defaultRoleName } = await buildSession();
  subscribePrinter(bus);
  const rl = createInterface({ input: stdin, output: stdout });
  stdout.write(
    `\nvalet engine repl — model=${MODEL_ID} sandbox=${SANDBOX_KIND}` +
      (SANDBOX_KIND === "local" ? ` workspace=${WORKSPACE}` : "") +
      (defaultRoleName ? ` role=${defaultRoleName}` : "") +
      `\ntype a prompt, 'exit' to quit.\n`,
  );
  while (true) {
    const line = (await rl.question("\n> ")).trim();
    if (line === "") continue;
    if (line === "exit" || line === "quit") break;
    const receipt = await session.prompt(line, { role: defaultRoleName });
    await waitForIdle(bus, receipt.threadId);
  }
  rl.close();
}

const args = process.argv.slice(2);
if (args.length > 0) {
  await runOneShot(args.join(" "));
} else {
  await runInteractive();
}

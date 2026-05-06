#!/usr/bin/env -S node --import tsx
/**
 * End-to-end smoke REPL for @valet/engine.
 *
 * Wires up:
 *   - InMemorySessionStore + InMemoryEventBus + VirtualSandbox (no containers)
 *   - The engine's built-in tools (read/write/edit/bash/thread_read)
 *   - A real Anthropic model via pi-ai (defaults to claude-haiku-4-5)
 *
 * Usage:
 *
 *   # single prompt, exits when the agent emits end_turn:
 *   ANTHROPIC_API_KEY=... pnpm --filter @valet/engine exec tsx bin/repl.ts "say hi"
 *
 *   # interactive multi-turn (one prompt per stdin line, ctrl-D / 'exit' to quit):
 *   ANTHROPIC_API_KEY=... pnpm --filter @valet/engine exec tsx bin/repl.ts
 *
 *   # pick a different model:
 *   VALET_MODEL=claude-sonnet-4-6 ANTHROPIC_API_KEY=... pnpm ... bin/repl.ts
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { getModel } from "@mariozechner/pi-ai";
import {
  Engine,
  InMemoryEventBus,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BusEvent,
  type Session,
} from "../src/index.js";

const MODEL_ID = process.env.VALET_MODEL ?? "claude-haiku-4-5";
const SYSTEM_PROMPT =
  process.env.VALET_SYSTEM_PROMPT ??
  "You are a helpful coding assistant running inside an in-memory virtual sandbox. " +
    "You have built-in tools: read, write, edit, bash, thread_read. " +
    "The sandbox starts empty at /. Be concise.";

function fail(message: string, code = 1): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

async function buildSession(): Promise<{ session: Session; bus: InMemoryEventBus }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    fail(
      "ANTHROPIC_API_KEY is not set. Export it in your shell before running this REPL.",
    );
  }
  // pi-ai's `getModel` is typed against MODELS at compile time; we cast the
  // env-supplied id at the boundary because it's user input.
  const model = getModel("anthropic", MODEL_ID as "claude-haiku-4-5");
  if (!model) {
    fail(
      `unknown anthropic model "${MODEL_ID}". Check VALET_MODEL or pi-ai's MODELS table.`,
    );
  }

  const store = new InMemorySessionStore();
  const bus = new InMemoryEventBus();
  const sandboxProvider = new VirtualSandboxProvider();
  const engine = new Engine({ providers: { store, bus, sandboxProvider } });

  const session = await engine.createSession({
    userId: "repl-user",
    orgId: "repl-org",
    workspace: "/",
    sandbox: {},
    model,
    systemPrompt: SYSTEM_PROMPT,
  });

  return { session, bus };
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
      case "turn_end":
        stdout.write(`\n\x1b[90m[turn ended: ${ev.reason}]\x1b[0m\n`);
        break;
      case "error":
        stdout.write(`\n\x1b[31m[error] ${ev.code}: ${ev.error}\x1b[0m\n`);
        break;
      default:
        // ignore queue_state, message_start, status, etc. — too noisy for a REPL
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
  const { session, bus } = await buildSession();
  subscribePrinter(bus);
  const receipt = await session.prompt(prompt);
  await waitForIdle(bus, receipt.threadId);
}

async function runInteractive(): Promise<void> {
  const { session, bus } = await buildSession();
  subscribePrinter(bus);
  const rl = createInterface({ input: stdin, output: stdout });
  stdout.write(
    `\nvalet engine repl — model=${MODEL_ID}; type a prompt, 'exit' to quit.\n`,
  );
  while (true) {
    const line = (await rl.question("\n> ")).trim();
    if (line === "" ) continue;
    if (line === "exit" || line === "quit") break;
    const receipt = await session.prompt(line);
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

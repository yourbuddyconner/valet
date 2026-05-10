import { Type } from "typebox";
import type { TSchema } from "typebox";
import type { ToolDef, MessageQuery } from "../types.js";

/**
 * Helper that preserves the schema's static type through the ToolDef so
 * `args` in `execute` is typed precisely instead of `unknown`.
 */
export function defineTool<T extends TSchema>(def: ToolDef<T>): ToolDef<T> {
  return def;
}

export const readTool = defineTool({
  name: "read",
  description: "Read the contents of a file from the sandbox.",
  parameters: Type.Object({ path: Type.String() }),
  execute: async (args, ctx) => {
    const text = await ctx.sandbox.readFile(args.path);
    return { text };
  },
});

export const writeTool = defineTool({
  name: "write",
  description: "Write contents to a file in the sandbox (creates or overwrites).",
  parameters: Type.Object({ path: Type.String(), content: Type.String() }),
  execute: async (args, ctx) => {
    await ctx.sandbox.writeFile(args.path, args.content);
    return { text: `wrote ${args.path}` };
  },
});

export const editTool = defineTool({
  name: "edit",
  description: "Replace exact text occurrences in a file.",
  parameters: Type.Object({
    path: Type.String(),
    oldString: Type.String(),
    newString: Type.String(),
  }),
  execute: async (args, ctx) => {
    const before = await ctx.sandbox.readFile(args.path);
    if (!before.includes(args.oldString)) {
      return { text: `no match for old_string in ${args.path}` };
    }
    const after = before.split(args.oldString).join(args.newString);
    await ctx.sandbox.writeFile(args.path, after);
    return { text: `edited ${args.path}` };
  },
});

export const bashTool = defineTool({
  name: "bash",
  description: "Execute a shell command in the sandbox.",
  parameters: Type.Object({ command: Type.String() }),
  execute: async (args, ctx) => {
    const result = await ctx.sandbox.exec(args.command, { signal: ctx.signal });
    const exitNote = result.exitCode === 0 ? "" : `\n[exit ${result.exitCode}]`;
    return { text: `${result.stdout}${result.stderr}${exitNote}` };
  },
});

export const threadReadTool = defineTool({
  name: "thread_read",
  description:
    "Read recent messages from another thread in this session. Useful for cross-thread context (e.g. an orchestrator pulling notes from a worker thread, or a thread checking what a sibling has done).",
  parameters: Type.Object({
    key: Type.String({ description: "Thread key to read from (e.g. 'web:default', 'task:research')." }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    includeCompacted: Type.Optional(Type.Boolean()),
  }),
  execute: async (args, ctx) => {
    const opts: MessageQuery = {
      limit: args.limit ?? 30,
      includeCompacted: args.includeCompacted ?? true,
    };
    const entries = await ctx.threadRead(args.key, opts);
    if (entries.length === 0) return { text: `(thread "${args.key}" has no messages)` };
    const lines: string[] = [`# thread:${args.key}`];
    for (const e of entries) {
      if (e.type === "message") {
        const author = e.author?.name ? ` (${e.author.name})` : "";
        lines.push(`\n## ${e.role}${author} @ ${new Date(e.createdAt).toISOString()}`);
        lines.push(e.content);
      } else if (e.type === "compaction") {
        lines.push(`\n## [compaction summary]`);
        lines.push(e.summary);
      } else if (e.type === "decision_gate") {
        lines.push(
          `\n## [decision gate: ${e.gate.type} — ${e.gate.status}] ${e.gate.title}`,
        );
        if (e.gate.body) lines.push(e.gate.body);
      } else if (e.type === "branch_summary") {
        lines.push(`\n## [branch summary]`);
        lines.push(e.summary);
      }
    }
    return { text: lines.join("\n") };
  },
});

export const listThreadsTool = defineTool({
  name: "list_threads",
  description:
    "List sibling threads in this session, including paused ones. Use this " +
    "to discover thread keys before calling `thread_read`. Returns key, " +
    "status, model override (if any), and a short summary when available.",
  parameters: Type.Object({}),
  execute: async (_args, ctx) => {
    const threads = await ctx.listThreads();
    if (threads.length === 0) return { text: "(no threads)" };
    const lines: string[] = [`# threads (${threads.length})`];
    for (const t of threads) {
      const isSelf = t.id === ctx.threadId ? " (this thread)" : "";
      const model = t.model ? ` [model:${t.model}]` : "";
      const updated = new Date(t.updatedAt).toISOString();
      lines.push(`- \`${t.key}\` — ${t.status}${model}${isSelf} (updated ${updated})`);
      if (t.summary) lines.push(`    ${t.summary}`);
    }
    return { text: lines.join("\n") };
  },
});

export const switchModelTool = defineTool({
  name: "switch_model",
  description:
    "Switch the model used for subsequent LLM calls in *this thread*. " +
    "Useful when a turn needs a stronger reasoning model or a faster/cheaper " +
    "one. The change takes effect on the next LLM call — the in-flight tool " +
    "call finishes against the old model. Scope is always thread-local; " +
    "changing the session default is a user-facing setting and not exposed " +
    "to the agent.",
  parameters: Type.Object({
    model: Type.String({
      description:
        "Target model id, e.g. 'claude-haiku-4-5' or 'anthropic/claude-opus-4-7'.",
    }),
  }),
  execute: async (args, ctx) => {
    try {
      const { fromModel, toModel } = await ctx.setModel({ model: args.model });
      if (fromModel === toModel) {
        return { text: `model unchanged (${toModel})` };
      }
      return { text: `switched thread model: ${fromModel} → ${toModel}` };
    } catch (err) {
      return {
        text:
          err instanceof Error
            ? `switch_model failed: ${err.message}`
            : "switch_model failed",
      };
    }
  },
});

export const builtinTools: ToolDef[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  threadReadTool,
  listThreadsTool,
  switchModelTool,
];

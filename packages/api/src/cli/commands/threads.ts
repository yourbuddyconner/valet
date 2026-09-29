import { InstanceClient } from "../client.js";
import { ExitCode } from "../exit.js";
import { parseGlobalFlags, printErr, printJson, printLine, renderTable, type ParsedFlags } from "../output.js";
import { resolveInstance } from "../resolve.js";
import type { CliContext } from "../types.js";

type ThreadsClient = Pick<InstanceClient, "getThread" | "listWorkspaceThreads" | "createWorkspaceThread">;
export async function runThreads(client: ThreadsClient, flags: ParsedFlags): Promise<number> {
  const workspace = typeof flags.flags.workspace === "string" ? flags.flags.workspace : undefined;
  switch (flags.rest[0]) {
    case "list": {
      const result = await client.listWorkspaceThreads(workspace);
      if (flags.json) printJson(result);
      else printLine(result.threads.length ? renderTable(["THREAD", "TITLE"], result.threads.map(t => [t.id, t.title ?? ""])) : "no threads");
      return ExitCode.OK;
    }
    case "new": {
      const thread = await client.createWorkspaceThread({ title: typeof flags.flags.title === "string" ? flags.flags.title : undefined }, workspace);
      if (flags.json) printJson(thread); else printLine(thread.id);
      return ExitCode.OK;
    }
    case "show": {
      const id = flags.rest[1];
      if (!id) break;
      const thread = await client.getThread(id);
      if (flags.json) printJson(thread); else printLine(`${thread.id}  ${thread.title ?? "Untitled thread"}`);
      return ExitCode.OK;
    }
  }
  printErr("usage: valet threads <list|new|show ID> [--workspace user|TEAM_ID] [--title TITLE]");
  return ExitCode.Usage;
}

export async function run(args: string[], ctx: CliContext): Promise<number> {
  const flags = parseGlobalFlags(args);
  const instance = resolveInstance({ flag: typeof flags.flags.instance === "string" ? flags.flags.instance : undefined, env: process.env.VALET_INSTANCE, config: ctx.config });
  return runThreads(new InstanceClient({ url: instance.url, apiKey: instance.apiKey }), flags);
}

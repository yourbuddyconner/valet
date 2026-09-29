/**
 * `valet status` — report an instance's health plus client/server version
 * skew (spec decisions 6 & 9). `run` resolves the instance and delegates to
 * the pure `runStatus`, which takes the narrow `StatusClient` surface.
 */
import { InstanceClient } from "../client.js";
import { ExitCode } from "../exit.js";
import { parseGlobalFlags, printErr, printJson, printLine } from "../output.js";
import { resolveInstance, type ResolvedInstance } from "../resolve.js";
import type { CliContext } from "../types.js";
import { VALET_VERSION } from "../../version.js";
import type { HealthResponse } from "../../wire/types.js";

/** The subset of `InstanceClient` the `status` command needs. */
export interface StatusClient {
  health(): Promise<HealthResponse>;
}

export interface StatusInput {
  name: string;
  url: string;
  json: boolean;
  threadId?: string;
  sessionId?: string;
}

/**
 * Pure status render. Returns OK even on version skew — skew is a warning
 * (to stderr in human mode; a `skew` boolean in JSON mode), not a failure.
 */
export async function runStatus(client: StatusClient, input: StatusInput): Promise<number> {
  const health = await client.health();
  const clientVersion = VALET_VERSION;
  const serverVersion = health.version;
  const skew = serverVersion !== undefined && serverVersion !== clientVersion;

  if (input.json) {
    printJson({
      instance: { name: input.name, url: input.url },
      health,
      clientVersion,
      skew,
    });
    return ExitCode.OK;
  }

  printLine(`instance:  ${input.name} (${input.url})`);
  printLine(`ok:        ${health.ok}`);
  printLine(`service:   ${health.service}`);
  printLine(`server:    ${serverVersion ?? "unknown"}`);
  printLine(`sandbox:   ${health.sandboxBackend ?? "unknown"}`);
  printLine(`client:    ${clientVersion}`);
  if (skew) {
    printErr(`warning: client version ${clientVersion} differs from server version ${serverVersion}`);
  }
  return ExitCode.OK;
}

/** Thread addresses resolve to their existing runtime; status does not create work. */
export async function runTargetStatus(
  client: Pick<InstanceClient, "getThread" | "getSession">,
  input: StatusInput,
): Promise<number> {
  const thread = input.threadId ? await client.getThread(input.threadId) : undefined;
  if (thread && input.sessionId && input.sessionId !== thread.sessionId) {
    printErr("The thread does not belong to the specified runtime. Use its runtime or omit --session.");
    return ExitCode.Usage;
  }
  const sessionId = thread?.sessionId ?? input.sessionId;
  if (!sessionId) return ExitCode.Usage;
  const runtime = await client.getSession(sessionId);
  if (input.json) printJson({ thread, runtime });
  else {
    if (thread) printLine(`thread:    ${thread.id} (${thread.title ?? "Untitled thread"})`);
    printLine(`runtime:   ${runtime.id}`);
    printLine(`status:    ${runtime.status}`);
    printLine(`activity:  ${runtime.runState}`);
  }
  return ExitCode.OK;
}

export async function run(args: string[], ctx: CliContext): Promise<number> {
  const flags = parseGlobalFlags(args);
  if (flags.flags.thread === true || flags.flags.session === true || flags.flags.thread === "" || flags.flags.session === "") {
    printErr("valet status: provide an id after --thread or --session.");
    return ExitCode.Usage;
  }
  const instance: ResolvedInstance = resolveInstance({
    flag: typeof flags.flags.instance === "string" ? flags.flags.instance : undefined,
    env: process.env.VALET_INSTANCE,
    config: ctx.config,
  });
  const client = new InstanceClient({ url: instance.url, apiKey: instance.apiKey });
  if (typeof flags.flags.thread === "string" || typeof flags.flags.session === "string") {
    return runTargetStatus(client, {
      name: instance.name, url: instance.url, json: flags.json,
      threadId: typeof flags.flags.thread === "string" ? flags.flags.thread : undefined,
      sessionId: typeof flags.flags.session === "string" ? flags.flags.session : undefined,
    });
  }
  return runStatus(client, { name: instance.name, url: instance.url, json: flags.json });
}

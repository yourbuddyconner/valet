/**
 * `valet gates list` / `valet gates resolve <gateId> <option>` — inspect and
 * resolve decision gates on a session (defaulting to the orchestrator).
 *
 * `run` is a thin shell; `runGates(client, flags)` is the pure, stub-testable
 * core over the narrow `GatesClient` surface.
 */
import { InstanceClient } from "../client.js";
import { ExitCode } from "../exit.js";
import { parseGlobalFlags, printErr, printJson, printLine, renderTable, type ParsedFlags } from "../output.js";
import { resolveInstance } from "../resolve.js";
import type { CliContext } from "../types.js";
import type {
  DecisionGate,
  EnsureWorkspaceRuntimeResponse,
  ListDecisionsResponse,
  ResolveDecisionRequest,
} from "../../wire/types.js";

/** The subset of `InstanceClient` the `gates` command needs. */
export interface GatesClient {
  ensureOrchestrator(): Promise<EnsureWorkspaceRuntimeResponse>;
  listDecisions(id: string): Promise<ListDecisionsResponse>;
  resolveDecision(id: string, gateId: string, body: ResolveDecisionRequest): Promise<void>;
}

const USAGE = "usage: valet gates <list|resolve>";

/** Format pending gates as an aligned gateId/type/title/actions table. */
export function formatGatesTable(gates: DecisionGate[]): string {
  const rows = gates.map((g) => [g.id, g.type, g.title, g.actions.map((a) => a.id).join(",")]);
  return renderTable(["GATE", "TYPE", "TITLE", "ACTIONS"], rows);
}

/** Resolve the target session: `--session <id>` overrides the orchestrator. */
async function targetSession(client: GatesClient, flags: ParsedFlags): Promise<string> {
  const override = flags.flags.session;
  if (typeof override === "string") return override;
  return (await client.ensureOrchestrator()).sessionId;
}

async function gatesList(client: GatesClient, flags: ParsedFlags): Promise<number> {
  const id = await targetSession(client, flags);
  const { gates } = await client.listDecisions(id);
  const pending = gates.filter((g) => g.status === "pending");

  if (flags.json) {
    printJson({ gates: pending });
    return ExitCode.OK;
  }
  if (pending.length === 0) {
    printLine("no pending gates");
    return ExitCode.OK;
  }
  printLine(formatGatesTable(pending));
  return ExitCode.OK;
}

async function gatesResolve(client: GatesClient, flags: ParsedFlags): Promise<number> {
  const gateId = flags.rest[1];
  if (gateId === undefined || gateId === "") {
    printErr("usage: valet gates resolve <gateId> <actionId> | --value <text>");
    return ExitCode.Usage;
  }

  // `<option>` positional = an actionId (approval/credential gates). `--value`
  // carries free-form text (question gates).
  const actionId = flags.rest[2];
  const value = typeof flags.flags.value === "string" ? flags.flags.value : undefined;
  if (actionId === undefined && value === undefined) {
    printErr("valet gates resolve: provide an <actionId>, or --value <text> for a question gate");
    return ExitCode.Usage;
  }

  const body: ResolveDecisionRequest = {};
  if (actionId !== undefined) body.actionId = actionId;
  if (value !== undefined) body.value = value;

  const id = await targetSession(client, flags);
  await client.resolveDecision(id, gateId, body);

  if (flags.json) printJson({ ok: true, gateId });
  else printLine(`resolved gate ${gateId}`);
  return ExitCode.OK;
}

/** Pure dispatch over the `gates` subcommands, testable with a stub client. */
export async function runGates(client: GatesClient, flags: ParsedFlags): Promise<number> {
  switch (flags.rest[0]) {
    case "list":
      return gatesList(client, flags);
    case "resolve":
      return gatesResolve(client, flags);
    default:
      printErr(USAGE);
      return ExitCode.Usage;
  }
}

export async function run(args: string[], ctx: CliContext): Promise<number> {
  const flags = parseGlobalFlags(args);
  const instance = resolveInstance({
    flag: typeof flags.flags.instance === "string" ? flags.flags.instance : undefined,
    env: process.env.VALET_INSTANCE,
    config: ctx.config,
  });
  const client = new InstanceClient({ url: instance.url, apiKey: instance.apiKey });
  return runGates(client, flags);
}

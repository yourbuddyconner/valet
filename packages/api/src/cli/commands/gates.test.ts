import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ExitCode } from "../exit.js";
import { parseGlobalFlags } from "../output.js";
import { formatGatesTable, runGates, type GatesClient } from "./gates.js";
import type { DecisionGate, ResolveDecisionRequest } from "../../wire/types.js";

function gate(id: string, status: DecisionGate["status"] = "pending"): DecisionGate {
  return {
    id,
    sessionId: "s1",
    threadId: "t1",
    type: "approval",
    title: `Gate ${id}`,
    actions: [{ id: "approve", label: "Approve" }],
    status,
    createdAt: 1,
    updatedAt: 1,
  };
}

interface ResolveCall {
  id: string;
  gateId: string;
  body: ResolveDecisionRequest;
}

function stubClient(
  gates: DecisionGate[],
  overrides: Partial<GatesClient> = {},
): { client: GatesClient; resolves: ResolveCall[]; ensureCalls: () => number } {
  const resolves: ResolveCall[] = [];
  let ensure = 0;
  const client: GatesClient = {
    listThreadDecisions: () => Promise.resolve({ gates }),
    resolveThreadDecision: (id, gateId, body) => { resolves.push({ id, gateId, body }); return Promise.resolve(); },
    ensureOrchestrator: () => {
      ensure += 1;
      return Promise.resolve({ sessionId: "orch_1" });
    },
    listDecisions: () => Promise.resolve({ gates }),
    resolveDecision: (id, gateId, body) => {
      resolves.push({ id, gateId, body });
      return Promise.resolve();
    },
    ...overrides,
  };
  return { client, resolves, ensureCalls: () => ensure };
}

let outSpy: MockInstance;
let errSpy: MockInstance;
beforeEach(() => {
  outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());
const stdout = (): string => outSpy.mock.calls.map((c) => String(c[0])).join("");
const stderr = (): string => errSpy.mock.calls.map((c) => String(c[0])).join("");

describe("runGates list", () => {
  it("filters to pending and prints JSON", async () => {
    const { client } = stubClient([gate("g1"), gate("g2", "resolved")]);
    const code = await runGates(client, parseGlobalFlags(["list", "--json"]));
    expect(code).toBe(ExitCode.OK);
    const parsed = JSON.parse(stdout()) as { gates: DecisionGate[] };
    expect(parsed.gates).toHaveLength(1);
    expect(parsed.gates[0].id).toBe("g1");
  });

  it("defaults to the orchestrator session", async () => {
    const bundle = stubClient([gate("g1")]);
    await runGates(bundle.client, parseGlobalFlags(["list"]));
    expect(bundle.ensureCalls()).toBe(1);
    expect(stdout()).toContain("g1");
  });

  it("uses --session override (no ensureOrchestrator)", async () => {
    let askedId: string | undefined;
    const bundle = stubClient([gate("g1")], {
      listDecisions: (id) => {
        askedId = id;
        return Promise.resolve({ gates: [gate("g1")] });
      },
    });
    await runGates(bundle.client, parseGlobalFlags(["list", "--session", "sess_9"]));
    expect(bundle.ensureCalls()).toBe(0);
    expect(askedId).toBe("sess_9");
  });

  it("prints a friendly line when there are no pending gates", async () => {
    const { client } = stubClient([gate("g1", "resolved")]);
    await runGates(client, parseGlobalFlags(["list", "--session", "s"]));
    expect(stdout()).toContain("no pending gates");
  });
});

describe("runGates resolve", () => {
  it("resolves with a positional actionId", async () => {
    const { client, resolves } = stubClient([gate("g1")]);
    const code = await runGates(client, parseGlobalFlags(["resolve", "g1", "approve", "--session", "s"]));
    expect(code).toBe(ExitCode.OK);
    expect(resolves).toEqual([{ id: "s", gateId: "g1", body: { actionId: "approve" } }]);
    expect(stdout()).toContain("resolved gate g1");
  });

  it("resolves a question gate with --value", async () => {
    const { client, resolves } = stubClient([gate("g1")]);
    const code = await runGates(
      client,
      parseGlobalFlags(["resolve", "g1", "--value", "the answer", "--session", "s"]),
    );
    expect(code).toBe(ExitCode.OK);
    expect(resolves[0].body).toEqual({ value: "the answer" });
  });

  it("rejects a missing gateId with Usage", async () => {
    const { client, resolves } = stubClient([gate("g1")]);
    const code = await runGates(client, parseGlobalFlags(["resolve"]));
    expect(code).toBe(ExitCode.Usage);
    expect(resolves).toHaveLength(0);
  });

  it("rejects a resolve with neither actionId nor --value", async () => {
    const { client, resolves } = stubClient([gate("g1")]);
    const code = await runGates(client, parseGlobalFlags(["resolve", "g1", "--session", "s"]));
    expect(code).toBe(ExitCode.Usage);
    expect(resolves).toHaveLength(0);
    expect(stderr()).toContain("actionId");
  });
});

describe("runGates unknown subcommand", () => {
  it("returns Usage", async () => {
    const { client } = stubClient([]);
    expect(await runGates(client, parseGlobalFlags(["frob"]))).toBe(ExitCode.Usage);
  });
});

describe("formatGatesTable", () => {
  it("includes gate id, type, title and action ids", () => {
    const table = formatGatesTable([gate("g1")]);
    expect(table).toContain("g1");
    expect(table).toContain("approval");
    expect(table).toContain("approve");
  });
});

it("rejects conflicting legacy and thread selectors before resolving", async () => {
  const { client, resolves } = stubClient([gate("g1")]);
  expect(await runGates(client, parseGlobalFlags(["resolve", "g1", "approve", "--thread", "t1", "--session", "other"]))).toBe(ExitCode.Usage);
  expect(resolves).toEqual([]);
});

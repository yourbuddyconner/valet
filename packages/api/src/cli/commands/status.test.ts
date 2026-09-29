import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ExitCode } from "../exit.js";
import { runStatus, type StatusClient } from "./status.js";
import { VALET_VERSION } from "../../version.js";
import type { HealthResponse } from "../../wire/types.js";

function stubClient(health: HealthResponse): StatusClient {
  return { health: () => Promise.resolve(health) };
}

const HEALTHY: HealthResponse = {
  ok: true,
  service: "valet-api",
  ts: 123,
  version: VALET_VERSION,
  sandboxBackend: "local",
};

let outSpy: MockInstance;
let errSpy: MockInstance;
beforeEach(() => {
  outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());
const stdout = (): string => outSpy.mock.calls.map((c) => String(c[0])).join("");
const stderr = (): string => errSpy.mock.calls.map((c) => String(c[0])).join("");

describe("runStatus", () => {
  it("prints instance/health/versions and returns OK when versions match", async () => {
    const code = await runStatus(stubClient(HEALTHY), { name: "local", url: "http://x", json: false });
    expect(code).toBe(ExitCode.OK);
    const out = stdout();
    expect(out).toContain("local (http://x)");
    expect(out).toContain("valet-api");
    expect(out).toContain(`server:    ${VALET_VERSION}`);
    expect(out).toContain("sandbox:   local");
    expect(out).toContain(`client:    ${VALET_VERSION}`);
    expect(stderr()).toBe("");
  });

  it("warns to stderr on version skew but still returns OK", async () => {
    const code = await runStatus(
      stubClient({ ...HEALTHY, version: "9.9.9" }),
      { name: "prod", url: "http://y", json: false },
    );
    expect(code).toBe(ExitCode.OK);
    expect(stderr()).toContain("differs from server version 9.9.9");
  });

  it("--json emits instance, health, clientVersion and skew", async () => {
    const code = await runStatus(
      stubClient({ ...HEALTHY, version: "9.9.9" }),
      { name: "prod", url: "http://y", json: true },
    );
    expect(code).toBe(ExitCode.OK);
    const parsed = JSON.parse(stdout()) as {
      instance: { name: string; url: string };
      health: HealthResponse;
      clientVersion: string;
      skew: boolean;
    };
    expect(parsed.instance).toEqual({ name: "prod", url: "http://y" });
    expect(parsed.health.sandboxBackend).toBe("local");
    expect(parsed.clientVersion).toBe(VALET_VERSION);
    expect(parsed.skew).toBe(true);
  });

  it("does not flag skew when the server omits its version", async () => {
    const { version: _omit, ...noVersion } = HEALTHY;
    const code = await runStatus(stubClient(noVersion), { name: "local", url: "http://x", json: true });
    expect(code).toBe(ExitCode.OK);
    const parsed = JSON.parse(stdout()) as { skew: boolean };
    expect(parsed.skew).toBe(false);
  });
});

describe("target status", () => {
  it("resolves a thread and reports its runtime without ensuring new work", async () => {
    const { runTargetStatus } = await import("./status.js");
    const thread = { id: "t1", sessionId: "s1", title: "Review", createdAt: 1, archivedAt: null };
    const getSession = vi.fn().mockResolvedValue({ id: "s1", status: "running", runState: "working" });
    expect(await runTargetStatus({ getThread: async () => thread, getSession }, { name: "local", url: "http://x", json: true, threadId: "t1" })).toBe(ExitCode.OK);
    expect(getSession).toHaveBeenCalledWith("s1");
    expect(JSON.parse(stdout())).toMatchObject({ thread, runtime: { id: "s1" } });
  });

  it("retains explicit runtime status and rejects mismatched targets", async () => {
    const { runTargetStatus } = await import("./status.js");
    const getThread = vi.fn().mockResolvedValue({ id: "t1", sessionId: "other" });
    const getSession = vi.fn().mockResolvedValue({ id: "s1", status: "running", runState: "idle" });
    const input = { name: "local", url: "http://x", json: true, sessionId: "s1" };
    expect(await runTargetStatus({ getThread, getSession }, input)).toBe(ExitCode.OK);
    expect(getThread).not.toHaveBeenCalled();
    getSession.mockClear();
    expect(await runTargetStatus({ getThread, getSession }, { ...input, threadId: "t1" })).toBe(ExitCode.Usage);
    expect(getSession).not.toHaveBeenCalled();
  });
});

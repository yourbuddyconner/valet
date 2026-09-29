import { afterEach, expect, it, vi } from "vitest";
import { runThreads } from "./threads.js";
import { parseGlobalFlags } from "../output.js";

afterEach(() => vi.restoreAllMocks());
it("creates a thread in the selected workspace without creating a standalone runtime", async () => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const create = vi.fn(async () => ({ id: "thread-1", sessionId: "runtime-1", createdAt: 1, lastUserActivityAt: 1 }));
  const code = await runThreads({ createWorkspaceThread: create, listWorkspaceThreads: async () => ({ threads: [] }), getThread: async () => ({ id: "thread-1", sessionId: "runtime-1", title: null, createdAt: 1, archivedAt: null }) }, parseGlobalFlags(["new", "--workspace", "team-1", "--title", "Release"]));
  expect(code).toBe(0);
  expect(create).toHaveBeenCalledWith({ title: "Release" }, "team-1");
});

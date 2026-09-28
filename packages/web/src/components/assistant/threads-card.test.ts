import { describe, expect, it } from "vitest";
import type { ChildWorkSummary, ThreadSummary } from "@valet/api/wire";
import { threadActivity } from "./threads-card";

function thread(id: string, createdAt: number, title?: string): ThreadSummary {
  return { id, sessionId: "s1", title, createdAt, lastUserActivityAt: createdAt };
}

function child(parentThreadId: string, status: ChildWorkSummary["status"]): ChildWorkSummary {
  return {
    sessionId: `c-${Math.abs(parentThreadId.length * 7)}-${status}`,
    parentThreadId,
    title: "child",
    status,
  } as ChildWorkSummary;
}

describe("threadActivity", () => {
  it("orders newest-first and caps at the limit", () => {
    const rows = threadActivity(
      [thread("a", 1), thread("b", 3), thread("c", 2)],
      [],
      2,
    );
    expect(rows.map((r) => r.thread.id)).toEqual(["b", "c"]);
  });

  it("joins running/settled child counts per thread", () => {
    const rows = threadActivity(
      [thread("a", 2), thread("b", 1)],
      [child("a", "running"), child("a", "settled"), child("b", "settled")],
    );
    expect(rows[0]).toMatchObject({ running: 1, settled: 1 });
    expect(rows[1]).toMatchObject({ running: 0, settled: 1 });
  });

  it("returns zero counts for threads with no children", () => {
    const rows = threadActivity([thread("a", 1)], []);
    expect(rows[0]).toMatchObject({ running: 0, settled: 0 });
  });
});

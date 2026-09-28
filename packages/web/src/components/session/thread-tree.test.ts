/**
 * Thread tree pure logic (decision 12): grouping children by the thread
 * that spawned them, and the status-dot class mapping. No DOM — the
 * component itself pulls from three live queries (orchestrator info,
 * threads, children) plus router search state, so these are extracted
 * precisely so they're testable without mounting all of that.
 */
import { describe, expect, it } from "vitest";
import type { DecisionGate, ChildWorkSummary, ThreadSummary } from "@valet/api/wire";
import { defaultThreadId } from "~/lib/thread-default";
import {
  childStatusDotClassName,
  groupChildrenByThread,
  hasGateOutsideList,
  sortThreads,
  threadIdsWithPendingGates,
  untitledThreadLabel,
  visibleThreads,
} from "./thread-tree";

function child(overrides: Partial<ChildWorkSummary> = {}): ChildWorkSummary {
  return {
    sessionId: "child-1",
    title: "fix-auth",
    parentThreadId: "thread-1",
    status: "running",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("groupChildrenByThread", () => {
  it("groups children under their parentThreadId", () => {
    const children = [
      child({ sessionId: "c1", parentThreadId: "thread-1" }),
      child({ sessionId: "c2", parentThreadId: "thread-1" }),
      child({ sessionId: "c3", parentThreadId: "thread-2" }),
    ];
    const grouped = groupChildrenByThread(children);
    expect(grouped.get("thread-1")?.map((c) => c.sessionId)).toEqual(["c1", "c2"]);
    expect(grouped.get("thread-2")?.map((c) => c.sessionId)).toEqual(["c3"]);
  });

  it("returns an empty map for no children", () => {
    expect(groupChildrenByThread([])).toEqual(new Map());
  });

  it("threads with no children simply have no entry", () => {
    const grouped = groupChildrenByThread([child({ parentThreadId: "thread-1" })]);
    expect(grouped.has("thread-2")).toBe(false);
  });
});

describe("childStatusDotClassName", () => {
  it("running gets the moss pulse class", () => {
    expect(childStatusDotClassName("running")).toContain("bg-moss");
    expect(childStatusDotClassName("running")).toContain("animate-pulse");
  });

  it("settled gets the muted class, no pulse", () => {
    const cls = childStatusDotClassName("settled");
    expect(cls).toContain("bg-muted");
    expect(cls).not.toContain("animate-pulse");
  });
});

/**
 * TKAI-258: the gate card and header badge are scoped to the active thread,
 * so this set is what tells the tree to mark OTHER threads that are blocked
 * on a decision.
 */
describe("threadIdsWithPendingGates", () => {
  const gate = (id: string, threadId: string): DecisionGate => ({
    id,
    sessionId: "s1",
    threadId,
    type: "approval",
    title: "Approve the deploy",
    actions: [{ id: "approve", label: "Approve" }],
    status: "pending",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });

  it("collects the threadId of each pending gate", () => {
    const ids = threadIdsWithPendingGates({
      g1: gate("g1", "thread-a"),
      g2: gate("g2", "thread-b"),
    });
    expect(ids).toEqual(new Set(["thread-a", "thread-b"]));
  });

  it("dedupes multiple gates on one thread", () => {
    const ids = threadIdsWithPendingGates({
      g1: gate("g1", "thread-a"),
      g2: gate("g2", "thread-a"),
    });
    expect(ids).toEqual(new Set(["thread-a"]));
  });

  it("returns an empty set for no gates and for an unseeded store slice", () => {
    expect(threadIdsWithPendingGates({})).toEqual(new Set());
    expect(threadIdsWithPendingGates(undefined)).toEqual(new Set());
  });
});

/**
 * A gated thread is exempt from the origin-bucket and search filters:
 * hiding its row would hide the only in-session surface for the gate,
 * which is the gap TKAI-258 closes.
 */
describe("visibleThreads", () => {
  const t = (id: string, key: string, title: string): ThreadSummary => ({
    id,
    sessionId: "s1",
    title,
    createdAt: 1_000,
    lastUserActivityAt: 1_000,
    key,
  });
  const threads = [
    t("t-web", "web:1", "Plan the launch"),
    t("t-auto", "signal:workflow:r1", "Nightly digest"),
  ];

  it("applies bucket and search filters when no gates are pending", () => {
    expect(visibleThreads(threads, "chat", "", new Set()).map((x) => x.id)).toEqual(["t-web"]);
    expect(visibleThreads(threads, "all", "digest", new Set()).map((x) => x.id)).toEqual(["t-auto"]);
  });

  it("keeps a gated thread the bucket filter would hide", () => {
    const ids = visibleThreads(threads, "chat", "", new Set(["t-auto"])).map((x) => x.id);
    expect(ids).toEqual(["t-web", "t-auto"]);
  });

  it("keeps a gated thread the search query would hide, in original order", () => {
    const ids = visibleThreads(threads, "all", "digest", new Set(["t-web"])).map((x) => x.id);
    expect(ids).toEqual(["t-web", "t-auto"]);
  });
});

describe("hasGateOutsideList", () => {
  const t = (id: string): ThreadSummary => ({ id, sessionId: "s1", createdAt: 1_000, lastUserActivityAt: 1_000, key: "web:1" });

  it("true when a gate's thread is missing from the active list (archived)", () => {
    expect(hasGateOutsideList([t("a")], new Set(["archived-thread"]))).toBe(true);
  });

  it("false when every gated thread is listed, and for no gates", () => {
    expect(hasGateOutsideList([t("a")], new Set(["a"]))).toBe(false);
    expect(hasGateOutsideList([t("a")], new Set())).toBe(false);
  });
});

/**
 * The fallback label used to be `Thread ${index + 1}`. Threads sort newest
 * first, so creating one renumbered every row below it — a number that
 * claims an identity and then hands it to a different thread. At two
 * threads nobody notices; at thirty the whole list shifts.
 */
describe("untitledThreadLabel", () => {
  const t = (id: string, createdAt: number): ThreadSummary => ({
    id,
    sessionId: "s1",
    createdAt,
    lastUserActivityAt: createdAt,
    key: "web:1",
  });

  it("names the newest created thread for what it is", () => {
    expect(untitledThreadLabel(t("a", 1_000), true)).toBe("New thread");
  });

  it("uses a deterministic nonblank label while automatic naming is pending", () => {
    const older = t("b", 1_700_000_000_000);
    expect(untitledThreadLabel(older, false).trim()).not.toBe("");
  });

  it("distinguishes two untitled threads created at different times", () => {
    const a = t("a", 1_700_000_000_000);
    const b = t("b", 1_700_086_400_000);
    expect(untitledThreadLabel(a, false)).not.toBe(untitledThreadLabel(b, false));
  });
});
describe("sortThreads", () => {
  const thread = (id: string, createdAt: number, lastUserActivityAt: number): ThreadSummary => ({
    id,
    sessionId: "s1",
    createdAt,
    lastUserActivityAt,
    key: "web:1",
  });

  it("moves a user-updated older thread ahead without moving an agent-only thread", () => {
    const agentThread = thread("agent", 2_000, 2_000);
    const userThread = thread("user", 1_000, 3_000);
    expect(sortThreads([agentThread, userThread], "last-user-activity").map((t) => t.id)).toEqual([
      "user",
      "agent",
    ]);
  });

  it("preserves newest-first creation order when Created is selected", () => {
    const older = thread("older", 1_000, 5_000);
    const newer = thread("newer", 2_000, 2_000);
    expect(sortThreads([older, newer], "created").map((t) => t.id)).toEqual(["newer", "older"]);
  });

  it("keeps the newest created thread as the implicit selection in either sort order", () => {
    const olderActive = thread("older", 1_000, 5_000);
    const newer = thread("newer", 2_000, 2_000);
    expect(defaultThreadId(sortThreads([olderActive, newer], "last-user-activity"))).toBe("newer");
    expect(defaultThreadId(sortThreads([olderActive, newer], "created"))).toBe("newer");
  });
});

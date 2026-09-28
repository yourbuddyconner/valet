/**
 * `computeCollisions` (TKAI-294) — the containment lattice over symbolic
 * filter comparison: equal, superset, subset, partial overlap, disjoint,
 * plus the target policy (workflow fan-out allowed, cross-kind downgraded
 * to a warning) and the dead-key exclusions.
 */
import type { EventCatalogEntry } from "@valet/engine";
import { describe, expect, it } from "vitest";
import { computeCollisions, type CollisionCandidate } from "./collisions.js";
import type { SubscriptionFilter } from "./match.js";

function entry(key: string, fields: string[]): EventCatalogEntry {
  return {
    key,
    description: key,
    filters: fields.map((field) => ({ field, path: field, description: field })),
  };
}

const CATALOG: EventCatalogEntry[] = [
  entry("slack.app_mention", ["user", "channel"]),
  entry("slack.message", ["user", "channel", "text"]),
  entry("github.push", ["repo", "branch"]),
  entry("github.pull_request.opened", ["repo", "branch"]),
];

interface TestSub {
  id: string;
  name: string;
  eventKeys: string[];
  filters: SubscriptionFilter[];
  target: { kind: string; workflowId?: string; assistantId?: string };
}

function sub(over: Partial<TestSub> = {}): TestSub {
  return {
    id: "existing-1",
    name: "existing",
    eventKeys: ["slack.message"],
    filters: [],
    target: { kind: "orchestrator" },
    ...over,
  };
}

function candidate(over: Partial<CollisionCandidate> = {}): CollisionCandidate {
  return {
    eventKeys: ["slack.message"],
    filters: [],
    target: { kind: "orchestrator" },
    ...over,
  };
}

const chEq = (v: string): SubscriptionFilter => ({ field: "channel", op: "eq", value: v });
const chIn = (v: string[]): SubscriptionFilter => ({ field: "channel", op: "in", value: v });

describe("computeCollisions — containment lattice", () => {
  it("blocks an unfiltered candidate over a channel-scoped rule (superset)", () => {
    const report = computeCollisions(
      candidate(),
      [sub({ filters: [chIn(["C1", "C2"])] })],
      CATALOG,
    );
    expect(report.blocking).toHaveLength(1);
    expect(report.blocking[0].relation).toBe("superset");
    expect(report.blocking[0].sharedKeys).toEqual(["slack.message"]);
    expect(report.overlapping).toHaveLength(0);
  });

  it("blocks an identical rule (equal)", () => {
    const report = computeCollisions(
      candidate({ filters: [chEq("C1")] }),
      [sub({ filters: [chEq("C1")] })],
      CATALOG,
    );
    expect(report.blocking).toHaveLength(1);
    expect(report.blocking[0].relation).toBe("equal");
  });

  it("warns when the candidate is the narrower rule (subset)", () => {
    const report = computeCollisions(
      candidate({ filters: [chEq("C1")] }),
      [sub({ filters: [chIn(["C1", "C2"])] })],
      CATALOG,
    );
    expect(report.blocking).toHaveLength(0);
    expect(report.overlapping).toHaveLength(1);
    expect(report.overlapping[0].relation).toBe("subset");
  });

  it("warns on a partial overlap (neither contains the other)", () => {
    const report = computeCollisions(
      candidate({ filters: [chIn(["C1", "C3"])] }),
      [sub({ filters: [chIn(["C1", "C2"])] })],
      CATALOG,
    );
    expect(report.overlapping).toHaveLength(1);
    expect(report.overlapping[0].relation).toBe("partial");
  });

  it("reports nothing for provably disjoint channel sets", () => {
    const report = computeCollisions(
      candidate({ filters: [chEq("C1")] }),
      [sub({ filters: [chEq("C2")] })],
      CATALOG,
    );
    expect(report.blocking).toHaveLength(0);
    expect(report.overlapping).toHaveLength(0);
  });

  it("reports nothing when a filter field's whole set is empty (empty in list)", () => {
    const report = computeCollisions(candidate({ filters: [chIn([])] }), [sub()], CATALOG);
    expect(report.blocking).toHaveLength(0);
    expect(report.overlapping).toHaveLength(0);
  });

  it("proves eq ⊆ prefix and prefix ⊆ contains implications", () => {
    const repoEq: SubscriptionFilter = { field: "repo", op: "eq", value: "acme/widgets" };
    const repoPrefix: SubscriptionFilter = { field: "repo", op: "prefix", value: "acme/" };
    const repoContains: SubscriptionFilter = { field: "repo", op: "contains", value: "acme" };
    const gh = { eventKeys: ["github.push"] };

    const bySubset = computeCollisions(
      candidate({ ...gh, filters: [repoEq] }),
      [sub({ ...gh, filters: [repoPrefix] })],
      CATALOG,
    );
    expect(bySubset.overlapping[0]?.relation).toBe("subset");

    const byPrefix = computeCollisions(
      candidate({ ...gh, filters: [repoContains] }),
      [sub({ ...gh, filters: [repoPrefix] })],
      CATALOG,
    );
    expect(byPrefix.blocking[0]?.relation).toBe("superset");
  });

  it("treats disjoint prefixes as no collision", () => {
    const report = computeCollisions(
      candidate({ eventKeys: ["github.push"], filters: [{ field: "repo", op: "prefix", value: "acme/" }] }),
      [sub({ eventKeys: ["github.push"], filters: [{ field: "repo", op: "prefix", value: "beta/" }] })],
      CATALOG,
    );
    expect(report.blocking).toHaveLength(0);
    expect(report.overlapping).toHaveLength(0);
  });

  it("a regex filter can prove nothing: never blocking, still a warning", () => {
    const report = computeCollisions(
      candidate({ filters: [{ field: "channel", op: "regex", value: "^C1$" }] }),
      [sub({ filters: [chEq("C1")] })],
      CATALOG,
    );
    expect(report.blocking).toHaveLength(0);
    expect(report.overlapping).toHaveLength(1);
    expect(report.overlapping[0].relation).toBe("partial");
  });

  it("an unfiltered candidate still contains a regex-filtered rule", () => {
    const report = computeCollisions(
      candidate(),
      [sub({ filters: [{ field: "channel", op: "regex", value: "^C" }] })],
      CATALOG,
    );
    expect(report.blocking[0]?.relation).toBe("superset");
  });
});

describe("computeCollisions — event keys", () => {
  it("reports nothing when the key sets do not intersect", () => {
    const report = computeCollisions(
      candidate({ eventKeys: ["github.push"] }),
      [sub({ eventKeys: ["slack.message"] })],
      CATALOG,
    );
    expect(report.blocking).toHaveLength(0);
    expect(report.overlapping).toHaveLength(0);
  });

  it("expands trailing wildcards through the catalog", () => {
    const report = computeCollisions(
      candidate({ eventKeys: ["github.*"] }),
      [sub({ eventKeys: ["github.push"] })],
      CATALOG,
    );
    expect(report.blocking).toHaveLength(1);
    expect(report.blocking[0].sharedKeys).toEqual(["github.push"]);
  });

  it("drops a key one side can never match (undeclared filter field)", () => {
    // `text` is declared by slack.message only; a rule filtering on it never
    // matches slack.app_mention, so the pair shares no effective key.
    const report = computeCollisions(
      candidate({
        eventKeys: ["slack.app_mention"],
        filters: [{ field: "user", op: "eq", value: "U1" }],
      }),
      [
        sub({
          eventKeys: ["slack.app_mention"],
          filters: [
            { field: "user", op: "eq", value: "U1" },
            { field: "text", op: "contains", value: "deploy" },
          ],
        }),
      ],
      CATALOG,
    );
    expect(report.blocking).toHaveLength(0);
    expect(report.overlapping).toHaveLength(0);
  });

  it("ignores a mention rule with no user filter (it fails closed at match time)", () => {
    const report = computeCollisions(
      candidate({
        eventKeys: ["slack.app_mention"],
        filters: [{ field: "user", op: "eq", value: "U1" }],
      }),
      [sub({ eventKeys: ["slack.app_mention"], filters: [] })],
      CATALOG,
    );
    expect(report.blocking).toHaveLength(0);
    expect(report.overlapping).toHaveLength(0);
  });

  it("two creators' mention rules are disjoint on the user filter", () => {
    const mention = (user: string, channels: string[]) => ({
      eventKeys: ["slack.app_mention"],
      filters: [
        { field: "user", op: "eq", value: user } satisfies SubscriptionFilter,
        chIn(channels),
      ],
    });
    const report = computeCollisions(
      candidate(mention("U1", ["C1"])),
      [sub(mention("U2", ["C1"]))],
      CATALOG,
    );
    expect(report.blocking).toHaveLength(0);
    expect(report.overlapping).toHaveLength(0);
  });
});

describe("computeCollisions — target policy", () => {
  const wf = (workflowId: string) => ({ kind: "workflow", workflowId });

  it("allows identical coverage aimed at two DIFFERENT workflows (fan-out)", () => {
    const report = computeCollisions(
      candidate({ target: wf("wf-a") }),
      [sub({ target: wf("wf-b") })],
      CATALOG,
    );
    expect(report.blocking).toHaveLength(0);
    expect(report.overlapping).toHaveLength(0);
  });

  it("blocks identical coverage aimed at the SAME workflow", () => {
    const report = computeCollisions(
      candidate({ target: wf("wf-a") }),
      [sub({ target: wf("wf-a") })],
      CATALOG,
    );
    expect(report.blocking).toHaveLength(1);
  });

  // The assistant arm of the same fan-out rule the workflow cases above prove:
  // telling two named assistants about one event is deliberate, not a clobber.
  it("blocks duplicate workspace delivery even when stale targets name different assistants", () => {
    const report = computeCollisions(
      candidate({ target: { kind: "orchestrator", assistantId: "a-ops" } }),
      [sub({ target: { kind: "orchestrator", assistantId: "a-eng" } })],
      CATALOG,
    );
    expect(report.blocking).toHaveLength(1);
    expect(report.overlapping).toHaveLength(0);
  });

  it("blocks identical coverage aimed at the SAME assistant", () => {
    const report = computeCollisions(
      candidate({ target: { kind: "orchestrator", assistantId: "a-ops" } }),
      [sub({ target: { kind: "orchestrator", assistantId: "a-ops" } })],
      CATALOG,
    );
    expect(report.blocking).toHaveLength(1);
  });

  it("still blocks when one side names no assistant: it may BE the other", () => {
    // An absent id means the owner's default, which the named rule may also
    // resolve to. Nothing here can tell, so the pair keeps blocking.
    const report = computeCollisions(
      candidate({ target: { kind: "orchestrator", assistantId: "a-ops" } }),
      [sub({ target: { kind: "orchestrator" } })],
      CATALOG,
    );
    expect(report.blocking).toHaveLength(1);
  });

  it("downgrades a workflow↔orchestrator superset to a warning", () => {
    const report = computeCollisions(
      candidate({ target: wf("wf-a") }),
      [sub({ filters: [chEq("C1")], target: { kind: "orchestrator" } })],
      CATALOG,
    );
    expect(report.blocking).toHaveLength(0);
    expect(report.overlapping).toHaveLength(1);
    expect(report.overlapping[0].relation).toBe("superset");
  });

  it("reports each colliding row separately", () => {
    const report = computeCollisions(
      candidate(),
      [
        sub({ id: "a", filters: [chEq("C1")] }),
        sub({ id: "b", filters: [chEq("C2")] }),
        sub({ id: "c", eventKeys: ["github.push"] }),
      ],
      CATALOG,
    );
    expect(report.blocking.map((b) => b.subscription.id).sort()).toEqual(["a", "b"]);
    expect(report.overlapping).toHaveLength(0);
  });
});


describe("team mention collisions", () => {
  it("detects overlapping team rules without creator filters, including interim rows", () => {
    const candidate: CollisionCandidate = {
      ownerType: "team", eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "eq", value: "C1" }], target: { kind: "orchestrator" },
    };
    const existing = { ...candidate, filters: [...candidate.filters, { field: "user", op: "eq", value: "U_CREATOR" } satisfies SubscriptionFilter] };
    expect(computeCollisions(candidate, [existing], CATALOG).blocking).toHaveLength(1);
    expect(computeCollisions(existing, [candidate], CATALOG).blocking).toHaveLength(1);
  });
});

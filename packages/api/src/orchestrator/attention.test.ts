/**
 * Attention router (Phase 4 decision 19): the pure audience-resolution
 * matrix (`resolveAudience`, no DB) plus `routeAttention`'s DB-backed
 * behavior (preference gating, idempotent insert) over a real
 * `bootTestApi()` stack.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import {
  principalFromOwner,
  resolveAudience,
  routeAttention,
  type AttentionChannelDeliverer,
  type AttentionEvent,
} from "./attention.js";
import { notifications, orgMembers, teamMembers, teams, userNotificationPreferences } from "../schema/index.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("principalFromOwner (pure)", () => {
  it("accepts the three owner types a principal can have", () => {
    expect(principalFromOwner({ ownerType: "user", ownerId: "u1" })).toEqual({ type: "user", id: "u1" });
    expect(principalFromOwner({ ownerType: "team", ownerId: "t1" })).toEqual({ type: "team", id: "t1" });
    expect(principalFromOwner({ ownerType: "org", ownerId: "o1" })).toEqual({ type: "org", id: "o1" });
  });

  it("rejects an absent owner and an owner type it cannot resolve an audience for", () => {
    expect(principalFromOwner(undefined)).toBeUndefined();
    expect(principalFromOwner({ ownerType: "robot", ownerId: "r1" })).toBeUndefined();
  });
});

describe("resolveAudience (pure)", () => {
  it("user owner resolves to just that user", () => {
    expect(resolveAudience({ type: "user", id: "u1" }, "notification", {})).toEqual(["u1"]);
  });

  it("team owner resolves to every member for non-escalation kinds", () => {
    const membership = {
      teamMembers: [
        { userId: "u1", role: "admin" as const },
        { userId: "u2", role: "member" as const },
      ],
    };
    expect(resolveAudience({ type: "team", id: "t1" }, "approval", membership).sort()).toEqual(["u1", "u2"]);
  });

  it("team owner narrows to admins only for escalation kind", () => {
    const membership = {
      teamMembers: [
        { userId: "u1", role: "admin" as const },
        { userId: "u2", role: "member" as const },
      ],
    };
    expect(resolveAudience({ type: "team", id: "t1" }, "escalation", membership)).toEqual(["u1"]);
  });

  it("org owner resolves to org admins from membership", () => {
    const membership = { orgAdmins: ["a1", "a2"] };
    expect(resolveAudience({ type: "org", id: "o1" }, "notification", membership)).toEqual(["a1", "a2"]);
  });

  it("org owner with no admins in membership resolves to an empty audience", () => {
    expect(resolveAudience({ type: "org", id: "o1" }, "escalation", {})).toEqual([]);
  });
});

describe("routeAttention (DB-backed)", () => {
  it("inserts one notification per audience member for a user owner", async () => {
    api = await bootTestApi();
    const { db } = api.providers;

    await routeAttention(
      { db },
      { kind: "notification", owner: { type: "user", id: "local-user" }, title: "hello" },
    );

    const rows = await db.select().from(notifications).where(eq(notifications.userId, "local-user"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("hello");
    expect(rows[0]?.readAt).toBeNull();
  });

  it("routes to a team's admins only for escalation, and to all members otherwise", async () => {
    api = await bootTestApi();
    const { db } = api.providers;

    const now = Date.now();
    await db.insert(teams).values({ id: "team-1", orgId: "local-org", name: "Platform", createdAt: now });
    await db
      .insert(teamMembers)
      .values([
        { teamId: "team-1", userId: "local-user", role: "admin" },
        { teamId: "team-1", userId: "test-member", role: "member" },
      ]);

    await routeAttention({ db }, { kind: "escalation", owner: { type: "team", id: "team-1" }, title: "stuck" });
    const escalationRecipients = await db.select().from(notifications).where(eq(notifications.kind, "escalation"));
    expect(escalationRecipients.map((r) => r.userId)).toEqual(["local-user"]);

    await routeAttention({ db }, { kind: "notification", owner: { type: "team", id: "team-1" }, title: "fyi" });
    const fyiRecipients = await db.select().from(notifications).where(eq(notifications.kind, "notification"));
    expect(fyiRecipients.map((r) => r.userId).sort()).toEqual(["local-user", "test-member"]);
  });

  it("routes to org admins for an org owner", async () => {
    api = await bootTestApi();
    const { db } = api.providers;

    await routeAttention({ db }, { kind: "notification", owner: { type: "org", id: "local-org" }, title: "org-wide" });
    const rows = await db.select().from(notifications).where(eq(notifications.kind, "notification"));
    // local-user and test-admin are seeded org admins (see _setup.ts); test-member is not.
    expect(rows.map((r) => r.userId).sort()).toEqual(["local-user", "test-admin"]);
  });

  it("skips a user who disabled web delivery for the kind (default is enabled)", async () => {
    api = await bootTestApi();
    const { db } = api.providers;

    await db
      .insert(userNotificationPreferences)
      .values({ userId: "local-user", kind: "notification", web: false });

    await routeAttention(
      { db },
      { kind: "notification", owner: { type: "user", id: "local-user" }, title: "should be skipped" },
    );
    await routeAttention(
      { db },
      { kind: "escalation", owner: { type: "user", id: "local-user" }, title: "should land (different kind)" },
    );

    const rows = await db.select().from(notifications).where(eq(notifications.userId, "local-user"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("escalation");
  });

  it("skips a kind disabled via PUT /api/notifications/preferences (route-driven)", async () => {
    api = await bootTestApi();
    const { db } = api.providers;

    const putRes = await fetch(`${api.baseUrl}/api/notifications/preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "notification", web: false }),
    });
    expect(putRes.status).toBe(200);

    await routeAttention(
      { db },
      { kind: "notification", owner: { type: "user", id: "local-user" }, title: "should be skipped" },
    );
    await routeAttention(
      { db },
      { kind: "escalation", owner: { type: "user", id: "local-user" }, title: "should land" },
    );

    const rows = await db.select().from(notifications).where(eq(notifications.userId, "local-user"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("escalation");
  });

  it("is idempotent when the same dedupeKey fires twice", async () => {
    api = await bootTestApi();
    const { db } = api.providers;

    const event = {
      kind: "escalation" as const,
      owner: { type: "user" as const, id: "local-user" },
      title: "stuck submission",
      dedupeKey: "queue-item-1",
    };
    await routeAttention({ db }, event);
    await routeAttention({ db }, event);

    const rows = await db.select().from(notifications).where(eq(notifications.userId, "local-user"));
    expect(rows).toHaveLength(1);
  });

  it("calls each channel deliverer once per recipient", async () => {
    api = await bootTestApi();
    const { db } = api.providers;

    await db.insert(teams).values({ id: "team-2", orgId: "local-org", name: "Deliverers", createdAt: Date.now() });
    await db
      .insert(teamMembers)
      .values([
        { teamId: "team-2", userId: "local-user", role: "admin" },
        { teamId: "team-2", userId: "test-member", role: "member" },
      ]);

    const teamCalls: AttentionEvent[] = [];
    const calls: Array<{ userId: string; event: AttentionEvent }> = [];
    const stub: AttentionChannelDeliverer = {
      deliverTeam: async (event) => { teamCalls.push(event); },
      deliver: async (userId, event) => {
        calls.push({ userId, event });
      },
    };

    await routeAttention(
      { db, channels: [stub] },
      { kind: "notification", owner: { type: "team", id: "team-2" }, title: "fanout" },
    );

    expect(calls).toHaveLength(0);
    expect(teamCalls).toHaveLength(1);
    await db.insert(userNotificationPreferences).values({ userId: "local-user", kind: "notification", web: true, teamDm: true });
    await routeAttention({ db, channels: [stub] }, { kind: "notification", owner: { type: "team", id: "team-2" }, title: "fanout" });
    expect(calls.map((c) => c.userId)).toEqual(["local-user"]);
    expect(calls.every((c) => c.event.title === "fanout")).toBe(true);
    await db.delete(orgMembers).where(eq(orgMembers.userId, "local-user"));
    await routeAttention({ db, channels: [stub] }, { kind: "notification", owner: { type: "team", id: "team-2" }, title: "removed" });
    expect(calls).toHaveLength(1);

  });

  it("a rejecting deliverer does not prevent notification inserts or other deliverers", async () => {
    api = await bootTestApi();
    const { db } = api.providers;

    const rejecting: AttentionChannelDeliverer = {
      deliver: async () => {
        throw new Error("boom");
      },
    };
    const calls: string[] = [];
    const ok: AttentionChannelDeliverer = {
      deliver: async (userId) => {
        calls.push(userId);
      },
    };

    await routeAttention(
      { db, channels: [rejecting, ok] },
      { kind: "notification", owner: { type: "user", id: "local-user" }, title: "resilient" },
    );

    // Give the fire-and-forget deliverers a turn to settle.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const rows = await db.select().from(notifications).where(eq(notifications.userId, "local-user"));
    expect(rows).toHaveLength(1);
    expect(calls).toEqual(["local-user"]);
  });
});

/**
 * Attention router wiring (Phase 4 decision 19 "wired producers"): drives
 * the shared EventStream with synthetic `submission_stuck` and
 * `decision_gate` BusEvents (no real LLM turn needed — the wiring only
 * cares about the event shape and the durable session rows) and asserts
 * the resulting `notifications` rows.
 */
import { assistantSessionId, type BusEvent, type SessionData } from "@valet/engine";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { notifications } from "../schema/index.js";
import { wireAttentionRouter } from "./attention-wiring.js";
import type { AttentionEvent } from "./attention.js";

let api: TestApi | undefined;
let unsub: (() => void) | undefined;

afterEach(async () => {
  unsub?.();
  unsub = undefined;
  await api?.cleanup();
  api = undefined;
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor: timed out");
}

function baseSession(overrides: Partial<SessionData> & { id: string }): SessionData {
  const now = Date.now();
  return {
    userId: "local-user",
    orgId: "local-org",
    workspace: "/tmp/does-not-matter",
    purpose: "interactive",
    status: "running",
    owner: { type: "user", id: "local-user" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** A pending-gate BusEvent on `sessionId`, shaped as the engine emits it. */
function gateEvent(sessionId: string, gateId: string, title: string): BusEvent {
  const now = Date.now();
  return {
    sessionId,
    threadId: "th-1",
    timestamp: now,
    event: {
      type: "decision_gate",
      threadId: "th-1",
      gate: {
        id: gateId,
        sessionId,
        threadId: "th-1",
        queueItemId: "qi-1",
        resumeKey: "resume-1",
        ordinal: 1,
        type: "approval",
        title,
        actions: [{ id: "approve", label: "Approve" }],
        status: "pending",
        createdAt: now,
        updatedAt: now,
      },
    },
  };
}

/** A terminal-gate BusEvent on `sessionId`, shaped as the engine emits it. */
function gateSettledEvent(
  sessionId: string,
  gateId: string,
  type: "decision_gate_resolved" | "decision_gate_expired" | "decision_gate_withdrawn",
): BusEvent {
  const base = { sessionId, threadId: "th-1", timestamp: Date.now() };
  if (type === "decision_gate_resolved") {
    return {
      ...base,
      event: {
        type,
        threadId: "th-1",
        gateId,
        resolution: { actionId: "approve", resolvedBy: "local-user", resolvedAt: Date.now() },
      },
    };
  }
  if (type === "decision_gate_withdrawn") {
    return { ...base, event: { type, threadId: "th-1", gateId, reason: "cancel" } };
  }
  return { ...base, event: { type, threadId: "th-1", gateId } };
}

describe("wireAttentionRouter", () => {
  it("submission_stuck produces an escalation notification for the session's owner", async () => {
    api = await bootTestApi();
    const { db, engineStore, eventStream } = api.providers;
    unsub = wireAttentionRouter({ db, engineStore, eventStream });

    const sessionId = `sess-${randomUUID()}`;
    await engineStore.saveSession(baseSession({ id: sessionId }));

    const event: BusEvent = {
      sessionId,
      threadId: "th-1",
      queueItemId: "qi-1",
      timestamp: Date.now(),
      event: {
        type: "submission_stuck",
        sessionId,
        threadId: "th-1",
        queueItemId: "qi-1",
        attemptCount: 3,
        ageMs: 900_000,
      },
    };
    await eventStream.append(event, `test-stuck-${randomUUID()}`);

    await waitFor(async () => {
      const rows = await db.select().from(notifications).where(eq(notifications.kind, "escalation"));
      return rows.length > 0;
    });

    const rows = await db.select().from(notifications).where(eq(notifications.kind, "escalation"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe("local-user");
    expect(rows[0]?.sessionId).toBe(sessionId);
    expect(rows[0]?.href).toBe(`/sessions/${encodeURIComponent(sessionId)}?thread=th-1`);

    // Re-emitting the same stuck alarm (same queueItemId) must not double-insert.
    await eventStream.append(event, `test-stuck-again-${randomUUID()}`);
    await new Promise((r) => setTimeout(r, 100));
    const rowsAfter = await db.select().from(notifications).where(eq(notifications.kind, "escalation"));
    expect(rowsAfter).toHaveLength(1);
  });

  it("decision_gate on a child session routes an approval to the parent's owner with a child href", async () => {
    api = await bootTestApi();
    const { db, engineStore, eventStream } = api.providers;
    unsub = wireAttentionRouter({ db, engineStore, eventStream });

    const parentSessionId = `parent-${randomUUID()}`;
    const childSessionId = `child-${randomUUID()}`;
    // Use a user-owner parent so audience resolution needs no membership fixture.
    await engineStore.saveSession(
      baseSession({ id: parentSessionId, owner: { type: "user", id: "local-user" }, purpose: "orchestrator" }),
    );
    await engineStore.saveSession(
      baseSession({
        id: childSessionId,
        owner: { type: "user", id: "local-user" },
        purpose: "child",
        parentSessionId,
        parentThreadId: "th-parent",
      }),
    );

    const gateId = `gate-${randomUUID()}`;
    const event: BusEvent = {
      sessionId: childSessionId,
      threadId: "th-child",
      timestamp: Date.now(),
      event: {
        type: "decision_gate",
        threadId: "th-child",
        gate: {
          id: gateId,
          sessionId: childSessionId,
          threadId: "th-child",
          queueItemId: "qi-child",
          resumeKey: "resume-1",
          ordinal: 1,
          type: "approval",
          title: "Approve deploy?",
          body: "The child wants to deploy.",
          actions: [{ id: "approve", label: "Approve" }],
          status: "pending",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    };
    await eventStream.append(event, `test-gate-${randomUUID()}`);

    await waitFor(async () => {
      const rows = await db.select().from(notifications).where(eq(notifications.kind, "approval"));
      return rows.length > 0;
    });

    const rows = await db.select().from(notifications).where(eq(notifications.kind, "approval"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe("local-user");
    expect(rows[0]?.title).toBe("Approve deploy?");
    expect(rows[0]?.sessionId).toBe(childSessionId);
    expect(rows[0]?.href).toBe(`/sessions/${encodeURIComponent(childSessionId)}?thread=th-child`);
  });

  it("decision_gate hands the gate's id and actions to channel deliverers", async () => {
    api = await bootTestApi();
    const { db, engineStore, eventStream } = api.providers;
    const delivered: AttentionEvent[] = [];
    unsub = wireAttentionRouter({
      db,
      engineStore,
      eventStream,
      channels: [
        {
          deliver: async (_userId, event) => {
            delivered.push(event);
          },
        },
      ],
    });

    const sessionId = `sess-${randomUUID()}`;
    await engineStore.saveSession(baseSession({ id: sessionId }));
    const gateId = `gate-${randomUUID()}`;
    await eventStream.append(gateEvent(sessionId, gateId, "Approve the tool call?"), `test-gate-${randomUUID()}`);

    await waitFor(async () => delivered.length > 0);
    expect(delivered[0]?.gate).toEqual({ id: gateId, actions: [{ id: "approve", label: "Approve" }] });
    expect(delivered[0]?.sessionId).toBe(sessionId);
  });

  it("decision_gate with tool context delivers a digested body and labeled fields, not raw JSON", async () => {
    api = await bootTestApi();
    const { db, engineStore, eventStream } = api.providers;
    const delivered: AttentionEvent[] = [];
    unsub = wireAttentionRouter({
      db,
      engineStore,
      eventStream,
      channels: [
        {
          deliver: async (_userId, event) => {
            delivered.push(event);
          },
        },
      ],
    });

    const sessionId = `sess-${randomUUID()}`;
    await engineStore.saveSession(baseSession({ id: sessionId }));
    const gateId = `gate-${randomUUID()}`;
    const event = gateEvent(sessionId, gateId, "Approve Do Thing?");
    if (event.event.type === "decision_gate") {
      event.event.gate.body = 'do it\n\ntool_id=fake.do_thing\nargs={"a":1}';
      event.event.gate.context = {
        riskLevel: "high",
        service: "fake",
        tool_id: "fake.do_thing",
        args: { a: 1 },
        summary: "do it",
      };
    }
    await eventStream.append(event, `test-gate-${randomUUID()}`);

    await waitFor(async () => delivered.length > 0);
    expect(delivered[0]?.body).toBe("do it");
    expect(delivered[0]?.gate?.fields).toEqual([
      { label: "Tool", value: "`fake.do_thing`" },
      { label: "Risk", value: "high" },
      { label: "a", value: "1" },
    ]);
    // The stored notification row gets the digested body too.
    const rows = await db.select().from(notifications).where(eq(notifications.kind, "approval"));
    expect(rows[0]?.body).toBe("do it");
    expect(rows[0]?.body).not.toContain("args=");
  });

  it("decision_gate on a standalone session routes an approval to that session's own owner", async () => {
    api = await bootTestApi();
    const { db, engineStore, eventStream } = api.providers;
    unsub = wireAttentionRouter({ db, engineStore, eventStream });

    const sessionId = `sess-${randomUUID()}`;
    await engineStore.saveSession(baseSession({ id: sessionId, purpose: "interactive" }));

    const gateId = `gate-${randomUUID()}`;
    await eventStream.append(
      gateEvent(sessionId, gateId, "Approve something?"),
      `test-gate-standalone-${randomUUID()}`,
    );

    await waitFor(async () => {
      const rows = await db.select().from(notifications).where(eq(notifications.kind, "approval"));
      return rows.length > 0;
    });

    const rows = await db.select().from(notifications).where(eq(notifications.kind, "approval"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe("local-user");
    expect(rows[0]?.title).toBe("Approve something?");
    expect(rows[0]?.sessionId).toBe(sessionId);
    expect(rows[0]?.href).toBe(`/sessions/${encodeURIComponent(sessionId)}?thread=th-1`);
  });

  it("decision_gate on an assistant session routes an approval to that session's own owner", async () => {
    api = await bootTestApi();
    const { db, engineStore, eventStream } = api.providers;
    unsub = wireAttentionRouter({ db, engineStore, eventStream });

    const sessionId = assistantSessionId("asst_attention");
    await engineStore.saveSession(baseSession({ id: sessionId, purpose: "orchestrator" }));

    const gateId = `gate-${randomUUID()}`;
    await eventStream.append(
      gateEvent(sessionId, gateId, "Approve the assistant's plan?"),
      `test-gate-orchestrator-${randomUUID()}`,
    );

    await waitFor(async () => {
      const rows = await db.select().from(notifications).where(eq(notifications.kind, "approval"));
      return rows.length > 0;
    });

    const rows = await db.select().from(notifications).where(eq(notifications.kind, "approval"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe("local-user");
    expect(rows[0]?.sessionId).toBe(sessionId);
    // An assistant's conversation lives at /chat, and /sessions deliberately
    // excludes assistants — a /sessions link for one points at a surface
    // that does not list it. The `?assistant=` form also carries the owner
    // implicitly, so the reader lands in the right context instead of
    // looking at a conversation their current scope excludes.
    expect(rows[0]?.href).toBe("/chat?workspace=user&thread=th-1");
  });

  it("marks a gate's notification read when the gate resolves, and only that gate's", async () => {
    api = await bootTestApi();
    const { db, engineStore, eventStream } = api.providers;
    unsub = wireAttentionRouter({ db, engineStore, eventStream });

    const sessionId = `sess-${randomUUID()}`;
    await engineStore.saveSession(baseSession({ id: sessionId }));

    // The second gate's id is a LIKE-metacharacter trap for the first's:
    // without escaping, the prefix match `n-approval-g_1:...` would treat
    // `_` as "any character" and mark `gx1`'s row read too.
    const suffix = randomUUID();
    const gateId = `g_1:${suffix}`;
    const lookalikeId = `gx1:${suffix}`;
    await eventStream.append(gateEvent(sessionId, gateId, "Approve A?"), `test-a-${randomUUID()}`);
    await eventStream.append(
      gateEvent(sessionId, lookalikeId, "Approve B?"),
      `test-b-${randomUUID()}`,
    );

    await waitFor(async () => {
      const rows = await db.select().from(notifications).where(eq(notifications.kind, "approval"));
      return rows.length === 2;
    });

    await eventStream.append(
      gateSettledEvent(sessionId, gateId, "decision_gate_resolved"),
      `test-resolved-${randomUUID()}`,
    );

    await waitFor(async () => {
      const rows = await db.select().from(notifications).where(eq(notifications.id, `n-approval-${gateId}-local-user`));
      return rows[0]?.readAt != null;
    });

    const lookalike = await db
      .select()
      .from(notifications)
      .where(eq(notifications.id, `n-approval-${lookalikeId}-local-user`));
    expect(lookalike[0]?.readAt).toBeNull();
  });

  it("marks a gate's notification read when the gate expires or is withdrawn", async () => {
    api = await bootTestApi();
    const { db, engineStore, eventStream } = api.providers;
    unsub = wireAttentionRouter({ db, engineStore, eventStream });

    const sessionId = `sess-${randomUUID()}`;
    await engineStore.saveSession(baseSession({ id: sessionId }));

    const expiredId = `gate-${randomUUID()}`;
    const withdrawnId = `gate-${randomUUID()}`;
    await eventStream.append(gateEvent(sessionId, expiredId, "Approve C?"), `test-c-${randomUUID()}`);
    await eventStream.append(gateEvent(sessionId, withdrawnId, "Approve D?"), `test-d-${randomUUID()}`);

    await waitFor(async () => {
      const rows = await db.select().from(notifications).where(eq(notifications.kind, "approval"));
      return rows.length === 2;
    });

    await eventStream.append(
      gateSettledEvent(sessionId, expiredId, "decision_gate_expired"),
      `test-expired-${randomUUID()}`,
    );
    await eventStream.append(
      gateSettledEvent(sessionId, withdrawnId, "decision_gate_withdrawn"),
      `test-withdrawn-${randomUUID()}`,
    );

    await waitFor(async () => {
      const rows = await db.select().from(notifications).where(eq(notifications.kind, "approval"));
      return rows.length === 2 && rows.every((r) => r.readAt != null);
    });
  });

  it("decision_gate on a child whose parent row is gone falls back to the child's own owner", async () => {
    api = await bootTestApi();
    const { db, engineStore, eventStream } = api.providers;
    unsub = wireAttentionRouter({ db, engineStore, eventStream });

    const childSessionId = `child-${randomUUID()}`;
    await engineStore.saveSession(
      baseSession({
        id: childSessionId,
        purpose: "child",
        parentSessionId: `parent-${randomUUID()}`,
        parentThreadId: "th-parent",
      }),
    );

    const gateId = `gate-${randomUUID()}`;
    await eventStream.append(
      gateEvent(childSessionId, gateId, "Approve deploy?"),
      `test-gate-orphan-${randomUUID()}`,
    );

    await waitFor(async () => {
      const rows = await db.select().from(notifications).where(eq(notifications.kind, "approval"));
      return rows.length > 0;
    });

    const rows = await db.select().from(notifications).where(eq(notifications.kind, "approval"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe("local-user");
    expect(rows[0]?.sessionId).toBe(childSessionId);
  });
});

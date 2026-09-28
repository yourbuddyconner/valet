/**
 * DB-backed tests for `updateWorkflowTrigger`. Uses the same PGlite harness
 * as Task 1 (`schedule-service.db.test.ts`), with the real github plugin for
 * `validateSubscription`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import githubPlugin from "@valet/plugin-github/plugin";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { eventSubscriptions, workflowDefinitions } from "../schema/index.js";
import {
  createWorkflowTrigger,
  updateWorkflowTrigger,
} from "./trigger-service.js";
import type { AppDb } from "../lib/drizzle.js";
import { InMemoryCredentialStore } from "@valet/engine";

/** Arm-gate deps for the create calls. Every workflow in this file is
 * user-owned, so the team readiness gate never runs. */
const armDeps = () => ({ db, credentials: new InMemoryCredentialStore(), plugins: [githubPlugin] });


let db: AppDb;
let cleanup: () => Promise<void>;

const OWNER = { userId: "user_1", orgId: "org_1" };

beforeAll(async () => {
  const boot = await freshTestPgDb();
  db = boot.appDb;
  cleanup = boot.cleanup;

  const now = Date.now();
  await db.insert(workflowDefinitions).values({
    id: "wf_1",
    orgId: OWNER.orgId,
    ownerType: "user",
    ownerId: OWNER.userId,
    name: "test workflow",
    definition: { version: "dag/v1", nodes: [], edges: [] },
    createdAt: now,
    updatedAt: now,
  });
});

afterAll(async () => {
  await cleanup();
});

describe("updateWorkflowTrigger", () => {
  it("updates name/eventKeys/enabled and returns the summary", async () => {
    const created = await createWorkflowTrigger(armDeps(), OWNER, {
      workflowId: "wf_1",
      name: "original",
      eventKeys: ["github.pull_request.opened"],
    });
    if (!created.ok) throw new Error(created.error);
    const triggerId = created.trigger.triggerId;

    const updated = await updateWorkflowTrigger(armDeps(), OWNER, triggerId, {
      name: "renamed",
      enabled: false,
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.trigger.name).toBe("renamed");
      expect(updated.trigger.enabled).toBe(false);
    }
  });

  it("re-validates merged eventKeys/filters and 400s with the validator message", async () => {
    const created = await createWorkflowTrigger(armDeps(), OWNER, {
      workflowId: "wf_1",
      name: "to-invalidate",
      eventKeys: ["github.pull_request.opened"],
    });
    if (!created.ok) throw new Error(created.error);
    const triggerId = created.trigger.triggerId;

    const updated = await updateWorkflowTrigger(armDeps(), OWNER, triggerId, {
      eventKeys: ["github.no_such_event"],
    });
    expect(updated.ok).toBe(false);
    if (!updated.ok) expect(updated.status).toBe(400);
  });

  it("404s for unknown ids, cross-org rows, and non-workflow subscriptions", async () => {
    // Unknown id
    const missing = await updateWorkflowTrigger(armDeps(), OWNER, "nope", {
      name: "x",
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(404);

    // Cross-org: trigger exists under a different org
    const created = await createWorkflowTrigger(armDeps(), OWNER, {
      workflowId: "wf_1",
      name: "cross-org trigger",
      eventKeys: ["github.pull_request.opened"],
    });
    if (!created.ok) throw new Error(created.error);
    const crossOrg = await updateWorkflowTrigger(
      armDeps(),
      { userId: OWNER.userId, orgId: "org_other" },
      created.trigger.triggerId,
      { name: "x" },
    );
    expect(crossOrg.ok).toBe(false);
    if (!crossOrg.ok) expect(crossOrg.status).toBe(404);

    // Non-workflow subscription (orchestrator target) — must 404 through this seam
    const now = Date.now();
    const orchId = randomUUID();
    await db.insert(eventSubscriptions).values({
      id: orchId,
      orgId: OWNER.orgId,
      ownerType: "user",
      ownerId: OWNER.userId,
      name: "orch sub",
      eventKeys: ["github.pull_request.opened"],
      filters: [],
      target: { kind: "orchestrator" },
      enabled: true,
      createdBy: OWNER.userId,
      createdAt: now,
      updatedAt: now,
    });
    const orchUpdate = await updateWorkflowTrigger(armDeps(), OWNER, orchId, {
      name: "should-fail",
    });
    expect(orchUpdate.ok).toBe(false);
    if (!orchUpdate.ok) expect(orchUpdate.status).toBe(404);
  });
});

/**
 * PUBLIC `/webhooks/events/:service` generic ingress (event-system plan,
 * Task 5). Route-level: real Hono app via `bootTestApi`, real HTTP requests,
 * real HMAC signatures, assertions against actual DB rows.
 *
 * The linear-specific cases are skipped until Task 8 ships
 * `plugin-linear`'s TriggerDefs — without them the route 404s every
 * `/webhooks/events/linear` POST before org/signature resolution runs.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import githubPlugin from "@valet/plugin-github/plugin";
import linearPlugin from "@valet/plugin-linear/plugin";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { eventDeliveries, eventDropLog, events, eventSubscriptions, linearInstallations } from "../schema/index.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

/** Signs a Linear body the way plugin-linear verifies it (HMAC-SHA256 hex
 * over the raw body). */
function linearSig(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

const WEBHOOK_SECRET = "test-secret";

/** Org linear credential (webhook secret in metadata) + installation row
 * mapping the Linear workspace to `local-org`. */
async function seedLinearOrg(a: TestApi, workspaceId = "lin-org-1"): Promise<void> {
  await a.providers.engineCredentials.save({ type: "org", id: "local-org" }, "linear", {
    type: "oauth2",
    accessToken: "linear-access-token",
    metadata: { webhookSecret: WEBHOOK_SECRET },
  });
  const now = Date.now();
  await a.providers.db.insert(linearInstallations).values({
    id: "li_seed",
    orgId: "local-org",
    workspaceId,
    workspaceName: "Linear Test Workspace",
    connectedBy: "local-user",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedSubscription(a: TestApi, eventKeys: string[]): Promise<void> {
  const now = Date.now();
  await a.providers.db.insert(eventSubscriptions).values({
    id: "sub_seed",
    orgId: "local-org",
    ownerType: "org",
    ownerId: "local-org",
    name: "test subscription",
    eventKeys,
    filters: [],
    target: { kind: "orchestrator" },
    enabled: true,
    createdBy: "local-user",
    createdAt: now,
    updatedAt: now,
  });
}

function linearIssueBody(action: "create" | "update" = "create"): string {
  return JSON.stringify({
    action,
    type: "Issue",
    organizationId: "lin-org-1",
    webhookTimestamp: Date.now(),
    data: { id: "iss-1", identifier: "TKAI-1", title: "Bug", team: { key: "TKAI" } },
    webhookId: "wh-1",
    createdAt: new Date().toISOString(),
  });
}

async function postLinear(baseUrl: string, body: string, signature: string, deliveryId = "del-1") {
  return fetch(`${baseUrl}/webhooks/events/linear`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Linear-Signature": signature,
      "Linear-Delivery": deliveryId,
    },
    body,
  });
}

describe("POST /webhooks/events/:service", () => {
  it("404s an unknown service (no plugin trigger defs match)", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/webhooks/events/nope`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown service" });
  });

  it("413s when body exceeds 1 MiB (content-length pre-check)", async () => {
    api = await bootTestApi({ plugins: [githubPlugin] });
    const oversizedBody = "x".repeat(1024 * 1024 + 1);
    const res = await fetch(`${api.baseUrl}/webhooks/events/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversizedBody,
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload too large" });
  });

  describe("linear ingress", () => {
    it.each(["create", "update"] as const)("ingests a signed Linear issue %s: event and matched delivery", async (action) => {
      api = await bootTestApi({ plugins: [linearPlugin] });
      // This test asserts the delivery row as ingest wrote it (status
      // "pending"). The ingest path nudges the dispatcher, which delivers
      // the row asynchronously and flips it to "delivered" — a race this
      // test lost on slow CI runners. Stop the dispatcher so the nudge is a
      // no-op; dispatch itself is covered by events/dispatcher.test.ts.
      await api.providers.eventDispatcher.stop();
      await seedLinearOrg(api);
      await seedSubscription(api, [`linear.issue.${action}`]);

      const body = linearIssueBody(action);
      const res = await postLinear(api.baseUrl, body, linearSig(body, WEBHOOK_SECRET));
      expect(res.status).toBe(204);

      const eventRows = await api.providers.db.select().from(events).where(eq(events.orgId, "local-org"));
      expect(eventRows).toHaveLength(1);
      expect(eventRows[0].service).toBe("linear");
      expect(eventRows[0].eventKey).toBe(`linear.issue.${action}`);

      const deliveryRows = await api.providers.db
        .select()
        .from(eventDeliveries)
        .where(eq(eventDeliveries.eventId, eventRows[0].id));
      expect(deliveryRows).toHaveLength(1);
      expect(deliveryRows[0].status).toBe("pending");
      expect(deliveryRows[0].subscriptionId).toBe("sub_seed");
    });

    it("replays are deduped (same delivery id -> 204, no second row)", async () => {
      api = await bootTestApi({ plugins: [linearPlugin] });
      await seedLinearOrg(api);
      await seedSubscription(api, ["linear.issue.create"]);

      const body = linearIssueBody();
      const sig = linearSig(body, WEBHOOK_SECRET);
      const first = await postLinear(api.baseUrl, body, sig);
      expect(first.status).toBe(204);
      const second = await postLinear(api.baseUrl, body, sig);
      expect(second.status).toBe(204);

      const eventRows = await api.providers.db.select().from(events).where(eq(events.orgId, "local-org"));
      expect(eventRows).toHaveLength(1);
      const deliveryRows = await api.providers.db
        .select()
        .from(eventDeliveries)
        .where(eq(eventDeliveries.eventId, eventRows[0].id));
      expect(deliveryRows).toHaveLength(1);
    });

    it("bad signature -> 403 + event_drop_log row with reason bad_signature", async () => {
      api = await bootTestApi({ plugins: [linearPlugin] });
      await seedLinearOrg(api);

      const body = linearIssueBody();
      const res = await postLinear(api.baseUrl, body, linearSig(body, `${WEBHOOK_SECRET}-wrong`));
      expect(res.status).toBe(403);

      const eventRows = await api.providers.db.select().from(events).where(eq(events.orgId, "local-org"));
      expect(eventRows).toHaveLength(0);
      const drops = await api.providers.db.select().from(eventDropLog).where(eq(eventDropLog.orgId, "local-org"));
      expect(drops.some((d) => d.reason === "bad_signature")).toBe(true);
    });

    it("unknown organizationId -> 204 no-op (no installation row, no event)", async () => {
      api = await bootTestApi({ plugins: [linearPlugin] });
      // No installation row at all — the workspace can't be mapped to an org.
      const body = linearIssueBody();
      const res = await postLinear(api.baseUrl, body, linearSig(body, WEBHOOK_SECRET));
      expect(res.status).toBe(204);

      const eventRows = await api.providers.db.select().from(events).where(eq(events.orgId, "local-org"));
      expect(eventRows).toHaveLength(0);
    });

    it("missing org credential -> 204 + drop log reason unknown_org", async () => {
      api = await bootTestApi({ plugins: [linearPlugin] });
      // Installation row exists but no `linear` credential (no webhook secret).
      const now = Date.now();
      await api.providers.db.insert(linearInstallations).values({
        id: "li_seed",
        orgId: "local-org",
        workspaceId: "lin-org-1",
        workspaceName: "Linear Test Workspace",
        connectedBy: "local-user",
        createdAt: now,
        updatedAt: now,
      });

      const body = linearIssueBody();
      const res = await postLinear(api.baseUrl, body, linearSig(body, WEBHOOK_SECRET));
      expect(res.status).toBe(204);

      const drops = await api.providers.db.select().from(eventDropLog).where(eq(eventDropLog.orgId, "local-org"));
      expect(drops.some((d) => d.reason === "unknown_org")).toBe(true);
      const eventRows = await api.providers.db.select().from(events).where(eq(events.orgId, "local-org"));
      expect(eventRows).toHaveLength(0);
    });
  });
});

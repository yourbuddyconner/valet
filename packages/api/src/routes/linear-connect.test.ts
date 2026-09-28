/**
 * `/api/org/linear` connect flow (event-system plan, Task 9). Route-level:
 * real Hono app via `bootTestApi`, real HTTP requests, a fake Linear API
 * server (`startLinearFixture`) subbed in via `LINEAR_API_URL` /
 * `LINEAR_OAUTH_URL` — same shape as `github-app.test.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { startLinearFixture, type LinearFixture, type LinearFixtureCall } from "../test-helpers/linear-fixture.js";
import { linearInstallations } from "../schema/index.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

let api: TestApi | undefined;
let fixture: LinearFixture | undefined;

const SAVED_ENV_KEYS = ["LINEAR_API_URL", "LINEAR_OAUTH_URL", "LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "VALET_PUBLIC_URL"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(
  SAVED_ENV_KEYS.map((k) => [k, process.env[k]]),
);

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  await fixture?.close();
  fixture = undefined;
  for (const key of SAVED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function useFixture(overrides: Parameters<typeof startLinearFixture>[0] = {}): LinearFixture {
  fixture = startLinearFixture(overrides);
  process.env.LINEAR_API_URL = fixture.url;
  process.env.LINEAR_OAUTH_URL = fixture.url;
  process.env.LINEAR_CLIENT_ID = "lin-client-id";
  process.env.LINEAR_CLIENT_SECRET = "lin-client-secret";
  return fixture;
}

async function fetchAuthorizeUrl(baseUrl: string): Promise<URL> {
  const res = await fetch(`${baseUrl}/api/org/linear/connect`, { method: "POST", headers: HEADERS });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { url: string };
  return new URL(body.url);
}

/** Drives the full connect → callback exchange against the fixture and
 * returns the callback response (redirect: manual). */
async function completeConnect(baseUrl: string): Promise<Response> {
  const authorizeUrl = await fetchAuthorizeUrl(baseUrl);
  const state = authorizeUrl.searchParams.get("state");
  expect(state).toBeTruthy();
  return fetch(`${baseUrl}/api/org/linear/callback?code=lin-code&state=${encodeURIComponent(state!)}`, {
    redirect: "manual",
  });
}

function graphqlCalls(f: LinearFixture, needle: string): LinearFixtureCall[] {
  return f.calls.filter((call) => {
    if (call.path !== "/graphql") return false;
    const body = call.body as { query?: string } | undefined;
    return typeof body?.query === "string" && body.query.includes(needle);
  });
}

describe("POST /api/org/linear/connect", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    useFixture();
    const res = await fetch(`${api.baseUrl}/api/org/linear/connect`, { method: "POST", headers: MEMBER_HEADERS });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "org admin required" });
  });

  it("503s with a clear message when LINEAR_CLIENT_ID/SECRET are unset", async () => {
    api = await bootTestApi();
    delete process.env.LINEAR_CLIENT_ID;
    delete process.env.LINEAR_CLIENT_SECRET;
    const res = await fetch(`${api.baseUrl}/api/org/linear/connect`, { method: "POST", headers: HEADERS });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("LINEAR_CLIENT_ID");
  });

  it("returns an authorize URL with client_id, redirect_uri, scope, state, and actor=app", async () => {
    api = await bootTestApi();
    const f = useFixture();
    const url = await fetchAuthorizeUrl(api.baseUrl);
    expect(url.origin).toBe(f.url);
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("lin-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(`${api.baseUrl}/api/org/linear/callback`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("read,write,admin");
    expect(url.searchParams.get("actor")).toBe("app");
    expect(url.searchParams.get("state")).toBeTruthy();
  });
});

describe("GET /api/org/linear/callback", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    useFixture();
    const res = await fetch(`${api.baseUrl}/api/org/linear/callback?code=x&state=y`, {
      headers: MEMBER_HEADERS,
      redirect: "manual",
    });
    expect(res.status).toBe(403);
  });

  it("400s when code or state is missing", async () => {
    api = await bootTestApi();
    useFixture();
    const res = await fetch(`${api.baseUrl}/api/org/linear/callback?code=abc`, { redirect: "manual" });
    expect(res.status).toBe(400);
  });

  it("400s on a tampered state", async () => {
    api = await bootTestApi();
    useFixture();
    const authorizeUrl = await fetchAuthorizeUrl(api.baseUrl);
    const state = authorizeUrl.searchParams.get("state")!;
    const tampered = `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`;
    const res = await fetch(
      `${api.baseUrl}/api/org/linear/callback?code=abc&state=${encodeURIComponent(tampered)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid or expired state" });
  });

  it("exchanges the code, creates the webhook, saves the credential + installation, and 302s", async () => {
    api = await bootTestApi();
    const f = useFixture();
    const res = await completeConnect(api.baseUrl);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/settings");

    // Token exchange hit the fixture with the code + app credentials.
    const tokenCall = f.calls.find((call) => call.path === "/oauth/token");
    expect(tokenCall).toBeDefined();
    expect(tokenCall!.body).toMatchObject({
      code: "lin-code",
      client_id: "lin-client-id",
      client_secret: "lin-client-secret",
      grant_type: "authorization_code",
      redirect_uri: `${api.baseUrl}/api/org/linear/callback`,
    });

    // webhookCreate pointed at our ingress with a generated secret.
    const [createCall] = graphqlCalls(f, "webhookCreate");
    expect(createCall).toBeDefined();
    expect(createCall.authHeader).toBe("Bearer lin_test");
    const variables = (createCall.body as { variables: { input: Record<string, unknown> } }).variables;
    expect(variables.input.url).toBe(`${api.baseUrl}/webhooks/events/linear`);
    expect(variables.input.allPublicTeams).toBe(true);
    expect(variables.input.resourceTypes).toEqual(["Issue", "Comment", "Project", "Cycle", "IssueLabel", "Reaction"]);
    const secret = variables.input.secret;
    expect(typeof secret).toBe("string");
    expect(secret).toMatch(/^[0-9a-f]{64}$/);

    // Credential saved with the same secret + workspace id in metadata.
    const cred = await api.providers.engineCredentials.get({ type: "org", id: "local-org" }, "linear");
    expect(cred).toMatchObject({
      type: "oauth2",
      accessToken: "lin_test",
      metadata: { webhookSecret: secret, workspaceId: "lin-org-1" },
    });

    // Installation row upserted.
    const rows = await api.providers.db.select().from(linearInstallations).where(eq(linearInstallations.orgId, "local-org"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: "lin-org-1",
      workspaceName: "Turnkey",
      webhookId: "wh-1",
      connectedBy: "local-user",
    });
  });

  it("reconnecting the same workspace updates the existing row instead of duplicating it", async () => {
    api = await bootTestApi();
    const f = useFixture();
    expect((await completeConnect(api.baseUrl)).status).toBe(302);
    expect((await completeConnect(api.baseUrl)).status).toBe(302);

    const rows = await api.providers.db.select().from(linearInstallations).where(eq(linearInstallations.orgId, "local-org"));
    expect(rows).toHaveLength(1);

    // The old webhook (wh-1, created during the first connect) must have been
    // deleted before the new one was registered — prevents an orphaned webhook
    // delivering with a dead signing secret.
    const [deleteCall] = graphqlCalls(f, "webhookDelete");
    expect(deleteCall).toBeDefined();
    expect((deleteCall.body as { variables: { id: string } }).variables.id).toBe("wh-1");
  });

  it("502s when webhook creation fails — credential + install saved FIRST (repairable, no delivery gap)", async () => {
    // The credential (with the signing secret) and the installation row are
    // persisted BEFORE webhookCreate: Linear can deliver the moment the
    // webhook exists, and a delivery the ingress can't resolve is 204'd and
    // never retried. A failed webhookCreate therefore leaves a repairable
    // half-connected state (webhookConfigured: false), not nothing.
    api = await bootTestApi();
    useFixture({ webhookCreate: () => ({ body: { data: { webhookCreate: { success: false } } } }) });
    const res = await completeConnect(api.baseUrl);
    expect(res.status).toBe(502);

    const cred = await api.providers.engineCredentials.get({ type: "org", id: "local-org" }, "linear");
    expect(cred).toMatchObject({ type: "oauth2", accessToken: "lin_test" });
    const rows = await api.providers.db.select().from(linearInstallations).where(eq(linearInstallations.orgId, "local-org"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: "lin-org-1", webhookId: null });

    const status = await fetch(`${api.baseUrl}/api/org/linear`, { headers: HEADERS });
    expect(await status.json()).toMatchObject({ webhookConfigured: false });
  });

  it("409s when a different workspace is already connected for the org", async () => {
    // One workspace per org: the org credential holds exactly one token, so
    // a second workspace would orphan the first's webhook forever.
    api = await bootTestApi();
    useFixture();
    await api.providers.db.insert(linearInstallations).values({
      id: "lin_pre-existing",
      orgId: "local-org",
      workspaceId: "lin-org-OTHER",
      workspaceName: "Other Workspace",
      webhookId: "wh-other",
      connectedBy: "local-user",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const res = await completeConnect(api.baseUrl);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("Other Workspace");

    // Nothing about the pre-existing install was touched, and no credential
    // was written for the rejected workspace.
    const rows = await api.providers.db.select().from(linearInstallations).where(eq(linearInstallations.orgId, "local-org"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: "lin-org-OTHER", webhookId: "wh-other" });
    expect(await api.providers.engineCredentials.get({ type: "org", id: "local-org" }, "linear")).toBeNull();
  });
});

describe("GET /api/org/linear", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/linear`, { headers: MEMBER_HEADERS });
    expect(res.status).toBe(403);
  });

  it("reports disconnected before any connect", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/linear`, { headers: HEADERS });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ connected: false, webhookConfigured: false, ready: false });
  });

  it("reflects connected state after the callback", async () => {
    api = await bootTestApi();
    useFixture();
    expect((await completeConnect(api.baseUrl)).status).toBe(302);

    const res = await fetch(`${api.baseUrl}/api/org/linear`, { headers: HEADERS });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ connected: true, workspaceName: "Turnkey", webhookConfigured: true, configured: true, ready: true });
  });
});

describe("DELETE /api/org/linear", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/linear`, { method: "DELETE", headers: MEMBER_HEADERS });
    expect(res.status).toBe(403);
  });

  it("deletes the webhook, installation rows, and credential", async () => {
    api = await bootTestApi();
    const f = useFixture();
    expect((await completeConnect(api.baseUrl)).status).toBe(302);

    const res = await fetch(`${api.baseUrl}/api/org/linear`, { method: "DELETE", headers: HEADERS });
    expect(res.status).toBe(204);

    const [deleteCall] = graphqlCalls(f, "webhookDelete");
    expect(deleteCall).toBeDefined();
    expect((deleteCall.body as { variables: { id: string } }).variables.id).toBe("wh-1");

    const rows = await api.providers.db.select().from(linearInstallations).where(eq(linearInstallations.orgId, "local-org"));
    expect(rows).toHaveLength(0);
    const cred = await api.providers.engineCredentials.get({ type: "org", id: "local-org" }, "linear");
    expect(cred).toBeNull();

    const getRes = await fetch(`${api.baseUrl}/api/org/linear`, { headers: HEADERS });
    expect(await getRes.json()).toMatchObject({ connected: false, webhookConfigured: false, ready: false });
  });

  it("still disconnects (204) when the webhookDelete call fails", async () => {
    api = await bootTestApi();
    useFixture({ webhookDelete: () => ({ status: 500, body: { errors: [{ message: "boom" }] } }) });
    expect((await completeConnect(api.baseUrl)).status).toBe(302);

    const res = await fetch(`${api.baseUrl}/api/org/linear`, { method: "DELETE", headers: HEADERS });
    expect(res.status).toBe(204);
    const rows = await api.providers.db.select().from(linearInstallations).where(eq(linearInstallations.orgId, "local-org"));
    expect(rows).toHaveLength(0);
  });
});

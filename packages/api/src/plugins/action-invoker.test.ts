import { seedWorkspaceAssistant } from "../test-helpers/assistant-fixture.js";
/**
 * Unit tests for `buildActionInvoker` (plugin-system-v2 plan Task 6) — the
 * headless dispatch primitive behind the workflow `tool` node's
 * `engine.invokeAction` seam. Exercises the invoker directly (fixture
 * `actionPluginByService` map, in-memory sqlite, a fake `CredentialStore`)
 * rather than through `buildWorkflowEngineDeps`/`bootTestApi` — the run
 * context resolution (`resolveRunContext`) those go through is covered
 * separately in `../workflows/engine-deps.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { Type } from "typebox";
import type {
  ActionPlugin,
  CredentialOwner,
  CredentialStore,
  PluginAction,
  PluginActionContext,
  StoredCredential,
  ValetPlugin,
} from "@valet/engine";
import { InMemorySessionStore } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { actionInvocations, actionPolicies, assistants, runtimeGrants, sessionRepos, githubInstallations, orgs, teams, workflowDefinitions } from "../schema/index.js";
import { grantPolicyKey } from "../policies/resolution.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { linkIdentity } from "../channels/identity-links.js";
import { PgCredentialStore } from "./credential-store.js";
import { saveAppConfig, type GithubAppConfig } from "../services/github-app.js";
import type { OnePasswordCtx, OnePasswordService } from "../services/onepassword.js";
import { buildActionInvoker, type ActionInvocationContext } from "./action-invoker.js";
import { workflowsActionPlugin } from "../workflows/actions.js";
import { InMemoryWorkflowStore } from "@valet/workflow";

import { slackPlugin } from "@valet/plugin-slack/actions";

/** Fake `OnePasswordService` — only `resolveCredential` is exercised by the invoker's credential providers. */
function fakeOnePassword(
  resolveCredential: OnePasswordService["resolveCredential"],
): OnePasswordService {
  const unused = () => {
    throw new Error("not exercised by this suite");
  };
  return {
    tokenConnected: unused,
    listVaults: unused,
    resolveReference: unused,
    findCredentialForService: async () => null,
    findCandidates: async () => [],
    resolveCredential,
  };
}

async function makeDb(): Promise<AppDb> {
  const { appDb } = await freshTestPgDb();
  return appDb;
}

/** Minimal in-memory `CredentialStore` — enough to exercise scoping/missing-credential behavior without pulling in `SqliteCredentialStore`'s encryption machinery. */
class FakeCredentialStore implements CredentialStore {
  private readonly rows = new Map<string, StoredCredential>();

  private key(owner: CredentialOwner, service: string): string {
    return `${owner.type}:${owner.id}:${service}`;
  }

  seed(owner: CredentialOwner, service: string, credential: StoredCredential): void {
    this.rows.set(this.key(owner, service), credential);
  }

  async get(owner: CredentialOwner, service: string): Promise<StoredCredential | null> {
    return this.rows.get(this.key(owner, service)) ?? null;
  }

  async save(owner: CredentialOwner, service: string, credential: StoredCredential): Promise<void> {
    this.rows.set(this.key(owner, service), credential);
  }

  async delete(owner: CredentialOwner, service: string): Promise<void> {
    this.rows.delete(this.key(owner, service));
  }

  async list(): Promise<{ service: string; scopes?: string[]; connectedAt: string }[]> {
    return [];
  }
}

const userOwner: ActionInvocationContext = { userId: "u1", orgId: "org1", owner: { type: "user", id: "u1" } };

interface CountingAction {
  action: PluginAction;
  calls: () => number;
  lastArgs: () => Record<string, unknown> | undefined;
}

function countingAction(opts: {
  id?: string;
  execute?: PluginAction["execute"];
} = {}): CountingAction {
  let count = 0;
  let last: Record<string, unknown> | undefined;
  const action: PluginAction = {
    id: opts.id ?? "demo.ping",
    name: "ping",
    description: "ping",
    riskLevel: "low",
    parameters: Type.Object({ msg: Type.String() }),
    execute:
      opts.execute ??
      (async (args, ctx) => {
        count += 1;
        last = args as Record<string, unknown>;
        const credential = await ctx.credentials.get();
        return { success: true, data: { echoed: (args as { msg: string }).msg, hasCredential: credential !== null } };
      }),
  };
  return { action, calls: () => count, lastArgs: () => last };
}

function actionPluginByServiceOf(
  service: string,
  actionPlugin: ActionPlugin,
): Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }> {
  const plugin: ValetPlugin = { name: service, version: "0.0.1", actions: [actionPlugin] };
  return new Map([[service, { plugin, actionPlugin }]]);
}

describe("buildActionInvoker", () => {
  it("happy path: executes the resolved action and returns {ok:true, result}", async () => {
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      userOwner,
    );

    expect(result).toEqual({ ok: true, result: { echoed: "hi", hasCredential: false } });
    expect(fixture.calls()).toBe(1);
  });

  it("a workflow tool action can extract a document, the same as a session action", async () => {
    // Document extraction needs no session, thread or sandbox: it is a pure
    // call over bytes, and the native extractor lives in this process. A
    // workflow node that reads a PDF must not be told extraction is
    // unavailable on the deployment when the deployment can do it.
    let seen: PluginActionContext["extractDocument"];
    const probe = countingAction({
      execute: async (_args, ctx) => {
        seen = ctx.extractDocument;
        return { success: true, data: {} };
      },
    });
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [probe.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });

    await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:extract" },
      userOwner,
    );

    expect(typeof seen).toBe("function");
  });

  it("the workflow extractor reads a real PDF and declines a non-PDF", async () => {
    let extract: NonNullable<PluginActionContext["extractDocument"]> | undefined;
    const probe = countingAction({
      execute: async (_args, ctx) => {
        extract = ctx.extractDocument;
        return { success: true, data: {} };
      },
    });
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [probe.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });
    await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:extract2" },
      userOwner,
    );

    const pdf = new Uint8Array(readFileSync(new URL("../services/__fixtures__/sample.pdf", import.meta.url)));
    // Wired to the real extractor, not a stub that resolves to null.
    await expect(
      extract?.({ data: pdf, mimeType: "application/pdf", name: "sample.pdf" }),
    ).resolves.toMatchObject({ markdown: expect.stringContaining("Quarterly Revenue Report") });
    // Anything the api cannot extract answers null, so the caller says why.
    await expect(
      extract?.({ data: new Uint8Array([1, 2, 3]), mimeType: "application/zip", name: "x.zip" }),
    ).resolves.toBeNull();
  });

  it("dedup: a duplicate invocationId returns the ORIGINAL result without re-invoking execute", async () => {
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });
    const req = { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" };

    const first = await invoke(req, userOwner);
    const second = await invoke(req, userOwner);

    expect(second).toEqual(first);
    expect(fixture.calls()).toBe(1);
  });

  it("unknown service: returns a stable {ok:false} that dedups without ever resolving an action", async () => {
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });
    const req = { service: "nope", action: "ping", params: {}, invocationId: "workflow:r1:n1" };

    const first = await invoke(req, userOwner);
    const second = await invoke(req, userOwner);

    expect(first).toEqual({ ok: false, error: "unknown action: nope.ping" });
    expect(second).toEqual(first);
  });

  it("unknown action within a known service: stable {ok:false}, dedup applies", async () => {
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });
    const req = { service: "demo", action: "does_not_exist", params: {}, invocationId: "workflow:r1:n1" };

    const first = await invoke(req, userOwner);
    const second = await invoke(req, userOwner);

    expect(first).toEqual({ ok: false, error: "unknown action: demo.does_not_exist" });
    expect(second).toEqual(first);
    expect(fixture.calls()).toBe(0);
  });

  it("param validation failure: missing required param never reaches execute", async () => {
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: {}, invocationId: "workflow:r1:n1" },
      userOwner,
    );

    expect(result.ok).toBe(false);
    expect(fixture.calls()).toBe(0);
  });

  it("missing credential: the action still executes and sees credentials.get() === null", async () => {
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      userOwner,
    );

    expect(result).toEqual({ ok: true, result: { echoed: "hi", hasCredential: false } });
  });

  it("a saved credential is visible to the action via credentials.get()", async () => {
    const store = new FakeCredentialStore();
    store.seed({ type: "user", id: "u1" }, "demo", { type: "api_key", apiKey: "secret-token" });
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: store, actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      userOwner,
    );

    expect(result).toEqual({ ok: true, result: { echoed: "hi", hasCredential: true } });
  });

  it("org owner maps to a CredentialOwner and scopes credential lookups by org", async () => {
    const store = new FakeCredentialStore();
    store.seed({ type: "org", id: "org1" }, "demo", { type: "api_key", apiKey: "org-token" });
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: store, actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      { userId: "u1", orgId: "org1", owner: { type: "org", id: "org1" } },
    );

    expect(result).toEqual({ ok: true, result: { echoed: "hi", hasCredential: true } });
  });

  it("owner-precedence contract (Task 6): a user-owned run resolves a 1Password reference row through onePassword", async () => {
    const store = new FakeCredentialStore();
    store.seed({ type: "user", id: "u1" }, "demo", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://vault/item/field", tokenScope: "org" } },
    });
    let sawCtx: OnePasswordCtx | undefined;
    const onePassword = fakeOnePassword(async (row, ctx) => {
      sawCtx = ctx;
      return { type: row.type, metadata: row.metadata, apiKey: "resolved-user-secret" };
    });
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: store, actionPluginByService, onePassword });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      userOwner,
    );

    expect(result).toEqual({ ok: true, result: { echoed: "hi", hasCredential: true } });
    expect(sawCtx).toEqual({ orgId: "org1", userId: "u1", scopes: ["org", "personal"] });
  });

  it("owner-precedence contract (Task 6): an org-owned run resolves the org row's 1Password reference through onePassword", async () => {
    const store = new FakeCredentialStore();
    store.seed({ type: "org", id: "org1" }, "demo", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://Shared/Acme/credential", tokenScope: "org" } },
    });
    let sawCtx: OnePasswordCtx | undefined;
    const onePassword = fakeOnePassword(async (row, ctx) => {
      sawCtx = ctx;
      return { type: row.type, metadata: row.metadata, apiKey: "resolved-org-secret" };
    });
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: store, actionPluginByService, onePassword });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      { userId: "u1", orgId: "org1", owner: { type: "org", id: "org1" } },
    );

    expect(result).toEqual({ ok: true, result: { echoed: "hi", hasCredential: true } });
    expect(sawCtx).toEqual({ orgId: "org1", userId: "u1", scopes: ["org"] });
  });

  // TKAI-487 / R3. The personal 1Password scope belongs to exactly one owner
  // type. A team- or org-owned run is prompted and read by people other than
  // the actor frozen onto it, so its reads must never reach that actor's own
  // vault — the run's OWNER picks the scopes, never the actor.
  describe("the personal 1Password scope follows the run owner, not the actor", () => {
    /** Records every scope the vault lookup is asked for. */
    function scopeRecordingOnePassword(): { onePassword: OnePasswordService; scopes: () => string[] } {
      const seen: string[] = [];
      const unused = () => {
        throw new Error("not exercised by this suite");
      };
      return {
        scopes: () => seen,
        onePassword: {
          tokenConnected: unused,
          listVaults: unused,
          resolveReference: unused,
          findCandidates: async () => [],
          resolveCredential: unused,
          findCredentialForService: async (scope) => {
            seen.push(scope);
            return null;
          },
        },
      };
    }

    async function invokeWith(owner: ActionInvocationContext, onePassword: OnePasswordService) {
      const db = await makeDb();
      await db.insert(orgs).values({ id: "org1", name: "Org", createdAt: 1 });
      if (owner.owner.type === "team") {
        await db.insert(teams).values({ id: owner.owner.id, orgId: "org1", name: "Team", createdAt: 1 });
      }
      const fixture = countingAction();
      const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
      const invoke = buildActionInvoker({
        db,
        credentials: new FakeCredentialStore(),
        actionPluginByService,
        onePassword,
      });
      return invoke(
        { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
        owner,
      );
    }

    it("a user-owned run consults the personal vault", async () => {
      const { onePassword, scopes } = scopeRecordingOnePassword();
      await invokeWith(userOwner, onePassword);
      expect(scopes()).toContain("personal");
    });

    // The acting member here is a real person with a real user id, which is
    // the whole hazard: it is inert only because the owner picks the scopes.
    it("a team-owned run reads the team vault and never the acting member's personal one", async () => {
      const { onePassword, scopes } = scopeRecordingOnePassword();
      await invokeWith(
        { userId: "member-who-clicked", orgId: "org1", owner: { type: "team", id: "t1" } },
        onePassword,
      );
      expect(scopes()).toContain("team");
      expect(scopes()).not.toContain("personal");
    });

    it("an org-owned run never reads the acting member's personal vault", async () => {
      const { onePassword, scopes } = scopeRecordingOnePassword();
      await invokeWith(
        { userId: "member-who-clicked", orgId: "org1", owner: { type: "org", id: "org1" } },
        onePassword,
      );
      expect(scopes()).not.toContain("personal");
    });
  });

  it("team-owned run propagates its principal into a workflows tool action", async () => {
    const db = await makeDb();
    await db.insert(orgs).values({ id: "org1", name: "Org", createdAt: 1 });
    await db.insert(teams).values({ id: "t1", orgId: "org1", name: "Team", createdAt: 1 });
    const workflowStore = new InMemoryWorkflowStore();
    const workflows = workflowsActionPlugin(() => ({
      db,
      workflowStore,
      // save_workflow does not start or resume runs, and records no origin.
      workflowRunHost: null as never,
      engineStore: new InMemorySessionStore(),
      credentials: new FakeCredentialStore(),
    }));
    const invoke = buildActionInvoker({
      db,
      credentials: new FakeCredentialStore(),
      actionPluginByService: actionPluginByServiceOf("workflows", workflows),
    });

    const result = await invoke(
      {
        service: "workflows",
        action: "save_workflow",
        params: {
          name: "Created by tool node",
          definition: {
            version: "dag/v1",
            nodes: [{ id: "start", type: "trigger" }, { id: "done", type: "stop" }],
            edges: [{ from: "start", to: "done" }],
          },
        },
        invocationId: "workflow:r1:workflows-save",
      },
      { userId: "former-member", orgId: "org1", owner: { type: "team", id: "t1" } },
    );

    expect(result.ok).toBe(true);
    expect(await db.select().from(workflowDefinitions)).toEqual([
      expect.objectContaining({ ownerType: "team", ownerId: "t1", name: "Created by tool node" }),
    ]);
  });

  it("team-owned run: resolves a direct team credential", async () => {
    const store = new FakeCredentialStore();
    store.seed({ type: "team", id: "t1" }, "demo", { type: "api_key", apiKey: "team-tok" });
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: store, actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:team-direct" },
      { userId: "team:t1", orgId: "org1", owner: { type: "team", id: "t1" } },
    );

    expect(result).toEqual({ ok: true, result: { echoed: "hi", hasCredential: true } });
  });

  it("team-owned slack run: uses the org bot token and stays bare", async () => {
    let seenOwnerId: unknown = "sentinel";
    const action: PluginAction = {
      id: "slack.whoami",
      name: "whoami",
      description: "reports the owner id it was handed",
      riskLevel: "low",
      parameters: Type.Object({}),
      execute: async (_args, ctx) => {
        const cred = await ctx.credentials.get();
        seenOwnerId = cred?.metadata?.["owner_slack_user_id"];
        return { success: true, data: { token: cred?.accessToken ?? null } };
      },
    };
    const actionPlugin: ActionPlugin = { service: "slack", actions: [action] };
    const plugin: ValetPlugin = {
      name: "slack",
      version: "0.0.1",
      actions: [actionPlugin],
      credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }],
    };
    const store = new FakeCredentialStore();
    store.seed({ type: "org", id: "org1" }, "slack", { type: "bot_token", accessToken: "org-bot" });
    const db = await makeDb();
    await linkIdentity(db, { provider: "slack", externalId: "U123LINKED", userId: "u1" });
    const invoke = buildActionInvoker({
      db,
      credentials: store,
      actionPluginByService: new Map([["slack", { plugin, actionPlugin }]]),
    });

    const result = await invoke(
      { service: "slack", action: "whoami", params: {}, invocationId: "workflow:r1:team-slack" },
      { userId: "u1", orgId: "org1", owner: { type: "team", id: "t1" } },
    );

    expect(result).toEqual({ ok: true, result: { token: "org-bot" } });
    expect(seenOwnerId).toBeUndefined();
  });

  it("team workflow posts with the organization bot without a personal Slack identity", async () => {
    const db = await makeDb();
    const store = new FakeCredentialStore();
    store.seed({ type: "org", id: "org1" }, "slack", { type: "bot_token", accessToken: "org-bot" });
    const plugin: ValetPlugin = {
      name: "slack",
      version: "0.0.1",
      actions: [slackPlugin],
      credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }],
    };
    const invoke = buildActionInvoker({
      db,
      credentials: store,
      actionPluginByService: new Map([["slack", { plugin, actionPlugin: slackPlugin }]]),
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, channel: { id: "C1", is_private: false, is_im: false, is_mpim: false } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ts: "1.2", channel: "C1" })));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await invoke(
        { service: "slack", action: "send_message", params: { channel: "C1", text: "Deploy complete" }, invocationId: "workflow:r1:team-slack-send" },
        { userId: "team:t1", orgId: "org1", owner: { type: "team", id: "t1" } },
      );

      expect(result).toEqual({ ok: true, result: { ts: "1.2", channel: "C1" } });
      expect((fetchMock.mock.calls[1] as [string, RequestInit])[1].headers).toMatchObject({
        Authorization: "Bearer org-bot",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("workflow slack.send_message posts as the owner's configured assistant", async () => {
    const db = await makeDb();
    const assistant = await seedWorkspaceAssistant(db, "org1", { type: "user", id: "u1" }, "Release bot");
    await db
      .update(assistants)
      .set({ avatarUrl: "https://cdn.example.com/release-bot.png" })
      .where(eq(assistants.id, assistant.id));

    const store = new FakeCredentialStore();
    store.seed({ type: "org", id: "org1" }, "slack", { type: "bot_token", accessToken: "org-bot" });
    const plugin: ValetPlugin = {
      name: "slack",
      version: "0.0.1",
      actions: [slackPlugin],
      credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }],
    };
    const invoke = buildActionInvoker({
      db,
      credentials: store,
      actionPluginByService: new Map([["slack", { plugin, actionPlugin: slackPlugin }]]),
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, channel: { id: "C1", is_private: false, is_im: false, is_mpim: false } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ts: "1.2", channel: "C1" })));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await invoke(
        { service: "slack", action: "send_message", params: { channel: "C1", text: "Deploy complete" }, invocationId: "workflow:r1:slack-send" },
        userOwner,
      );

      expect(result).toEqual({ ok: true, result: { ts: "1.2", channel: "C1" } });
      expect(JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string)).toMatchObject({
        channel: "C1",
        text: "Deploy complete",
        username: "Release bot",
        icon_url: "https://cdn.example.com/release-bot.png",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("team-owned run: a declared service with no team credential refuses before execute", async () => {
    const fixture = countingAction();
    const actionPlugin: ActionPlugin = { service: "demo", actions: [fixture.action] };
    const plugin: ValetPlugin = {
      name: "demo",
      version: "0.0.1",
      actions: [actionPlugin],
      credentials: [{ type: "api_key", configKeys: ["apiKey"] }],
    };
    const store = new FakeCredentialStore();
    // An org row for the same service must stay invisible to the team run
    // (decision 5) — the refusal fires even though the org has a token.
    store.seed({ type: "org", id: "org1" }, "demo", { type: "api_key", apiKey: "org-tok" });
    const invoke = buildActionInvoker({
      db: await makeDb(),
      credentials: store,
      actionPluginByService: new Map([["demo", { plugin, actionPlugin }]]),
    });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:team-missing" },
      { userId: "team:t1", orgId: "org1", owner: { type: "team", id: "t1" } },
    );

    expect(result).toEqual({
      ok: false,
      error:
        "This team has no demo credential. Share one from Integrations, or store one for the team in Settings → Organization → Teams.",
    });
    expect(fixture.calls()).toBe(0);
  });

  it("team-owned run: a dynamic plugin with no team credential refuses before discovery", async () => {
    // An MCP-backed plugin lists its actions over the credential, so
    // discovery itself throws the plugin's generic message when the team
    // holds nothing. The team refusal must win: its copy names the fix.
    const fixture = countingAction();
    const actionPlugin: ActionPlugin = {
      service: "demo",
      actions: [],
      async resolveActions({ credentials }) {
        if ((await credentials.get()) === null) throw new Error("demo: no credential connected");
        return [fixture.action];
      },
    };
    const plugin: ValetPlugin = {
      name: "demo",
      version: "0.0.1",
      actions: [actionPlugin],
      credentials: [{ type: "api_key", configKeys: ["apiKey"] }],
    };
    const store = new FakeCredentialStore();
    store.seed({ type: "user", id: "u1" }, "demo", { type: "api_key", apiKey: "personal-tok" });
    const invoke = buildActionInvoker({
      db: await makeDb(),
      credentials: store,
      actionPluginByService: new Map([["demo", { plugin, actionPlugin }]]),
    });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:team-dynamic" },
      { userId: "u1", orgId: "org1", owner: { type: "team", id: "t1" } },
    );

    expect(result).toEqual({
      ok: false,
      error:
        "This team has no demo credential. Share one from Integrations, or store one for the team in Settings → Organization → Teams.",
    });
    expect(fixture.calls()).toBe(0);
  });

  it("team-owned run: a service with no credential declaration still executes", async () => {
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:team-undeclared" },
      { userId: "team:t1", orgId: "org1", owner: { type: "team", id: "t1" } },
    );

    expect(result).toEqual({ ok: true, result: { echoed: "hi", hasCredential: false } });
    expect(fixture.calls()).toBe(1);
  });

  it("team-owned run: a broken delegated reference returns the typed error", async () => {
    const { TeamCredentialStore, CredentialReferenceBrokenError } = await import(
      "./team-credential-store.js"
    );
    const inner = new FakeCredentialStore();
    inner.seed({ type: "team", id: "t1" }, "demo", {
      type: "oauth2",
      metadata: { delegatedFrom: "u1" },
    });
    const store = new TeamCredentialStore(inner, { isMember: async () => true });
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: store, actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:team-broken" },
      { userId: "team:t1", orgId: "org1", owner: { type: "team", id: "t1" } },
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && "error" in result ? result.error : "").toMatch(
      /Reconnect demo|share it with the team again/,
    );
    expect(result.ok === false && "error" in result ? result.error : "").toBe(
      new CredentialReferenceBrokenError("demo").message,
    );
  });

  // Discovery reads the credential before any try/catch the invoker has. A
  // lease refusal raised there must come back as a failed result that names
  // the fix, not as a rejected promise the workflow node reports bare.
  it("team-owned run: obsolete grants do not block action discovery", async () => {
    const store = new FakeCredentialStore();
    store.seed({ type: "team", id: "t1" }, "onepassword", {
      type: "service_account",
      metadata: { refs: ["op://Shared/Acme/credential"] },
    });
    store.seed({ type: "team", id: "t1" }, "demo", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://Shared/Other/password", tokenScope: "org" } },
    });
    const dynamicAction = countingAction({ id: "demo.dyn" });
    const actionPlugin: ActionPlugin = {
      service: "demo",
      actions: [],
      resolveActions: async ({ credentials }) => {
        await credentials.get();
        return [dynamicAction.action];
      },
    };
    const actionPluginByService = actionPluginByServiceOf("demo", actionPlugin);
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: store, actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "dyn", params: { msg: "hi" }, invocationId: "workflow:r1:team-lease-dyn" },
      { userId: "team:t1", orgId: "org1", owner: { type: "team", id: "t1" } },
    );

    expect(result.ok).toBe(true);
    expect(dynamicAction.calls()).toBe(1);
  });

  it("team-owned run: an unknown action reports the typo, not a missing credential", async () => {
    const fixture = countingAction();
    const actionPlugin: ActionPlugin = { service: "demo", actions: [fixture.action] };
    const plugin: ValetPlugin = {
      name: "demo",
      version: "0.0.1",
      actions: [actionPlugin],
      credentials: [{ type: "api_key", configKeys: ["apiKey"] }],
    };
    // No team row: the credential refusal would fire if it ran first. The
    // action name is what is wrong here, so that is what the error names.
    const invoke = buildActionInvoker({
      db: await makeDb(),
      credentials: new FakeCredentialStore(),
      actionPluginByService: new Map([["demo", { plugin, actionPlugin }]]),
    });

    const result = await invoke(
      { service: "demo", action: "pnig", params: { msg: "hi" }, invocationId: "workflow:r1:team-typo" },
      { userId: "team:t1", orgId: "org1", owner: { type: "team", id: "t1" } },
    );

    expect(result).toEqual({ ok: false, error: "unknown action: demo.pnig" });
    expect(fixture.calls()).toBe(0);
  });

  it("execute throw is caught and mapped to {ok:false, error}", async () => {
    const fixture = countingAction({
      execute: async () => {
        throw new Error("boom");
      },
    });
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      userOwner,
    );

    expect(result).toEqual({ ok: false, error: "boom" });
  });

  it("PluginActionResult failure maps to {ok:false, error}", async () => {
    const fixture = countingAction({
      execute: async () => ({ success: false, error: "denied by upstream" }),
    });
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      userOwner,
    );

    expect(result).toEqual({ ok: false, error: "denied by upstream" });
  });

  it("dynamic resolveActions is used when the action isn't in the static list", async () => {
    let resolveCalls = 0;
    const dynamicAction = countingAction({ id: "demo.dyn" });
    const actionPlugin: ActionPlugin = {
      service: "demo",
      actions: [],
      resolveActions: async () => {
        resolveCalls += 1;
        return [dynamicAction.action];
      },
    };
    const actionPluginByService = actionPluginByServiceOf("demo", actionPlugin);
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "dyn", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      userOwner,
    );

    expect(result).toEqual({ ok: true, result: { echoed: "hi", hasCredential: false } });
    expect(dynamicAction.calls()).toBe(1);
    expect(resolveCalls).toBe(1);
  });

  it("concurrent duplicate invocations converge on one stored result", async () => {
    let seen = 0;
    const fixture = countingAction({
      execute: async (args) => {
        seen += 1;
        return { success: true, data: { call: seen, msg: (args as { msg: string }).msg } };
      },
    });
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });
    const req = { service: "demo", action: "ping", params: { msg: "race" }, invocationId: "workflow:r1:n1" };

    const [a, b] = await Promise.all([invoke(req, userOwner), invoke(req, userOwner)]);

    expect(a).toEqual(b);
  });

  it("returns a deterministic error for a service whose org prerequisite is unconfigured", async () => {
    // Availability gate (integration-availability design): the plugin declares
    // requires.orgCredential and no org credential exists for ctx.orgId.
    const fixture = countingAction({ id: "gated.ping" });
    const actionPlugin: ActionPlugin = { service: "gated", actions: [fixture.action] };
    const plugin: ValetPlugin = {
      name: "gated",
      version: "0.0.1",
      actions: [actionPlugin],
      credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }],
    };
    const actionPluginByService = new Map([["gated", { plugin, actionPlugin }]]);
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });

    const result = await invoke(
      { service: "gated", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:gated" },
      userOwner,
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && "error" in result ? result.error : "").toContain("Settings → Organization");
    expect(fixture.calls()).toBe(0);
  });

  // A team may hold its own verified token for an org-provided service
  // (team credentials design). With no org row, that token is the service
  // for this team; the gate must read it before it refuses.
  it("team-owned run: a team's own token satisfies an org-credential prerequisite with no org row", async () => {
    const fixture = countingAction({ id: "gated.ping" });
    const actionPlugin: ActionPlugin = { service: "gated", actions: [fixture.action] };
    const plugin: ValetPlugin = {
      name: "gated",
      version: "0.0.1",
      actions: [actionPlugin],
      credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }],
    };
    const store = new FakeCredentialStore();
    store.seed({ type: "team", id: "t1" }, "gated", {
      type: "bot_token",
      accessToken: "xoxb-team",
      scopes: ["assistant:write"],
      metadata: { teamId: "T0TEAM", teamName: "Team Workspace", botUserId: "U0BOT" },
    });
    const invoke = buildActionInvoker({
      db: await makeDb(),
      credentials: store,
      actionPluginByService: new Map([["gated", { plugin, actionPlugin }]]),
    });

    const result = await invoke(
      { service: "gated", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:team-own-gated" },
      { userId: "team:t1", orgId: "org1", owner: { type: "team", id: "t1" } },
    );

    expect(result).toEqual({ ok: true, result: { echoed: "hi", hasCredential: true } });
    expect(fixture.calls()).toBe(1);
  });

  it("team-owned run: with neither an org row nor a team row the unconfigured refusal is unchanged", async () => {
    const fixture = countingAction({ id: "gated.ping" });
    const actionPlugin: ActionPlugin = { service: "gated", actions: [fixture.action] };
    const plugin: ValetPlugin = {
      name: "gated",
      version: "0.0.1",
      actions: [actionPlugin],
      credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }],
    };
    const invoke = buildActionInvoker({
      db: await makeDb(),
      credentials: new FakeCredentialStore(),
      actionPluginByService: new Map([["gated", { plugin, actionPlugin }]]),
    });

    const result = await invoke(
      { service: "gated", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:team-none-gated" },
      { userId: "team:t1", orgId: "org1", owner: { type: "team", id: "t1" } },
    );

    expect(result).toEqual({
      ok: false,
      error: "gated is not configured for this organization. An admin can set it up in Settings → Organization.",
    });
    expect(fixture.calls()).toBe(0);
  });

  it("gates on a shared oauth declaration held by a different plugin (full registry scan)", async () => {
    // The declaration for the credential service lives on plugin B; the
    // action lives on plugin A. The gate must scan the full plugin set, not
    // just the action's owning plugin, or the env-unset OAuth service slips
    // through as "manual".
    const fixture = countingAction({ id: "shared.ping" });
    const actionPlugin: ActionPlugin = { service: "shared", actions: [fixture.action] };
    const actionsPlugin: ValetPlugin = { name: "shared-actions", version: "0.0.1", actions: [actionPlugin] };
    const declPlugin: ValetPlugin = {
      name: "shared",
      version: "0.0.1",
      credentials: [{
        type: "oauth2",
        configKeys: ["accessToken"],
        oauth: {
          mode: "authorization_code",
          authorizationUrl: "https://accounts.example.com/auth",
          tokenUrl: "https://accounts.example.com/token",
          clientIdEnv: "UNSET_SHARED_ID",
          clientSecretEnv: "UNSET_SHARED_SECRET",
        },
      }],
    };
    const actionPluginByService = new Map([["shared", { plugin: actionsPlugin, actionPlugin }]]);
    const invoke = buildActionInvoker({
      db: await makeDb(),
      credentials: new FakeCredentialStore(),
      actionPluginByService,
      plugins: [actionsPlugin, declPlugin],
    });

    const result = await invoke(
      { service: "shared", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:shared" },
      userOwner,
    );

    expect(result.ok).toBe(false);
    expect(fixture.calls()).toBe(0);
  });

  it("executes normally once the org credential exists for the gated service", async () => {
    const fixture = countingAction({ id: "gated.ping" });
    const actionPlugin: ActionPlugin = { service: "gated", actions: [fixture.action] };
    const plugin: ValetPlugin = {
      name: "gated",
      version: "0.0.1",
      actions: [actionPlugin],
      credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }],
    };
    const store = new FakeCredentialStore();
    store.seed({ type: "org", id: "org1" }, "gated", { type: "bot_token", accessToken: "org-tok" });
    const actionPluginByService = new Map([["gated", { plugin, actionPlugin }]]);
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: store, actionPluginByService });

    const result = await invoke(
      { service: "gated", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:gated-ok" },
      userOwner,
    );

    expect(result.ok).toBe(true);
    expect(fixture.calls()).toBe(1);
  });

  it("hands the ORG credential to a handler when the run owner is a member (owner escalation)", async () => {
    // The gate above only proves the availability check opens. It says
    // nothing about the token the handler actually receives, because
    // `countingAction` never reads one — which is how an org-provided
    // service could pass the gate and then fail inside the action.
    //
    // `requires.orgCredential` means the org credential IS the integration
    // (integration-availability rule 5): a member has nothing of their own
    // to connect, and a session resolves it by escalating from the user
    // owner to the org (`engine/host.ts`'s slack branch). A workflow tool
    // node runs as the workflow's owner — a user — so without the same
    // escalation every org-provided service reads null here and every such
    // node fails with the plugin's own missing-credential message.
    let seenToken: string | null = null;
    const action: PluginAction = {
      id: "gated.whoami",
      name: "whoami",
      description: "reports the token it was handed",
      riskLevel: "low",
      parameters: Type.Object({}),
      execute: async (_args, ctx) => {
        seenToken = (await ctx.credentials.get())?.accessToken ?? null;
        return { success: true, data: { token: seenToken } };
      },
    };
    const actionPlugin: ActionPlugin = { service: "gated", actions: [action] };
    const plugin: ValetPlugin = {
      name: "gated",
      version: "0.0.1",
      actions: [actionPlugin],
      credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }],
    };
    const store = new FakeCredentialStore();
    store.seed({ type: "org", id: "org1" }, "gated", { type: "bot_token", accessToken: "org-tok" });
    const invoke = buildActionInvoker({
      db: await makeDb(),
      credentials: store,
      actionPluginByService: new Map([["gated", { plugin, actionPlugin }]]),
    });

    const result = await invoke(
      { service: "gated", action: "whoami", params: {}, invocationId: "workflow:r1:gated-token" },
      userOwner,
    );

    expect(result).toEqual({ ok: true, result: { token: "org-tok" } });
    expect(seenToken).toBe("org-tok");
  });

  it("stamps the run owner's linked Slack id onto a resolved slack credential", async () => {
    // The token alone cannot answer "may the run owner read this private
    // channel" — plugin-slack's private-channel guard and `slack.dm_owner`
    // read `metadata.owner_slack_user_id`, which only the identity link can
    // supply. Without this stamp a linked user's workflow still fails with
    // "Owner has not linked their Slack identity" (run wfrun_mt1kva4i5wqesi).
    let seenOwnerId: unknown;
    const action: PluginAction = {
      id: "slack.whoami",
      name: "whoami",
      description: "reports the owner id it was handed",
      riskLevel: "low",
      parameters: Type.Object({}),
      execute: async (_args, ctx) => {
        const cred = await ctx.credentials.get();
        seenOwnerId = cred?.metadata?.["owner_slack_user_id"];
        return { success: true, data: { token: cred?.accessToken ?? null } };
      },
    };
    const actionPlugin: ActionPlugin = { service: "slack", actions: [action] };
    const plugin: ValetPlugin = {
      name: "slack",
      version: "0.0.1",
      actions: [actionPlugin],
      credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }],
    };
    const store = new FakeCredentialStore();
    store.seed({ type: "org", id: "org1" }, "slack", { type: "bot_token", accessToken: "org-tok" });
    const db = await makeDb();
    await linkIdentity(db, { provider: "slack", externalId: "U123LINKED", userId: "u1" });
    const invoke = buildActionInvoker({
      db,
      credentials: store,
      actionPluginByService: new Map([["slack", { plugin, actionPlugin }]]),
    });

    const result = await invoke(
      { service: "slack", action: "whoami", params: {}, invocationId: "workflow:r1:slack-identity" },
      userOwner,
    );

    expect(result).toEqual({ ok: true, result: { token: "org-tok" } });
    expect(seenOwnerId).toBe("U123LINKED");
  });

  it("leaves the slack credential bare when the run owner has no identity link", async () => {
    // No link → no stamp; the plugin's own guards keep failing closed with
    // their "link it in Settings" message, which is now accurate.
    let seenOwnerId: unknown = "sentinel";
    const action: PluginAction = {
      id: "slack.whoami",
      name: "whoami",
      description: "reports the owner id it was handed",
      riskLevel: "low",
      parameters: Type.Object({}),
      execute: async (_args, ctx) => {
        const cred = await ctx.credentials.get();
        seenOwnerId = cred?.metadata?.["owner_slack_user_id"];
        return { success: true, data: { token: cred?.accessToken ?? null } };
      },
    };
    const actionPlugin: ActionPlugin = { service: "slack", actions: [action] };
    const plugin: ValetPlugin = {
      name: "slack",
      version: "0.0.1",
      actions: [actionPlugin],
      credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }],
    };
    const store = new FakeCredentialStore();
    store.seed({ type: "org", id: "org1" }, "slack", { type: "bot_token", accessToken: "org-tok" });
    const invoke = buildActionInvoker({
      db: await makeDb(),
      credentials: store,
      actionPluginByService: new Map([["slack", { plugin, actionPlugin }]]),
    });

    const result = await invoke(
      { service: "slack", action: "whoami", params: {}, invocationId: "workflow:r1:slack-nolink" },
      userOwner,
    );

    expect(result).toEqual({ ok: true, result: { token: "org-tok" } });
    expect(seenOwnerId).toBeUndefined();
  });

  it("does not stamp a Slack identity for an org-owned run", async () => {
    // An org-owned run has no single person whose channel membership could
    // authorize a private-channel read — the credential stays bare even
    // when identity links exist.
    let seenOwnerId: unknown = "sentinel";
    const action: PluginAction = {
      id: "slack.whoami",
      name: "whoami",
      description: "reports the owner id it was handed",
      riskLevel: "low",
      parameters: Type.Object({}),
      execute: async (_args, ctx) => {
        const cred = await ctx.credentials.get();
        seenOwnerId = cred?.metadata?.["owner_slack_user_id"];
        return { success: true, data: { token: cred?.accessToken ?? null } };
      },
    };
    const actionPlugin: ActionPlugin = { service: "slack", actions: [action] };
    const plugin: ValetPlugin = {
      name: "slack",
      version: "0.0.1",
      actions: [actionPlugin],
      credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }],
    };
    const store = new FakeCredentialStore();
    store.seed({ type: "org", id: "org1" }, "slack", { type: "bot_token", accessToken: "org-tok" });
    const db = await makeDb();
    await linkIdentity(db, { provider: "slack", externalId: "U123LINKED", userId: "u1" });
    const invoke = buildActionInvoker({
      db,
      credentials: store,
      actionPluginByService: new Map([["slack", { plugin, actionPlugin }]]),
    });

    const orgOwner: ActionInvocationContext = { userId: "org:org1", orgId: "org1", owner: { type: "org", id: "org1" } };
    const result = await invoke(
      { service: "slack", action: "whoami", params: {}, invocationId: "workflow:r1:slack-orgowner" },
      orgOwner,
    );

    expect(result).toEqual({ ok: true, result: { token: "org-tok" } });
    expect(seenOwnerId).toBeUndefined();
  });

  it("keeps slack.dm_owner fail-closed for a team owner with no identity", async () => {
    const store = new FakeCredentialStore();
    store.seed({ type: "org", id: "org1" }, "slack", { type: "bot_token", accessToken: "org-tok" });
    const db = await makeDb();
    // A member's identity link must not be stamped onto a team-owned run.
    await linkIdentity(db, { provider: "slack", externalId: "U123LINKED", userId: "u1" });
    const plugin: ValetPlugin = {
      name: "slack", version: "0.0.1", actions: [slackPlugin],
      credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }],
    };
    const invoke = buildActionInvoker({
      db,
      credentials: store,
      actionPluginByService: new Map([["slack", { plugin, actionPlugin: slackPlugin }]]),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await invoke(
        { service: "slack", action: "dm_owner", params: { text: "Hello" }, invocationId: "workflow:r1:team-dm-owner" },
        { userId: "team:t1", orgId: "org1", owner: { type: "team", id: "t1" } },
      );

      expect(result).toEqual({
        ok: false,
        error: "Owner has not linked their Slack identity. Ask them to link it in Settings > Integrations > Slack.",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("prefers the run owner's OWN credential over the org one", async () => {
    // Escalation is a fallback, never an override: a personal credential for
    // the same service still wins, the same precedence `engine/host.ts` gives
    // a personal Slack token over the org bot token.
    let seenToken: string | null = null;
    const action: PluginAction = {
      id: "gated.whoami",
      name: "whoami",
      description: "reports the token it was handed",
      riskLevel: "low",
      parameters: Type.Object({}),
      execute: async (_args, ctx) => {
        seenToken = (await ctx.credentials.get())?.accessToken ?? null;
        return { success: true, data: { token: seenToken } };
      },
    };
    const actionPlugin: ActionPlugin = { service: "gated", actions: [action] };
    const plugin: ValetPlugin = {
      name: "gated",
      version: "0.0.1",
      actions: [actionPlugin],
      credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }],
    };
    const store = new FakeCredentialStore();
    store.seed({ type: "org", id: "org1" }, "gated", { type: "bot_token", accessToken: "org-tok" });
    store.seed({ type: "user", id: "u1" }, "gated", { type: "bot_token", accessToken: "my-own-tok" });
    const invoke = buildActionInvoker({
      db: await makeDb(),
      credentials: store,
      actionPluginByService: new Map([["gated", { plugin, actionPlugin }]]),
    });

    const result = await invoke(
      { service: "gated", action: "whoami", params: {}, invocationId: "workflow:r1:gated-own" },
      userOwner,
    );

    expect(result).toEqual({ ok: true, result: { token: "my-own-tok" } });
    expect(seenToken).toBe("my-own-tok");
  });

  it("does NOT hand a member the org row for a service nobody declared org-provided", async () => {
    // `personal` declares a plain `api_key` with no `requires.orgCredential`,
    // so its org row is one person's configuration rather than the org's
    // shared credential. A member's run must not act as whoever stored it.
    let seenToken: string | null = null;
    const action: PluginAction = {
      id: "personal.whoami",
      name: "whoami",
      description: "reports the token it was handed",
      riskLevel: "low",
      parameters: Type.Object({}),
      execute: async (_args, ctx) => {
        seenToken = (await ctx.credentials.get())?.accessToken ?? null;
        return { success: true, data: { token: seenToken } };
      },
    };
    const actionPlugin: ActionPlugin = { service: "personal", actions: [action] };
    const plugin: ValetPlugin = {
      name: "personal",
      version: "0.0.1",
      actions: [actionPlugin],
      credentials: [{ type: "api_key", configKeys: ["apiKey"] }],
    };
    const store = new FakeCredentialStore();
    store.seed({ type: "org", id: "org1" }, "personal", { type: "api_key", apiKey: "someone-elses" });
    const invoke = buildActionInvoker({
      db: await makeDb(),
      credentials: store,
      actionPluginByService: new Map([["personal", { plugin, actionPlugin }]]),
    });

    const result = await invoke(
      { service: "personal", action: "whoami", params: {}, invocationId: "workflow:r1:personal" },
      userOwner,
    );

    expect(result).toEqual({ ok: true, result: { token: null } });
    expect(seenToken).toBeNull();
  });
});

/**
 * `github` service resolution (GH-T10) — the `github` credential provider
 * must resolve through `resolveGitHubToken` instead of a raw
 * `CredentialStore.get` read. Exercised against a real `PgCredentialStore`
 * + the shared fake GitHub API server (`test-helpers/github-fixture.ts`),
 * mirroring `services/github-tokens.test.ts`'s own harness rather than the
 * `FakeCredentialStore` the rest of this file uses — `resolveGitHubToken`
 * needs a real `CredentialStore` to persist single-flight refresh
 * rotations against (not exercised here, but keeping one credential-store
 * implementation per file avoids a second, divergent fake).
 */
describe("buildActionInvoker: github service resolution", () => {
  const orgId = "gh-org";
  const userId = "gh-user";
  const NOW = 1_700_000_000_000;

  const { privateKey: privateKeyPem } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const appConfig: GithubAppConfig = {
    appId: "1",
    appSlug: "valet-app",
    oauthClientId: "Iv1.abc",
    htmlUrl: "https://github.com/apps/valet-app",
    oauthClientSecret: "client-secret",
    webhookSecret: "webhook-secret",
    privateKeyPem,
  };

  let fixture: GithubFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  /** A minimal `github`-service action that mirrors how the real
   * plugin-github actions consume the credential (`getOctokit` in
   * `plugin-github/src/actions/actions.ts`): a bare `ctx.credentials.get()`,
   * throwing the exact same connect-hint message on a missing token. */
  function githubWhoamiAction(): PluginAction {
    return {
      id: "github.whoami",
      name: "whoami",
      description: "whoami",
      riskLevel: "low",
      parameters: Type.Object({}),
      execute: async (_args, ctx) => {
        const cred = await ctx.credentials.get();
        const token = cred?.accessToken;
        if (!token) {
          throw new Error("Missing GitHub access token. Connect the GitHub integration in Settings.");
        }
        return { success: true, data: { token } };
      },
    };
  }

  async function harness(): Promise<{ appDb: AppDb; credentials: PgCredentialStore }> {
    const { appDb, pgdb } = await freshTestPgDb();
    return { appDb, credentials: new PgCredentialStore(pgdb, deriveSecretKey("test-key")) };
  }

  /** Same credential consumption as `githubWhoamiAction`, but with the
   * `owner`/`repo` parameters every real repo-scoped plugin-github action
   * declares — the pair an `app`-credential node's installation lookup is
   * derived from. */
  function githubRepoAction(): PluginAction {
    return {
      id: "github.create_comment",
      name: "create_comment",
      description: "create a comment",
      riskLevel: "low",
      parameters: Type.Object({ owner: Type.String(), repo: Type.String() }),
      execute: async (_args, ctx) => {
        const cred = await ctx.credentials.get();
        const token = cred?.accessToken;
        if (!token) {
          throw new Error("Missing GitHub access token. Connect the GitHub integration in Settings.");
        }
        return { success: true, data: { token } };
      },
    };
  }

  function githubActionPluginByService(): Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }> {
    return actionPluginByServiceOf("github", {
      service: "github",
      actions: [githubWhoamiAction(), githubRepoAction()],
    });
  }

  /** The github plugin with its credential declared, so the team refusal
   * gate sees `github` as a service a team must hold a credential for. */
  function declaredGithubActionPluginByService(
    actions: PluginAction[],
  ): Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }> {
    const actionPlugin: ActionPlugin = { service: "github", actions };
    const plugin: ValetPlugin = {
      name: "github",
      version: "0.0.1",
      actions: [actionPlugin],
      credentials: [{ type: "oauth2", configKeys: ["accessToken"] }],
    };
    return new Map([["github", { plugin, actionPlugin }]]);
  }

  /** `githubWhoamiAction` plus a call counter, so a refusal can be told
   * apart from the action's own missing-token throw. */
  function countingGithubWhoami(): { action: PluginAction; calls: () => number } {
    let count = 0;
    const base = githubWhoamiAction();
    const action: PluginAction = {
      ...base,
      execute: async (args, ctx) => {
        count += 1;
        return base.execute(args, ctx);
      },
    };
    return { action, calls: () => count };
  }

  const teamOwner: ActionInvocationContext = {
    userId: "team:gh-team",
    orgId,
    owner: { type: "team", id: "gh-team" },
  };
  const TEAM_GITHUB_REFUSAL =
    "This team has no github credential. Install the GitHub App on the repository's owner in " +
    "Settings → Organization → GitHub, or store a github credential for the team in Settings → Organization → Teams.";

  it("team-owned: no installation and no team row refuses before execute and names the fix", async () => {
    const { appDb, credentials } = await harness();
    fixture = startGithubFixture();
    const whoami = countingGithubWhoami();
    const invoke = buildActionInvoker({
      db: appDb,
      credentials,
      actionPluginByService: declaredGithubActionPluginByService([whoami.action]),
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });

    const result = await invoke(
      { service: "github", action: "whoami", params: {}, invocationId: "workflow:r1:team-gh-none" },
      teamOwner,
    );

    expect(result).toEqual({ ok: false, error: TEAM_GITHUB_REFUSAL });
    expect(whoami.calls()).toBe(0);
  });

  it("team-owned: an App installation resolves the installation token", async () => {
    const { appDb, credentials } = await harness();
    await saveAppConfig({ credentials }, orgId, appConfig);
    await appDb.insert(githubInstallations).values({
      id: "ghi_team_1",
      orgId,
      installationId: 4242,
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "all",
      suspended: false,
      cachedToken: null,
      cachedTokenExpiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    fixture = startGithubFixture({
      createInstallationToken: (id) => ({
        body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() },
      }),
    });
    const whoami = countingGithubWhoami();
    const invoke = buildActionInvoker({
      db: appDb,
      credentials,
      actionPluginByService: declaredGithubActionPluginByService([whoami.action]),
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });

    const result = await invoke(
      { service: "github", action: "whoami", params: {}, invocationId: "workflow:r1:team-gh-inst" },
      teamOwner,
    );

    expect(result).toEqual({ ok: true, result: { token: "inst-4242" } });
    expect(whoami.calls()).toBe(1);
  });

  it("team-owned: a stored team github credential is the identity the run acts as", async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "team", id: "gh-team" }, "github", {
      type: "oauth2",
      accessToken: "team-tok",
    });
    fixture = startGithubFixture();
    const whoami = countingGithubWhoami();
    const invoke = buildActionInvoker({
      db: appDb,
      credentials,
      actionPluginByService: declaredGithubActionPluginByService([whoami.action]),
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });

    const result = await invoke(
      { service: "github", action: "whoami", params: {}, invocationId: "workflow:r1:team-gh-row" },
      teamOwner,
    );

    expect(result).toEqual({ ok: true, result: { token: "team-tok" } });
  });

  // A delegated row follows to the member's live github row. When that row
  // is one the member's own runs would refuse (identity-only scopes here),
  // the team run must not act on it either: it falls to the App path the
  // same way a team with no row does.
  it("team-owned: an unhealthy delegated github row falls through to the installation token", async () => {
    const { TeamCredentialStore } = await import("./team-credential-store.js");
    const { appDb, credentials: inner } = await harness();
    const credentials = new TeamCredentialStore(inner, { isMember: async () => true });
    await saveAppConfig({ credentials }, orgId, appConfig);
    await appDb.insert(githubInstallations).values({
      id: "ghi_team_2",
      orgId,
      installationId: 4343,
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "all",
      suspended: false,
      cachedToken: null,
      cachedTokenExpiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await credentials.save({ type: "user", id: userId }, "github", {
      type: "oauth2",
      accessToken: "identity-tok",
      metadata: { login: "octocat", identityOnly: true },
    });
    await credentials.save({ type: "team", id: "gh-team" }, "github", {
      type: "oauth2",
      metadata: { delegatedFrom: userId, sourceType: "oauth2" },
    });
    fixture = startGithubFixture({
      createInstallationToken: (id) => ({
        body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() },
      }),
    });
    const whoami = countingGithubWhoami();
    const invoke = buildActionInvoker({
      db: appDb,
      credentials,
      actionPluginByService: declaredGithubActionPluginByService([whoami.action]),
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });

    const result = await invoke(
      { service: "github", action: "whoami", params: {}, invocationId: "workflow:r1:team-gh-unhealthy" },
      teamOwner,
    );

    expect(result).toEqual({ ok: true, result: { token: "inst-4343" } });
    expect(whoami.calls()).toBe(1);
  });

  it("user-connected: resolves the user's healthy github credential", async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "user", id: userId }, "github", {
      type: "oauth2",
      accessToken: "user-tok",
      metadata: { login: "octocat" },
    });
    fixture = startGithubFixture();
    const invoke = buildActionInvoker({
      db: appDb,
      credentials,
      actionPluginByService: githubActionPluginByService(),
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });

    const result = await invoke(
      { service: "github", action: "whoami", params: {}, invocationId: "workflow:r1:n1" },
      { userId, orgId, owner: { type: "user", id: userId } },
    );

    expect(result).toEqual({ ok: true, result: { token: "user-tok" } });
  });

  it("unconnected + a sole installation: resolves an installation token (anonymous org path)", async () => {
    const { appDb, credentials } = await harness();
    await saveAppConfig({ credentials }, orgId, appConfig);
    await appDb.insert(githubInstallations).values({
      id: "ghi_999",
      orgId,
      installationId: 999,
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "all",
      suspended: false,
      cachedToken: null,
      cachedTokenExpiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    fixture = startGithubFixture({
      createInstallationToken: (id) => ({
        body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() },
      }),
    });
    const invoke = buildActionInvoker({
      db: appDb,
      credentials,
      actionPluginByService: githubActionPluginByService(),
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });

    const result = await invoke(
      { service: "github", action: "whoami", params: {}, invocationId: "workflow:r1:n1" },
      { userId, orgId, owner: { type: "user", id: userId } },
    );

    expect(result).toEqual({ ok: true, result: { token: "inst-999" } });
  });

  it("team owner + member PAT + installation: uses the installation, not the member PAT", async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "user", id: userId }, "github", {
      type: "oauth2",
      accessToken: "user-tok",
      metadata: { login: "octocat" },
    });
    await saveAppConfig({ credentials }, orgId, appConfig);
    await appDb.insert(githubInstallations).values({
      id: "ghi_444",
      orgId,
      installationId: 444,
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "all",
      suspended: false,
      cachedToken: null,
      cachedTokenExpiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    fixture = startGithubFixture({
      createInstallationToken: (id) => ({
        body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() },
      }),
    });
    const invoke = buildActionInvoker({
      db: appDb,
      credentials,
      actionPluginByService: githubActionPluginByService(),
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });

    const result = await invoke(
      { service: "github", action: "whoami", params: {}, invocationId: "workflow:r1:n-team" },
      { userId, orgId, owner: { type: "team", id: "team_1" } },
    );

    expect(result).toEqual({ ok: true, result: { token: "inst-444" } });
  });

  it("repo-bound session with explicit binding auth:\"app\": installation token even when the user is connected", async () => {
    const { appDb, credentials } = await harness();
    // A healthy user credential IS connected — must be ignored because the
    // binding's `auth` is the explicit "app" tier, not "auto".
    await credentials.save({ type: "user", id: userId }, "github", {
      type: "oauth2",
      accessToken: "user-tok",
      metadata: { login: "octocat" },
    });
    await saveAppConfig({ credentials }, orgId, appConfig);
    await appDb.insert(githubInstallations).values({
      id: "ghi_1",
      orgId,
      installationId: 111,
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "all",
      suspended: false,
      cachedToken: null,
      cachedTokenExpiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const sessionId = "sess-1";
    await appDb.insert(sessionRepos).values({
      sessionId,
      host: "github",
      fullName: "acme/repo",
      cloneUrl: "https://github.com/acme/repo.git",
      auth: "app",
      position: 0,
    });
    fixture = startGithubFixture({
      createInstallationToken: (id) => ({
        body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() },
      }),
    });
    const invoke = buildActionInvoker({
      db: appDb,
      credentials,
      actionPluginByService: githubActionPluginByService(),
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });

    const result = await invoke(
      { service: "github", action: "whoami", params: {}, invocationId: "workflow:r1:n1" },
      { userId, orgId, owner: { type: "user", id: userId }, sessionId },
    );

    expect(result).toEqual({ ok: true, result: { token: "inst-111" } });
  });

  it("does not expose the App slug when personal installations are disabled", async () => {
    const { appDb, credentials } = await harness();
    await appDb.insert(orgs).values({
      id: orgId,
      name: "GitHub org",
      createdAt: NOW,
      allowPersonalInstallations: false,
    });
    await saveAppConfig({ credentials }, orgId, appConfig);
    fixture = startGithubFixture();
    const invoke = buildActionInvoker({
      db: appDb,
      credentials,
      actionPluginByService: githubActionPluginByService(),
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });

    const result = await invoke(
      { service: "github", action: "whoami", params: {}, invocationId: "workflow:r1:personal-install-disabled" },
      { userId, orgId, owner: { type: "user", id: userId } },
    );

    expect(result).toEqual({
      ok: false,
      error: "the GitHub App has no usable installation. Ask an org admin for GitHub access.",
    });
    if (!result.ok && "error" in result) expect(result.error).not.toContain(appConfig.appSlug);
  });

  it("unbound session, no user credential, no installation, no org PAT: the connect-hint error surfaces as the action's error result", async () => {
    const { appDb, credentials } = await harness();
    fixture = startGithubFixture();
    const invoke = buildActionInvoker({
      db: appDb,
      credentials,
      actionPluginByService: githubActionPluginByService(),
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });

    const result = await invoke(
      { service: "github", action: "whoami", params: {}, invocationId: "workflow:r1:n1" },
      { userId, orgId, owner: { type: "user", id: userId } },
    );

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      error: expect.stringContaining("connect your GitHub account"),
    });
  });

  // ── credential: "app" — the bot identity, or a loud failure ───────────
  //
  // A user-owned review workflow must comment as the GitHub App, not as the
  // person who saved it. `auto` + `api` tries the user's own credential
  // first, so an `app` node MUST bypass that precedence, and MUST fail
  // instead of falling back to a human identity.

  /** App config + one installation on `acme`, plus a healthy user
   * credential that an `app`-credential node must ignore. */
  async function seedAppAndUser(appDb: AppDb, credentials: PgCredentialStore): Promise<void> {
    await credentials.save({ type: "user", id: userId }, "github", {
      type: "oauth2",
      accessToken: "user-tok",
      metadata: { login: "octocat" },
    });
    await saveAppConfig({ credentials }, orgId, appConfig);
    await appDb.insert(githubInstallations).values({
      id: "ghi_222",
      orgId,
      installationId: 222,
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "all",
      suspended: false,
      cachedToken: null,
      cachedTokenExpiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  it('credential "app": resolves the installation for the params owner, ignoring a healthy user credential', async () => {
    const { appDb, credentials } = await harness();
    await seedAppAndUser(appDb, credentials);
    fixture = startGithubFixture({
      createInstallationToken: (id) => ({
        body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() },
      }),
    });
    const invoke = buildActionInvoker({
      db: appDb,
      credentials,
      actionPluginByService: githubActionPluginByService(),
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });

    const result = await invoke(
      {
        service: "github",
        action: "create_comment",
        params: { owner: "acme", repo: "widgets" },
        invocationId: "workflow:r1:n1",
        credential: "app",
      },
      { userId, orgId, owner: { type: "user", id: userId } },
    );

    expect(result).toEqual({ ok: true, result: { token: "inst-222" } });
  });

  it('credential "app": fails loudly when the App is not installed on the params owner', async () => {
    const { appDb, credentials } = await harness();
    // Installed on `acme` only; the action targets `other-org`.
    await seedAppAndUser(appDb, credentials);
    fixture = startGithubFixture({
      createInstallationToken: (id) => ({
        body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() },
      }),
    });
    const invoke = buildActionInvoker({
      db: appDb,
      credentials,
      actionPluginByService: githubActionPluginByService(),
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });

    const result = await invoke(
      {
        service: "github",
        action: "create_comment",
        params: { owner: "other-org", repo: "widgets" },
        invocationId: "workflow:r1:n2",
        credential: "app",
      },
      { userId, orgId, owner: { type: "user", id: userId } },
    );

    // No silent fallback to `user-tok` — the whole point of the strict tier.
    expect(result).toEqual({
      ok: false,
      error:
        "the GitHub App is not installed on other-org — open Settings → Organization → GitHub and install it on other-org",
    });
  });

  it('credential "app": names the missing owner/repo parameters when the repo cannot be derived', async () => {
    const { appDb, credentials } = await harness();
    await seedAppAndUser(appDb, credentials);
    fixture = startGithubFixture();
    const invoke = buildActionInvoker({
      db: appDb,
      credentials,
      actionPluginByService: githubActionPluginByService(),
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });

    const result = await invoke(
      { service: "github", action: "whoami", params: {}, invocationId: "workflow:r1:n3", credential: "app" },
      { userId, orgId, owner: { type: "user", id: userId } },
    );

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      error: expect.stringContaining('Add "owner" and "repo"'),
    });
  });

  it('credential "auto" keeps the default precedence: the user credential still wins', async () => {
    const { appDb, credentials } = await harness();
    await seedAppAndUser(appDb, credentials);
    fixture = startGithubFixture();
    const invoke = buildActionInvoker({
      db: appDb,
      credentials,
      actionPluginByService: githubActionPluginByService(),
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });

    const result = await invoke(
      {
        service: "github",
        action: "create_comment",
        params: { owner: "acme", repo: "widgets" },
        invocationId: "workflow:r1:n4",
        credential: "auto",
      },
      { userId, orgId, owner: { type: "user", id: userId } },
    );

    expect(result).toEqual({ ok: true, result: { token: "user-tok" } });
  });

  it('credential "user": fails loudly when the user has no connected GitHub account', async () => {
    const { appDb, credentials } = await harness();
    // App + installation exist, but no user credential — `user` must not
    // fall back to the installation.
    await saveAppConfig({ credentials }, orgId, appConfig);
    await appDb.insert(githubInstallations).values({
      id: "ghi_333",
      orgId,
      installationId: 333,
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "all",
      suspended: false,
      cachedToken: null,
      cachedTokenExpiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    fixture = startGithubFixture();
    const invoke = buildActionInvoker({
      db: appDb,
      credentials,
      actionPluginByService: githubActionPluginByService(),
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });

    const result = await invoke(
      {
        service: "github",
        action: "create_comment",
        params: { owner: "acme", repo: "widgets" },
        invocationId: "workflow:r1:n5",
        credential: "user",
      },
      { userId, orgId, owner: { type: "user", id: userId } },
    );

    expect(result).toEqual({
      ok: false,
      error: "no GitHub account is connected for this user",
    });
  });

  it("non-github service is untouched: no githubTokenDeps required, resolveGitHubToken never consulted", async () => {
    const store = new FakeCredentialStore();
    store.seed({ type: "user", id: "u1" }, "demo", { type: "api_key", apiKey: "secret-token" });
    const fixture2 = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture2.action] });
    // githubTokenDeps deliberately omitted — a non-github action must not need it.
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: store, actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      userOwner,
    );

    expect(result).toEqual({ ok: true, result: { echoed: "hi", hasCredential: true } });
  });

  it("a non-github service refuses an app selection instead of ignoring it", async () => {
    const store = new FakeCredentialStore();
    store.seed({ type: "user", id: "u1" }, "demo", { type: "api_key", apiKey: "secret-token" });
    const fixture2 = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture2.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: store, actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1", credential: "app" },
      userOwner,
    );

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining("Remove the credential field") });
    // Refused before the action ran — an ignored selection would have let it
    // execute under the workflow owner's own credential.
    expect(fixture2.calls()).toBe(0);
  });
});

describe("buildActionInvoker: workflow policy enforcement (action-policies T3)", () => {
  const ORG = "org1";
  const RUN = "run_wf1";
  // A high-risk action: with no policy it defaults to require_approval.
  function highRiskAction() {
    let deployCount = 0;
    const inner = countingAction({
      id: "demo.deploy",
      execute: async () => {
        deployCount += 1;
        return { success: true as const, data: { deployed: true } };
      },
    });
    return {
      action: inner.action,
      calls: () => deployCount,
      lastArgs: inner.lastArgs,
    };
  }
  const highRiskPlugin = (a: PluginAction) => actionPluginByServiceOf("demo", {
    service: "demo",
    actions: [{ ...a, riskLevel: "critical" }],
  });
  const wfCtx: ActionInvocationContext = {
    userId: "u1", orgId: ORG, owner: { type: "user", id: "u1" }, workflowExecutionId: RUN,
  };

  it("require_approval (high-risk, no grant) returns requiresApproval and parks a pending audit row; action never runs", async () => {
    const db = await makeDb();
    const fixture = highRiskAction();
    const invoke = buildActionInvoker({ db, credentials: new FakeCredentialStore(), actionPluginByService: highRiskPlugin(fixture.action) });
    const res = await invoke({ service: "demo", action: "deploy", params: { msg: "x" }, invocationId: "workflow:run_wf1:n1" }, wfCtx);
    expect(res).toEqual({ ok: false, requiresApproval: true, riskLevel: "critical", provenance: "risk_default" });
    expect(fixture.calls()).toBe(0);
    const audit = await db.select().from(actionInvocations).where(eq(actionInvocations.workflowExecutionId, RUN));
    expect(audit).toHaveLength(1);
    expect(audit[0].status).toBe("pending");
    expect(audit[0].resolvedMode).toBe("require_approval");
  });

  it("an org deny fails the node as blocked; action never runs", async () => {
    const db = await makeDb();
    const fixture = highRiskAction();
    await db.insert(actionPolicies).values({
      id: "pd", orgId: ORG, principalType: "org", principalId: ORG,
      // Action-scope policies target the fully-qualified fqid — the ONE
      // canonical id both invocation paths resolve to (spec T6 #3, fixed).
      service: null, actionId: "demo.deploy", riskLevel: null, mode: "deny",
      paramMatchers: [], appliesIn: "any", origin: "settings", managedBy: null,
      expiresAt: null, revokedAt: null, createdAt: 1, updatedAt: 1,
    });
    const invoke = buildActionInvoker({ db, credentials: new FakeCredentialStore(), actionPluginByService: highRiskPlugin(fixture.action) });
    const res = await invoke({ service: "demo", action: "deploy", params: {}, invocationId: "workflow:run_wf1:n2" }, wfCtx);
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("blocked by org policy");
    expect(fixture.calls()).toBe(0);
  });

  it("an exec-scoped grant covers the action → it runs", async () => {
    const db = await makeDb();
    const fixture = highRiskAction();
    await db.insert(runtimeGrants).values({
      id: "gr", orgId: ORG, sessionId: null, workflowExecutionId: RUN,
      policyKey: grantPolicyKey("demo", "deploy"), mode: "allow", grantedBy: "u1", createdAt: 1, revokedAt: null,
    });
    const invoke = buildActionInvoker({ db, credentials: new FakeCredentialStore(), actionPluginByService: highRiskPlugin(fixture.action) });
    const res = await invoke({ service: "demo", action: "deploy", params: { msg: "x" }, invocationId: "workflow:run_wf1:n3" }, wfCtx);
    // The returned data proves the action executed (the grant quieted the gate).
    expect(res).toEqual({ ok: true, result: { deployed: true } });
    const audit = await db.select().from(actionInvocations).where(eq(actionInvocations.invocationId, "pol:wf:workflow:run_wf1:n3"));
    // The decision row is stamped with the execution outcome + full
    // PluginActionResult after execute (spec T6 #6, fixed).
    expect(audit[0].status).toBe("completed");
    expect(audit[0].startedAt).toBeGreaterThanOrEqual(audit[0].createdAt);
    expect(audit[0].result).toEqual({ success: true, data: { deployed: true } });
    expect(audit[0].matchedGrantId).toBe("gr");
  });

  it("dedup: a replayed invocationId writes exactly one audit row and never re-runs enforcement", async () => {
    const db = await makeDb();
    const fixture = highRiskAction();
    const invoke = buildActionInvoker({ db, credentials: new FakeCredentialStore(), actionPluginByService: highRiskPlugin(fixture.action) });
    const req = { service: "demo", action: "deploy", params: {}, invocationId: "workflow:run_wf1:n4" };
    const first = await invoke(req, wfCtx);
    const second = await invoke(req, wfCtx);
    expect(second).toEqual(first); // stored result row is authoritative
    const audit = await db.select().from(actionInvocations).where(eq(actionInvocations.invocationId, "pol:wf:workflow:run_wf1:n4"));
    expect(audit).toHaveLength(1);
  });

  // ── requiresApproval gate (Task 4) ──────────────────────────────────────

  it("require_approval with no approval field returns requiresApproval outcome and is NOT stored in the dedup table", async () => {
    const db = await makeDb();
    const fixture = highRiskAction();
    const invoke = buildActionInvoker({ db, credentials: new FakeCredentialStore(), actionPluginByService: highRiskPlugin(fixture.action) });
    const req = { service: "demo", action: "deploy", params: { msg: "x" }, invocationId: "workflow:run_wf1:n5" };
    const res = await invoke(req, wfCtx);
    expect(res).toEqual({ ok: false, requiresApproval: true, riskLevel: "critical", provenance: "risk_default" });
    // Gate outcomes must NOT land in the dedup table — an approved retry must
    // reach enforcement fresh (re-querying the current policy state).
    const rows = await db.select().from(actionInvocations).where(eq(actionInvocations.invocationId, req.invocationId));
    expect(rows).toHaveLength(0);
  });

  it("require_approval WITH the approval field executes and stamps audit row status approved", async () => {
    const db = await makeDb();
    const fixture = highRiskAction();
    const invoke = buildActionInvoker({ db, credentials: new FakeCredentialStore(), actionPluginByService: highRiskPlugin(fixture.action) });
    const req = {
      service: "demo",
      action: "deploy",
      params: { msg: "x" },
      invocationId: "workflow:run_wf1:n6",
      approval: { resolvedBy: "u1", note: "lgtm" },
    };
    const res = await invoke(req, wfCtx);
    expect(res).toEqual({ ok: true, result: { deployed: true } });
    expect(fixture.calls()).toBe(1);
    // The audit row is stamped "approved" on the policy side.
    const audit = await db.select().from(actionInvocations).where(eq(actionInvocations.invocationId, "pol:wf:workflow:run_wf1:n6"));
    expect(audit).toHaveLength(1);
    // persistInvocationAudit writes "approved" but updateInvocationOutcome
    // then stamps the final execution outcome ("completed"). Task 5 will assert
    // resolvedBy once that column lands.
    expect(audit[0].status).toBe("completed");
    // The dedup table holds the computed result so a re-drive returns it without re-running.
    const dedup = await db.select().from(actionInvocations).where(eq(actionInvocations.invocationId, req.invocationId));
    expect(dedup).toHaveLength(1);
  });

  it("resolver throw returns requiresApproval with provenance resolver_error; action never runs", async () => {
    const db = await makeDb();
    const fixture = highRiskAction();
    // Wrap db with a Proxy that throws on the second select call.
    // selectStoredResult (the dedup check) is the first select; policy
    // resolution (resolveActionPolicy) does the subsequent selects. Because
    // requiresApproval is returned without reaching the dedup insert, only two
    // select calls happen (initial dedup check + first policy table select).
    let selectCallCount = 0;
    const origSelect = db.select.bind(db);
    const failingDb: AppDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "select") return Reflect.get(target, prop, receiver);
        return function (...args: unknown[]) {
          selectCallCount += 1;
          if (selectCallCount === 1) {
            // First select is selectStoredResult — let it through.
            return (origSelect as (...a: unknown[]) => unknown)(...args);
          }
          throw new Error("simulated db error during policy resolution");
        };
      },
    }) as AppDb;

    const invoke2 = buildActionInvoker({ db: failingDb, credentials: new FakeCredentialStore(), actionPluginByService: highRiskPlugin(fixture.action) });
    const res = await invoke2(
      { service: "demo", action: "deploy", params: { msg: "x" }, invocationId: "workflow:run_wf1:n7" },
      wfCtx,
    );
    expect(res).toEqual({ ok: false, requiresApproval: true, provenance: "resolver_error" });
    expect(fixture.calls()).toBe(0);
  });

  it("cannot approve past a team deny", async () => {
    const db = await makeDb();
    const fixture = highRiskAction();
    await db.insert(actionPolicies).values({ id: "team-block", orgId: ORG, principalType: "team", principalId: "team-a", service: "demo", mode: "deny", origin: "admin", createdAt: 1, updatedAt: 1 });
    const invoke = buildActionInvoker({ db, credentials: new FakeCredentialStore(), actionPluginByService: highRiskPlugin(fixture.action) });
    const result = await invoke({ service: "demo", action: "deploy", params: { msg: "x" }, invocationId: "team-deny", approval: { resolvedBy: "u1" } }, { ...wfCtx, owner: { type: "team", id: "team-a" } });
    expect(result).toEqual({ ok: false, error: "demo.deploy is blocked by team policy" });
    expect(fixture.calls()).toBe(0);
  });

  it("rechecks team policy even when an approved action's policy read fails", async () => {
    const db = await makeDb();
    const fixture = highRiskAction();
    const originalSelect = db.select.bind(db);
    let selects = 0;
    const failingDb = new Proxy(db, { get(target, prop, receiver) {
      if (prop !== "select") return Reflect.get(target, prop, receiver);
      return (...args: Parameters<typeof db.select>) => {
        if (++selects === 2) throw new Error("policy store unavailable");
        return originalSelect(...args);
      };
    } });
    const invoke = buildActionInvoker({ db: failingDb, credentials: new FakeCredentialStore(), actionPluginByService: highRiskPlugin(fixture.action) });
    const result = await invoke({ service: "demo", action: "deploy", params: { msg: "x" }, invocationId: "team-outage", approval: { resolvedBy: "u1" } }, { ...wfCtx, owner: { type: "team", id: "team-a" } });
    expect(result).toEqual({ ok: false, requiresApproval: true, provenance: "resolver_error" });
    expect(fixture.calls()).toBe(0);
  });

  it("resolver_error + approval field executes on the signal's authority", async () => {
    const db = await makeDb();
    const fixture = highRiskAction();
    // Same failing db strategy: second select throws. With approval set,
    // enforceWorkflowPolicy catches the throw and returns null (proceed).
    // The action executes, then the dedup insert and re-select both use the
    // real db. Call order: 1=dedup-pre, 2=policy (throw), 3=dedup-post.
    // We allow calls 1 and 3, throw on 2.
    let selectCallCount = 0;
    const origSelect = db.select.bind(db);
    const failingDb: AppDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "select") return Reflect.get(target, prop, receiver);
        return function (...args: unknown[]) {
          selectCallCount += 1;
          if (selectCallCount === 2) {
            throw new Error("simulated db error during policy resolution");
          }
          return (origSelect as (...a: unknown[]) => unknown)(...args);
        };
      },
    }) as AppDb;

    const invoke = buildActionInvoker({ db: failingDb, credentials: new FakeCredentialStore(), actionPluginByService: highRiskPlugin(fixture.action) });
    const res = await invoke(
      {
        service: "demo",
        action: "deploy",
        params: { msg: "x" },
        invocationId: "workflow:run_wf1:n8",
        approval: { resolvedBy: "u1" },
      },
      wfCtx,
    );
    // Resolver error + approval set → human resolution authorizes execution
    expect(res).toEqual({ ok: true, result: { deployed: true } });
    expect(fixture.calls()).toBe(1);
    // The resolver_error path writes a best-effort audit row before returning
    // null. Use the real db (not failingDb) to query — the proxy only
    // intercepts selects, but this verifies the insert/update went through
    // on the real backing store.
    const audit = await db.select().from(actionInvocations).where(eq(actionInvocations.invocationId, "pol:wf:workflow:run_wf1:n8"));
    expect(audit).toHaveLength(1);
    // updateInvocationOutcome stamps the final execution outcome after the
    // action runs, so the row ends as "completed" even though the audit
    // insert wrote "approved".
    expect(audit[0].status).toBe("completed");
    expect(audit[0].resolvedMode).toBe("require_approval");
  });

  it("parseStoredResult rejects a stored requiresApproval row (defensive: such rows must never exist)", async () => {
    const db = await makeDb();
    // Seed a row with { ok: false, requiresApproval: true } directly
    await db.insert(actionInvocations).values({
      invocationId: "corrupt:n9",
      result: { ok: false, requiresApproval: true },
      createdAt: Date.now(),
    });
    const invoke = buildActionInvoker({ db, credentials: new FakeCredentialStore(), actionPluginByService: highRiskPlugin(highRiskAction().action) });
    // A stored requiresApproval result is corrupt — such rows must never be persisted,
    // but if one exists the invoker must throw rather than silently returning it.
    await expect(
      invoke({ service: "demo", action: "deploy", params: { msg: "x" }, invocationId: "corrupt:n9" }, wfCtx),
    ).rejects.toThrow("stored requiresApproval outcome should never exist for");
  });
});

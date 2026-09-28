import { seedWorkspaceAssistant } from "../test-helpers/assistant-fixture.js";
/**
 * Team-owned sessions resolve credentials from the team principal, not the
 * prompting member. GitHub uses the App installation. Slack uses the org
 * bot token and stays bare. A user-owned session is unchanged.
 */
import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { githubInstallations } from "../schema/index.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { saveAppConfig, type GithubAppConfig } from "../services/github-app.js";
import { GitHubAuthError } from "../services/github-tokens.js";
import slackPlugin from "@valet/plugin-slack/plugin";
import { linkIdentity } from "../channels/identity-links.js";
import { EngineHost, sessionPrincipal } from "./host.js";
import { githubTokenArgsForOwner, isUsableGithubRow } from "../services/session-github-token.js";
import { agentSessions, orgs, teamMembers, teams } from "../schema/index.js";
import { createLlmProvider } from "../services/llm-providers.js";

import { OnePasswordAuthError, type OnePasswordService } from "../services/onepassword.js";

const orgId = "team-cred-org";
const userId = "team-cred-user";
const teamId = "team_1";
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

describe("EngineHost team-owned session credentials", () => {
  let fixture: GithubFixture | undefined;
  let host: EngineHost | undefined;

  afterEach(async () => {
    host?.evictAll();
    host = undefined;
    await fixture?.close();
    fixture = undefined;
  });

  async function harness(): Promise<{ appDb: AppDb; credentials: PgCredentialStore }> {
    const { appDb, pgdb } = await freshTestPgDb();
    // Actor mode holds only while the actor is on the owning team, so the
    // roster is part of the world every case here runs in.
    await appDb.insert(teams).values({ id: teamId, orgId, name: "Team", createdAt: NOW });
    await appDb.insert(teamMembers).values({ teamId, userId, role: "member" });
    return { appDb, credentials: new PgCredentialStore(pgdb, deriveSecretKey("test-key")) };
  }

  function makeHost(appDb: AppDb, credentials: PgCredentialStore, fixtureUrl: string): EngineHost {
    const h = new EngineHost({
      engineStore: new InMemorySessionStore(),
      sandboxProvider: new VirtualSandboxProvider(),
      eventStream: new InMemoryEventStream(),
      engineCredentials: credentials,
      db: appDb,
      plugins: [slackPlugin],
      githubTokenDeps: {
        key: deriveSecretKey("cache-key"),
        apiUrl: fixtureUrl,
        githubUrl: fixtureUrl,
        now: () => NOW,
      },
    });
    host = h;
    return h;
  }

  const teamMeta = {
    userId,
    orgId,
    workspace: "/tmp",
    ownerType: "team" as const,
    ownerTeamId: teamId,
  };
  // A team session from before team-owner resolution shipped. The boot pass
  // stamps its row `actor`; the loader carries that onto the meta.
  const legacyTeamMeta = { ...teamMeta, credentialOwnerMode: "actor" as const };

  it("resolves GitHub through the installation, not the prompting member", async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "user", id: userId }, "github", {
      type: "oauth2",
      accessToken: "user-tok",
      metadata: { login: "octocat" },
    });
    await saveAppConfig({ credentials }, orgId, appConfig);
    await appDb.insert(githubInstallations).values({
      id: "ghi_team",
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
    fixture = startGithubFixture({
      createInstallationToken: (id) => ({
        body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() },
      }),
    });
    const h = makeHost(appDb, credentials, fixture.url);

    const session = await h.sessionFor("sess-team-gh", teamMeta);
    const cred = await session.credentialProvider().get("github");

    expect(cred?.accessToken).toBe("inst-333");
  });

  it("unbound team GitHub with a member PAT and no installation does not use the member token", async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "user", id: userId }, "github", {
      type: "oauth2",
      accessToken: "user-tok",
      metadata: { login: "octocat" },
    });
    fixture = startGithubFixture();
    const h = makeHost(appDb, credentials, fixture.url);

    const session = await h.sessionFor("sess-team-gh-member-pat", teamMeta);
    await expect(session.credentialProvider().get("github")).rejects.toThrow(
      /no GitHub credential|GitHub App/,
    );
  });

  it("unbound team GitHub with an org PAT and no installation does not use the org PAT", async () => {
    const { appDb, credentials } = await harness();
    await saveAppConfig({ credentials }, orgId, appConfig);
    await credentials.save({ type: "org", id: orgId }, "github", {
      type: "api_key",
      accessToken: "org-pat-must-not-win",
      metadata: { login: "acme-bot" },
    });
    fixture = startGithubFixture();
    const h = makeHost(appDb, credentials, fixture.url);

    const session = await h.sessionFor("sess-team-gh-org-pat", teamMeta);
    const read = session.credentialProvider().get("github");
    await expect(read).rejects.toBeInstanceOf(GitHubAuthError);
    await expect(read).rejects.toThrow(/install/);
  });

  it("unbound team GitHub with an org PAT and an installation resolves the installation token", async () => {
    const { appDb, credentials } = await harness();
    await saveAppConfig({ credentials }, orgId, appConfig);
    await credentials.save({ type: "org", id: orgId }, "github", {
      type: "api_key",
      accessToken: "org-pat-must-not-win",
      metadata: { login: "acme-bot" },
    });
    await appDb.insert(githubInstallations).values({
      id: "ghi_team_pat",
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
    const h = makeHost(appDb, credentials, fixture.url);

    const session = await h.sessionFor("sess-team-gh-org-pat-inst", teamMeta);
    const cred = await session.credentialProvider().get("github");

    expect(cred?.accessToken).toBe("inst-444");
  });

  it("githubTokenArgsForOwner selects the App for a non-user owner with or without a repo", () => {
    const team = { type: "team", id: teamId };
    expect(githubTokenArgsForOwner(team, orgId, "sess", undefined)).toEqual({
      orgId,
      sessionId: "sess",
      purpose: "api",
      auth: "app",
    });
    expect(githubTokenArgsForOwner(team, orgId, "sess", { owner: "acme", name: "repo" })).toEqual({
      orgId,
      sessionId: "sess",
      purpose: "api",
      auth: "app",
      repo: { owner: "acme", name: "repo" },
    });
    expect(githubTokenArgsForOwner({ type: "org", id: orgId }, orgId, "sess", undefined)).toEqual({
      orgId,
      sessionId: "sess",
      purpose: "api",
      auth: "app",
    });
    expect(githubTokenArgsForOwner({ type: "user", id: userId }, orgId, "sess", undefined)).toEqual({
      orgId,
      userId,
      sessionId: "sess",
      purpose: "api",
    });
  });

  it("resolves Slack to the org bot token with no owner_slack_user_id", async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "org", id: orgId }, "slack", {
      type: "oauth2",
      accessToken: "xoxb-org-bot",
      metadata: { team_id: "T99" },
    });
    await linkIdentity(appDb, { provider: "slack", externalId: "U42", userId });

    fixture = startGithubFixture();
    const h = makeHost(appDb, credentials, fixture.url);

    const session = await h.sessionFor("sess-team-slack", teamMeta);
    const cred = await session.credentialProvider().get("slack");

    expect(cred?.accessToken).toBe("xoxb-org-bot");
    expect(cred?.metadata?.["owner_slack_user_id"]).toBeUndefined();
  });

  it("a user-owned session still reads the user row", async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "user", id: userId }, "linear", {
      type: "api_key",
      apiKey: "user-linear",
    });
    fixture = startGithubFixture();
    const h = makeHost(appDb, credentials, fixture.url);

    const session = await h.sessionFor("sess-user-linear", { userId, orgId, workspace: "/tmp" });
    const cred = await session.credentialProvider().get("linear");

    expect(cred?.accessToken).toBe("user-linear");
  });

  it("sessionPrincipal throws when a team session has no ownerTeamId", () => {
    expect(() =>
      sessionPrincipal({ userId, orgId, workspace: "/tmp", ownerType: "team" }),
    ).toThrow(/owning team id/);
  });

  it("team OpenAI prefers the org LLM-provider key over the prompting member's row", async () => {
    const { appDb, credentials } = await harness();
    await appDb.insert(orgs).values({ id: orgId, name: "Org", createdAt: NOW });
    const provider = await createLlmProvider(appDb, { orgId, kind: "openai", name: "OpenAI" });
    await credentials.save({ type: "org", id: orgId }, `llm:${provider.id}`, {
      type: "api_key",
      apiKey: "sk-org-llm",
    });
    await credentials.save({ type: "user", id: userId }, "openai", {
      type: "api_key",
      apiKey: "sk-member-must-not-win",
    });
    fixture = startGithubFixture();
    const h = makeHost(appDb, credentials, fixture.url);

    const session = await h.sessionFor("sess-team-openai-org", teamMeta);
    const cred = await session.credentialProvider().get("openai");

    expect(cred?.accessToken).toBe("sk-org-llm");
  });

  it("team OpenAI reaches the org-scoped vault item a team workflow reaches", async () => {
    const { appDb, credentials } = await harness();
    await appDb.insert(orgs).values({ id: orgId, name: "Org", createdAt: NOW });
    const tried: string[] = [];
    const onePassword: OnePasswordService = {
      tokenConnected: async () => true,
      listVaults: async () => [],
      resolveReference: async () => "",
      resolveCredential: async (row) => row,
      findCandidates: async () => [],
      findCredentialForService: async (scope, _ctx, service) => {
        tried.push(scope);
        if (scope === "team") throw new OnePasswordAuthError("No team token", "no_token");
        return scope === "org" && service === "openai" ? "sk-org-vault" : null;
      },
    };
    fixture = startGithubFixture();
    const h = new EngineHost({
      engineStore: new InMemorySessionStore(),
      sandboxProvider: new VirtualSandboxProvider(),
      eventStream: new InMemoryEventStream(),
      engineCredentials: credentials,
      db: appDb,
      plugins: [slackPlugin],
      onePassword,
      githubTokenDeps: {
        key: deriveSecretKey("cache-key"),
        apiUrl: fixture.url,
        githubUrl: fixture.url,
        now: () => NOW,
      },
    });
    host = h;

    const session = await h.sessionFor("sess-team-openai-vault", teamMeta);
    const cred = await session.credentialProvider().get("openai");

    expect(cred?.accessToken).toBe("sk-org-vault");
    // An absent team token permits org discovery, never personal discovery.
    expect(tried).toEqual(["team", "org"]);
  });

  it("team OpenAI does not read the prompting member's key when no org or team row exists", async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "user", id: userId }, "openai", {
      type: "api_key",
      apiKey: "sk-member-must-not-win",
    });
    fixture = startGithubFixture();
    const h = makeHost(appDb, credentials, fixture.url);

    const session = await h.sessionFor("sess-team-openai-no-org", teamMeta);
    const cred = await session.credentialProvider().get("openai");

    expect(cred?.accessToken).not.toBe("sk-member-must-not-win");
  });

  describe("credential_owner_mode", () => {
    it("actor mode resolves the acting member's row with org fallback, as before team ownership", async () => {
      const { appDb, credentials } = await harness();
      await credentials.save({ type: "user", id: userId }, "linear", {
        type: "api_key",
        apiKey: "member-linear",
      });
      fixture = startGithubFixture();
      const h = makeHost(appDb, credentials, fixture.url);

      const session = await h.sessionFor("sess-legacy-team-linear", legacyTeamMeta);
      const cred = await session.credentialProvider().get("linear");

      expect(cred?.accessToken).toBe("member-linear");
    });

    // An organization-audience Slack mention can make a nonmember the actor
    // of a team assistant turn. A legacy actor-mode session must not then
    // read that person's personal vault on the team's behalf.
    it("an actor who is not on the owning team resolves the team's credential, not their own", async () => {
      const { appDb, credentials } = await harness();
      const outsider = "org-only-user";
      await credentials.save({ type: "user", id: outsider }, "linear", {
        type: "api_key",
        apiKey: "outsider-linear-must-not-win",
      });
      await credentials.save({ type: "team", id: teamId }, "linear", {
        type: "api_key",
        apiKey: "team-linear",
      });
      fixture = startGithubFixture();
      const h = makeHost(appDb, credentials, fixture.url);

      const session = await h.sessionFor("sess-legacy-team-outsider", { ...legacyTeamMeta, userId: outsider });
      const cred = await session.credentialProvider().get("linear");

      expect(cred?.accessToken).toBe("team-linear");
    });

    it("actor mode resolves GitHub through the acting member's row, not the App", async () => {
      const { appDb, credentials } = await harness();
      await credentials.save({ type: "user", id: userId }, "github", {
        type: "oauth2",
        accessToken: "member-tok",
        metadata: { login: "octocat" },
      });
      fixture = startGithubFixture();
      const h = makeHost(appDb, credentials, fixture.url);

      const session = await h.sessionFor("sess-legacy-team-gh", legacyTeamMeta);
      const cred = await session.credentialProvider().get("github");

      expect(cred?.accessToken).toBe("member-tok");
    });

    it("actor mode enriches the org Slack token with the acting member's identity link", async () => {
      const { appDb, credentials } = await harness();
      await credentials.save({ type: "org", id: orgId }, "slack", {
        type: "oauth2",
        accessToken: "xoxb-org-bot",
        metadata: { team_id: "T99" },
      });
      await linkIdentity(appDb, { provider: "slack", externalId: "U42", userId });
      fixture = startGithubFixture();
      const h = makeHost(appDb, credentials, fixture.url);

      const session = await h.sessionFor("sess-legacy-team-slack", legacyTeamMeta);
      const cred = await session.credentialProvider().get("slack");

      expect(cred?.accessToken).toBe("xoxb-org-bot");
      expect(cred?.metadata?.["owner_slack_user_id"]).toBe("U42");
    });

    it("actor mode reads the acting member's OpenAI row", async () => {
      const { appDb, credentials } = await harness();
      await appDb.insert(orgs).values({ id: orgId, name: "Org", createdAt: NOW });
      await credentials.save({ type: "user", id: userId }, "openai", {
        type: "api_key",
        apiKey: "sk-member",
      });
      fixture = startGithubFixture();
      const h = makeHost(appDb, credentials, fixture.url);

      const session = await h.sessionFor("sess-legacy-team-openai", legacyTeamMeta);
      const cred = await session.credentialProvider().get("openai");

      expect(cred?.accessToken).toBe("sk-member");
    });

    // A child of a legacy team orchestrator is spawned with the parent's
    // mode, and its first build (before its row exists) must honour it, or
    // the first turn would act as the team and every rebuild as the member.
    it("a child spawned in actor mode resolves the acting member's row on its first build", async () => {
      const { appDb, credentials } = await harness();
      await credentials.save({ type: "user", id: userId }, "linear", {
        type: "api_key",
        apiKey: "member-linear",
      });
      fixture = startGithubFixture();
      const h = makeHost(appDb, credentials, fixture.url);
      const parent = await h.sessionFor("sess-legacy-team-parent", legacyTeamMeta);
      const child = await h.childSessionFor("child-legacy-actor", {
        parentSessionId: "sess-legacy-team-parent",
        parentThreadId: parent.thread("web:default").id,
        actorUserId: userId,
        orgId,
        owner: { type: "team", id: teamId },
        workspace: "/tmp",
        credentialOwnerMode: "actor",
      });
      const cred = await child.credentialProvider().get("linear");
      expect(cred?.accessToken).toBe("member-linear");
    });

    it("owner mode, explicit or absent, resolves as the team and never reads the member's row", async () => {
      const { appDb, credentials } = await harness();
      await credentials.save({ type: "user", id: userId }, "linear", {
        type: "api_key",
        apiKey: "member-linear",
      });
      await credentials.save({ type: "user", id: userId }, "github", {
        type: "oauth2",
        accessToken: "member-tok",
        metadata: { login: "octocat" },
      });
      fixture = startGithubFixture();
      const h = makeHost(appDb, credentials, fixture.url);

      const explicit = await h.sessionFor("sess-owner-team", { ...teamMeta, credentialOwnerMode: "owner" });
      expect(await explicit.credentialProvider().get("linear")).toBeNull();
      await expect(explicit.credentialProvider().get("github")).rejects.toBeInstanceOf(GitHubAuthError);

      const absent = await h.sessionFor("sess-null-team", { ...teamMeta, credentialOwnerMode: null });
      expect(await absent.credentialProvider().get("linear")).toBeNull();
      await expect(absent.credentialProvider().get("github")).rejects.toBeInstanceOf(GitHubAuthError);
    });

    it("a user-owned session ignores the column", async () => {
      const { appDb, credentials } = await harness();
      await credentials.save({ type: "user", id: userId }, "linear", {
        type: "api_key",
        apiKey: "user-linear",
      });
      fixture = startGithubFixture();
      const h = makeHost(appDb, credentials, fixture.url);

      const session = await h.sessionFor("sess-user-owner-col", {
        userId,
        orgId,
        workspace: "/tmp",
        credentialOwnerMode: "owner",
      });
      expect((await session.credentialProvider().get("linear"))?.accessToken).toBe("user-linear");
    });

    it("a team assistant session reads the mode from its stored row", async () => {
      const { appDb, credentials } = await harness();
      await appDb.insert(orgs).values({ id: orgId, name: "Org", createdAt: NOW });
      await credentials.save({ type: "user", id: userId }, "linear", {
        type: "api_key",
        apiKey: "member-linear",
      });
      const assistant = await seedWorkspaceAssistant(appDb, orgId, { type: "team", id: teamId });
      await appDb.insert(agentSessions).values({
        id: assistant.sessionId,
        userId,
        orgId,
        workspace: "/tmp",
        status: "active",
        ownerType: "team",
        ownerId: teamId,
        credentialOwnerMode: "actor",
        createdAt: NOW,
        updatedAt: NOW,
      });
      fixture = startGithubFixture();
      const h = new EngineHost({
        engineStore: new InMemorySessionStore(),
        sandboxProvider: new VirtualSandboxProvider(),
        eventStream: new InMemoryEventStream(),
        engineCredentials: credentials,
        db: appDb,
        apiBaseUrl: "http://127.0.0.1:0",
        plugins: [slackPlugin],
        githubTokenDeps: {
          key: deriveSecretKey("cache-key"),
          apiUrl: fixture.url,
          githubUrl: fixture.url,
          now: () => NOW,
        },
      });
      host = h;

      const session = await h.assistantSessionFor(assistant.id, { actorUserId: userId, orgId }, {
        sessionId: assistant.sessionId,
      });
      const cred = await session.credentialProvider().get("linear");

      expect(cred?.accessToken).toBe("member-linear");
    });
  });

  describe("team github row (decision 6, deviation 10)", () => {
    it("an owner-mode team session resolves the team's own github row when there is no App", async () => {
      const { appDb, credentials } = await harness();
      await credentials.save({ type: "team", id: teamId }, "github", {
        type: "oauth2",
        accessToken: "team-tok",
        metadata: { login: "team-bot" },
      });
      fixture = startGithubFixture();
      const h = makeHost(appDb, credentials, fixture.url);

      const session = await h.sessionFor("sess-team-gh-row", teamMeta);
      const cred = await session.credentialProvider().get("github");

      expect(cred?.accessToken).toBe("team-tok");
    });

    it("the team row outranks the App installation, as it does for a workflow tool node", async () => {
      const { appDb, credentials } = await harness();
      await credentials.save({ type: "team", id: teamId }, "github", {
        type: "api_key",
        apiKey: "team-pat",
        metadata: { login: "team-bot" },
      });
      await saveAppConfig({ credentials }, orgId, appConfig);
      await appDb.insert(githubInstallations).values({
        id: "ghi_team_row",
        orgId,
        installationId: 555,
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
      const h = makeHost(appDb, credentials, fixture.url);

      const session = await h.sessionFor("sess-team-gh-row-over-app", teamMeta);
      const cred = await session.credentialProvider().get("github");

      expect(cred?.accessToken).toBe("team-pat");
    });

    it("an unhealthy team row is skipped and the App path answers as before", async () => {
      const { appDb, credentials } = await harness();
      await credentials.save({ type: "team", id: teamId }, "github", {
        type: "oauth2",
        accessToken: "team-identity-only",
        metadata: { login: "team-bot", identityOnly: true },
      });
      fixture = startGithubFixture();
      const h = makeHost(appDb, credentials, fixture.url);

      const session = await h.sessionFor("sess-team-gh-row-unhealthy", teamMeta);
      const read = session.credentialProvider().get("github");
      await expect(read).rejects.toBeInstanceOf(GitHubAuthError);
      await expect(read).rejects.toThrow(/install/);
    });

    it("isUsableGithubRow accepts a row with a secret and rejects identity-only, refresh-failed, and empty rows", () => {
      expect(isUsableGithubRow({ type: "oauth2", accessToken: "t" })).toBe(true);
      expect(isUsableGithubRow({ type: "api_key", apiKey: "k" })).toBe(true);
      expect(isUsableGithubRow({ type: "oauth2", accessToken: "t", metadata: { identityOnly: true } })).toBe(false);
      expect(isUsableGithubRow({ type: "oauth2", accessToken: "t", metadata: { refreshFailedAt: 1 } })).toBe(false);
      expect(isUsableGithubRow({ type: "oauth2", accessToken: "" })).toBe(false);
      expect(isUsableGithubRow(null)).toBe(false);
    });
  });
});

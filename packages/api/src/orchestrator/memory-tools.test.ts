/**
 * `mem_*` engine ToolDefs — drives each tool's `execute()` against a real
 * in-process HTTP server (via `bootTestApi`, the same harness the memory
 * route integration tests use) with a hand-built `ToolContext`, proving
 * the tools round-trip over the honest HTTP seam rather than a mocked
 * fetch (decision 15).
 */
import { decode } from "@toon-format/toon";
import { describe, it, expect, afterEach } from "vitest";
import type {
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  MessageQuery,
  Sandbox,
  SessionEntry,
  ToolContext,
} from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { eq } from "drizzle-orm";
import { agentSessions, artifacts, teamMembers } from "../schema/index.js";
import { createTeam } from "../services/teams.js";
import { internalToken } from "../lib/internal-auth.js";
import {
  memWriteTool,
  memPatchTool,
  memReadTool,
  memSearchTool,
  memMoveTool,
  memCopyToTeamTool,
  memCopyFromTeamTool,
  artifactCopyToTeamTool,
  memLinksTool,
  memShareTool,
  artifactPublishTool,
  memRmTool,
  buildMemoryTools,
} from "./memory-tools.js";

const stubCredentials: CredentialProvider = {
  get: async (): Promise<Credential | null> => null,
  request: async (): Promise<Credential> => {
    throw new Error("not implemented in test stub");
  },
};

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const sandbox: Partial<Sandbox> & { id: string } = { id: "sb-1" };
  return {
    userId: "u1",
    orgId: "o1",
    sessionId: "s1",
    threadId: "t1",
    credentials: stubCredentials,
    sandbox: sandbox as Sandbox,
    requestDecision: async (_gate: DecisionGateRequest): Promise<DecisionResolution> => {
      throw new Error("not implemented in test stub");
    },
    signal: new AbortController().signal,
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
    ...overrides,
  };
}

async function seedPublishingContext(api: TestApi, ctx: ToolContext) {
  await api.providers.db.insert(agentSessions).values({
    id: ctx.sessionId, userId: ctx.userId, orgId: "local-org", workspace: "/tmp",
    ownerType: ctx.owner?.type ?? "user", ownerId: ctx.owner?.id ?? ctx.userId, createdAt: 1, updatedAt: 1,
  });
  await api.providers.engineStore.saveThread(ctx.sessionId, {
    id: ctx.threadId, sessionId: ctx.sessionId, key: `web:${ctx.threadId}`, status: "active",
    queueMode: "followup", createdAt: 1, updatedAt: 1,
  });
}

let api: TestApi;

afterEach(async () => {
  await api?.cleanup();
});

describe("buildMemoryTools", () => {
  it("returns memory and artifact tools", () => {
    const names = buildMemoryTools().map((t) => t.name);
    expect(names).toEqual([
      "mem_write",
      "mem_patch",
      "mem_read",
      "mem_search",
      "mem_move",
      "mem_copy_to_team",
      "mem_copy_from_team",
      "artifact_copy_to_team",
      "mem_links",
      "mem_share",
      "artifact_publish",
      "mem_rm",
    ]);
  });

  it("describes explicit copy sources, destinations, and collision rules", () => {
    expect(memCopyToTeamTool.description).toContain("original copy request does not authorize replacement");
    expect(memCopyToTeamTool.parameters).toMatchObject({
      required: ["from", "to", "teamId"],
      properties: {
        from: { description: expect.stringContaining("personal memory path") },
        to: { description: expect.stringContaining("Destination path") },
        teamId: { description: expect.stringContaining("destination team ID") },
      },
    });
    expect(artifactCopyToTeamTool.description).toContain("original remains unchanged");
    expect(artifactCopyToTeamTool.parameters).toMatchObject({
      required: ["artifactId", "teamId", "key"],
      properties: {
        artifactId: { description: expect.stringContaining("personal artifact ID") },
        teamId: { description: expect.stringContaining("destination team ID") },
        key: { description: expect.stringContaining("Must not exist") },
      },
    });
  });
});

describe("mem_* tools: apiBaseUrl/internalToken not configured", () => {
  it("mem_write returns [memory_unavailable] without throwing", async () => {
    const ctx = makeCtx();
    const result = await memWriteTool.execute({ path: "notes/a.md", content: "hi" }, ctx);
    expect(result.text).toBe("[memory_unavailable] memory endpoint not configured");
  });

  it("mem_read returns [memory_unavailable] when internalToken is missing", async () => {
    const ctx = makeCtx({ config: { apiBaseUrl: "http://localhost:1" } });
    const result = await memReadTool.execute({ path: "notes/a.md" }, ctx);
    expect(result.text).toBe("[memory_unavailable] memory endpoint not configured");
  });
});

describe("mem_* tools: network-level failure", () => {
  it("mem_read against an unreachable port returns [memory_error] instead of throwing", async () => {
    const ctx = makeCtx({
      config: { apiBaseUrl: "http://127.0.0.1:1", internalToken: "t" },
      owner: { type: "user", id: "local-user" },
    });
    const result = await memReadTool.execute({ path: "notes/a.md" }, ctx);
    expect(result.text).toMatch(/^\[memory_error\]/);
  });
});

describe("mem_* tools: real HTTP round trip", () => {
  it("mem_write creates a file, then mem_read reads it back", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "local-user" },
    });

    const writeResult = await memWriteTool.execute(
      { path: "notes/hello.md", content: "# Hello\n\nWorld.\n" },
      ctx,
    );
    expect(writeResult.text).toBe("wrote notes/hello.md (v1)");

    const readResult = await memReadTool.execute({ path: "notes/hello.md" }, ctx);
    expect(readResult.text).toContain("World.");
  });

  it("mem_write relays ⚠ warnings from the service", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "local-user" },
    });

    const result = await memWriteTool.execute(
      { path: "notes/echo.md", content: "---\nvalet:\n  bogus_key: x\n---\nBody.\n" },
      ctx,
    );
    expect(result.text).toContain("⚠");
    expect(result.text).toContain("bogus_key");
  });

  it("mem_patch replaces text in an existing file", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "local-user" },
    });

    await memWriteTool.execute({ path: "notes/patchable.md", content: "# T\n\nAlpha.\n" }, ctx);
    const patchResult = await memPatchTool.execute(
      { path: "notes/patchable.md", oldString: "Alpha", newString: "Beta" },
      ctx,
    );
    expect(patchResult.text).toBe("patched notes/patchable.md (v2)");

    const readResult = await memReadTool.execute({ path: "notes/patchable.md" }, ctx);
    expect(readResult.text).toContain("Beta.");
    expect(readResult.text).not.toContain("Alpha.");
  });

  it("mem_patch with oldString '' creates a new file (journal-append idiom)", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "local-user" },
    });

    const result = await memPatchTool.execute({ path: "journal/2026-07-13.md", oldString: "", newString: "# Entry\n" }, ctx);
    expect(result.text).toBe("patched journal/2026-07-13.md (v1)");
  });

  it("mem_read on a directory returns the virtual index", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "local-user" },
    });
    await memWriteTool.execute({ path: "notes/one.md", content: "# One\n" }, ctx);

    const result = await memReadTool.execute({ path: "notes/" }, ctx);
    expect(result.text).toContain("one.md");
  });

  it("mem_move renames a file, rewrites the referencer, and relays the type warning", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "local-user" },
    });

    await memWriteTool.execute({ path: "people/dana.md", content: "# Dana\n" }, ctx);
    await memWriteTool.execute({ path: "notes/ref.md", content: "see [Dana](/people/dana.md)\n" }, ctx);

    const moveResult = await memMoveTool.execute({ from: "people/dana.md", to: "workflows/dana.md" }, ctx);
    expect(moveResult.text).toContain("moved people/dana.md → workflows/dana.md (v2)");
    expect(moveResult.text).toContain("1 referencing file(s) updated: notes/ref.md");
    expect(moveResult.text).toContain("⚠");
    expect(moveResult.text).toContain("type remains 'person'");

    const readResult = await memReadTool.execute({ path: "notes/ref.md" }, ctx);
    expect(readResult.text).toContain("[Dana](/workflows/dana.md)");
  });

  it("mem_links lists inbound and outbound edges with phantoms marked", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "local-user" },
    });

    await memWriteTool.execute({ path: "people/erin.md", content: "# Erin\n" }, ctx);
    await memWriteTool.execute(
      { path: "projects/x/hub.md", content: "# Hub\n\n[Erin](/people/erin.md) and [gone](/notes/gone.md)\n" },
      ctx,
    );

    const result = await memLinksTool.execute({ path: "projects/x/hub.md" }, ctx);
    expect(result.text).toContain("links for projects/x/hub.md");
    expect(result.text).toContain("inbound (0)");
    expect(result.text).toContain("outbound (2):");
    expect(result.text).toContain("people/erin.md — Erin [person]");
    expect(result.text).toContain("notes/gone.md (phantom — no file at this path)");

    const erin = await memLinksTool.execute({ path: "people/erin.md" }, ctx);
    expect(erin.text).toContain("inbound (1):");
    expect(erin.text).toContain("projects/x/hub.md — Hub");
  });

  it("mem_read on a missing file surfaces a [memory_error]", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "local-user" },
    });

    const result = await memReadTool.execute({ path: "notes/does-not-exist.md" }, ctx);
    expect(result.text).toMatch(/^\[memory_error\]/);
  });

  it("mem_search finds a written file by content", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "local-user" },
    });
    await memWriteTool.execute({ path: "notes/searchable.md", content: "# Searchable\n\nUnique needle text.\n" }, ctx);

    const result = await memSearchTool.execute({ query: "needle" }, ctx);
    expect(result.text).toContain("notes/searchable.md");
  });

  it("mem_search with no matches reports emptiness instead of an empty string", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "local-user" },
    });

    const result = await memSearchTool.execute({ query: "nonexistentxyz" }, ctx);
    expect(result.text).toContain("no memory results");
  });

  it("mem_rm deletes a file; a second mem_read then [memory_error]s", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "local-user" },
    });
    await memWriteTool.execute({ path: "notes/doomed.md", content: "# Doomed\n" }, ctx);

    const rmResult = await memRmTool.execute({ path: "notes/doomed.md" }, ctx);
    expect(rmResult.text).toBe("removed notes/doomed.md");

    const readResult = await memReadTool.execute({ path: "notes/doomed.md" }, ctx);
    expect(readResult.text).toMatch(/^\[memory_error\]/);
  });

  it("mem_write against a nonexistent update-only path surfaces the service's [memory_error]", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "local-user" },
    });

    const result = await memWriteTool.execute({ path: "notes/never-created.md" }, ctx);
    expect(result.text).toMatch(/^\[memory_error\]/);
    expect(result.text).toContain("does not exist");
  });

  it("writes carry an explicit owner tuple distinct from ctx.userId (internal dual auth)", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "team", id: "eng" },
    });

    const writeResult = await memWriteTool.execute({ path: "notes/team.md", content: "# Team note\n" }, ctx);
    // The result names the scope the server wrote. A team-owned session has
    // always written its team here; it just used to report a bare path, so
    // the agent could not tell the user where the file landed.
    expect(writeResult.text).toBe("wrote team:eng/notes/team.md (v1)");

    // Read back with a *user* owner who is on no teams — must not see it,
    // proving mem_write actually wrote to the team scope, not the actor's.
    const otherUserCtx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "someone-else" },
    });
    const readResult = await memReadTool.execute({ path: "notes/team.md" }, otherUserCtx);
    expect(readResult.text).toMatch(/^\[memory_error\]/);
  });

  it("mem_share round-trips: share returns a URL + audience line, revoke confirms", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "local-user" },
    });

    await memWriteTool.execute({ path: "artifacts/report.md", content: "# Report\n\nBody.\n" }, ctx);

    await seedPublishingContext(api, ctx);
    const shared = await memShareTool.execute({ path: "artifacts/report.md" }, ctx);
    expect(shared.text).toContain("shared artifacts/report.md → ");
    expect(shared.text).toContain("/a/");
    // The audience line is what the agent relays — it must state the login
    // requirement, not imply a public link.
    expect(shared.text).toContain("Logged-in members");
    const [savedShare] = await api.providers.db.select().from(artifacts).where(eq(artifacts.sourceMemoryPath, "artifacts/report.md"));
    expect(savedShare.sourceSessionId).toBe(ctx.sessionId);
    expect(savedShare.sourceThreadId).toBe(ctx.threadId);

    const revoked = await memShareTool.execute({ path: "artifacts/report.md", revoke: true }, ctx);
    expect(revoked.text).toBe("revoked share for artifacts/report.md");

    const reRevoke = await memShareTool.execute({ path: "artifacts/report.md", revoke: true }, ctx);
    expect(reRevoke.text).toMatch(/^\[memory_error\]/);
  });

  it("artifact_publish round-trips: publish returns URL + version + audience, republish bumps, revoke confirms", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({
      userId: "local-user",
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() },
      owner: { type: "user", id: "local-user" },
    });

    await seedPublishingContext(api, ctx);
    const published = await artifactPublishTool.execute(
      { key: "pages/board", content: "<h1>Board</h1>", format: "html", icon: "📊" },
      ctx,
    );
    expect(published.text).toContain("published pages/board → ");
    expect(published.text).toContain("/a/");
    expect(published.text).toContain("(version 1)");
    expect(published.text).toContain("Logged-in members");
    const [savedPage] = await api.providers.db.select().from(artifacts).where(eq(artifacts.sourceMemoryPath, "pages/board"));
    expect(savedPage.sourceSessionId).toBe(ctx.sessionId);
    expect(savedPage.sourceThreadId).toBe(ctx.threadId);

    // Same key = same page, next version.
    const republished = await artifactPublishTool.execute(
      { key: "pages/board", content: "<h1>Board v2</h1>", format: "html" },
      ctx,
    );
    expect(republished.text).toContain("(version 2)");
    const url = (text: string) => /→ (\S+)/.exec(text)?.[1];
    expect(url(republished.text)).toBe(url(published.text));

    // Missing content is a tool-level error naming the fix, not an HTTP 400.
    const empty = await artifactPublishTool.execute({ key: "pages/board" }, ctx);
    expect(empty.text).toContain("[artifact_error] pass exactly one of");

    const revoked = await artifactPublishTool.execute({ key: "pages/board", revoke: true }, ctx);
    expect(revoked.text).toBe("revoked page pages/board");
  });
});


describe("copy-to-team tools", () => {
  it("copies memory over HTTP and rechecks membership for internal requests", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({ userId: "local-user", owner: { type: "user", id: "local-user" },
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() } });
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Copy team", creatorUserId: "local-user" });
    await memWriteTool.execute({ path: "notes/source.md", content: "# Source\n\nExact content.\n" }, ctx);
    const args = { from: "notes/source.md", to: "notes/team.md", teamId: team.id };
    const result = await memCopyToTeamTool.execute(args, ctx);
    expect(decode(result.text)).toMatchObject({
      file: { ownerId: team.id, path: "notes/team.md" },
    });
    expect((await memCopyToTeamTool.execute(args, ctx)).text).toContain("already exists");
    await api.providers.db.delete(teamMembers).where(eq(teamMembers.teamId, team.id));
    expect((await memCopyToTeamTool.execute({ ...args, to: "notes/second.md" }, ctx)).text).toContain("[memory_error]");
    expect((await memReadTool.execute({ path: args.from }, ctx)).text).toContain("Exact content.");
  });

  // TKAI-484. A team member had to create a personal file, copy it across,
  // then delete the original. `teamId` writes straight into the team.
  it("writes into a team a plain member belongs to, and names the scope it wrote", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Mem team", creatorUserId: "local-user" });
    await api.providers.db.insert(teamMembers).values({ teamId: team.id, userId: "test-member", role: "member" });
    // A plain member, not the creator: the assertion would be vacuous as an admin.
    const ctx = makeCtx({ userId: "test-member", owner: { type: "user", id: "test-member" },
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() } });

    const wrote = await memWriteTool.execute(
      { path: "knowledge/runbook.md", content: "# Runbook\n\nTeam knowledge.\n", teamId: team.id },
      ctx,
    );
    expect(wrote.text).toBe(`wrote team:${team.id}/knowledge/runbook.md (v1)`);
    // It landed in the TEAM, and the member's own scope is untouched.
    expect((await memReadTool.execute({ path: `team:${team.id}/knowledge/runbook.md` }, ctx)).text).toContain("Team knowledge.");
    expect((await memReadTool.execute({ path: "knowledge/runbook.md" }, ctx)).text).toContain("[memory_error]");
  });

  // The owner header is host-supplied from the session; the teamId is
  // model-supplied. Only the second one can name a team, and only the route
  // decides whether it may.
  it("refuses a team the actor does not belong to, and stops resolving once they leave", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Closed team", creatorUserId: "local-user" });
    const outsider = makeCtx({ userId: "test-member", owner: { type: "user", id: "test-member" },
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() } });

    const refused = await memWriteTool.execute(
      { path: "knowledge/x.md", content: "nope", teamId: team.id },
      outsider,
    );
    expect(refused.text).toContain("[memory_error]");

    // A member writes, then leaves: the next write stops resolving.
    await api.providers.db.insert(teamMembers).values({ teamId: team.id, userId: "test-member", role: "member" });
    expect((await memWriteTool.execute({ path: "knowledge/x.md", content: "yes", teamId: team.id }, outsider)).text)
      .toBe(`wrote team:${team.id}/knowledge/x.md (v1)`);
    await api.providers.db.delete(teamMembers).where(eq(teamMembers.teamId, team.id));
    expect((await memWriteTool.execute({ path: "knowledge/y.md", content: "no", teamId: team.id }, outsider)).text)
      .toContain("[memory_error]");
  });

  it("omitting teamId still writes the caller's own scope", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({ userId: "local-user", owner: { type: "user", id: "local-user" },
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() } });
    const wrote = await memWriteTool.execute({ path: "notes/mine.md", content: "# Mine\n" }, ctx);
    // No `team:` prefix: the default scope is unchanged by this feature.
    expect(wrote.text).toBe("wrote notes/mine.md (v1)");
  });

  it("mem_patch reaches a team on the same terms as mem_write", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Patch team", creatorUserId: "local-user" });
    await api.providers.db.insert(teamMembers).values({ teamId: team.id, userId: "test-member", role: "member" });
    const ctx = makeCtx({ userId: "test-member", owner: { type: "user", id: "test-member" },
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() } });

    expect((await memPatchTool.execute(
      { path: "journal/today.md", oldString: "", newString: "first line\n", teamId: team.id }, ctx)).text)
      .toBe(`patched team:${team.id}/journal/today.md (v1)`);
    expect((await memPatchTool.execute(
      { path: "journal/today.md", oldString: "first line", newString: "first line\nsecond line", teamId: team.id }, ctx)).text)
      .toBe(`patched team:${team.id}/journal/today.md (v2)`);

    await api.providers.db.delete(teamMembers).where(eq(teamMembers.teamId, team.id));
    expect((await memPatchTool.execute(
      { path: "journal/today.md", oldString: "second", newString: "third", teamId: team.id }, ctx)).text)
      .toContain("[memory_error]");
  });

  it("copies an artifact over HTTP and refuses a destination collision", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({ userId: "local-user", owner: { type: "user", id: "local-user" },
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() } });
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Artifact team", creatorUserId: "local-user" });
    await seedPublishingContext(api, ctx);
    const published = await artifactPublishTool.execute(
      { key: "pages/source", content: "# Exact source", format: "markdown" },
      ctx,
    );
    const artifactId = /\/a\/([^/\s]+)/.exec(published.text)?.[1];
    if (!artifactId) throw new Error("published artifact URL missing token");
    const [source] = await api.providers.db.select().from(artifacts).where(eq(artifacts.token, artifactId));
    if (!source) throw new Error("published artifact missing");
    const args = { artifactId: source.id, teamId: team.id, key: "pages/team-copy" };
    const copied = await artifactCopyToTeamTool.execute(args, ctx);
    expect(decode(copied.text)).toMatchObject({ path: "pages/team-copy", visibility: "org" });
    expect((await artifactCopyToTeamTool.execute(args, ctx)).text).toContain("another key");
  });
});


describe("mem_copy_from_team", () => {
  it("discovers team knowledge, pulls it over HTTP, and enforces membership and personal scope", async () => {
    api = await bootTestApi();
    const ctx = makeCtx({ userId: "local-user", owner: { type: "user", id: "local-user" },
      config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() } });
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Knowledge", creatorUserId: "local-user" });
    await memWriteTool.execute({ path: "knowledge/source.md", content: "# Transfer\n\nExact knowledge.\n" }, ctx);
    await memCopyToTeamTool.execute({ from: "knowledge/source.md", to: "knowledge/team.md", teamId: team.id }, ctx);
    expect((await memReadTool.execute({ path: "" }, ctx)).text).toContain(`team:${team.id}`);
    expect((await memReadTool.execute({ path: `team:${team.id}/knowledge/` }, ctx)).text).toContain("team.md");
    await api.providers.db.update(teamMembers).set({ role: "member" }).where(eq(teamMembers.teamId, team.id));
    const args = { from: "knowledge/team.md", to: "knowledge/pulled.md", teamId: team.id };
    const result = await memCopyFromTeamTool.execute(args, ctx);
    expect(result.text).toContain('"ownerId":"local-user"');
    expect(result.text).toContain('"path":"knowledge/pulled.md"');
    expect((await memReadTool.execute({ path: args.to }, ctx)).text).toContain("Exact knowledge.");
    expect((await memCopyFromTeamTool.execute(args, ctx)).text).toContain("Ask the user whether to replace, rename, or cancel");
    const fresh = { ...args, to: "knowledge/denied.md" };
    expect((await memCopyFromTeamTool.execute(fresh, { ...ctx, owner: { type: "team", id: team.id } })).text).toContain("personal");
    expect((await memCopyFromTeamTool.execute(fresh, { ...ctx, owner: { type: "user", id: "test-member" } })).text).toContain("personal");
    await api.providers.db.delete(teamMembers).where(eq(teamMembers.teamId, team.id));
    expect((await memCopyFromTeamTool.execute(fresh, ctx)).text).toContain("[memory_error]");
    expect((await memReadTool.execute({ path: args.to }, ctx)).text).toContain("Exact knowledge.");
  });
});

for (const tool of [memCopyToTeamTool, memCopyFromTeamTool]) {
  describe(`${tool.name} collision confirmation`, () => {
    it("retains the conflict revision and replaces only after an explicit confirmation", async () => {
      api = await bootTestApi();
      const ctx = makeCtx({ userId: "local-user", owner: { type: "user", id: "local-user" },
        config: { apiBaseUrl: api.baseUrl, internalToken: internalToken() } });
      const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Confirmation", creatorUserId: "local-user" });
      const teamCtx = { ...ctx, owner: { type: "team" as const, id: team.id } };
      const sourceCtx = tool === memCopyToTeamTool ? ctx : teamCtx;
      const destinationCtx = tool === memCopyToTeamTool ? teamCtx : ctx;
      await memWriteTool.execute({ path: "notes/source.md", content: "# Source content" }, sourceCtx);
      await memWriteTool.execute({ path: "notes/source.md", content: "# Existing destination" }, destinationCtx);
      const args = { from: "notes/source.md", to: "notes/source.md", teamId: team.id };
      const conflict = await tool.execute(args, ctx);
      const details = JSON.parse(conflict.text.replace("[memory_error] ", ""));
      expect(details).toMatchObject({ code: "MEMORY_DESTINATION_EXISTS", destinationVersion: expect.any(String) });
      expect(details.error).toContain("Ask the user whether to replace, rename, or cancel");
      expect((await memReadTool.execute({ path: args.to }, destinationCtx)).text).toContain("Existing destination");
      // Exercise runtime defense as well as the schema: an unvalidated call
      // without a user confirmation must not reach the HTTP mutation.
      const unconfirmed = JSON.parse(JSON.stringify({ ...args, replacement: { expectedVersion: details.destinationVersion } }));
      expect((await tool.execute(unconfirmed, ctx)).text).toContain("requires explicit user confirmation");
      expect((await memReadTool.execute({ path: args.to }, destinationCtx)).text).toContain("Existing destination");
      const confirmed = { ...args, replacement: { expectedVersion: details.destinationVersion, userConfirmed: true as const } };
      const replacement = await tool.execute(confirmed, ctx);
      expect(tool === memCopyToTeamTool ? decode(replacement.text) : JSON.parse(replacement.text)).toMatchObject({ file: { version: 2 } });
      expect((await memReadTool.execute({ path: args.to }, destinationCtx)).text).toContain("Source content");
      const stale = JSON.parse((await tool.execute(confirmed, ctx)).text.replace("[memory_error] ", ""));
      expect(stale).toMatchObject({ code: "MEMORY_DESTINATION_CHANGED", destinationVersion: expect.any(String) });
      expect(stale.destinationVersion).not.toBe(details.destinationVersion);
      expect(tool.description).toContain("never invent a suffix");
      expect(tool.description).toContain("original copy request does not authorize replacement");
      expect(tool.parameters).toMatchObject({ properties: { replacement: {
        required: ["expectedVersion", "userConfirmed"], properties: { userConfirmed: { const: true } },
      } } });
    });
  });
}

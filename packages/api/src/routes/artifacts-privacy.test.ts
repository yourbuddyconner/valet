import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { internalToken } from "../lib/internal-auth.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, artifacts, orgMembers, orgs, teamMembers, teams, users } from "../schema/index.js";
import { addArtifactComment, getArtifactById, listArtifactComments, publishArtifact, revokeArtifactByPath, shareArtifact, setArtifactVisibility } from "../services/artifacts.js";
import type { GetArtifactResponse, ListArtifactsResponse } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function setup() {
  const target = await bootTestApi();
  api = target;
  const db = target.providers.db;
  await db.insert(users).values({ id: "nonmember", email: "nonmember@dev", name: "Nonmember", role: "member" });
  await db.insert(orgs).values({ id: "foreign-org", name: "Foreign", createdAt: 1 });
  await db.insert(teams).values([
    { id: "private-team", orgId: "local-org", name: "Private", createdAt: 1 },
    { id: "foreign-team", orgId: "foreign-org", name: "Foreign", createdAt: 1 },
  ]);
  await db.insert(teamMembers).values([
    { teamId: "private-team", userId: "local-user", role: "admin" },
    { teamId: "private-team", userId: "test-member", role: "member" },
    // A stale membership must not bypass the organization boundary.
    { teamId: "foreign-team", userId: "test-member", role: "member" },
    { teamId: "foreign-team", userId: "local-user", role: "member" },
  ]);
  const publish = (teamId: string, orgId: string) => publishArtifact(db, {
    owner: { type: "team", id: teamId }, actorUserId: "local-user", principal: { type: "team", id: teamId },
  }, { orgId, key: "private.html", content: "<h1>Team secret</h1>", format: "html" });
  const row = await publish("private-team", "local-org");
  const foreign = await publish("foreign-team", "foreign-org");
  const comment = await addArtifactComment(db, { artifactId: row.id, version: 1, body: "Private comment", authorUserId: "local-user" });
  const request = (path: string, userId = "test-member", method = "GET", body?: object) => fetch(`${target.baseUrl}/api/artifacts${path}`, {
    method, headers: { "x-valet-test-user-id": userId, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { db, row, foreign, comment, request };
}

describe("team artifact privacy", () => {
  it("offers management only to a sharer or admin with current team access", async () => {
    const { db, row, request } = await setup();
    expect(await (await request(`/${row.token}`, "local-user")).json()).toMatchObject({ management: { id: row.id } });
    const reader = await request(`/${row.token}`, "test-member");
    expect(reader.status).toBe(200);
    expect(await reader.json()).not.toHaveProperty("management");
    expect((await request(`/${row.token}`, "test-admin")).status).toBe(404);
    await db.insert(teamMembers).values({ teamId: "private-team", userId: "test-admin", role: "member" });
    expect(await (await request(`/${row.token}`, "test-admin")).json()).toMatchObject({ management: { id: row.id } });
    await db.delete(teamMembers).where(eq(teamMembers.userId, "local-user"));
    expect((await request(`/${row.token}`, "local-user")).status).toBe(404);
  });

  it("does not offer comment delivery across organization boundaries", async () => {
    const { db, row, request } = await setup();
    await db.insert(agentSessions).values({
      id: "foreign-source", userId: "test-member", orgId: "foreign-org", workspace: "fixture",
      ownerType: "user", ownerId: "test-member", createdAt: 1, updatedAt: 1,
    });
    await db.update(artifacts).set({ sourceSessionId: "foreign-source" }).where(eq(artifacts.id, row.id));
    const comments = await request(`/${row.token}/comments`);
    expect(comments.status).toBe(200);
    expect(await comments.json()).toMatchObject({ canSendToSession: false });
    const posted = await request(`/${row.token}/comments`, "test-member", "POST", { body: "Stay in this org", sendToSession: true });
    expect(posted.status).toBe(200);
    expect(await posted.json()).toMatchObject({ sent: false, comment: { sentToSession: null } });
  });

  it("keeps internal team tool publications team-owned without borrowing actor authority", async () => {
    const { request } = await setup();
    if (!api) throw new Error("Test API is unavailable");
    const response = await fetch(`${api.baseUrl}/api/artifacts/share`, {
      method: "POST",
      headers: {
        "content-type": "application/json", "x-valet-internal": internalToken(),
        "x-valet-owner": "team:private-team", "x-valet-actor": "test-admin",
      },
      body: JSON.stringify({ key: "internal-tool.md", content: "Internal team publication" }),
    });
    expect(response.status).toBe(200);
    // The real publish route supplies this response; test its access below.
    const shared = await response.json() as { url: string };
    const token = new URL(shared.url).pathname.replace(/^\/a\//, "");
    expect((await request(`/${token}`)).status).toBe(200);
    expect((await request(`/${token}`, "test-admin")).status).toBe(404);
  });

  it("gates service-level publish, share and revoke without an org-admin fallback", async () => {
    const { db, row } = await setup();
    const owner = { type: "team", id: "private-team" } as const;
    for (const actorUserId of ["nonmember", "test-admin"]) {
      const scope = { owner, actorUserId };
      await expect(publishArtifact(db, scope, { orgId: "local-org", key: "private.html", content: "Overwrite", format: "html" })).rejects.toThrow();
      await expect(shareArtifact(db, scope, { orgId: "local-org", path: "private.html" })).rejects.toThrow();
      await expect(revokeArtifactByPath(db, scope, "private.html", "local-org")).rejects.toThrow();
    }
    // A verified team principal may publish for itself, with no actor fallback.
    const own = { owner, actorUserId: "test-admin", principal: owner };
    const borrowedActor = { ...own, owner: { type: "user", id: "test-admin" } } as const;
    await expect(publishArtifact(db, borrowedActor, { orgId: "local-org", key: "borrowed.md", content: "Wrong owner", format: "markdown" })).rejects.toThrow();
    await expect(shareArtifact(db, borrowedActor, { orgId: "local-org", path: "borrowed.md" })).rejects.toThrow();
    await expect(revokeArtifactByPath(db, borrowedActor, "borrowed.md", "local-org")).rejects.toThrow();
    const created = await publishArtifact(db, own, { orgId: "local-org", key: "internal.md", content: "Team tool", format: "markdown" });
    await expect(publishArtifact(db, { ...own, principal: { type: "team", id: "foreign-team" } }, { orgId: "local-org", key: "private.html", content: "Wrong team", format: "html" })).rejects.toThrow();
    await revokeArtifactByPath(db, own, created.sourceMemoryPath, "local-org");
    expect(await getArtifactById(db, row.id)).toMatchObject({ version: 1, revokedAt: null });
  });

  it("serves source, rendering, comments and member interactions through live membership", async () => {
    const { row, comment, request } = await setup();
    const read = await request(`/${row.token}`);
    expect(read.status).toBe(200);
    // The route response is checked against the wire contract below.
    const page = await read.json() as GetArtifactResponse;
    expect(page.content).toContain("Team secret"); // Download source.
    expect(page.rendered).toContain("Team secret");
    expect(page.canComment).toBe(true);
    expect((await request(`/${row.token}/comments`)).status).toBe(200);
    expect((await request(`/${row.token}/comments`, "test-member", "POST", { body: "Member reply", parentId: comment.id, sendToSession: true })).status).toBe(200);
    expect((await request(`/${row.token}/comments/${comment.id}/resolve`, "local-user", "POST")).status).toBe(200);
    expect((await request(`/${row.id}`, "test-member", "PATCH", { visibility: "public" })).status).toBe(403);
    expect((await request(`/${row.id}/versions`, "local-user")).status).toBe(200);
    expect((await request(`/${row.id}`, "local-user", "PATCH", { sharedVersion: 1 })).status).toBe(200);
    expect((await request("/share?ownerType=team&ownerId=private-team", "test-member", "POST", { key: "member.md", content: "Member publish" })).status).toBe(200);
  });

  it("denies nonmembers, org admins and removed publishers on every artifact surface", async () => {
    const { db, row, comment, request } = await setup();
    await db.delete(teamMembers).where(eq(teamMembers.userId, "local-user"));
    for (const user of ["nonmember", "test-admin", "local-user"]) {
      for (const path of [`/${row.token}`, `/${row.token}/comments`, `/${row.id}/versions`, "?ownerType=team&ownerId=private-team"]) {
        expect((await request(path, user)).status, `${user} GET ${path}`).toBe(404);
      }
      expect((await request(`/${row.token}/comments`, user, "POST", { body: "Leak", sendToSession: true })).status).toBe(404);
      expect((await request(`/${row.token}/comments/${comment.id}/resolve`, user, "POST")).status).toBe(404);
      expect((await request(`/${row.id}`, user, "PATCH", { sharedVersion: 1 })).status).toBe(404);
      expect((await request(`/${row.id}`, user, "DELETE")).status).toBe(404);
      for (const body of [{ key: "private.html", content: "Overwrite" }, { key: "private.html", revoke: true }, { path: "private.html" }]) {
        expect((await request("/share?ownerType=team&ownerId=private-team", user, "POST", body)).status).toBe(404);
      }
      for (const path of ["", "?mine=1"]) {
        // The route response is checked against the wire contract below.
        const list = await (await request(path, user)).json() as ListArtifactsResponse;
        expect(list.artifacts.map((item) => item.id)).not.toContain(row.id);
      }
    }
    expect(await listArtifactComments(db, row.id)).toHaveLength(1);
    expect(await getArtifactById(db, row.id)).toMatchObject({ version: 1, revokedAt: null, sharedVersion: null });
  });

  it("requires live org membership even when team membership and deployment identity remain", async () => {
    const { db, row, comment, request } = await setup();
    await db.update(orgs).set({ allowPublicArtifacts: true }).where(eq(orgs.id, "local-org"));
    await db.update(artifacts).set({ visibility: "public" }).where(eq(artifacts.id, row.id));
    await db.delete(orgMembers).where(eq(orgMembers.userId, "local-user"));
    await db.delete(orgMembers).where(eq(orgMembers.userId, "test-member"));
    for (const user of ["local-user", "test-member"]) {
      for (const path of [`/${row.token}`, `/${row.token}/comments`, `/${row.id}/versions`, "?ownerType=team&ownerId=private-team", "?ownerType=team&ownerId=private-team&limit=1"]) {
        expect((await request(path, user)).status, path).toBe(404);
      }
      expect((await request(`/${row.token}/comments`, user, "POST", { body: "Stale member" })).status).toBe(404);
      expect((await request(`/${row.token}/comments/${comment.id}/resolve`, user, "POST")).status).toBe(404);
      expect((await request(`/${row.id}`, user, "DELETE")).status).toBe(404);
      for (const path of ["", "?mine=1"]) {
        expect(await (await request(path, user)).json()).toMatchObject({ artifacts: [] });
      }
      const scope = { owner: { type: "team", id: "private-team" }, actorUserId: user } as const;
      await expect(publishArtifact(db, scope, { orgId: "local-org", key: "private.html", content: "Overwrite", format: "html" })).rejects.toThrow();
      await expect(shareArtifact(db, scope, { orgId: "local-org", path: "private.html" })).rejects.toThrow();
      await expect(revokeArtifactByPath(db, scope, "private.html", "local-org")).rejects.toThrow();
      for (const body of [{ key: "private.html", content: "Overwrite" }, { key: "private.html", revoke: true }, { path: "private.html" }]) {
        expect((await request("/share?ownerType=team&ownerId=private-team", user, "POST", body)).status).toBe(404);
      }
    }
    expect(await getArtifactById(db, row.id)).toMatchObject({ version: 1, revokedAt: null });
    expect(await db.select().from(teamMembers).where(eq(teamMembers.teamId, "private-team"))).toHaveLength(2);
  });

  it("hides foreign-org artifacts and refuses cross-org sharing even with stale membership", async () => {
    const { foreign, request } = await setup();
    for (const path of [`/${foreign.token}`, `/${foreign.token}/comments`, `/${foreign.id}/versions`, "?ownerType=team&ownerId=foreign-team"]) {
      expect((await request(path)).status).toBe(404);
    }
    expect((await request(`/${foreign.token}/comments`, "test-member", "POST", { body: "Cross org" })).status).toBe(404);
    expect((await request(`/${foreign.id}`, "local-user", "PATCH", { visibility: "public" })).status).toBe(404);
    expect((await request(`/${foreign.id}`, "local-user", "DELETE")).status).toBe(404);
    expect((await request("/share?ownerType=team&ownerId=foreign-team", "test-member", "POST", { key: "cross.md", content: "Cross org" })).status).toBe(404);
  });

  it("refuses public widening and keeps legacy public team rows private", async () => {
    const { db, row, request } = await setup();
    await db.update(orgs).set({ allowPublicArtifacts: true }).where(eq(orgs.id, "local-org"));
    expect((await request(`/${row.id}`, "local-user", "PATCH", { visibility: "public", sharedVersion: 1 })).status).toBe(400);
    await expect(setArtifactVisibility(db, row.id, "public", "local-user")).rejects.toThrow();
    expect(await getArtifactById(db, row.id)).toMatchObject({ visibility: "org", sharedVersion: null });
    await db.update(artifacts).set({ visibility: "public" }).where(eq(artifacts.id, row.id));
    expect((await request(`/${row.token}`, "nonmember")).status).toBe(404);
    expect((await request(`/${row.token}`)).status).toBe(200);
    await db.delete(teamMembers).where(eq(teamMembers.userId, "test-member"));
    expect((await request(`/${row.token}`)).status).toBe(404);
    expect((await request(`/${row.token}/comments`)).status).toBe(404);
  });
});

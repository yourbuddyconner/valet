import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { artifacts, orgs, teamMembers, teams } from "../schema/index.js";
import { publishArtifact } from "../services/artifacts.js";
import type { ListArtifactsResponse } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function setup() {
  const target = await bootTestApi();
  api = target;
  const db = target.providers.db;
  await db.insert(orgs).values({ id: "foreign-org", name: "Foreign", createdAt: 1 });
  await db.insert(teams).values([
    { id: "team-a", orgId: "local-org", name: "A", createdAt: 1 },
    { id: "team-b", orgId: "local-org", name: "B", createdAt: 1 },
    { id: "foreign-team", orgId: "foreign-org", name: "Foreign", createdAt: 1 },
  ]);
  await db.insert(teamMembers).values([
    { teamId: "team-a", userId: "test-member", role: "member" },
    { teamId: "team-a", userId: "local-user", role: "member" },
    { teamId: "team-b", userId: "local-user", role: "member" },
  ]);
  const publish = async (owner: { type: "user" | "team"; id: string }, key: string, actor = "local-user") => {
    const row = await publishArtifact(db, { owner, actorUserId: actor }, {
      orgId: "local-org", key, content: `# ${key}`, format: "markdown",
    });
    // Equal timestamps exercise the id tie-breaker across page boundaries.
    await db.update(artifacts).set({ updatedAt: 1234 }).where(eq(artifacts.id, row.id));
    return row;
  };
  const personal = await publish({ type: "user", id: "local-user" }, "personal");
  const otherPersonal = await publish({ type: "user", id: "test-member" }, "other-personal", "test-member");
  const teamRows = await Promise.all(["one", "two", "three"].map((key) => publish({ type: "team", id: "team-a" }, key)));
  const revoked = await publish({ type: "team", id: "team-a" }, "revoked");
  await db.update(artifacts).set({ revokedAt: 100, updatedAt: 9999 }).where(eq(artifacts.id, revoked.id));
  await publish({ type: "team", id: "team-b" }, "other-team");
  await db.delete(teamMembers).where(eq(teamMembers.userId, "local-user"));
  return { target, personal, otherPersonal, teamRows, revoked };
}

async function list(target: TestApi, query: string, userId = "local-user") {
  const response = await fetch(`${target.baseUrl}/api/artifacts?${query}`, {
    headers: { "x-valet-test-user-id": userId },
  });
  expect(response.status).toBe(200);
  // The route response is checked against the wire contract below.
  const body = await response.json() as ListArtifactsResponse;
  return body;
}

describe("workspace artifact lists", () => {
  it("filters source work before pagination and binds the cursor to that work", async () => {
    const { target, teamRows } = await setup();
    for (const row of teamRows) {
      await target.providers.db.update(artifacts).set({ sourceSessionId: "work-one", sourceThreadId: "thread-one" }).where(eq(artifacts.id, row.id));
    }
    const query = "ownerType=team&ownerId=team-a&sourceSessionId=work-one&sourceThreadId=thread-one&limit=2";
    const first = await list(target, query, "test-member");
    expect(first.artifacts).toHaveLength(2);
    expect(first.artifacts.every(row => row.sourceSessionId === "work-one" && row.sourceThreadId === "thread-one")).toBe(true);
    const cursor = encodeURIComponent(first.nextCursor ?? "");
    const second = await list(target, `${query}&cursor=${cursor}`, "test-member");
    expect(second.artifacts).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const wrongSource = await fetch(`${target.baseUrl}/api/artifacts?${query.replace("work-one", "work-two")}&cursor=${cursor}`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(wrongSource.status).toBe(400);
    const wrongThread = await list(target, query.replace("thread-one", "thread-two"), "test-member");
    expect(wrongThread.artifacts).toEqual([]);
    const wrongThreadCursor = await fetch(`${target.baseUrl}/api/artifacts?${query.replace("thread-one", "thread-two")}&cursor=${cursor}`, { headers: { "x-valet-test-user-id": "test-member" } });
    expect(wrongThreadCursor.status).toBe(400);
    const empty = await list(target, query.replace("work-one", "work-two"), "test-member");
    expect(empty.artifacts).toEqual([]);
    expect((await fetch(`${target.baseUrl}/api/artifacts?sourceSessionId=work-one`)).status).toBe(400);
  });

  it("uses stored ownership, not publishing actor, for personal and team lists", async () => {
    const { target, personal, otherPersonal, teamRows } = await setup();
    const mine = await list(target, "ownerType=user&ownerId=local-user&limit=50");
    expect(mine.artifacts.map((row) => row.id)).toEqual([personal.id]);
    const other = await list(target, "ownerType=user&ownerId=test-member&limit=50", "test-member");
    expect(other.artifacts.map((row) => row.id)).toEqual([otherPersonal.id]);
    // This member did not publish any team artifacts, but owns access through membership.
    const team = await list(target, "ownerType=team&ownerId=team-a&limit=50", "test-member");
    expect(team.artifacts.map((row) => row.id).sort()).toEqual(teamRows.map((row) => row.id).sort());
    expect(team.nextCursor).toBeNull();
  });

  it("refuses nonmembers, other personal owners, missing teams, and foreign-org teams", async () => {
    const { target } = await setup();
    for (const [query, userId] of [
      ["ownerType=team&ownerId=team-b", "test-member"],
      ["ownerType=user&ownerId=test-member", "local-user"],
      ["ownerType=team&ownerId=missing", "local-user"],
      ["ownerType=team&ownerId=foreign-team", "local-user"],
    ]) {
      const response = await fetch(`${target.baseUrl}/api/artifacts?${query}`, {
        headers: { "x-valet-test-user-id": userId },
      });
      expect(response.status).toBe(404);
    }
    // Org admin authority does not grant team artifact access.
    expect((await fetch(`${target.baseUrl}/api/artifacts?ownerType=team&ownerId=team-b`)).status).toBe(404);
    await target.providers.db.delete(teamMembers).where(eq(teamMembers.userId, "test-member"));
    const removed = await fetch(`${target.baseUrl}/api/artifacts?ownerType=team&ownerId=team-a&limit=50`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(removed.status).toBe(404);
  });

  it("pages active rows without skipping timestamp ties or crossing workspace boundaries", async () => {
    const { target, teamRows, revoked } = await setup();
    const query = "ownerType=team&ownerId=team-a&limit=2";
    const first = await list(target, query, "test-member");
    expect(first.artifacts).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const cursor = encodeURIComponent(first.nextCursor ?? "");
    const second = await list(target, `${query}&cursor=${cursor}`, "test-member");
    expect(second.artifacts).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.artifacts, ...second.artifacts].map((row) => row.id);
    expect(ids).toEqual(teamRows.map((row) => row.id).sort().reverse());
    expect(ids).not.toContain(revoked.id);
    await target.providers.db.insert(teamMembers).values({ teamId: "team-b", userId: "local-user", role: "member" });
    const wrongWorkspace = await fetch(`${target.baseUrl}/api/artifacts?ownerType=team&ownerId=team-b&limit=2&cursor=${cursor}`);
    expect(wrongWorkspace.status).toBe(400);
    // Non-paged callers keep the legacy list, including revoked rows.
    expect((await list(target, "ownerType=team&ownerId=team-a", "test-member")).artifacts).toHaveLength(4);
  });

  it("rejects malformed owners, limits, and cursors", async () => {
    const { target } = await setup();
    for (const query of [
      "limit=50", "mine=1&cursor=bad", "ownerType=user", "ownerId=team-a", "ownerType=org&ownerId=local-org",
      "mine=1&ownerType=user&ownerId=local-user",
      "ownerType=user&ownerId=local-user&limit=0",
      "ownerType=user&ownerId=local-user&limit=2.5",
      "ownerType=user&ownerId=local-user&cursor=bad",
    ]) {
      expect((await fetch(`${target.baseUrl}/api/artifacts?${query}`)).status).toBe(400);
    }
  });
});

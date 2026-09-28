import { seedWorkspaceAssistant } from "../test-helpers/assistant-fixture.js";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import {
  apikey,
  assistants,
  contentSources,
  credentials,
  orgMembers,
  orgs,
  teamMembers,
  teams,
  users,
  workflowDefinitions,
  workflowRuns,
  workflowSchedules,
} from "../schema/index.js";
import { reapTeamWorkflows } from "../workflows/service.js";
import {
  addMember,
  canAdministerTeam,
  ConfigManagedTeamError,
  createTeam,
  deleteTeam,
  isLiveIdpMirror,
  LastAdminError,
  listTeamMembers,
  teamMembershipSummaries,
  listTeamsForOrg,
  listTeamsForUser,
  NotOrgMemberError,
  NotTeamMemberError,
  removeMember,
  seedMissingTeamDefaults,
  setRole,
  TeamHasActiveRunsError,
  TeamNameConflictError,
  TeamOwnsWorkflowsError,
} from "./teams.js";
import { findDefaultAssistant } from "../assistants/service.js";

async function seedUser(db: AppDb, id: string, orgId: string) {
  await db.insert(users).values({ id, email: `${id}@x.test`, name: id, role: "member" });
  await db.insert(orgMembers).values({ orgId, userId: id, role: "member" });
}

describe("teams service", () => {
  let db: AppDb;
  const orgId = "org1";

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    await db.insert(orgs).values({ id: orgId, name: "Org", createdAt: Date.now() });
    await seedUser(db, "u1", orgId);
    await seedUser(db, "u2", orgId);
    await seedUser(db, "u3", orgId);
  });

  it("aggregates membership in bounded batches without including another org", async () => {
    await db.insert(orgs).values({ id: "other-org", name: "Other", createdAt: Date.now() });
    await db.insert(teams).values([
      { id: "one", orgId, name: "One", createdAt: 1 },
      { id: "two", orgId, name: "Two", createdAt: 1 },
      { id: "empty", orgId, name: "Empty", createdAt: 1 },
      { id: "foreign", orgId: "other-org", name: "Foreign", createdAt: 1 },
    ]);
    await db.insert(teamMembers).values([
      { teamId: "one", userId: "u1", role: "admin" },
      { teamId: "one", userId: "u2", role: "member" },
      { teamId: "two", userId: "u2", role: "admin" },
      { teamId: "foreign", userId: "u1", role: "admin" },
    ]);
    const reads = vi.spyOn(db, "select");
    try {
      expect(await teamMembershipSummaries(db, orgId, [], "u1")).toEqual(new Map());
      expect(reads).not.toHaveBeenCalled();
      const result = await teamMembershipSummaries(db, orgId, [
        "one", "foreign", "empty", ...Array.from({ length: 1_001 }, (_, i) => `absent-${i}`), "two",
      ], "u1");
      expect(result).toEqual(new Map([
        ["one", { memberCount: 2, callerRole: "admin" }],
        ["two", { memberCount: 1, callerRole: null }],
      ]));
      expect(reads).toHaveBeenCalledTimes(2);
      expect((await teamMembershipSummaries(db, orgId, ["one"], "u2")).get("one")?.callerRole).toBe("member");
    } finally {
      reads.mockRestore();
    }
  });

  // Teams written before the seed shipped have no default assistant, and a
  // member switching to one would hit a notice with no create path. The boot
  // backfill gives every such team its default once and leaves teams that
  // already hold one alone.
  it("seedMissingTeamDefaults gives a pre-existing team its default once", async () => {
    const now = Date.now();
    await db.insert(teams).values({ id: "team_old", orgId, name: "Old", origin: "local", createdAt: now });
    await db.insert(teams).values({ id: "team_named", orgId, name: "Named", origin: "local", createdAt: now });
    await seedWorkspaceAssistant(db, orgId, { type: "team", id: "team_named" }, "Bot");
    const seeded = await createTeam(db, { orgId, name: "Fresh", creatorUserId: "u1" });

    // "Named" already holds a default: its first assistant became one.
    expect(await seedMissingTeamDefaults(db)).toEqual(["team_old"]);
    for (const id of ["team_old", "team_named", seeded.id]) {
      const row = await findDefaultAssistant(db, orgId, { type: "team", id });
      expect(row).toBeDefined();
    }
    const namedRows = await db.select().from(assistants).where(and(eq(assistants.ownerType, "team"), eq(assistants.ownerId, "team_named")));
    expect(namedRows.map((r) => r.name)).toEqual(["Bot"]);

    expect(await seedMissingTeamDefaults(db)).toEqual([]);
  });

  it("createTeam auto-admits the creator as admin", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    expect(team.name).toBe("Platform");
    expect(team.orgId).toBe(orgId);

    const teams = await listTeamsForUser(db, "u1");
    expect(teams).toHaveLength(1);
    expect(teams[0].id).toBe(team.id);
  });

  it("createTeam seeds the team's default assistant in the same transaction (TKAI-337)", async () => {
    // Every `/chat` UI affordance for a team keys off "the team owns an
    // assistant". Lazy creation left a brand-new team with no group, no
    // `+`, and silently opened the caller's personal assistant. The row
    // must be present the moment the team is.
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });

    const owned = await db
      .select()
      .from(assistants)
      .where(and(eq(assistants.ownerType, "team"), eq(assistants.ownerId, team.id)));
    expect(owned).toHaveLength(1);
    expect(owned[0]).toBeDefined();
    expect(owned[0]?.archivedAt).toBeNull();
    expect(owned[0]?.orgId).toBe(orgId);
    // Session address follows the assistant id (`assistant:{id}`), so the
    // rail and every dispatch resolve to the same session.
    expect(owned[0]?.sessionId).toBe(`assistant:${owned[0]!.id}`);
  });

  it("createTeam returns the seeded default assistant with the team", async () => {
    // The route answers POST with the assistant so the client can open it
    // at once. A re-read after commit would be a second query for a row the
    // transaction already holds, and a miss there would surface as a 500.
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });

    const owned = await db
      .select()
      .from(assistants)
      .where(and(eq(assistants.ownerType, "team"), eq(assistants.ownerId, team.id)));
    expect(team.defaultAssistant).toEqual(owned[0]);
    expect(team.defaultAssistant).toBeDefined();
  });

  it("createTeam rolls the assistant back with the team on a name conflict", async () => {
    // The seed lives inside the create transaction, so a duplicate name
    // must leave neither row behind — otherwise a retry after a rejected
    // create would strand a dangling-owner assistant.
    await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    const before = await db.select().from(assistants);

    await expect(
      createTeam(db, { orgId, name: "Platform", creatorUserId: "u2" }),
    ).rejects.toThrow(TeamNameConflictError);

    const after = await db.select().from(assistants);
    expect(after).toHaveLength(before.length);
  });

  it("createTeam rolls the team back when the assistant seed throws", async () => {
    // The seed is injected rather than module-mocked: a `vi.mock` of the
    // assistants module resolved to a different instance under CI and the
    // real seed ran, so the create resolved instead of rejecting.
    await expect(
      createTeam(db, {
        orgId,
        name: "Rollback",
        creatorUserId: "u1",
        seedDefaultAssistant: async () => {
          throw new Error("seed failed");
        },
      }),
    ).rejects.toThrow("seed failed");

    const leftoverTeams = await db.select().from(teams).where(eq(teams.name, "Rollback"));
    const leftoverAssistants = await db
      .select()
      .from(assistants)
      .where(and(eq(assistants.ownerType, "team")));
    expect(leftoverTeams).toHaveLength(0);
    expect(leftoverAssistants).toHaveLength(0);
  });

  it("rejects a duplicate team name within the same org", async () => {
    await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await expect(createTeam(db, { orgId, name: "Platform", creatorUserId: "u2" })).rejects.toThrow(
      TeamNameConflictError,
    );
  });

  it("allows the same team name across different orgs", async () => {
    await db.insert(orgs).values({ id: "org2", name: "Org2", createdAt: Date.now() });
    await seedUser(db, "u9", "org2");
    await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await expect(
      createTeam(db, { orgId: "org2", name: "Platform", creatorUserId: "u9" }),
    ).resolves.toBeDefined();
  });

  it("addMember adds a member with the given role", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await addMember(db, { teamId: team.id, userId: "u2", role: "member" });

    const teams = await listTeamsForUser(db, "u2");
    expect(teams.map((t) => t.id)).toContain(team.id);
  });

  it("canAdministerTeam admits only team admins or org admins", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await addMember(db, { teamId: team.id, userId: "u2", role: "member" });

    expect(await canAdministerTeam(db, team.id, "u1")).toBe(true);
    expect(await canAdministerTeam(db, team.id, "u2")).toBe(false);

    await db.update(orgMembers).set({ role: "admin" }).where(
      and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, "u3")),
    );
    // Recovery override applies even when the org admin is not on the team.
    expect(await canAdministerTeam(db, team.id, "u3")).toBe(true);
  });

  it("a global operator without either membership role cannot administer a team", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await addMember(db, { teamId: team.id, userId: "u2", role: "member" });
    await db.update(users).set({ role: "admin" }).where(eq(users.id, "u2"));

    expect(await canAdministerTeam(db, team.id, "u2")).toBe(false);
  });

  it("setRole promotes/demotes a member", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await addMember(db, { teamId: team.id, userId: "u2", role: "member" });
    await setRole(db, { teamId: team.id, userId: "u2", role: "admin" });
    // now two admins; demoting u1 should succeed since u2 remains admin
    await expect(setRole(db, { teamId: team.id, userId: "u1", role: "member" })).resolves.toBeUndefined();
  });

  it("setRole rejects demoting the last admin", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await addMember(db, { teamId: team.id, userId: "u2", role: "member" });
    await expect(setRole(db, { teamId: team.id, userId: "u1", role: "member" })).rejects.toThrow(
      LastAdminError,
    );
  });

  it("removeMember rejects removing the last admin", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await addMember(db, { teamId: team.id, userId: "u2", role: "member" });
    await expect(removeMember(db, { teamId: team.id, userId: "u1" })).rejects.toThrow(LastAdminError);
  });

  it("removeMember allows removing a non-last admin", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await addMember(db, { teamId: team.id, userId: "u2", role: "admin" });
    await expect(removeMember(db, { teamId: team.id, userId: "u1" })).resolves.toBeUndefined();

    const teams = await listTeamsForUser(db, "u1");
    expect(teams).toHaveLength(0);
  });

  it("removeMember rejects a user who isn't a member", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await expect(removeMember(db, { teamId: team.id, userId: "u3" })).rejects.toThrow(NotTeamMemberError);
  });

  it("listTeamsForOrg returns every team in the org, not just the caller's own", async () => {
    const t1 = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    const t2 = await createTeam(db, { orgId, name: "Design", creatorUserId: "u2" });
    const orgTeams = await listTeamsForOrg(db, orgId);
    expect(orgTeams.map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort());
  });

  it("listTeamMembers returns userId + role for a team", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await addMember(db, { teamId: team.id, userId: "u2", role: "member" });
    const members = await listTeamMembers(db, team.id);
    expect(members.sort((a, b) => a.userId.localeCompare(b.userId))).toEqual([
      { userId: "u1", role: "admin" },
      { userId: "u2", role: "member" },
    ]);
  });

  it("last-admin guard is atomic under a role-change + removal race on the only two admins", async () => {
    // Two admins; concurrently demote one and remove the other. Only one of
    // the two operations may succeed — the second must observe the
    // just-applied state and reject as a last-admin violation.
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await addMember(db, { teamId: team.id, userId: "u2", role: "admin" });

    const results = await Promise.allSettled([
      setRole(db, { teamId: team.id, userId: "u1", role: "member" }),
      removeMember(db, { teamId: team.id, userId: "u2" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it("listTeamsForUser returns only teams the user belongs to", async () => {
    const t1 = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await createTeam(db, { orgId, name: "Design", creatorUserId: "u2" });

    const teams = await listTeamsForUser(db, "u1");
    expect(teams.map((t) => t.id)).toEqual([t1.id]);
  });

  it("deleteTeam removes the team, memberships, and team orchestrator schedules", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await db.insert(workflowSchedules).values({
      id: "team_schedule",
      orgId,
      ownerType: "team",
      ownerId: team.id,
      targetKind: "orchestrator",
      prompt: "Review work",
      name: "Team schedule",
      cron: "0 9 * * *",
      timezone: "UTC",
      enabled: true,
      nextFireAt: 2_000,
      createdBy: "u1",
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    await deleteTeam(db, { teamId: team.id });

    const teams = await listTeamsForUser(db, "u1");
    expect(teams).toHaveLength(0);
    expect(await db.select().from(workflowSchedules)).toHaveLength(0);
  });

  it("deleteTeam drops team-owned credential rows including the 1Password grant", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await db.insert(credentials).values({
      ownerType: "team",
      ownerId: team.id,
      service: "onepassword",
      type: "service_account",
      metadata: { refs: ["op://Shared/Acme/credential"] },
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    await deleteTeam(db, { teamId: team.id });
    const leftover = await db
      .select()
      .from(credentials)
      .where(and(eq(credentials.ownerType, "team"), eq(credentials.ownerId, team.id)));
    expect(leftover).toEqual([]);
  });

  it("deleteTeam reaps the team's API keys and leaves every other key", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    const survivor = await createTeam(db, { orgId, name: "Design", creatorUserId: "u2" });
    const minted = { createdAt: new Date(), updatedAt: new Date() };
    await db.insert(apikey).values([
      {
        id: "ak_doomed",
        referenceId: "u1",
        key: "hash-doomed",
        teamId: team.id,
        metadata: JSON.stringify({ teamId: team.id, createdBy: "u1" }),
        ...minted,
      },
      {
        id: "ak_other_team",
        referenceId: "u2",
        key: "hash-other",
        teamId: survivor.id,
        metadata: JSON.stringify({ teamId: survivor.id, createdBy: "u2" }),
        ...minted,
      },
      { id: "ak_personal", referenceId: "u1", key: "hash-personal", ...minted },
    ]);

    await deleteTeam(db, { teamId: team.id });

    const remaining = await db.select({ id: apikey.id }).from(apikey);
    expect(remaining.map((row) => row.id).sort()).toEqual(["ak_other_team", "ak_personal"]);
  });

  it("deleteTeam rejects deletion while the team owns a workflow", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await db.insert(workflowDefinitions).values({
      id: "wf_1",
      orgId,
      ownerType: "team",
      ownerId: team.id,
      name: "team workflow",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    await expect(deleteTeam(db, { teamId: team.id })).rejects.toThrow(TeamOwnsWorkflowsError);

    const teams = await listTeamsForUser(db, "u1");
    expect(teams).toHaveLength(1);
  });

  it("createTeam adopts one source per org workflow source", async () => {
    await db.insert(contentSources).values({
      id: "skillsrc_org_wf",
      orgId,
      ownerType: "org",
      ownerId: orgId,
      createdBy: "u1",
      repoFullName: "tkhq/automation",
      ref: "main",
      subpath: "workflows",
      kinds: ["workflows"],
      enabled: true,
      status: "ok",
      attempts: 0,
      nextAttemptAt: 1_000,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    await db.insert(contentSources).values({
      id: "skillsrc_org_skills",
      orgId,
      ownerType: "org",
      ownerId: orgId,
      createdBy: "u1",
      repoFullName: "tkhq/skills",
      ref: "",
      subpath: "",
      kinds: ["skills"],
      enabled: true,
      status: "ok",
      attempts: 0,
      nextAttemptAt: 1_000,
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    const team = await createTeam(db, {
      orgId,
      name: "Platform",
      creatorUserId: "u1",
      adoptSources: [
        {
          repoFullName: "tkhq/automation",
          ref: "main",
          subpath: "workflows",
          kinds: ["workflows"],
        },
      ],
    });

    expect(team.adoptedSources).toHaveLength(1);
    expect(team.adoptedSources[0]!.repoFullName).toBe("tkhq/automation");
    expect(team.adoptedSources[0]!.ownerType).toBe("team");
    expect(team.adoptedSources[0]!.ownerId).toBe(team.id);
    expect(team.adoptedSources[0]!.createdBy).toBe("u1");

    const rows = await db
      .select()
      .from(contentSources)
      .where(and(eq(contentSources.ownerType, "team"), eq(contentSources.ownerId, team.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kinds).toEqual(["workflows"]);
  });

  // An org source may collect skills alongside workflows. Copying its kinds
  // gave every new team a team-owned mirror of every org skill and its own
  // poll of the repository. The adopted row exists for the workflows.
  it("createTeam adopts only the workflows kind of a mixed-kind org source", async () => {
    const team = await createTeam(db, {
      orgId,
      name: "Platform",
      creatorUserId: "u1",
      adoptSources: [
        {
          repoFullName: "tkhq/automation",
          ref: "main",
          subpath: "",
          kinds: ["skills", "workflows", "templates"],
        },
      ],
    });

    expect(team.adoptedSources).toHaveLength(1);
    expect(team.adoptedSources[0]!.kinds).toEqual(["workflows"]);
    const rows = await db
      .select()
      .from(contentSources)
      .where(and(eq(contentSources.ownerType, "team"), eq(contentSources.ownerId, team.id)));
    expect(rows[0]!.kinds).toEqual(["workflows"]);
  });

  it("createTeam with no adoptSources writes only the team and membership", async () => {
    const team = await createTeam(db, { orgId, name: "Empty", creatorUserId: "u1" });
    expect(team.adoptedSources).toEqual([]);
    const sources = await db.select().from(contentSources);
    expect(sources).toHaveLength(0);
    const members = await listTeamMembers(db, team.id);
    expect(members).toEqual([{ userId: "u1", role: "admin" }]);
  });

  it("rolls adoption back with the team when the source insert conflicts", async () => {
    await expect(
      createTeam(db, {
        orgId,
        name: "Platform",
        creatorUserId: "u1",
        adoptSources: [
          { repoFullName: "tkhq/a", ref: "", subpath: "", kinds: ["workflows"] },
          { repoFullName: "tkhq/a", ref: "other", subpath: "", kinds: ["workflows"] },
        ],
      }),
    ).rejects.toThrow();

    expect(await listTeamsForUser(db, "u1")).toHaveLength(0);
    expect(await db.select().from(contentSources)).toHaveLength(0);
  });

  it("deleteTeam reaps owned workflows when the callback does", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await db.insert(workflowDefinitions).values({
      id: "wf_reap",
      orgId,
      ownerType: "team",
      ownerId: team.id,
      name: "adopted",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    await deleteTeam(db, {
      teamId: team.id,
      reapOwnedWorkflows: async (tx) => {
        await tx
          .delete(workflowDefinitions)
          .where(and(eq(workflowDefinitions.ownerType, "team"), eq(workflowDefinitions.ownerId, team.id)));
      },
    });

    expect(await listTeamsForUser(db, "u1")).toHaveLength(0);
    expect(await db.select().from(workflowDefinitions)).toHaveLength(0);
  });

  it("deleteTeam refuses when reap reports an unsettled run", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await db.insert(workflowDefinitions).values({
      id: "wf_live",
      orgId,
      ownerType: "team",
      ownerId: team.id,
      name: "live",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    await expect(
      deleteTeam(db, {
        teamId: team.id,
        reapOwnedWorkflows: async () => {
          throw new TeamHasActiveRunsError(team.id);
        },
      }),
    ).rejects.toThrow(TeamHasActiveRunsError);

    expect(await listTeamsForUser(db, "u1")).toHaveLength(1);
    expect(await db.select().from(workflowDefinitions)).toHaveLength(1);
  });

  it("deleteTeam refuses an unsettled run without waiting on its own transaction", async () => {
    // `reapTeamWorkflows` runs inside the delete transaction. Its run
    // check once read through the process-wide `PgWorkflowStore`, a second
    // handle over the SAME PGlite instance as `db`, and that read waited
    // on the open transaction forever. The check must read `workflow_runs`
    // through `tx`. A hang here is the bug.
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await db.insert(workflowDefinitions).values({
      id: "wf_busy",
      orgId,
      ownerType: "team",
      ownerId: team.id,
      name: "busy",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    await db.insert(workflowRuns).values({
      id: "run_busy",
      workflowId: "wf_busy",
      definitionVersionId: "v1",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      params: {},
      status: "running",
      ownerType: "team",
      ownerId: team.id,
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("deleteTeam hung on its own transaction")), 5_000);
    });
    try {
      await expect(
        Promise.race([
          deleteTeam(db, {
            teamId: team.id,
            reapOwnedWorkflows: (tx) => reapTeamWorkflows(tx, team.id),
          }),
          timeout,
        ]),
      ).rejects.toThrow(TeamHasActiveRunsError);
    } finally {
      clearTimeout(timer);
    }

    expect(await listTeamsForUser(db, "u1")).toHaveLength(1);
    expect(await db.select().from(workflowDefinitions)).toHaveLength(1);
  });

  it("addMember rejects a userId with no org_members row in the team's org", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await expect(addMember(db, { teamId: team.id, userId: "no-such-user", role: "member" })).rejects.toThrow(
      NotOrgMemberError,
    );
  });

  it("addMember rejects a userId that belongs to a different org", async () => {
    await db.insert(orgs).values({ id: "org2", name: "Org2", createdAt: Date.now() });
    await seedUser(db, "u9", "org2");

    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await expect(addMember(db, { teamId: team.id, userId: "u9", role: "member" })).rejects.toThrow(
      NotOrgMemberError,
    );
  });

  describe("identity-provider-backed teams", () => {
    async function seedIdpTeam(): Promise<string> {
      const id = "team_idp";
      await db.insert(teams).values({
        id,
        orgId,
        name: "platform",
        origin: "idp",
        externalId: "/platform",
        createdAt: Date.now(),
      });
      await db.insert(teamMembers).values({ teamId: id, userId: "u1", role: "admin" });
      await db.insert(teamMembers).values({ teamId: id, userId: "u2", role: "member" });
      return id;
    }

    it("is never a live login-managed mirror", async () => {
      const teamId = await seedIdpTeam();
      const rows = await db.select().from(teams).where(eq(teams.id, teamId));
      expect(await isLiveIdpMirror(db, rows[0]!)).toBe(false);
    });

    it("keeps manual membership edits available", async () => {
      const teamId = await seedIdpTeam();
      await addMember(db, { teamId, userId: "u3", role: "member" });
      await setRole(db, { teamId, userId: "u2", role: "admin" });
      await removeMember(db, { teamId, userId: "u3" });

      const members = await listTeamMembers(db, teamId);
      expect(members).toHaveLength(2);
      expect(members.find((member) => member.userId === "u2")?.role).toBe("admin");
    });

    it("can be deleted without a login sync recreating it", async () => {
      const teamId = await seedIdpTeam();
      await deleteTeam(db, { teamId });
      expect(await listTeamsForUser(db, "u1")).toEqual([]);
    });
  });

  describe("config-declared teams", () => {
    /**
     * Seeds a team the way the boot reconciler does: `origin: "config"` and
     * no external id. `createTeam` always writes `local`, so it cannot
     * produce one.
     */
    async function seedConfigTeam(): Promise<string> {
      const id = "team_cfg_seed";
      await db.insert(teams).values({ id, orgId, name: "declared", origin: "config", createdAt: Date.now() });
      await db.insert(teamMembers).values({ teamId: id, userId: "u1", role: "admin" });
      await db.insert(teamMembers).values({ teamId: id, userId: "u2", role: "member" });
      return id;
    }

    it("deleteTeam refuses and names the file to edit", async () => {
      const teamId = await seedConfigTeam();
      await expect(deleteTeam(db, { teamId })).rejects.toThrow(ConfigManagedTeamError);
      // Naming the refusal is not enough — the reader needs the file, because
      // the next boot recreates a team deleted anywhere else.
      await expect(deleteTeam(db, { teamId })).rejects.toThrow(/VALET_CONFIG/);
      expect(await listTeamsForUser(db, "u1")).toHaveLength(1);
    });

    it("membership stays editable, unlike a mirrored team's", async () => {
      // The file only asserts members, so an edit here is real work that
      // lasts until the next restart. Refusing it would be stricter than the
      // file's own rule.
      const teamId = await seedConfigTeam();

      await addMember(db, { teamId, userId: "u3", role: "member" });
      expect(await listTeamMembers(db, teamId)).toHaveLength(3);

      await setRole(db, { teamId, userId: "u2", role: "admin" });
      const members = await listTeamMembers(db, teamId);
      expect(members.find((m) => m.userId === "u2")?.role).toBe("admin");

      await removeMember(db, { teamId, userId: "u3" });
      expect(await listTeamMembers(db, teamId)).toHaveLength(2);
    });
  });

  it("createTeam still reports a conflict when a row was inserted outside the service's own check", async () => {
    // Inserts directly (bypassing createTeam's pre-check) to simulate a
    // conflicting row appearing between an out-of-band check and the
    // transaction — the `teams_org_name` unique index is the real backstop,
    // and a violation must map to TeamNameConflictError, not a raw 500.
    await db.insert(teams).values({ id: "team_preexisting", orgId, name: "Platform", createdAt: Date.now() });

    await expect(createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" })).rejects.toThrow(
      TeamNameConflictError,
    );
  });
});

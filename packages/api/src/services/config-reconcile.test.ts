/**
 * Boot-time instance config reconciler — org pass tests.
 *
 * Harness: shared PGlite AppDb + migrations, mirroring skill-sources.test.ts.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { eq, and, like } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { actionPolicies, invites, llmProviders, orgMembers, orgs, contentSources, skills, teams, teamMembers, users } from "../schema/index.js";
import { ensureOrg } from "./org.js";
import {
  reconcileInstanceConfig,
  configInviteId,
  configSkillSourceId,
  configTeamId,
  configProviderId,
  configPolicyId,
  type ReconcileDeps,
} from "./config-reconcile.js";
import { InstanceConfigError, type InstanceConfig } from "../config/instance-config.js";
import { findDefaultAssistant } from "../assistants/service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedUser(db: AppDb, id: string, email: string) {
  await db.insert(users).values({ id, email, name: id, role: "member" });
}

function deps(db: AppDb): ReconcileDeps {
  return { db };
}

// ---------------------------------------------------------------------------
// Id helper tests
// ---------------------------------------------------------------------------

describe("id helpers", () => {
  it("configInviteId produces the expected prefix and 12-char hex suffix", () => {
    const id = configInviteId("alice@example.com");
    expect(id).toMatch(/^invite_cfg_[0-9a-f]{12}$/);
  });

  it("configInviteId is deterministic", () => {
    expect(configInviteId("bob@example.com")).toBe(configInviteId("bob@example.com"));
  });

  it("configSkillSourceId produces the expected prefix and includes owner", () => {
    const id = configSkillSourceId("org", "org_1", "owner/repo", "main", "skills");
    expect(id).toMatch(/^skillsrc_cfg_[0-9a-f]{12}$/);
    expect(id).toBe(configSkillSourceId("org", "org_1", "owner/repo", "main", "skills"));
    expect(id).not.toBe(configSkillSourceId("team", "team_1", "owner/repo", "main", "skills"));
  });

  it("configTeamId produces the expected prefix", () => {
    const id = configTeamId("Engineering");
    expect(id).toMatch(/^team_cfg_[0-9a-f]{12}$/);
    expect(id).toBe(configTeamId("Engineering"));
  });

  it("configProviderId produces the expected prefix", () => {
    const id = configProviderId("my-provider");
    expect(id).toMatch(/^prov_cfg_[0-9a-f]{12}$/);
    expect(id).toBe(configProviderId("my-provider"));
  });
});

// ---------------------------------------------------------------------------
// Org pass tests
// ---------------------------------------------------------------------------

describe("reconcileInstanceConfig — org pass", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
  });

  it("empty org section (no org key) is a no-op — ensureOrg creates the org", async () => {
    const cfg: InstanceConfig = { version: 1 };
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select().from(orgs);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("My organization");
  });

  it("org.name renames the org", async () => {
    const cfg: InstanceConfig = { version: 1, org: { name: "Acme Corp" } };
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select({ name: orgs.name }).from(orgs);
    expect(rows[0]!.name).toBe("Acme Corp");
  });

  it("org.features merges keys, preserving undeclared existing flags", async () => {
    // Seed an org with an existing feature flag.
    const org = await ensureOrg(db);
    await db.update(orgs).set({ features: { organizations: true, legacy: true } }).where(eq(orgs.id, org.id));

    // Config only declares `organizations: false` — legacy must survive.
    const cfg: InstanceConfig = { version: 1, org: { features: { organizations: false } } };
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select({ features: orgs.features }).from(orgs);
    const features = rows[0]!.features as Record<string, boolean>;
    expect(features["organizations"]).toBe(false);
    expect(features["legacy"]).toBe(true);
  });

  it("auth.sso.teams.groups overwrites the stored allowlist, and says so when it changes", async () => {
    // Settings writes the same column, so the same file-wins rule and the
    // same boot line apply as for org.features.
    const org = await ensureOrg(db);
    await db.update(orgs).set({ ssoTeamGroups: ["/settings-made"] }).where(eq(orgs.id, org.id));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cfg: InstanceConfig = {
        version: 1,
        auth: { sso: { teams: { groups: ["/platform", "/research"] } } },
      };
      await reconcileInstanceConfig(deps(db), cfg);

      const rows = await db.select({ ssoTeamGroups: orgs.ssoTeamGroups }).from(orgs);
      expect(rows[0]!.ssoTeamGroups).toEqual(["/platform", "/research"]);
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes("auth.sso.teams.groups"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("a duplicate declared group neither changes the column nor re-prints the boot line", async () => {
    // The column always holds the NORMALIZED list, so the comparison must
    // normalize the declared list too. Compared raw, a duplicate in the
    // file makes the lengths differ forever, and the "file wins" line
    // prints at every boot with nothing actually changing.
    const org = await ensureOrg(db);
    await db.update(orgs).set({ ssoTeamGroups: ["/platform"] }).where(eq(orgs.id, org.id));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cfg: InstanceConfig = {
        version: 1,
        auth: { sso: { teams: { groups: ["/platform", "/platform"] } } },
      };
      await reconcileInstanceConfig(deps(db), cfg);

      const rows = await db.select({ ssoTeamGroups: orgs.ssoTeamGroups }).from(orgs);
      expect(rows[0]!.ssoTeamGroups).toEqual(["/platform"]);
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes("auth.sso.teams.groups"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("an undeclared auth.sso.teams.groups leaves the Settings-made allowlist alone", async () => {
    const org = await ensureOrg(db);
    await db.update(orgs).set({ ssoTeamGroups: ["/settings-made"] }).where(eq(orgs.id, org.id));

    const cfg: InstanceConfig = { version: 1 };
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select({ ssoTeamGroups: orgs.ssoTeamGroups }).from(orgs);
    expect(rows[0]!.ssoTeamGroups).toEqual(["/settings-made"]);
  });

  it("names the file when a declared feature overrides the stored value", async () => {
    // The Settings page writes the same column, so an admin who turns a
    // feature off there sees it come back at the next boot. The file wins by
    // design; the boot line is what lets the reader work out why.
    const org = await ensureOrg(db);
    await db.update(orgs).set({ features: { ssoTeamSync: false } }).where(eq(orgs.id, org.id));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cfg: InstanceConfig = { version: 1, org: { features: { ssoTeamSync: true } } };
      await reconcileInstanceConfig({ db, configPath: "/etc/valet.yaml" }, cfg);

      const lines = warn.mock.calls.map((call) => String(call[0]));
      const line = lines.find((text) => text.includes("org.features.ssoTeamSync"));
      expect(line).toContain("/etc/valet.yaml");
      expect(line).toContain("remove the key from that file");
    } finally {
      warn.mockRestore();
    }
  });

  it("says nothing when the file agrees with the stored value", async () => {
    // A steady deployment declares the same value at every boot. A line each
    // time would train the reader to ignore the one that matters.
    const org = await ensureOrg(db);
    await db.update(orgs).set({ features: { ssoTeamSync: true } }).where(eq(orgs.id, org.id));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cfg: InstanceConfig = { version: 1, org: { features: { ssoTeamSync: true } } };
      await reconcileInstanceConfig({ db, configPath: "/etc/valet.yaml" }, cfg);

      const lines = warn.mock.calls.map((call) => String(call[0]));
      expect(lines.filter((text) => text.includes("org.features."))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("org.bareSkillCommands sets the column", async () => {
    const cfg: InstanceConfig = { version: 1, org: { bareSkillCommands: true } };
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select({ bsc: orgs.bareSkillCommands }).from(orgs);
    expect(rows[0]!.bsc).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Members — existing user path
  // ---------------------------------------------------------------------------

  it("declared member with existing user inserts org_members row", async () => {
    await ensureOrg(db);
    await seedUser(db, "u1", "alice@example.com");

    const cfg: InstanceConfig = {
      version: 1,
      org: { members: [{ email: "alice@example.com", role: "member" }] },
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select().from(orgMembers).where(eq(orgMembers.userId, "u1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("member");
  });

  it("role change applies when user already has an org_members row", async () => {
    const org = await ensureOrg(db);
    await seedUser(db, "u1", "alice@example.com");
    // Seed as admin first.
    await db.insert(users).values({ id: "u2", email: "bob@example.com", name: "bob", role: "member" });
    await db.insert(orgMembers).values({ orgId: org.id, userId: "u2", role: "admin", createdAt: Date.now() });
    await db.insert(orgMembers).values({ orgId: org.id, userId: "u1", role: "admin", createdAt: Date.now() });

    // Demote u1 from admin → member (u2 remains admin so not last-admin).
    const cfg: InstanceConfig = {
      version: 1,
      org: { members: [{ email: "alice@example.com", role: "member" }] },
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select().from(orgMembers).where(eq(orgMembers.userId, "u1"));
    expect(rows[0]!.role).toBe("member");
  });

  it("demoting the sole admin throws LAST_ADMIN_ERROR", async () => {
    const org = await ensureOrg(db);
    await seedUser(db, "u1", "alice@example.com");
    // Only admin.
    await db.insert(orgMembers).values({ orgId: org.id, userId: "u1", role: "admin", createdAt: Date.now() });

    const cfg: InstanceConfig = {
      version: 1,
      org: { members: [{ email: "alice@example.com", role: "member" }] },
    };
    await expect(reconcileInstanceConfig(deps(db), cfg)).rejects.toThrow(
      "org.members would leave the organization with no admin",
    );
  });

  // ---------------------------------------------------------------------------
  // Members — unknown email / invite path
  // ---------------------------------------------------------------------------

  it("unknown email creates invite_cfg_* invite row with 10-year expiry", async () => {
    await ensureOrg(db);

    const cfg: InstanceConfig = {
      version: 1,
      org: { members: [{ email: "unknown@example.com", role: "admin" }] },
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const expectedId = configInviteId("unknown@example.com");
    const rows = await db.select().from(invites).where(eq(invites.id, expectedId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.email).toBe("unknown@example.com");
    expect(row.role).toBe("admin");
    expect(row.createdBy).toBe("config");
    expect(row.acceptedBy).toBeNull();

    // 10-year expiry: within ±60 seconds of 10*365*24*3600*1000ms from now.
    const tenYearsMs = 10 * 365 * 24 * 3600_000;
    const expiresAtMs = row.expiresAt.getTime();
    expect(expiresAtMs).toBeGreaterThan(Date.now() + tenYearsMs - 60_000);
    expect(expiresAtMs).toBeLessThan(Date.now() + tenYearsMs + 60_000);
  });

  it("second reconcile run on same unknown email is a no-op (same row id, role unchanged)", async () => {
    await ensureOrg(db);

    const cfg: InstanceConfig = {
      version: 1,
      org: { members: [{ email: "unknown@example.com", role: "member" }] },
    };
    await reconcileInstanceConfig(deps(db), cfg);
    await reconcileInstanceConfig(deps(db), cfg);

    const expectedId = configInviteId("unknown@example.com");
    const rows = await db.select().from(invites).where(eq(invites.id, expectedId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("member");
  });

  it("second run updates role on unaccepted config invite when role changes", async () => {
    await ensureOrg(db);

    const cfg1: InstanceConfig = {
      version: 1,
      org: { members: [{ email: "unknown@example.com", role: "member" }] },
    };
    await reconcileInstanceConfig(deps(db), cfg1);

    const cfg2: InstanceConfig = {
      version: 1,
      org: { members: [{ email: "unknown@example.com", role: "admin" }] },
    };
    await reconcileInstanceConfig(deps(db), cfg2);

    const expectedId = configInviteId("unknown@example.com");
    const rows = await db.select().from(invites).where(eq(invites.id, expectedId));
    expect(rows[0]!.role).toBe("admin");
  });

  it("removing an email deletes the unaccepted config invite", async () => {
    await ensureOrg(db);

    const cfg1: InstanceConfig = {
      version: 1,
      org: { members: [{ email: "unknown@example.com", role: "member" }] },
    };
    await reconcileInstanceConfig(deps(db), cfg1);

    // Remove the member from config.
    const cfg2: InstanceConfig = { version: 1, org: { members: [] } };
    await reconcileInstanceConfig(deps(db), cfg2);

    const expectedId = configInviteId("unknown@example.com");
    const rows = await db.select().from(invites).where(eq(invites.id, expectedId));
    expect(rows).toHaveLength(0);
  });

  it("does not delete an accepted config invite when the email is removed", async () => {
    await ensureOrg(db);

    const cfg1: InstanceConfig = {
      version: 1,
      org: { members: [{ email: "accepted@example.com", role: "member" }] },
    };
    await reconcileInstanceConfig(deps(db), cfg1);

    // Mark the config invite as accepted.
    const expectedId = configInviteId("accepted@example.com");
    await db
      .update(invites)
      .set({ acceptedBy: "some-user-id", acceptedAt: new Date() })
      .where(eq(invites.id, expectedId));

    // Remove from config.
    const cfg2: InstanceConfig = { version: 1, org: { members: [] } };
    await reconcileInstanceConfig(deps(db), cfg2);

    const rows = await db.select().from(invites).where(eq(invites.id, expectedId));
    expect(rows).toHaveLength(1);
  });

  it("does not delete a UI invite (invite_<uuid> prefix) when managing config invites", async () => {
    await ensureOrg(db);

    // Insert a UI invite manually.
    const uiInviteId = `invite_deadbeef-1234-5678-abcd-000000000001`;
    await db.insert(invites).values({
      id: uiInviteId,
      codeHash: "ui_code_hash_unique_value_xyz",
      email: "ui-user@example.com",
      role: "member",
      createdBy: "some-admin",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
    });

    // Config declares no members — should only sweep invite_cfg_* rows.
    const cfg: InstanceConfig = { version: 1, org: { members: [] } };
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select().from(invites).where(eq(invites.id, uiInviteId));
    expect(rows).toHaveLength(1);
  });

  it("full reconcile is idempotent for existing user members", async () => {
    const org = await ensureOrg(db);
    await seedUser(db, "u1", "alice@example.com");

    const cfg: InstanceConfig = {
      version: 1,
      org: { members: [{ email: "alice@example.com", role: "member" }] },
    };
    await reconcileInstanceConfig(deps(db), cfg);
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db
      .select()
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, "u1")));
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Teams pass tests
// ---------------------------------------------------------------------------

describe("reconcileInstanceConfig — teams pass", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
  });

  it("marks a team it creates as config-owned", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      teams: [{ name: "Engineering" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);

    // `origin`, not the id, is what says who owns this row. The id stays
    // deterministic because a legible id is free, but nothing keys on it —
    // an adopted team keeps the id it was born with (next test).
    const rows = await db.select().from(teams).where(eq(teams.name, "Engineering"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.origin).toBe("config");
    expect(rows[0]!.id).toBe(configTeamId("Engineering"));
  });

  it("seeds the default assistant of a team it creates", async () => {
    // Every `/chat` affordance for a team keys off "the team owns an
    // assistant" (TKAI-337). A declared team is inserted here, not through
    // `createTeam`, so it has to seed the default itself.
    const org = await ensureOrg(db);
    const cfg: InstanceConfig = {
      version: 1,
      teams: [{ name: "Engineering" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const teamId = configTeamId("Engineering");
    const seeded = await findDefaultAssistant(db, org.id, { type: "team", id: teamId });
    expect(seeded).toBeDefined();
    expect(seeded?.archivedAt).toBeNull();
  });

  it("adopts an existing UI team, keeping its id and promoting its origin", async () => {
    const org = await ensureOrg(db);
    // Insert a UI team with a different id but the same name.
    const uiTeamId = "team_ui_deadbeef";
    await db.insert(teams).values({ id: uiTeamId, orgId: org.id, name: "Engineering", createdAt: Date.now() });

    const cfg: InstanceConfig = {
      version: 1,
      teams: [{ name: "Engineering" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);

    // The UI team id must be unchanged.
    const allRows = await db.select().from(teams).where(eq(teams.name, "Engineering"));
    expect(allRows).toHaveLength(1);
    expect(allRows[0]!.id).toBe(uiTeamId);
    // Promoted: the file now asserts this team's members at every boot, so a
    // row left at `local` would make `origin` answer the wrong question.
    expect(allRows[0]!.origin).toBe("config");
  });

  it("refuses to adopt a team that mirrors an identity-provider group", async () => {
    const org = await ensureOrg(db);
    await db.insert(teams).values({
      id: "team_mirror",
      orgId: org.id,
      name: "Engineering",
      origin: "idp",
      externalId: "/Engineering",
      createdAt: Date.now(),
    });

    const cfg: InstanceConfig = {
      version: 1,
      teams: [{ name: "Engineering", members: [{ email: "alice@example.com", role: "admin" }] }],
    };

    // Boot must fail. Adoption would hand a group's membership to the file
    // while the login sync still removes whoever the claim omits.
    await expect(reconcileInstanceConfig(deps(db), cfg)).rejects.toThrow(InstanceConfigError);
    await expect(reconcileInstanceConfig(deps(db), cfg)).rejects.toThrow(
      /already the mirror of identity provider group "\/Engineering"/,
    );

    // The mirrored row is untouched — not promoted, not re-owned.
    const rows = await db.select().from(teams).where(eq(teams.name, "Engineering"));
    expect(rows[0]!.origin).toBe("idp");
  });

  it("demotes a config team to local when the file stops declaring it", async () => {
    const declared: InstanceConfig = { version: 1, teams: [{ name: "Engineering" }] };
    await reconcileInstanceConfig(deps(db), declared);

    // Next boot, the team is gone from the file.
    const withoutIt: InstanceConfig = { version: 1, teams: [] };
    await reconcileInstanceConfig(deps(db), withoutIt);

    // Released, never destroyed: the row and its members survive.
    const rows = await db.select().from(teams).where(eq(teams.name, "Engineering"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.origin).toBe("local");
  });

  it("keeps a config team's members when it demotes the team", async () => {
    const org = await ensureOrg(db);
    await seedUser(db, "u-keep", "keep@example.com");
    await db
      .insert(orgMembers)
      .values({ orgId: org.id, userId: "u-keep", role: "member", createdAt: Date.now() });

    await reconcileInstanceConfig(deps(db), {
      version: 1,
      teams: [{ name: "Engineering", members: [{ email: "keep@example.com", role: "admin" }] }],
    });
    await reconcileInstanceConfig(deps(db), { version: 1, teams: [] });

    const rows = await db.select().from(teamMembers).where(eq(teamMembers.userId, "u-keep"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("admin");
  });

  it("adds a declared member to an existing team", async () => {
    const org = await ensureOrg(db);
    await seedUser(db, "u1", "alice@example.com");
    await db.insert(orgMembers).values({ orgId: org.id, userId: "u1", role: "member", createdAt: Date.now() });

    const cfg: InstanceConfig = {
      version: 1,
      teams: [{ name: "Engineering", members: [{ email: "alice@example.com", role: "member" }] }],
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const teamId = configTeamId("Engineering");
    const memberRows = await db.select().from(teamMembers).where(eq(teamMembers.teamId, teamId));
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]!.userId).toBe("u1");
  });

  it("skips member whose email has no user (run succeeds)", async () => {
    await ensureOrg(db);

    const cfg: InstanceConfig = {
      version: 1,
      teams: [{ name: "Engineering", members: [{ email: "ghost@example.com", role: "member" }] }],
    };
    // Must not throw.
    await expect(reconcileInstanceConfig(deps(db), cfg)).resolves.toBeUndefined();

    const teamId = configTeamId("Engineering");
    const memberRows = await db.select().from(teamMembers).where(eq(teamMembers.teamId, teamId));
    expect(memberRows).toHaveLength(0);
  });

  it("skips member who is not an org member", async () => {
    await ensureOrg(db);
    // User exists but has no org_members row.
    await seedUser(db, "u1", "alice@example.com");

    const cfg: InstanceConfig = {
      version: 1,
      teams: [{ name: "Engineering", members: [{ email: "alice@example.com", role: "member" }] }],
    };
    await expect(reconcileInstanceConfig(deps(db), cfg)).resolves.toBeUndefined();

    const teamId = configTeamId("Engineering");
    const memberRows = await db.select().from(teamMembers).where(eq(teamMembers.teamId, teamId));
    expect(memberRows).toHaveLength(0);
  });

  it("updates an existing team_members role", async () => {
    const org = await ensureOrg(db);
    await seedUser(db, "u1", "alice@example.com");
    await db.insert(orgMembers).values({ orgId: org.id, userId: "u1", role: "admin", createdAt: Date.now() });

    // First run: add as member.
    const cfg1: InstanceConfig = {
      version: 1,
      teams: [{ name: "Engineering", members: [{ email: "alice@example.com", role: "member" }] }],
    };
    await reconcileInstanceConfig(deps(db), cfg1);

    // Second run: promote to admin.
    const cfg2: InstanceConfig = {
      version: 1,
      teams: [{ name: "Engineering", members: [{ email: "alice@example.com", role: "admin" }] }],
    };
    await reconcileInstanceConfig(deps(db), cfg2);

    const teamId = configTeamId("Engineering");
    const memberRows = await db.select().from(teamMembers).where(eq(teamMembers.teamId, teamId));
    expect(memberRows[0]!.role).toBe("admin");
  });

  it("second run is idempotent — no duplicate team or member rows", async () => {
    const org = await ensureOrg(db);
    await seedUser(db, "u1", "alice@example.com");
    await db.insert(orgMembers).values({ orgId: org.id, userId: "u1", role: "member", createdAt: Date.now() });

    const cfg: InstanceConfig = {
      version: 1,
      teams: [{ name: "Engineering", members: [{ email: "alice@example.com", role: "member" }] }],
    };
    await reconcileInstanceConfig(deps(db), cfg);
    await reconcileInstanceConfig(deps(db), cfg);

    const teamRows = await db.select().from(teams).where(eq(teams.name, "Engineering"));
    expect(teamRows).toHaveLength(1);

    const teamId = configTeamId("Engineering");
    const memberRows = await db.select().from(teamMembers).where(eq(teamMembers.teamId, teamId));
    expect(memberRows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// LLM providers pass tests
// ---------------------------------------------------------------------------

describe("reconcileInstanceConfig — llmProviders pass", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
  });

  it("creates a known-kind provider row on first run", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      llmProviders: [{ kind: "anthropic" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select().from(llmProviders).where(eq(llmProviders.kind, "anthropic"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enabled).toBe(true);
    expect(rows[0]!.name).toBe("anthropic");
  });

  it("updates an existing known-kind provider on second run with changed fields", async () => {
    const cfg1: InstanceConfig = {
      version: 1,
      llmProviders: [{ kind: "openai", name: "OpenAI", enabled: true }],
    };
    await reconcileInstanceConfig(deps(db), cfg1);

    const cfg2: InstanceConfig = {
      version: 1,
      llmProviders: [{ kind: "openai", name: "OpenAI Disabled", enabled: false }],
    };
    await reconcileInstanceConfig(deps(db), cfg2);

    const rows = await db.select().from(llmProviders).where(eq(llmProviders.kind, "openai"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enabled).toBe(false);
    expect(rows[0]!.name).toBe("OpenAI Disabled");
  });

  it("known-kind provider second run is a no-op (same row)", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      llmProviders: [{ kind: "google" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select().from(llmProviders).where(eq(llmProviders.kind, "google"));
    expect(rows).toHaveLength(1);
  });

  it("creates openai_compatible provider with deterministic id keyed by name", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      llmProviders: [
        {
          kind: "openai_compatible",
          name: "my-llm",
          baseUrl: "https://api.example.com/v1",
          models: [{ id: "model-1", name: "Model One" }],
        },
      ],
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const expectedId = configProviderId("my-llm");
    const rows = await db.select().from(llmProviders).where(eq(llmProviders.id, expectedId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("my-llm");
    expect(rows[0]!.baseUrl).toBe("https://api.example.com/v1");
  });

  it("second run on openai_compatible provider with same name is a no-op", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      llmProviders: [{ kind: "openai_compatible", name: "my-llm", baseUrl: "https://api.example.com/v1" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);
    await reconcileInstanceConfig(deps(db), cfg);

    const expectedId = configProviderId("my-llm");
    const rows = await db.select().from(llmProviders).where(eq(llmProviders.id, expectedId));
    expect(rows).toHaveLength(1);
  });

  it("never deletes a provider row even when removed from config", async () => {
    const cfg1: InstanceConfig = {
      version: 1,
      llmProviders: [{ kind: "anthropic" }],
    };
    await reconcileInstanceConfig(deps(db), cfg1);

    const cfg2: InstanceConfig = { version: 1 };
    await reconcileInstanceConfig(deps(db), cfg2);

    const rows = await db.select().from(llmProviders).where(eq(llmProviders.kind, "anthropic"));
    expect(rows).toHaveLength(1);
  });

  it("creates a known-kind provider with enabled: false on first run (disabled immediately)", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      llmProviders: [{ kind: "openrouter", enabled: false }],
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select().from(llmProviders).where(eq(llmProviders.kind, "openrouter"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Skill sources pass tests
// ---------------------------------------------------------------------------

describe("reconcileInstanceConfig — contentSources pass", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
  });

  it("inserts a declared source with org ownership and pending status", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      skillSources: [{ repo: "owner/repo", ref: "main", subpath: "skills" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const expectedId = configSkillSourceId("org", (await ensureOrg(db)).id, "owner/repo", "main", "skills");
    const rows = await db.select().from(contentSources).where(eq(contentSources.id, expectedId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.ownerType).toBe("org");
    expect(row.status).toBe("pending");
    expect(row.enabled).toBe(true);
    expect(row.nextAttemptAt).toBeLessThanOrEqual(Date.now());
  });

  it("does not punch a live claim lease on a never-synced config row", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      skillSources: [{ repo: "owner/repo" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);
    const id = configSkillSourceId("org", (await ensureOrg(db)).id, "owner/repo", "", "");
    const claimedUntil = Date.now() + 60_000;
    await db
      .update(contentSources)
      .set({ nextAttemptAt: claimedUntil, status: "pending", lastSyncedAt: null })
      .where(eq(contentSources.id, id));

    await reconcileInstanceConfig(deps(db), cfg);

    const [row] = await db.select().from(contentSources).where(eq(contentSources.id, id));
    expect(row?.nextAttemptAt).toBe(claimedUntil);
  });

  it("kicks a dead never-synced pending claim", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      skillSources: [{ repo: "owner/repo" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);
    const id = configSkillSourceId("org", (await ensureOrg(db)).id, "owner/repo", "", "");
    const claimedUntil = Date.now() + 60_000;
    await db
      .update(contentSources)
      .set({
        nextAttemptAt: claimedUntil,
        status: "pending",
        lastSyncedAt: null,
        updatedAt: Date.now() - 6 * 60_000,
      })
      .where(eq(contentSources.id, id));

    await reconcileInstanceConfig(deps(db), cfg);

    const [row] = await db.select().from(contentSources).where(eq(contentSources.id, id));
    expect(row?.nextAttemptAt).toBeLessThanOrEqual(Date.now());
  });

  it("leaves a synced config row's schedule alone", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      skillSources: [{ repo: "owner/repo" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);
    const id = configSkillSourceId("org", (await ensureOrg(db)).id, "owner/repo", "", "");
    const nextAttemptAt = Date.now() + 120_000;
    await db
      .update(contentSources)
      .set({
        nextAttemptAt,
        status: "pending",
        lastSyncedAt: Date.now(),
        updatedAt: Date.now() - 6 * 60_000,
      })
      .where(eq(contentSources.id, id));

    await reconcileInstanceConfig(deps(db), cfg);

    const [row] = await db.select().from(contentSources).where(eq(contentSources.id, id));
    expect(row?.nextAttemptAt).toBe(nextAttemptAt);
    expect(row?.lastSyncedAt).not.toBeNull();
  });

  it("does not reset an error row's retry backoff", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      skillSources: [{ repo: "owner/repo" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);
    const id = configSkillSourceId("org", (await ensureOrg(db)).id, "owner/repo", "", "");
    const backoffUntil = Date.now() + 600_000;
    await db
      .update(contentSources)
      .set({
        nextAttemptAt: backoffUntil,
        status: "error",
        lastSyncedAt: null,
        lastError: "GitHub returned 502",
        attempts: 2,
        updatedAt: Date.now() - 6 * 60_000,
      })
      .where(eq(contentSources.id, id));

    await reconcileInstanceConfig(deps(db), cfg);

    const [row] = await db.select().from(contentSources).where(eq(contentSources.id, id));
    expect(row?.nextAttemptAt).toBe(backoffUntil);
    expect(row?.status).toBe("error");
    expect(row?.attempts).toBe(2);
  });

  it("second run on same source is a no-op", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      skillSources: [{ repo: "owner/repo" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);
    const id = configSkillSourceId("org", (await ensureOrg(db)).id, "owner/repo", "", "");
    const future = Date.now() + 60_000;
    await db
      .update(contentSources)
      .set({ nextAttemptAt: future, lastSyncedAt: Date.now(), status: "ok" })
      .where(eq(contentSources.id, id));

    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select().from(contentSources);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.nextAttemptAt).toBe(future);
  });

  it("does not reset nextAttemptAt on an error row with backoff", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      skillSources: [{ repo: "owner/repo" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);
    const id = configSkillSourceId("org", (await ensureOrg(db)).id, "owner/repo", "", "");
    const future = Date.now() + 120_000;
    await db
      .update(contentSources)
      .set({ nextAttemptAt: future, lastSyncedAt: null, status: "error" })
      .where(eq(contentSources.id, id));

    await reconcileInstanceConfig(deps(db), cfg);

    const [row] = await db.select().from(contentSources).where(eq(contentSources.id, id));
    expect(row?.nextAttemptAt).toBe(future);
  });

  it("skips and warns when an unmanaged row already tracks the same repo+subpath", async () => {
    const org = await ensureOrg(db);
    // Insert an unmanaged (non-cfg_) row for the same repo.
    await db.insert(contentSources).values({
      id: "skillsrc_unmanaged_abc",
      orgId: org.id,
      ownerType: "org",
      ownerId: org.id,
      repoFullName: "owner/repo",
      ref: "",
      subpath: "",
      enabled: true,
      status: "pending",
      attempts: 0,
      nextAttemptAt: Date.now(),
      lastSha: null,
      lastManifestHash: null,
      lastSyncedAt: null,
      lastError: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const cfg: InstanceConfig = {
      version: 1,
      skillSources: [{ repo: "owner/repo" }],
    };
    await expect(reconcileInstanceConfig(deps(db), cfg)).resolves.toBeUndefined();

    // Should not have inserted a managed row.
    const managedRows = await db
      .select()
      .from(contentSources)
      .where(like(contentSources.id, "skillsrc_cfg_%"));
    expect(managedRows).toHaveLength(0);
  });

  it("removes a managed source and its repo-origin skills when removed from config", async () => {
    const org = await ensureOrg(db);
    const srcId = configSkillSourceId("org", org.id, "owner/repo", "", "");

    // Insert the managed source directly.
    await db.insert(contentSources).values({
      id: srcId,
      orgId: org.id,
      ownerType: "org",
      ownerId: org.id,
      repoFullName: "owner/repo",
      ref: "",
      subpath: "",
      enabled: true,
      status: "pending",
      attempts: 0,
      nextAttemptAt: Date.now(),
      lastSha: null,
      lastManifestHash: null,
      lastSyncedAt: null,
      lastError: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Insert a mirrored repo skill.
    await db.insert(skills).values({
      id: "skill_test_1",
      orgId: org.id,
      ownerType: "org",
      ownerId: org.id,
      origin: "repo",
      sourceId: srcId,
      name: "test-skill",
      description: "A test skill",
      content: "content",
      frontmatter: {},
      contentSha: "abc123",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Config now declares no skill sources.
    const cfg: InstanceConfig = { version: 1, skillSources: [] };
    await reconcileInstanceConfig(deps(db), cfg);

    // Source and its skills should be gone.
    const srcRows = await db.select().from(contentSources).where(eq(contentSources.id, srcId));
    expect(srcRows).toHaveLength(0);

    const skillRows = await db.select().from(skills).where(eq(skills.sourceId, srcId));
    expect(skillRows).toHaveLength(0);
  });

  it("does not remove an unmanaged source even when contentSources is empty", async () => {
    const org = await ensureOrg(db);
    // Insert an unmanaged source.
    await db.insert(contentSources).values({
      id: "skillsrc_ui_abc123",
      orgId: org.id,
      ownerType: "org",
      ownerId: org.id,
      repoFullName: "owner/repo2",
      ref: "",
      subpath: "",
      enabled: true,
      status: "pending",
      attempts: 0,
      nextAttemptAt: Date.now(),
      lastSha: null,
      lastManifestHash: null,
      lastSyncedAt: null,
      lastError: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const cfg: InstanceConfig = { version: 1, skillSources: [] };
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select().from(contentSources).where(eq(contentSources.id, "skillsrc_ui_abc123"));
    expect(rows).toHaveLength(1);
  });

  it("full second run with all three passes is a no-op", async () => {
    const org = await ensureOrg(db);
    await seedUser(db, "u1", "alice@example.com");
    await db.insert(orgMembers).values({ orgId: org.id, userId: "u1", role: "member", createdAt: Date.now() });

    const cfg: InstanceConfig = {
      version: 1,
      teams: [{ name: "Engineering", members: [{ email: "alice@example.com", role: "member" }] }],
      llmProviders: [{ kind: "anthropic" }],
      skillSources: [{ repo: "owner/repo", ref: "main", subpath: "" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);
    await reconcileInstanceConfig(deps(db), cfg);

    const teamRows = await db.select().from(teams);
    expect(teamRows).toHaveLength(1);

    const providerRows = await db.select().from(llmProviders);
    expect(providerRows).toHaveLength(1);

    const sourceRows = await db.select().from(contentSources);
    expect(sourceRows).toHaveLength(1);
  });

  it("URL-variant duplicate (raw strings differ, same repo+subpath) throws a clean error with no partial insert", async () => {
    await ensureOrg(db);
    // `obra/superpowers` and its full https .git URL normalize to the same
    // (repoFullName, subpath) but differ as raw strings, so the validator's
    // raw-string dedupe misses them. The reconciler must reject before insert.
    const cfg: InstanceConfig = {
      version: 1,
      skillSources: [
        { repo: "obra/superpowers", subpath: "skills" },
        { repo: "https://github.com/obra/superpowers.git", subpath: "skills" },
      ],
    };
    await expect(reconcileInstanceConfig(deps(db), cfg)).rejects.toThrow(
      "a source can track only one ref",
    );

    // No partial write — neither entry landed a row.
    const rows = await db.select().from(contentSources).where(like(contentSources.id, "skillsrc_cfg_%"));
    expect(rows).toHaveLength(0);
  });

  it("scopes a source to a named team and fails boot when that team is missing", async () => {
    await seedUser(db, "u1", "alice@example.com");
    await seedUser(db, "u2", "bob@example.com");
    const cfg: InstanceConfig = {
      version: 1,
      org: {
        members: [
          { email: "alice@example.com", role: "admin" },
          { email: "bob@example.com", role: "member" },
        ],
      },
      teams: [{ name: "Platform", members: [{ email: "alice@example.com", role: "admin" }] }],
      skillSources: [{ repo: "owner/repo", subpath: "platform", team: "Platform" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const org = await ensureOrg(db);
    const [team] = await db.select().from(teams).where(eq(teams.name, "Platform"));
    expect(team).toBeDefined();
    const rows = await db.select().from(contentSources).where(like(contentSources.id, "skillsrc_cfg_%"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ownerType).toBe("team");
    expect(rows[0]?.ownerId).toBe(team!.id);
    expect(rows[0]?.id).toBe(
      configSkillSourceId("team", team!.id, "owner/repo", "", "platform"),
    );

    await db.insert(skills).values({
      id: "skill_team_reach",
      orgId: org.id,
      ownerType: "team",
      ownerId: team!.id,
      origin: "repo",
      sourceId: rows[0]!.id,
      name: "team-skill",
      description: "Team skill.",
      content: "# Team\n",
      frontmatter: {},
      contentSha: "abc",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const { listSkills } = await import("./skills.js");
    const member = await listSkills(db, { userId: "u1", orgId: org.id });
    const outsider = await listSkills(db, { userId: "u2", orgId: org.id });
    expect(member.map((s) => s.name)).toEqual(["team-skill"]);
    expect(outsider).toEqual([]);

    await expect(
      reconcileInstanceConfig(deps(db), {
        version: 1,
        skillSources: [{ repo: "owner/repo", team: "Missing" }],
      }),
    ).rejects.toThrow(/names team "Missing"/);
  });

  it("lets two teams track the same repo and same subpath and prunes only the removed config row", async () => {
    await seedUser(db, "u1", "alice@example.com");
    const cfg: InstanceConfig = {
      version: 1,
      org: { members: [{ email: "alice@example.com", role: "admin" }] },
      teams: [
        { name: "Platform", members: [{ email: "alice@example.com", role: "admin" }] },
        { name: "Design", members: [{ email: "alice@example.com", role: "admin" }] },
      ],
      skillSources: [
        { repo: "owner/mono", subpath: "skills", team: "Platform" },
        { repo: "owner/mono", subpath: "skills", team: "Design" },
      ],
    };
    await reconcileInstanceConfig(deps(db), cfg);
    await reconcileInstanceConfig(deps(db), cfg);

    const [platform] = await db.select().from(teams).where(eq(teams.name, "Platform"));
    const [design] = await db.select().from(teams).where(eq(teams.name, "Design"));
    expect(platform).toBeDefined();
    expect(design).toBeDefined();
    const first = await db.select().from(contentSources).where(like(contentSources.id, "skillsrc_cfg_%"));
    expect(first).toHaveLength(2);
    expect(new Set(first.map((r) => r.ownerId))).toEqual(new Set([platform!.id, design!.id]));
    expect(new Set(first.map((r) => r.id))).toEqual(
      new Set([
        configSkillSourceId("team", platform!.id, "owner/mono", "", "skills"),
        configSkillSourceId("team", design!.id, "owner/mono", "", "skills"),
      ]),
    );
    expect(first.every((r) => r.subpath === "skills")).toBe(true);

    await reconcileInstanceConfig(deps(db), {
      ...cfg,
      skillSources: [{ repo: "owner/mono", subpath: "skills", team: "Platform" }],
    });

    const after = await db.select().from(contentSources).where(like(contentSources.id, "skillsrc_cfg_%"));
    expect(after).toHaveLength(1);
    expect(after[0]?.ownerId).toBe(platform!.id);
    expect(after[0]?.subpath).toBe("skills");
  });
});

// ---------------------------------------------------------------------------
// Conflict guards — partial prior run / concurrent boot
// ---------------------------------------------------------------------------

describe("reconcileInstanceConfig — conflict guards", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
  });

  it("succeeds when an org_members row for a declared member already exists (partial prior run)", async () => {
    const org = await ensureOrg(db);
    await seedUser(db, "u1", "alice@example.com");
    // Simulate a prior partial reconcile: the org_members row is already
    // present at the same declared role.
    await db.insert(orgMembers).values({ orgId: org.id, userId: "u1", role: "admin", createdAt: Date.now() });

    const cfg: InstanceConfig = {
      version: 1,
      org: { members: [{ email: "alice@example.com", role: "admin" }] },
    };
    await expect(reconcileInstanceConfig(deps(db), cfg)).resolves.toBeUndefined();

    const rows = await db
      .select()
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, "u1")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("admin");
  });

  it("succeeds when a team_members row for a declared member already exists (partial prior run)", async () => {
    const org = await ensureOrg(db);
    await seedUser(db, "u1", "alice@example.com");
    await db.insert(orgMembers).values({ orgId: org.id, userId: "u1", role: "member", createdAt: Date.now() });

    // Pre-create the team and the team_members row at the declared role.
    const teamId = configTeamId("Engineering");
    await db.insert(teams).values({ id: teamId, orgId: org.id, name: "Engineering", createdAt: Date.now() });
    await db.insert(teamMembers).values({ teamId, userId: "u1", role: "member" });

    const cfg: InstanceConfig = {
      version: 1,
      teams: [{ name: "Engineering", members: [{ email: "alice@example.com", role: "member" }] }],
    };
    await expect(reconcileInstanceConfig(deps(db), cfg)).resolves.toBeUndefined();

    const rows = await db.select().from(teamMembers).where(eq(teamMembers.teamId, teamId));
    expect(rows).toHaveLength(1);
  });

  it("succeeds when a config invite row already exists at the declared id (partial prior run)", async () => {
    await ensureOrg(db);
    const inviteId = configInviteId("newcomer@example.com");
    // Pre-insert a config invite row with a stale role.
    await db.insert(invites).values({
      id: inviteId,
      codeHash: "deadbeef",
      email: "newcomer@example.com",
      role: "member",
      createdBy: "config",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const cfg: InstanceConfig = {
      version: 1,
      org: { members: [{ email: "newcomer@example.com", role: "admin" }] },
    };
    await expect(reconcileInstanceConfig(deps(db), cfg)).resolves.toBeUndefined();

    const rows = await db.select().from(invites).where(eq(invites.id, inviteId));
    expect(rows).toHaveLength(1);
    // The onConflictDoUpdate path (or the select/update path) reconciles the role.
    expect(rows[0]!.role).toBe("admin");
  });
});

// ---------------------------------------------------------------------------
// Tool policies pass tests
// ---------------------------------------------------------------------------

describe("configPolicyId", () => {
  it("produces the pol:config: prefix and 12-char hex suffix, keyed by target", () => {
    const id = configPolicyId("service", "github");
    expect(id).toMatch(/^pol:config:[0-9a-f]{12}$/);
    expect(id).toBe(configPolicyId("service", "github"));
  });

  it("distinguishes dimensions for the same value", () => {
    expect(configPolicyId("service", "github")).not.toBe(configPolicyId("action", "github"));
  });
});

describe("reconcileInstanceConfig — toolPolicies pass", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
  });

  async function orgId(): Promise<string> {
    return (await ensureOrg(db)).id;
  }

  it("creates a service-targeted org row with origin/managed_by set", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      toolPolicies: [{ service: "github", mode: "deny" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const id = configPolicyId("service", "github");
    const rows = await db.select().from(actionPolicies).where(eq(actionPolicies.id, id));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.orgId).toBe(await orgId());
    expect(row.principalType).toBe("org");
    expect(row.principalId).toBe(await orgId());
    expect(row.service).toBe("github");
    expect(row.actionId).toBeNull();
    expect(row.riskLevel).toBeNull();
    expect(row.mode).toBe("deny");
    expect(row.appliesIn).toBe("any");
    expect(row.origin).toBe("admin");
    expect(row.managedBy).toBe("config");
    expect(row.paramMatchers).toEqual([]);
    expect(row.expiresAt).toBeNull();
    expect(row.revokedAt).toBeNull();
  });

  it("creates an action-targeted row on the action_id column", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      toolPolicies: [{ action: "github.merge_pull_request", mode: "require_approval", appliesIn: "session" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const id = configPolicyId("action", "github.merge_pull_request");
    const row = (await db.select().from(actionPolicies).where(eq(actionPolicies.id, id)))[0]!;
    expect(row.actionId).toBe("github.merge_pull_request");
    expect(row.service).toBeNull();
    expect(row.riskLevel).toBeNull();
    expect(row.appliesIn).toBe("session");
  });

  it("creates a riskLevel-targeted row on the risk_level column", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      toolPolicies: [{ riskLevel: "critical", mode: "deny" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const id = configPolicyId("risk", "critical");
    const row = (await db.select().from(actionPolicies).where(eq(actionPolicies.id, id)))[0]!;
    expect(row.riskLevel).toBe("critical");
    expect(row.service).toBeNull();
    expect(row.actionId).toBeNull();
  });

  it("is a no-op on a second run — stable ids, no duplicate rows", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      toolPolicies: [{ service: "github", mode: "deny" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db
      .select()
      .from(actionPolicies)
      .where(like(actionPolicies.id, "pol:config:%"));
    expect(rows).toHaveLength(1);
  });

  it("updates the mode in place when a rule's mode changes", async () => {
    await reconcileInstanceConfig(deps(db), {
      version: 1,
      toolPolicies: [{ service: "github", mode: "deny" }],
    });
    await reconcileInstanceConfig(deps(db), {
      version: 1,
      toolPolicies: [{ service: "github", mode: "require_approval" }],
    });

    const id = configPolicyId("service", "github");
    const rows = await db.select().from(actionPolicies).where(eq(actionPolicies.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mode).toBe("require_approval");
    expect(rows[0]!.revokedAt).toBeNull();
  });

  it("soft-revokes a removed rule (keeps the row, stamps revoked_at)", async () => {
    await reconcileInstanceConfig(deps(db), {
      version: 1,
      toolPolicies: [{ service: "github", mode: "deny" }],
    });
    await reconcileInstanceConfig(deps(db), { version: 1, toolPolicies: [] });

    const id = configPolicyId("service", "github");
    const rows = await db.select().from(actionPolicies).where(eq(actionPolicies.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt).not.toBeNull();
  });

  it("resurrects a previously removed rule by clearing revoked_at", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      toolPolicies: [{ service: "github", mode: "deny" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);
    await reconcileInstanceConfig(deps(db), { version: 1, toolPolicies: [] });
    await reconcileInstanceConfig(deps(db), cfg);

    const id = configPolicyId("service", "github");
    const rows = await db.select().from(actionPolicies).where(eq(actionPolicies.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt).toBeNull();
    expect(rows[0]!.mode).toBe("deny");
  });

  it("never touches a UI-created policy row (random id) during the sweep", async () => {
    const org = await orgId();
    const now = Date.now();
    const uiId = randomUUID();
    await db.insert(actionPolicies).values({
      id: uiId,
      orgId: org,
      principalType: "org",
      principalId: org,
      service: "linear",
      actionId: null,
      riskLevel: null,
      mode: "allow",
      paramMatchers: [],
      appliesIn: "any",
      origin: "settings",
      managedBy: null,
      expiresAt: null,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    // A config run declaring a different target must not revoke the UI row.
    await reconcileInstanceConfig(deps(db), {
      version: 1,
      toolPolicies: [{ service: "github", mode: "deny" }],
    });

    const uiRows = await db.select().from(actionPolicies).where(eq(actionPolicies.id, uiId));
    expect(uiRows).toHaveLength(1);
    expect(uiRows[0]!.revokedAt).toBeNull();
  });

  it("leaves action_policies untouched when toolPolicies is absent (unmanaged)", async () => {
    const org = await orgId();
    const now = Date.now();
    const uiId = randomUUID();
    await db.insert(actionPolicies).values({
      id: uiId,
      orgId: org,
      principalType: "org",
      principalId: org,
      service: "github",
      actionId: null,
      riskLevel: null,
      mode: "deny",
      paramMatchers: [],
      appliesIn: "any",
      origin: "settings",
      managedBy: null,
      expiresAt: null,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    await reconcileInstanceConfig(deps(db), { version: 1 });

    const rows = await db.select().from(actionPolicies).where(eq(actionPolicies.id, uiId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt).toBeNull();
  });
});

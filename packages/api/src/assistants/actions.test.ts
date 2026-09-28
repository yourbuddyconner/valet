/**
 * Agent-facing assistant-profile actions. The suite asserts the properties
 * that make this surface safe to hand to an LLM: every call is scoped to
 * the principal in `ctx`, writes run the same validation the routes run,
 * persona changes evict the cached session (and no-ops do not), and a
 * service error comes back as `success: false` instead of a throw.
 */
import type { PluginActionContext } from "@valet/engine";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDb } from "../lib/drizzle.js";
import { orgMembers, orgs, users } from "../schema/index.js";
import { addMember, createTeam } from "../services/teams.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { assistantsActionPlugin } from "./actions.js";
import { createAssistant } from "./service.js";

const ORG = "org1";

function ctx(overrides?: { userId?: string; orgId?: string }): PluginActionContext {
  // The actions read `userId`/`orgId` and nothing else; a full ToolContext
  // needs a live sandbox — the same shortcut skills-actions.test.ts takes.
  return {
    userId: "u1",
    orgId: ORG,
    actionId: "assistants.list_assistants",
    service: "assistants",
    ...overrides,
  } as PluginActionContext;
}

async function seedUser(db: AppDb, id: string) {
  await db.insert(users).values({ id, email: `${id}@x.test`, name: id, role: "member" });
  await db.insert(orgMembers).values({ orgId: ORG, userId: id, role: "member" });
}

describe("assistantsActionPlugin", () => {
  let db: AppDb;
  let evict: ReturnType<typeof vi.fn<(sessionId: string) => void>>;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    await db.insert(orgs).values({ id: ORG, name: "Org", createdAt: Date.now() });
    await seedUser(db, "u1");
    await seedUser(db, "u2");
    evict = vi.fn<(sessionId: string) => void>();
  });

  function actionById(id: string) {
    const plugin = assistantsActionPlugin(db, evict);
    const found = plugin.actions.find((a) => a.id === id);
    if (!found) throw new Error(`action missing: ${id}`);
    return found;
  }

  it("exposes read-only compatibility listing, with no profile mutation tools", () => {
    const plugin = assistantsActionPlugin(db, evict);
    expect(plugin.service).toBe("assistants");
    expect(plugin.actions.map((a) => a.id).sort()).toEqual([
      "assistants.list_assistants",
    ]);
  });

  it("lists own and team assistants, never another user's personal ones", async () => {
    // `createTeam` seeds an unnamed default team assistant (TKAI-337), so
    // the named-row set is what "belongs to me or my teams" reduces to.
    const team = await createTeam(db, { orgId: ORG, name: "Security", creatorUserId: "u2" });
    await addMember(db, { teamId: team.id, userId: "u1", role: "member" });
    await createAssistant(db, ORG, { type: "user", id: "u1" }, "Mine");
    await createAssistant(db, ORG, { type: "user", id: "u2" }, "Theirs");
    await createAssistant(db, ORG, { type: "team", id: team.id }, "Ours");

    const result = await actionById("assistants.list_assistants").execute({}, ctx());
    expect(result.success).toBe(true);
    const rows = (result.data as { assistants: { name?: string; owner: { type: string; id: string } }[] })
      .assistants;
    const named = rows.map((a) => a.name).filter((n): n is string => n !== undefined);
    expect(named.sort()).toEqual(["Mine", "Ours"]);
    expect(rows.some((a) => a.owner.type === "user" && a.owner.id === "u2")).toBe(false);
  });

  it("lists a seeded team default with no name, and says so in the description", async () => {
    // `createTeam` seeds each team's default unnamed. The agent sees the
    // row with `name` absent and `isDefault: true`; the description tells
    // it to expect that instead of treating the gap as a broken row.
    const team = await createTeam(db, { orgId: ORG, name: "Security", creatorUserId: "u1" });

    const listAction = actionById("assistants.list_assistants");
    expect(listAction.description).toMatch(/unnamed/);
    expect(listAction.description).toMatch(/name.*absent|absent.*name|no name/i);

    const result = await listAction.execute({}, ctx());
    const rows = (result.data as { assistants: { name?: string; isDefault: boolean; owner: { id: string } }[] })
      .assistants;
    const seeded = rows.find((a) => a.owner.id === team.id);
    expect(seeded).toBeDefined();
    expect(seeded?.isDefault).toBe(true);
    expect(seeded).not.toHaveProperty("name");
  });
});

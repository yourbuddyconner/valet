import { describe, expect, it, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { assistants, orgs } from "../schema/index.js";
import { ArchivedAssistantError, findDefaultAssistant, resolveDefaultAssistant } from "./service.js";

const ORG = "org1";
const TEAM = { type: "team", id: "team_1" } as const;

describe("resolveDefaultAssistant", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    await db.insert(orgs).values({ id: ORG, name: "Org", createdAt: Date.now() });
  });

  it("seeds inside the caller's transaction and rolls back with it", async () => {
    // `createTeam` seeds the team's default through this function, inside
    // its own transaction, so a failed team insert takes the seed with it.
    await expect(
      db.transaction(async (tx) => {
        const seeded = await resolveDefaultAssistant(tx, ORG, TEAM);
        expect(seeded.ownerId).toBe(TEAM.id);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");

    expect(await findDefaultAssistant(db, ORG, TEAM)).toBeUndefined();
    const rows = await db
      .select()
      .from(assistants)
      .where(and(eq(assistants.ownerType, TEAM.type), eq(assistants.ownerId, TEAM.id)));
    expect(rows).toHaveLength(0);
  });

  it("returns the existing default instead of minting a second one", async () => {
    const first = await resolveDefaultAssistant(db, ORG, TEAM);
    const second = await db.transaction((tx) => resolveDefaultAssistant(tx, ORG, TEAM));
    expect(second.id).toBe(first.id);
  });
  it("converges concurrent initialization to one durable row", async () => {
    const rows = await Promise.all(Array.from({ length: 8 }, () => resolveDefaultAssistant(db, ORG, TEAM)));
    expect(new Set(rows.map(row => row.id)).size).toBe(1);
    expect(await db.select().from(assistants)).toHaveLength(1);
  });

  it("does not replace an archived singleton or free its unique owner slot", async () => {
    const first = await resolveDefaultAssistant(db, ORG, TEAM);
    await db.update(assistants).set({ archivedAt: Date.now() }).where(eq(assistants.id, first.id));
    await expect(resolveDefaultAssistant(db, ORG, TEAM)).rejects.toBeInstanceOf(ArchivedAssistantError);
    const existing = await findDefaultAssistant(db, ORG, TEAM);
    expect(existing?.id).toBe(first.id);
    expect(existing?.archivedAt).not.toBeNull();
    await expect(db.insert(assistants).values({ id: "duplicate", orgId: ORG, ownerType: TEAM.type, ownerId: TEAM.id, sessionId: "assistant:duplicate", createdAt: Date.now() })).rejects.toThrow();
  });

});

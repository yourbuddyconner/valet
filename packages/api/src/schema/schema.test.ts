import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { applyAppMigrations, buildAppDb } from "../lib/drizzle.js";
import { agentSessions, orgs, orgMembers, users } from "./index.js";

describe("api schema migrations", () => {
  it("applies cleanly to a fresh in-memory db and roundtrips a session", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");

    applyAppMigrations(sqlite);

    const db = buildAppDb(sqlite);
    const now = Date.now();

    db.insert(orgs).values({ id: "o1", name: "Acme", createdAt: now }).run();
    db.insert(users)
      .values({ id: "u1", email: "u@x", name: "U", role: "admin", createdAt: now })
      .run();
    db.insert(orgMembers).values({ orgId: "o1", userId: "u1", role: "admin" }).run();
    db.insert(agentSessions)
      .values({
        id: "s1",
        userId: "u1",
        orgId: "o1",
        workspace: "/tmp/ws",
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const got = db.select().from(agentSessions).where(eq(agentSessions.id, "s1")).get();
    expect(got?.workspace).toBe("/tmp/ws");
    expect(got?.status).toBe("active");

    sqlite.close();
  });
});

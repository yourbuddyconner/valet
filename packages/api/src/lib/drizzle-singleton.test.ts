import { PGlite } from "@electric-sql/pglite";
import { pgDbFromPglite } from "@valet/store-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyAppMigrations, missingSchemaRepairs } from "./drizzle.js";

describe("workspace singleton repair on an already migrated database", () => {
  const pglite = new PGlite();
  const db = pgDbFromPglite(pglite);
  beforeAll(async () => { await applyAppMigrations(db); });
  afterAll(async () => { await db.close(); });

  async function restorePreviousSchema() {
    await db.query("DROP INDEX assistants_workspace");
    await db.query("ALTER TABLE assistants ADD COLUMN is_default boolean NOT NULL DEFAULT false");
    await db.query("CREATE UNIQUE INDEX assistants_default_owner ON assistants(org_id, owner_type, owner_id) WHERE is_default");
    await db.query("ALTER TABLE followed_threads ADD COLUMN assistant_id text");
    await db.query("ALTER TABLE workflow_schedules ADD COLUMN assistant_id text");
  }

  it("repairs the previous columns with one executable statement and reserves retired owners", async () => {
    await restorePreviousSchema();
    for (const column of ["name", "avatar_url", "personality", "behavior", "model", "reasoning"]) {
      await db.query(`ALTER TABLE assistants ADD COLUMN ${column} text`);
    }
    await db.query("ALTER TABLE teams DROP COLUMN slack_home_channel_id");
    await db.query("ALTER TABLE user_notification_preferences DROP COLUMN team_dm");
    await db.query("ALTER TABLE artifacts DROP COLUMN source_thread_id");
    await db.query(`INSERT INTO assistants(id, org_id, owner_type, owner_id, session_id, is_default, created_at, archived_at)
      VALUES ('live', 'org', 'user', 'live-owner', 'live-session', true, 1, NULL),
             ('retired', 'org', 'team', 'retired-owner', 'retired-session', false, 1, 2)`);
    const missing = (await missingSchemaRepairs(db)).map(repair => repair.describe);
    expect(missing).toContain("workspace assistant singleton cutover");
    expect(missing).toContain("artifacts.source_thread_id column");

    // The migration tracker is already populated, so this exercises the same
    // repair query path used at restart, including prepared-statement limits.
    await expect(applyAppMigrations(db)).resolves.toBeUndefined();
    const removed = await db.query(`SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND
      ((table_name = 'assistants' AND column_name IN ('is_default', 'name', 'avatar_url', 'personality', 'behavior', 'model', 'reasoning')) OR
       (table_name IN ('followed_threads', 'workflow_schedules') AND column_name = 'assistant_id'))`);
    expect(removed.rows).toEqual([]);
    const added = await db.query(`SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND
      ((table_name = 'teams' AND column_name = 'slack_home_channel_id') OR
       (table_name = 'user_notification_preferences' AND column_name = 'team_dm') OR
       (table_name = 'artifacts' AND column_name = 'source_thread_id')) ORDER BY table_name`);
    expect(added.rows).toEqual([
      { table_name: "artifacts", column_name: "source_thread_id" },
      { table_name: "teams", column_name: "slack_home_channel_id" },
      { table_name: "user_notification_preferences", column_name: "team_dm" },
    ]);
    const indexes = await db.query("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname IN ('assistants_workspace', 'assistants_default_owner')");
    expect(indexes.rows).toHaveLength(1);
    expect(indexes.rows[0].indexname).toBe("assistants_workspace");
    expect(indexes.rows[0].indexdef).toContain("UNIQUE INDEX");
    expect(indexes.rows[0].indexdef).not.toContain("WHERE");
    await expect(db.query(`INSERT INTO assistants(id, org_id, owner_type, owner_id, session_id, created_at)
      VALUES ('replacement', 'org', 'team', 'retired-owner', 'replacement-session', 3)`)).rejects.toThrow(/unique/i);
    const preserved = await db.query("SELECT id, session_id, archived_at FROM assistants WHERE org_id = 'org' ORDER BY id");
    expect(preserved.rows).toEqual([
      { id: "live", session_id: "live-session", archived_at: null },
      { id: "retired", session_id: "retired-session", archived_at: 2 },
    ]);
    await expect(applyAppMigrations(db)).resolves.toBeUndefined();
    expect(await missingSchemaRepairs(db)).toEqual([]);
    await db.query("DELETE FROM assistants WHERE org_id = 'org'");
  });

  it("rolls back the cutover if existing profiles share an owner", async () => {
    await restorePreviousSchema();
    await db.query(`INSERT INTO assistants(id, org_id, owner_type, owner_id, session_id, is_default, created_at, archived_at)
      VALUES ('first', 'duplicate-org', 'user', 'owner', 'first-session', true, 1, NULL),
             ('second', 'duplicate-org', 'user', 'owner', 'second-session', false, 1, 2)`);
    await expect(applyAppMigrations(db)).rejects.toThrow(/unique/i);
    const rows = await db.query("SELECT id, is_default FROM assistants WHERE org_id = 'duplicate-org' ORDER BY id");
    expect(rows.rows).toEqual([{ id: "first", is_default: true }, { id: "second", is_default: false }]);
    const oldIndex = await db.query("SELECT 1 FROM pg_indexes WHERE indexname = 'assistants_default_owner'");
    expect(oldIndex.rows).toHaveLength(1);
    expect((await missingSchemaRepairs(db)).map(repair => repair.describe)).toContain("workspace assistant singleton cutover");
  });
});

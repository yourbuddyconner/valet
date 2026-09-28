import { PGlite } from "@electric-sql/pglite";
import { pgDbFromPglite } from "@valet/store-postgres";
import { expect, it } from "vitest";
import { applyAppMigrations, missingSchemaRepairs } from "../lib/drizzle.js";

it("creates the briefing cache on fresh databases and repairs existing databases idempotently", async () => {
  const db = pgDbFromPglite(new PGlite());
  try {
    await applyAppMigrations(db);
    const columns = () => db.query("SELECT column_name FROM information_schema.columns WHERE table_name='workspace_briefing_cache' ORDER BY column_name");
    const fresh = await columns();
    expect(fresh.rows).toHaveLength(10);
    await db.query("DROP TABLE workspace_briefing_cache");
    expect(await missingSchemaRepairs(db)).toContainEqual(expect.objectContaining({ describe: "workspace briefing cache" }));
    await applyAppMigrations(db);
    expect(await columns()).toEqual(fresh);
    await db.query(`INSERT INTO workspace_briefing_cache(org_id,owner_type,owner_id,version)
      VALUES ('org','user','owner','v1')`);
    await applyAppMigrations(db);
    expect((await db.query("SELECT version FROM workspace_briefing_cache")).rows).toEqual([{ version: "v1" }]);
  } finally { await db.close(); }
});

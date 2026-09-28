import { PGlite } from "@electric-sql/pglite";
import { pgDbFromPglite } from "@valet/store-postgres";
import { expect, it } from "vitest";
import { applyAppMigrations, missingSchemaRepairs } from "./drizzle.js";
it("repairs receipt storage and its index on existing migrated stores", async () => {
  const db = pgDbFromPglite(new PGlite());
  try {
    await applyAppMigrations(db);
    await db.query("DROP TABLE event_receipts");
    expect((await missingSchemaRepairs(db)).map(r => r.describe)).toContain("event receipts table");
    await applyAppMigrations(db);
    expect((await missingSchemaRepairs(db)).map(r => r.describe)).not.toContain("event receipts table");
    await db.query("DROP INDEX event_receipts_page");
    await applyAppMigrations(db);
    expect((await missingSchemaRepairs(db)).map(r => r.describe)).not.toContain("event receipts page index");
  } finally { await db.close(); }
});

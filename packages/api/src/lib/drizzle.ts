import type Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Application Drizzle handle. Backed by better-sqlite3. The engine's session
 * store has its own Drizzle handle over the same connection — both reach the
 * same sqlite file.
 */
export type AppDb = BetterSQLite3Database<Record<string, never>>;

export function buildAppDb(sqlite: Database.Database): AppDb {
  return drizzle(sqlite, { casing: "snake_case" });
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Apply migrations from `packages/api/migrations/` to the open sqlite db.
 *
 * Tracks applied migrations in `__valet_app_migrations` (filename + timestamp)
 * so re-runs across server restarts are no-ops. Each migration runs in a
 * transaction — partial application leaves the tracker untouched.
 */
export function applyAppMigrations(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __valet_app_migrations (
      filename TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const migrationsDir = join(__dirname, "..", "..", "migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  // Backfill: if the schema tables already exist (db pre-dates the tracker)
  // but the tracker is empty, assume every migration has run and mark them
  // applied without re-executing. One-time bootstrap; harmless on fresh dbs.
  const trackerRows = sqlite
    .prepare("SELECT COUNT(*) as n FROM __valet_app_migrations")
    .get() as { n: number };
  if (trackerRows.n === 0) {
    const schemaSeed = sqlite
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_sessions'",
      )
      .get();
    if (schemaSeed) {
      const seed = sqlite.prepare<[string, number]>(
        "INSERT OR IGNORE INTO __valet_app_migrations (filename, applied_at) VALUES (?, ?)",
      );
      const now = Date.now();
      for (const file of files) seed.run(file, now);
    }
  }

  const isApplied = sqlite.prepare<[string]>(
    "SELECT 1 FROM __valet_app_migrations WHERE filename = ?",
  );
  const recordApplied = sqlite.prepare<[string, number]>(
    "INSERT INTO __valet_app_migrations (filename, applied_at) VALUES (?, ?)",
  );

  for (const file of files) {
    if (isApplied.get(file)) continue;

    const sql = readFileSync(join(migrationsDir, file), "utf8");
    // drizzle-kit emits multiple statements separated by `--> statement-breakpoint`.
    const statements = sql.split(/-->\s*statement-breakpoint/);

    const runMigration = sqlite.transaction(() => {
      for (const stmt of statements) {
        const trimmed = stmt.trim();
        if (trimmed) sqlite.exec(trimmed);
      }
      recordApplied.run(file, Date.now());
    });
    runMigration();
  }
}

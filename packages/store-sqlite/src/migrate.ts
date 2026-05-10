import type Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Apply this package's sqlite migrations to an open better-sqlite3 connection.
 *
 * Tracks applied migrations in `__valet_engine_migrations` so re-runs across
 * restarts are no-ops. Backfills the tracker if engine schema tables are
 * present but the tracker is empty (db pre-dates this change).
 */
export function applyEngineMigrations(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __valet_engine_migrations (
      filename TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const migrationsDir = join(__dirname, "..", "migrations", "sqlite");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  // Backfill bootstrap: if engine_sessions already exists but the tracker is
  // empty, assume every migration has been applied. One-time, harmless.
  const trackerRows = sqlite
    .prepare("SELECT COUNT(*) as n FROM __valet_engine_migrations")
    .get() as { n: number };
  if (trackerRows.n === 0) {
    const schemaSeed = sqlite
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='engine_sessions'",
      )
      .get();
    if (schemaSeed) {
      const seed = sqlite.prepare<[string, number]>(
        "INSERT OR IGNORE INTO __valet_engine_migrations (filename, applied_at) VALUES (?, ?)",
      );
      const now = Date.now();
      for (const file of files) seed.run(file, now);
    }
  }

  const isApplied = sqlite.prepare<[string]>(
    "SELECT 1 FROM __valet_engine_migrations WHERE filename = ?",
  );
  const recordApplied = sqlite.prepare<[string, number]>(
    "INSERT INTO __valet_engine_migrations (filename, applied_at) VALUES (?, ?)",
  );

  for (const file of files) {
    if (isApplied.get(file)) continue;

    const sql = readFileSync(join(migrationsDir, file), "utf8");
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

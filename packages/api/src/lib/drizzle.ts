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

/** Apply migrations from `packages/api/migrations/` to the open sqlite db. */
export function applyAppMigrations(sqlite: Database.Database): void {
  const migrationsDir = join(__dirname, "..", "..", "migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    // drizzle-kit emits multiple statements separated by `--> statement-breakpoint`.
    const statements = sql.split(/-->\s*statement-breakpoint/);
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }
}

import type Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Apply this package's sqlite migrations to an open better-sqlite3 connection.
 * Idempotent only at the file boundary — drizzle-kit migrations expect a fresh
 * schema. Callers using the same db across runs should use a real migrations
 * runner; this helper is for dev/test bootstrap.
 */
export function applyEngineMigrations(sqlite: Database.Database): void {
  const migrationsDir = join(__dirname, "..", "migrations", "sqlite");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const statements = sql.split(/-->\s*statement-breakpoint/);
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }
}

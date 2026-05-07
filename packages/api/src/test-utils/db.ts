import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Creates an in-memory SQLite database with all migrations applied,
 * returning a Drizzle instance compatible with the schema tables.
 */
export function createTestDb(): { db: BetterSQLite3Database; sqlite: DatabaseType } {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const migrationsDir = path.resolve(__dirname, '../../migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    sqlite.exec(sql);
  }

  const db = drizzle(sqlite, { casing: 'snake_case' });
  return { db, sqlite };
}

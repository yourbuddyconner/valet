import { drizzle } from 'drizzle-orm/d1';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

/**
 * Widened database type that accepts both D1 (production) and
 * better-sqlite3 (tests). Uses the base SQLite database type
 * so Drizzle query builder methods are compatible across both.
 */
export type AppDb = BaseSQLiteDatabase<any, any, any>;

/** Create a Drizzle instance from a D1 binding (production path). */
export function getDb(d1: D1Database): DrizzleD1Database {
  return drizzle(d1, { casing: 'snake_case' });
}

export function toDate(value: string | null | undefined): Date {
  if (!value) return new Date(0);
  // SQLite's datetime('now') returns "YYYY-MM-DD HH:MM:SS" (UTC, but no T/Z).
  // Normalize to ISO 8601 so `new Date()` unambiguously treats it as UTC.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return new Date(value.replace(' ', 'T') + 'Z');
  }
  return new Date(value);
}

import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Partial unique indexes are defined in migration 0058_disabled_actions.sql:
//   idx_da_service  UNIQUE(service) WHERE action_id IS NULL
//   idx_da_action   UNIQUE(service, action_id) WHERE action_id IS NOT NULL
// Drizzle's SQLite index builder does not support WHERE clauses, so they are
// managed exclusively via the migration SQL.
export const disabledActions = sqliteTable('disabled_actions', {
  id: text().primaryKey(),
  service: text().notNull(),
  actionId: text('action_id'),
  disabledBy: text('disabled_by').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

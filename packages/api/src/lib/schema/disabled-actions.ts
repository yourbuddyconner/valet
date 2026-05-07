import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

// Partial unique indexes are defined in the migration:
//   idx_da_service  UNIQUE(service) WHERE action_id IS NULL
//   idx_da_action   UNIQUE(service, action_id) WHERE action_id IS NOT NULL
// Drizzle's SQLite index builder does not support WHERE clauses, so they are
// managed exclusively via the migration SQL.
export const disabledActions = sqliteTable('disabled_actions', {
  id: text().primaryKey(),
  service: text().notNull(),
  actionId: text('action_id'),
  disabledBy: text('disabled_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

/**
 * Request-level performance telemetry for the Worker API surface.
 *
 * One row per sampled `/api/*` request. Distinct grain from `analytics_events`
 * (session-scoped agent telemetry) — request metrics are keyed by route, so the
 * route pattern is stored low-cardinality (`/api/sessions/:id`, never raw IDs).
 */
export const requestMetrics = sqliteTable('request_metrics', {
  id: text().primaryKey(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  method: text().notNull(),
  route: text().notNull(),
  status: integer().notNull(),
  durationMs: integer().notNull(),
  requestId: text(),
  requestBytes: integer(),
  userId: text().references(() => users.id, { onDelete: 'set null' }),
}, (table) => [
  index('idx_request_metrics_created').on(table.createdAt),
  index('idx_request_metrics_route_created').on(table.route, table.createdAt),
]);

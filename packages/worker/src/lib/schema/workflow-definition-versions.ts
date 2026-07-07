import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { workflows } from './workflows.js';
import { users } from './users.js';

/**
 * Append-only history of published workflow definitions. workflows
 * .published_version_id points at the active row; restore copies an
 * old version's `definition` back into `workflows.draft_definition`.
 */
export const workflowDefinitionVersions = sqliteTable('workflow_definition_versions', {
  id: text().primaryKey(),
  workflowId: text().notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  version: integer().notNull(),
  definition: text().notNull(),
  definitionHash: text().notNull(),
  validationStatus: text({ enum: ['ok', 'warning'] }).notNull().default('ok'),
  publishNote: text(),
  ui: text(),
  createdBy: text().references(() => users.id, { onDelete: 'set null' }),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_wdv_workflow_version').on(table.workflowId, table.version),
  index('idx_wdv_workflow_created').on(table.workflowId, table.createdAt),
]);

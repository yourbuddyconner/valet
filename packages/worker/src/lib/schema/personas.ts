import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

export const agentPersonas = sqliteTable('agent_personas', {
  id: text().primaryKey(),
  orgId: text().notNull().default('default'),
  name: text().notNull(),
  slug: text().notNull(),
  description: text(),
  icon: text(),
  visibility: text().notNull().default('shared'),
  isDefault: integer({ mode: 'boolean' }).notNull().default(false),
  defaultModel: text(),
  createdBy: text().references(() => users.id, { onDelete: 'set null' }),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_personas_slug').on(table.orgId, table.slug),
]);

export const agentPersonaFiles = sqliteTable('agent_persona_files', {
  id: text().primaryKey(),
  personaId: text().notNull(),
  filename: text().notNull(),
  content: text().notNull(),
  sortOrder: integer().notNull().default(0),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_persona_files_name').on(table.personaId, table.filename),
]);

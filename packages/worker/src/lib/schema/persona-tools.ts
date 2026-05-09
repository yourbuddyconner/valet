import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { agentPersonas } from './personas.js';

export const personaTools = sqliteTable('persona_tools', {
  id: text().primaryKey(),
  personaId: text().notNull().references(() => agentPersonas.id, { onDelete: 'cascade' }),
  service: text().notNull(),
  actionId: text(),
  enabled: integer().notNull().default(1),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_persona_tools_unique').on(table.personaId, table.service, table.actionId),
  index('idx_persona_tools_persona').on(table.personaId),
]);

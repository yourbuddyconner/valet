import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { agentPersonas } from './personas.js';

export const skills = sqliteTable('skills', {
  id: text().primaryKey(),
  orgId: text().notNull().default('default'),
  ownerId: text(),
  source: text().notNull().default('managed'),
  name: text().notNull(),
  slug: text().notNull(),
  description: text(),
  content: text().notNull(),
  visibility: text().notNull().default('private'),
  status: text().notNull().default('active'),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_skills_org_status').on(table.orgId, table.status),
  index('idx_skills_owner').on(table.ownerId),
]);

export const personaSkills = sqliteTable('persona_skills', {
  id: text().primaryKey(),
  personaId: text().notNull().references(() => agentPersonas.id, { onDelete: 'cascade' }),
  skillId: text().notNull().references(() => skills.id, { onDelete: 'cascade' }),
  sortOrder: integer().notNull().default(0),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_persona_skills_unique').on(table.personaId, table.skillId),
  index('idx_persona_skills_persona').on(table.personaId),
  index('idx_persona_skills_skill').on(table.skillId),
]);

export const orgDefaultSkills = sqliteTable('org_default_skills', {
  id: text().primaryKey(),
  orgId: text().notNull(),
  skillId: text().notNull().references(() => skills.id, { onDelete: 'cascade' }),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_org_default_skills_unique').on(table.orgId, table.skillId),
]);

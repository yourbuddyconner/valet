/** Test fixtures configure internal runtime metadata without a public profile API. */
import { eq } from 'drizzle-orm';
import type { Principal } from '@valet/engine';
import type { AppDb } from '../lib/drizzle.js';
import { resolveDefaultAssistant } from '../assistants/service.js';
import { assistants } from '../schema/index.js';
import type { AssistantBehavior } from '../wire/types.js';

export async function seedWorkspaceAssistant(db: AppDb, orgId: string, owner: Principal, name: string | null,
  config?: { personality?: string | null; behavior?: AssistantBehavior | null }) {
  const row = await resolveDefaultAssistant(db, orgId, owner);
  const [updated] = await db.update(assistants).set({
    name,
    ...(config?.personality === undefined ? {} : { personality: config.personality }),
    ...(config?.behavior === undefined ? {} : { behavior: config.behavior === null ? null : JSON.stringify(config.behavior) }),
  }).where(eq(assistants.id, row.id)).returning();
  if (!updated) throw new Error('Workspace assistant fixture disappeared');
  return updated;
}

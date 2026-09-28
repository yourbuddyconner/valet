import { and, eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { loadAssistantBySessionId } from "../assistants/service.js";
import { agentSessions, childWatches } from "../schema/index.js";

/** Read after authorizing the child. A move must not expose the former workspace. */
export async function visibleWorkOrigin(
  db: AppDb,
  child: Pick<typeof agentSessions.$inferSelect, "id" | "orgId" | "ownerType" | "ownerId">,
): Promise<{ sessionId: string; threadId: string } | undefined> {
  const [watch] = await db.select({ sessionId: childWatches.parentSessionId, threadId: childWatches.parentThreadId })
    .from(childWatches)
    .where(and(eq(childWatches.childSessionId, child.id), eq(childWatches.orgId, child.orgId)))
    .limit(1);
  if (!watch) return undefined;
  const runtime = await loadAssistantBySessionId(db, watch.sessionId);
  const parent = runtime ?? (await db.select().from(agentSessions).where(eq(agentSessions.id, watch.sessionId)).limit(1))[0];
  if (!parent || parent.orgId !== child.orgId || parent.ownerType !== child.ownerType || parent.ownerId !== child.ownerId) return undefined;
  if (runtime?.archivedAt != null) return undefined;
  return watch;
}

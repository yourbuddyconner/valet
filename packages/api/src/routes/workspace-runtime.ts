import type { Principal } from "@valet/engine";
import { and, count, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import { ensureDefaultAssistantSession, findDefaultAssistant, resolveDefaultAssistant } from "../assistants/service.js";
import { canViewAssistantOwner } from "../assistants/access.js";
import { childWatches } from "../schema/index.js";
import { getTeamInOrg } from "../services/teams.js";
import type { WorkspaceRuntimeInfoResponse, WorkspaceRuntimeResponse, EnsureWorkspaceRuntimeResponse } from "../wire/types.js";

export const workspaceRuntimeRouter = new Hono<AppEnv>();

export async function authorizedWorkspaceOwner(c: Context<AppEnv>, workspace = c.req.param("workspace")): Promise<Principal | null> {
  const principal = c.var.principal;
  const { db } = c.var.providers;
  if (workspace === "user") return principal.type === "user" ? principal : null;
  if (!workspace || !await getTeamInOrg(db, c.var.user.orgId, workspace)) return null;
  const allowed = await canViewAssistantOwner(db, { type: "team", id: workspace }, principal);
  return allowed ? { type: "team", id: workspace } : null;
}

workspaceRuntimeRouter.get("/:workspace/runtime", async (c) => {
  const owner = await authorizedWorkspaceOwner(c);
  if (!owner) return c.json({ error: "Workspace not found." }, 404);
  const row = await findDefaultAssistant(c.var.providers.db, c.var.user.orgId, owner);
  const body: WorkspaceRuntimeResponse = { sessionId: row?.sessionId ?? null, exists: row !== undefined };
  return c.json(body);
});

workspaceRuntimeRouter.post("/:workspace/runtime", async (c) => {
  const owner = await authorizedWorkspaceOwner(c);
  if (!owner) return c.json({ error: "Workspace not found." }, 404);
  const { sessionId } = await ensureDefaultAssistantSession(c.var.providers, owner, { actorUserId: c.var.user.id, orgId: c.var.user.orgId });
  const body: EnsureWorkspaceRuntimeResponse = { sessionId };
  return c.json(body);
});

// A durable app-assistant Thread per viewer in this workspace. Opening it is
// idempotent and never submits a model turn. Team threads retain team visibility.
workspaceRuntimeRouter.post("/:workspace/conversation", async (c) => {
  const owner = await authorizedWorkspaceOwner(c);
  if (!owner) return c.json({ error: "Workspace not found." }, 404);
  const { sessionId, session } = await ensureDefaultAssistantSession(c.var.providers, owner, { actorUserId: c.var.user.id, orgId: c.var.user.orgId });
  const thread = await session.createThread(`app-assistant:${c.var.user.id}`);
  return c.json({ sessionId, threadId: thread.id });
});

workspaceRuntimeRouter.get("/:workspace/runtime/info", async (c) => {
  const owner = await authorizedWorkspaceOwner(c);
  if (!owner) return c.json({ error: "Workspace not found." }, 404);
  const { db, engineHost } = c.var.providers;
  // Resolve the identity only: presence reads never start the runtime or a sandbox.
  const row = await resolveDefaultAssistant(db, c.var.user.orgId, owner);
  const [children] = await db.select({ n: count() }).from(childWatches)
    .where(and(eq(childWatches.parentSessionId, row.sessionId), eq(childWatches.settled, false)));
  const activeChildren = children?.n ?? 0;
  const live = engineHost.liveSession(row.sessionId);
  const presence = activeChildren > 0 ? "working" : live?.listThreads().some(thread => thread.runningItemId() !== undefined) ? "thinking" : "idle";
  const body: WorkspaceRuntimeInfoResponse = { sessionId: row.sessionId, presence, activeChildren };
  return c.json(body);
});

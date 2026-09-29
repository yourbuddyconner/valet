import { and, eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { engineGateToWire } from "../engine/bridge.js";
import type { AppEnv } from "../env.js";
import { agentSessions, sessionThreads, workflowRuns, workflowDefinitions } from "../schema/index.js";
import { canViewSession } from "../services/session-access.js";
import { authorizedWorkspaceOwner } from "./workspace-runtime.js";
import { ensureDefaultAssistantSession, findDefaultAssistant } from "../assistants/service.js";

/** Compatibility adapter: execution and authorization remain in the existing handlers. */
export function createThreadsRouter(forward: (request: Request) => Promise<Response>) {
  const router = new Hono<AppEnv>();
  async function relay(c: Context<AppEnv>, path: string, threadId?: string) {
    const url = new URL(c.req.url);
    url.pathname = path;
    if (threadId) {
      if (url.searchParams.has("threadId") && url.searchParams.get("threadId") !== threadId) {
        return c.json({ error: "threadId must match the URL." }, 400);
      }
      url.searchParams.set("threadId", threadId);
    }
    let body: string | undefined;
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      body = await c.req.text();
      if (threadId && body) {
        let parsed: unknown;
        try { parsed = JSON.parse(body); } catch { return c.json({ error: "Invalid JSON body." }, 400); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return c.json({ error: "Expected a JSON object." }, 400);
        if ("threadId" in parsed && parsed.threadId !== threadId) return c.json({ error: "threadId must match the URL." }, 400);
        body = JSON.stringify({ ...parsed, threadId });
      }
    }
    const headers = new Headers(c.req.raw.headers);
    headers.delete("content-length");
    return forward(new Request(url, { method: c.req.method, headers, body }));
  }

  router.on(["GET", "POST"], "/", async (c) => {
    const workspace = c.req.query("workspace") ?? (c.var.principal.type === "team" ? c.var.principal.id : "user");
    const owner = await authorizedWorkspaceOwner(c, workspace);
    if (!owner) return c.json({ error: "Workspace not found." }, 404);
    const existing = await findDefaultAssistant(c.var.providers.db, c.var.user.orgId, owner);
    if (!existing && c.req.method === "GET") return c.json({ threads: [] });
    const sessionId = existing?.sessionId ?? (await ensureDefaultAssistantSession(c.var.providers, owner, { actorUserId: c.var.user.id, orgId: c.var.user.orgId })).sessionId;
    return relay(c, `/api/sessions/${encodeURIComponent(sessionId)}/threads`);
  });

  router.on(["GET", "PATCH", "POST"], ["/:threadId", "/:threadId/messages", "/:threadId/abort", "/:threadId/resume", "/:threadId/decisions", "/:threadId/decisions/:gateId/resolve"], async (c) => {
    const threadId = c.req.param("threadId");
    const { db } = c.var.providers;
    const [appSession] = await db.select().from(agentSessions)
      .where(and(eq(agentSessions.orgId, c.var.user.orgId), sql`exists (
        select 1 from engine_threads where engine_threads.session_id = ${agentSessions.id} and engine_threads.id = ${threadId}
      )`)).limit(1);
    const suffix = c.req.path.split("/").at(-1);
    let sessionId = appSession?.id;
    if (appSession) {
      if (!await canViewSession(db, appSession, c.var.principal)) return c.json({ error: "Thread not found." }, 404);
    } else {
      // Workflow agents have no app runtime row. Their existing decision route
      // checks run ownership; never give this fallback prompt/sandbox access.
      if (![threadId, "decisions", "resolve"].includes(suffix ?? "")) return c.json({ error: "Thread not found." }, 404);
      const [workflowThread] = await db.select({ sessionId: sql<string>`t.session_id` })
        .from(sql`engine_threads t`)
        .innerJoin(workflowRuns, sql`${workflowRuns.id} = split_part(t.session_id, ':', 2)`)
        .innerJoin(workflowDefinitions, eq(workflowDefinitions.id, workflowRuns.workflowId))
        .where(and(eq(workflowDefinitions.orgId, c.var.user.orgId), sql`t.id = ${threadId} and t.session_id LIKE 'wf:%'`)).limit(1);
      if (!workflowThread) return c.json({ error: "Thread not found." }, 404);
      sessionId = workflowThread.sessionId;
      const checkUrl = new URL(c.req.url);
      checkUrl.pathname = `/api/sessions/${encodeURIComponent(sessionId)}/decisions`;
      checkUrl.search = "";
      const authorized = await forward(new Request(checkUrl, { headers: c.req.raw.headers }));
      if (!authorized.ok) return authorized;
    }
    if (!sessionId) return c.json({ error: "Thread not found." }, 404);
    const thread = await c.var.providers.engineStore.getThread(sessionId, threadId);
    if (!thread) return c.json({ error: "Thread not found." }, 404);
    const base = `/api/sessions/${encodeURIComponent(sessionId)}`;
    if (suffix === "decisions" && c.req.method === "GET") {
      const gates = await c.var.providers.engineStore.listDecisionGates(sessionId, threadId, "pending");
      return c.json({ gates: gates.map(engineGateToWire) });
    }
    if (suffix === "resolve" && c.req.method === "POST") {
      const gateId = c.req.param("gateId");
      const gate = await c.var.providers.engineStore.getDecisionGate(sessionId, gateId);
      if (!gate || gate.threadId !== threadId) return c.json({ error: "Decision not found in this thread." }, 404);
      return relay(c, `${base}/decisions/${encodeURIComponent(gateId)}/resolve`, threadId);
    }
    if (suffix === "messages" && ["GET", "POST"].includes(c.req.method)) return relay(c, `${base}/messages`, threadId);
    if ((suffix === "abort" || suffix === "resume") && c.req.method === "POST") return relay(c, `${base}/threads/${encodeURIComponent(threadId)}/${suffix}`, threadId);
    if (appSession && suffix === threadId && c.req.method === "PATCH") return relay(c, `${base}/threads/${encodeURIComponent(threadId)}`, threadId);
    if (suffix === threadId && c.req.method === "GET") {
      const [meta] = await db.select().from(sessionThreads).where(and(eq(sessionThreads.id, threadId), eq(sessionThreads.sessionId, sessionId))).limit(1);
      return c.json({ id: threadId, sessionId, title: meta?.title ?? null, createdAt: thread.createdAt, archivedAt: meta?.archivedAt ?? null });
    }
    return c.json({ error: "Unsupported thread operation." }, 405);
  });
  return router;
}

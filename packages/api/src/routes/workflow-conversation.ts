import { Hono } from "hono";
import { ensureDefaultAssistantSession } from "../assistants/service.js";
import type { AppEnv } from "../env.js";
import type { EnsureWorkflowConversationResponse } from "../wire/types.js";
import { ownedDefinitionRow } from "../workflows/service.js";

export const workflowConversationRouter = new Hono<AppEnv>();

// The definition's owner determines the conversation. Never accept routing
// from the browser. Each viewer reuses their app-assistant Thread in that owner workspace.
workflowConversationRouter.post("/:id/conversation", async (c) => {
  const { db, engineHost } = c.var.providers;
  const user = c.var.user;
  const workflow = await ownedDefinitionRow(db, {
    userId: user.id,
    orgId: user.orgId,
    principal: c.var.principal,
  }, c.req.param("id"));
  if (!workflow) return c.json({ error: "Workflow not found. Open a workflow you can access." }, 404);
  if (workflow.ownerType !== "user" && workflow.ownerType !== "team") {
    return c.json({ error: "Copy this workflow to a personal or team workspace to open its conversation." }, 409);
  }
  const { session, sessionId } = await ensureDefaultAssistantSession(
    { db, engineHost },
    { type: workflow.ownerType, id: workflow.ownerId },
    { actorUserId: user.id, orgId: user.orgId },
  );
  const thread = await session.createThread(`app-assistant:${user.id}`);
  // Opening the editor does not submit a model turn. Reopens cannot duplicate
  // an automatic introduction, including after a lost HTTP response.
  const response: EnsureWorkflowConversationResponse = { sessionId, threadId: thread.id };
  return c.json(response);
});

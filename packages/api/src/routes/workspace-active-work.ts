import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { decodePageCursor, readLimit } from "../lib/page-cursor.js";
import { listWorkspaceActiveWork } from "../services/workspace-active-work.js";
import type { OutcomeCursor } from "../services/workspace-outcomes.js";
import { authorizedWorkspaceOwner } from "./workspace-runtime.js";

export const workspaceActiveWorkRouter = new Hono<AppEnv>();
workspaceActiveWorkRouter.get("/:workspace/active-work", async c => {
  const owner = await authorizedWorkspaceOwner(c);
  if (!owner) return c.json({ error: "Workspace not found." }, 404);
  const limit = readLimit(c.req.query("limit"), 25, 100);
  if (limit === undefined) return c.json({ error: "Invalid limit. Use a positive whole number." }, 400);
  let cursor: OutcomeCursor | undefined;
  const raw = c.req.query("cursor");
  if (raw !== undefined) {
    const parsed = raw.length <= 4096 ? decodePageCursor(raw) : undefined;
    if (!parsed || parsed.feed !== "active-work" || parsed.orgId !== c.var.user.orgId || parsed.ownerType !== owner.type || parsed.ownerId !== owner.id
      || typeof parsed.at !== "number" || !Number.isSafeInteger(parsed.at) || parsed.at < 0
      || typeof parsed.id !== "string" || !parsed.id || parsed.id.length > 1024) {
      return c.json({ error: "Invalid cursor. Reload the active work list." }, 400);
    }
    cursor = { at: parsed.at, id: parsed.id };
  }
  return c.json(await listWorkspaceActiveWork(c.var.providers.db, c.var.user.orgId, owner, limit, cursor));
});

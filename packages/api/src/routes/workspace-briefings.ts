import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { getWorkspaceBriefings } from "../services/workspace-briefings.js";
import { authorizedWorkspaceOwner } from "./workspace-runtime.js";

export const workspaceBriefingsRouter = new Hono<AppEnv>();
workspaceBriefingsRouter.get("/:workspace/briefings", async c => {
  const owner = await authorizedWorkspaceOwner(c);
  if (!owner) return c.json({ error: "Workspace not found." }, 404);
  return c.json(await getWorkspaceBriefings(c.var.providers.db,c.var.user.orgId,owner));
});

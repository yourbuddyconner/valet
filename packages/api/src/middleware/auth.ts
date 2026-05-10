import type { MiddlewareHandler } from "hono";
import { LOCAL_ORG, LOCAL_USER } from "../providers/node.js";

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  role: "admin" | "member";
  orgId: string;
}

/**
 * Auth is intentionally stub-only in this package. Real OAuth lives in the
 * legacy worker; here, requests run as a single hardcoded local user.
 *
 * Set `VALET_LOCAL_AUTH=1` to opt in. Without it, every `/api/*` request 401s.
 */
export const authMiddleware: MiddlewareHandler = async (c, next) => {
  if (process.env.VALET_LOCAL_AUTH !== "1") {
    return c.json({ error: "auth not configured (set VALET_LOCAL_AUTH=1)" }, 401);
  }
  c.set("user", {
    id: LOCAL_USER.id,
    email: LOCAL_USER.email,
    name: LOCAL_USER.name,
    role: LOCAL_USER.role,
    orgId: LOCAL_ORG.id,
  } satisfies AuthUser);
  await next();
};

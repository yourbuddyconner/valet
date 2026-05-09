import type { MiddlewareHandler } from "hono";
import type { Providers } from "../providers/types.js";

/**
 * Inject the per-process Providers bundle onto every request. Built once at
 * boot in `main.ts`; routes read via `c.var.providers`.
 */
export function providersMiddleware(providers: Providers): MiddlewareHandler {
  return async (c, next) => {
    c.set("providers", providers);
    await next();
  };
}

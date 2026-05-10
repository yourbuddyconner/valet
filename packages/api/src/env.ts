import type { AuthUser } from "./middleware/auth.js";
import type { Providers } from "./providers/types.js";

/**
 * Hono request context shape for every route in this package.
 *
 * - `providers` is set by `providersMiddleware` at boot.
 * - `user` is set by `authMiddleware` for routes mounted under `/api/*`.
 */
export interface AppVariables {
  providers: Providers;
  user: AuthUser;
}

export type AppEnv = { Variables: AppVariables };

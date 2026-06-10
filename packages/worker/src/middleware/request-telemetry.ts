import type { MiddlewareHandler } from 'hono';
import { ValetError } from '@valet/shared';
import type { Env, Variables } from '../env.js';
import { recordRequestMetric, resolveSampleRate, shouldSample } from '../lib/request-telemetry.js';

/** Parse a Content-Length header into a non-negative byte count, or null if absent/invalid. */
function parseContentLength(value: string | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Times each REST API request and records its latency to `request_metrics`.
 *
 * Scope is deliberately the `/api/*` surface — the synchronous latency real users
 * wait on. The `/agent/*` proxy (long-lived IDE/VNC/terminal streams) would skew
 * the distribution, and CORS preflights carry no useful signal.
 *
 * Recording is fire-and-forget via `ctx.waitUntil`, so it adds zero latency to the
 * response it measures, and the whole emit path is guarded — telemetry must never
 * break or slow the request it observes.
 */
export const requestTelemetry: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  if (c.req.method === 'OPTIONS' || !c.req.path.startsWith('/api/')) {
    return next();
  }

  const start = Date.now();
  let status = 500;
  try {
    await next();
    status = c.res.status;
  } catch (err) {
    // Thrown errors are rendered downstream by the error handler; capture the
    // status they will resolve to, then rethrow so that handler still runs.
    status = err instanceof ValetError ? err.statusCode : 500;
    throw err;
  } finally {
    try {
      const durationMs = Date.now() - start;
      if (shouldSample(status, resolveSampleRate(c.env))) {
        const entry = {
          method: c.req.method,
          route: c.req.routePath, // low-cardinality pattern, e.g. /api/sessions/:id
          status,
          durationMs,
          requestId: c.get('requestId') ?? null, // pivots to the full request log
          requestBytes: parseContentLength(c.req.header('content-length')),
          userId: c.get('user')?.id ?? null,
        };
        // c.get('db') is the per-request Drizzle instance set by dbMiddleware,
        // which runs inside next() and is therefore available here in finally.
        c.executionCtx.waitUntil(
          recordRequestMetric(c.get('db'), entry).catch((err) => {
            console.error('[request-telemetry] failed to record request metric:', err);
          }),
        );
      }
    } catch (err) {
      // Never let telemetry surface an error into the request path.
      console.error('[request-telemetry] middleware error:', err);
    }
  }
};

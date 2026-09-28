/**
 * Hono app factory. Wiring lives here; main.ts only handles boot + listen.
 *
 * Splitting `createApp(providers)` from `main.ts` keeps tests fast (build a
 * test app with stub providers, no node-server). It also keeps boot-time
 * I/O (open sqlite, build providers) out of the hot test path.
 */
import { TeamAdminRequiredError, teamAdminRefusal } from "./services/team-deletion-access.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ValetError } from "@valet/shared";
import type { AppEnv } from "./env.js";
import type { RunningServer, ServerAdapter } from "./server-adapter.js";
import { nodeServerAdapter } from "./server-adapter.node.js";
import type { Providers } from "./providers/types.js";
import { providersMiddleware } from "./middleware/providers.js";
import { buildAuthMiddleware, refuseTeamKeyOutsideScope } from "./middleware/auth.js";
import { filterTeamKeysFromPersonalApiKeyList } from "./lib/personal-api-key-list.js";
import { teamIdFromApiKeyMetadata } from "./lib/request-principal.js";
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata, type ValetAuth } from "./auth/index.js";
import { mcpHandler } from "./auth/mcp.js";
import type { AuthConfig } from "./auth/config.js";
import type { AuthConfigResponse, HealthResponse, ReadyResponse } from "./wire/types.js";
import { VALET_VERSION } from "./version.js";
import { parseSandboxBackend } from "./providers/sandbox-backend.js";
import { sessionsRouter, listStandaloneSessions } from "./routes/sessions.js";
import { evalsRouter, ratingsRouter } from "./routes/ratings.js";
import { messagesRouter } from "./routes/messages.js";
import { adminRouter } from "./routes/admin.js";
import { teamDeletionRequestsRouter } from "./routes/team-deletion-requests.js";
import { teamsRouter } from "./routes/teams.js";
import { teamApiKeysRouter } from "./routes/team-api-keys.js";
import { memoryRouter } from "./routes/memory.js";
import { securityRouter } from "./routes/security.js";
import { workspaceRuntimeRouter } from "./routes/workspace-runtime.js";
import { childWorkRouter } from "./routes/child-work.js";
import { notificationsRouter } from "./routes/notifications.js";
import { changelogRouter } from "./routes/changelog.js";
import { workflowPreviewRouter } from "./routes/workflow-preview.js";
import { workflowTriggersRouter } from "./routes/workflow-triggers.js";
import { workflowConversationRouter } from "./routes/workflow-conversation.js";
import { workflowsRouter } from "./routes/workflows.js";
import { pluginsRouter } from "./routes/plugins.js";
import { templatesRouter } from "./routes/templates.js";
import { skillsRouter } from "./routes/skills.js";
import { credentialsRouter } from "./routes/credentials.js";
import { onePasswordRouter } from "./routes/onepassword.js";
import { sandboxSecretsRouter } from "./routes/sandbox-secrets.js";
import { credentialConnectRouter } from "./routes/credential-connect.js";
import { identityLinksRouter } from "./routes/identity-links.js";
import { meRouter } from "./routes/me.js";
import { modelsRouter } from "./routes/models.js";
import { usageRouter } from "./routes/usage.js";
import { proxyUsageRouter } from "./routes/proxy-usage.js";
import { orgRouter } from "./routes/org.js";
import { orgInvitesRouter } from "./routes/org-invites.js";
import { orgSettingsRouter } from "./routes/org-settings.js";
import { modelTiersRouter } from "./routes/model-tiers.js";
import { approvedModelsRouter } from "./routes/approved-models.js";
import { orgReasoningRouter } from "./routes/org-reasoning.js";
import { llmProvidersRouter } from "./routes/llm-providers.js";
import { githubAppRouter, githubAppWebhookRouter } from "./routes/github-app.js";
import { githubConnectRouter } from "./routes/github-connect.js";
import { linearConnectRouter } from "./routes/linear-connect.js";
import { reposRouter } from "./routes/repos.js";
import { sourcesRouter, sourcesPublicRouter } from "./routes/sources.js";
import { sandboxGitCredentialRouter } from "./routes/sandbox-git-credential.js";
import { fileUploadRouter } from "./routes/sandbox-file-upload.js";
import { browserRouter } from "./routes/browser.js";
import { profilePicturesPublicRouter, profilePicturesRouter } from "./routes/profile-pictures.js";
import { teamPoliciesRouter } from "./routes/team-policies.js";
import { policiesRouter, actionLogRouter } from "./routes/policies.js";
import { mePolicyOverridesRouter, meGrantsRouter } from "./routes/me-policies.js";
import { registerWsRoutes } from "./routes/ws.js";
import { registerGatewayHttpProxy, registerGatewayWsProxy } from "./routes/gateway-proxy.js";
import { registerProxyGateway } from "./routes/proxy-gateway.js";
import { channelsRouter } from "./routes/channels.js";
import { slackWebhookRouter } from "./routes/slack-webhook.js";
import { slackAppRouter } from "./routes/slack-app.js";
import { SLACK_WEBHOOK_MOUNT } from "./services/slack-app.js";
import { eventWebhooksRouter } from "./routes/event-webhooks.js";
import { workflowHooksRouter } from "./routes/workflow-hooks.js";
import { artifactsRouter, buildArtifactsPublicRouter } from "./routes/artifacts.js";
import { eventReceiptsRouter } from "./routes/event-receipts.js";
import { eventsRouter } from "./routes/events.js";
import { mountWebStatic } from "./static-web.js";
import { traceRequests } from "./observability/http-middleware.js";

export interface CreatedApp {
  app: Hono<AppEnv>;
  /**
   * Start listening on `port` and attach the WS upgrade handler, using the
   * runtime adapter passed to `createApp`. Returns a uniform handle whose
   * `close()` stops the socket. The WS `attach` token is captured internally,
   * so callers never touch runtime-specific plumbing.
   */
  startServer(opts: { port: number; onListen?: (port: number) => void }): RunningServer;
  /** True when `opts.webDistDir` pointed at a real build and the SPA was
   * mounted. `false` when unset (dev mode) OR set-but-missing-index.html —
   * the caller distinguishes those two (a set-but-unmounted dist is fatal). */
  webServed: boolean;
}

export interface CreateAppOpts {
  /**
   * Absolute path to the built `@valet/web` output (`vite build`'s `dist`).
   * Only set by `main.ts` in the bundled production image via
   * `VALET_WEB_DIST_DIR` — unset in `make dev-local`, where Vite's own dev
   * server serves the web app. See `static-web.ts`.
   */
  webDistDir?: string;
  /**
   * Readiness source for `GET /api/ready`. `main.ts` passes a callback that
   * flips true once the boot chain's traffic-protecting steps (session
   * restore, child-watch re-arm, config reconcile) complete — the k8s
   * readinessProbe reads it, so a new pod takes traffic only after that
   * work is done, while `/api/health` (liveness/startup) answers from the
   * moment the port binds. Absent → always ready (test harnesses and
   * embedded callers have no boot chain).
   */
  isReady?: () => boolean;
}

/**
 * Real-auth wiring — both fields are only present when `BETTER_AUTH_SECRET`
 * resolved a config (auth-v2 design). Absent → stub-only mode (today's
 * `VALET_LOCAL_AUTH` behavior), and `GET /api/auth-config` reports
 * `{ stub: true }`.
 */
export interface AuthWiring {
  auth?: ValetAuth;
  authConfig?: AuthConfig;
}

export function createApp(
  providers: Providers,
  authWiring: AuthWiring = {},
  opts: CreateAppOpts = {},
  // Default to the Node adapter so the many HTTP-only test callers (and the
  // node bundle) need no change. Under Bun, `main.ts` passes the Bun adapter
  // explicitly via `selectServerAdapter()` — the Node adapter's `serve` /
  // `createWebSocket` are then never called. The Node adapter is import-safe
  // under Bun; only `hono/bun` (the Bun adapter's dep) is not import-safe
  // under Node, and it is never statically imported here.
  adapter: ServerAdapter = nodeServerAdapter,
): CreatedApp {
  const app = new Hono<AppEnv>();
  const { auth, authConfig } = authWiring;

  // One server span per request (no-op unless the OTLP SDK is registered —
  // see observability/otel.ts). First in the chain so every downstream
  // middleware and handler runs inside the request's active span context.
  app.use("*", traceRequests());
  app.use("*", logger());
  app.use(
    "*",
    cors({
      origin: (origin) => origin ?? "*",
      credentials: true,
    }),
  );
  app.use("*", providersMiddleware(providers));

  // LLM recording proxy — /proxy/anthropic/* and /proxy/openai/*. Uses its
  // own vlt_ key auth (resolveProxyPrincipal); intentionally outside /api/*
  // so it never hits the cookie/session auth ladder. Placed here, after
  // `providersMiddleware`, so `c.var.providers` is available inside the handler.
  // Stub mode (no real auth instance) passes a verifyApiKey that always 401s —
  // the proxy requires real vlt_ keys.
  registerProxyGateway(app, {
    verifyApiKey: auth
      ? async (opts) => {
          const r = await auth.api.verifyApiKey({ body: opts });
          // Bridge ValetApiKeyRecord (referenceId, metadata) → PrincipalDeps
          // (userId, teamId). The team id rides along so the gateway can
          // resolve the team instead of billing the creating admin.
          return {
            valid: r.valid,
            key: r.key
              ? { id: r.key.id, userId: r.key.referenceId, teamId: teamIdFromApiKeyMetadata(r.key.metadata) }
              : null,
          };
        }
      : async () => ({ valid: false, key: null }),
  });

  // Public channel ingress (webhooks) — verification is transport-level
  // (`ChannelHost.handleWebhook` → `transport.verifyWebhook`), not the auth
  // gate below, since the caller is the provider (Telegram etc.), not a
  // logged-in Valet user. Mounting BEFORE `buildAuthMiddleware` is what
  // makes this route public — do not move it below that line.
  //
  // Slack gets its own ingress, mounted first so the more specific path
  // beats `channelsRouter`'s `/:channelType/webhook`. Slack delivers Events
  // API traffic and interactivity to one app-level URL; that route verifies
  // the signing-secret HMAC once against the org credential's metadata and
  // fans each update out to both the channel host and the event pipeline.
  app.route(SLACK_WEBHOOK_MOUNT, slackWebhookRouter);
  app.route("/api/channels", channelsRouter);

  // PUBLIC GitHub App webhook ingress — same reasoning as `channelsRouter`
  // above: the caller is GitHub, not a logged-in Valet user; verification
  // is HMAC-signature-level (`X-Hub-Signature-256`) inside the router
  // itself, not the auth gate below. Mounted BEFORE `buildAuthMiddleware`
  // for the same reason `channelsRouter` is.
  app.route("/webhooks/github-app", githubAppWebhookRouter);

  // PUBLIC generic event-webhook ingress — same reasoning as the mounts
  // above: the caller is the provider (Linear etc.), not a logged-in Valet
  // user; verification is signature-level (plugin `TriggerDef.verify` over
  // the raw bytes) inside the router itself, not the auth gate below.
  app.route("/webhooks/events", eventWebhooksRouter);

  // PUBLIC arbitrary-URL workflow trigger ingress (overhaul design decision
  // 5) — same reasoning as the mounts above: the hookId in the URL IS the
  // credential (no logged-in Valet user), verified constant-time inside the
  // router itself (`workflow-hooks.ts`), not the auth gate below. This IS
  // under `/api/*`, so mounting it here, before `buildAuthMiddleware`'s
  // `/api/*` registration, is what keeps it public — do not move it below
  // that line.
  app.route("/api/hooks", workflowHooksRouter);

  // PUBLIC artifact read (artifacts design) — `GET /api/artifacts/:token`.
  // The token in the URL is the capability; the handler resolves the
  // caller itself (`resolveOptionalIdentity`) because `org`-visibility
  // artifacts still serve logged-in members. Mounted BEFORE
  // `buildAuthMiddleware` like the webhook mounts above — do not move it
  // below that line. The share/list/manage half of the surface is the
  // authed `artifactsRouter` mounted at the same prefix below the gate.
  app.route("/api/artifacts", buildArtifactsPublicRouter(auth ?? null));

  // PUBLIC profile-picture read. Slack fetches assistant icon URLs without a
  // Valet session, so only the server-derived path identifies the object.
  app.route("/avatars", profilePicturesPublicRouter);

  // Public health check (no auth). Carries the running binary's version and
  // the resolved sandbox backend so `valet status` can report client/server
  // versions + skew (single-binary CLI plan, T6; spec decisions 6 & 9).
  app.get("/api/health", (c) => {
    const body: HealthResponse = {
      ok: true,
      service: "valet-api",
      ts: Date.now(),
      version: VALET_VERSION,
      sandboxBackend: parseSandboxBackend(process.env.VALET_SANDBOX_BACKEND),
    };
    return c.json(body);
  });

  // Public readiness check (no auth). Health above answers as soon as the
  // port binds (liveness: "process up, event loop alive"); this one stays
  // 503 until the boot chain finishes, so the k8s readinessProbe holds
  // traffic off a pod that is still restoring — the pod is NEVER killed for
  // slow boot work, it just stays NotReady. See `main.ts`'s background boot
  // chain and the sha-a6eadbe rollout RCA that forced the split.
  app.get("/api/ready", (c) => {
    const ready = opts.isReady?.() ?? true;
    const body: ReadyResponse = { ready };
    return c.json(body, ready ? 200 : 503);
  });

  // better-auth owns everything under /api/auth/* (signup, login, session,
  // social + SSO callbacks, api-key endpoints, MCP OAuth). Mounted BEFORE
  // authMiddleware so it's public even when VALET_LOCAL_AUTH isn't set —
  // otherwise login/signup could never succeed in production.
  if (auth) {
    app.on(["POST", "GET"], "/api/auth/*", async (c) => {
      const res = await auth.handler(c.req.raw);
      return filterTeamKeysFromPersonalApiKeyList(c.req.path, res);
    });
    app.get("/.well-known/oauth-authorization-server", (c) => oAuthDiscoveryMetadata(auth)(c.req.raw));
    app.get("/.well-known/oauth-protected-resource", (c) => oAuthProtectedResourceMetadata(auth)(c.req.raw));

    // MCP endpoint (Task 9): public mount, `withMcpAuth` guards it with the
    // `mcp` plugin's own bearer-token check (401 + `WWW-Authenticate` on
    // missing/invalid/expired tokens) — not `authMiddleware`.
    const mcp = mcpHandler({
      auth,
      db: providers.db,
      listSessions: async (userId) => {
        const rows = await listStandaloneSessions(providers.db, userId);
        return rows.map((r) => ({ id: r.id, title: r.title, status: r.status }));
      },
    });
    app.all("/mcp", (c) => mcp(c.req.raw));
  }

  // Unauthenticated: drives `/login`/`/signup` control rendering.
  app.get("/api/auth-config", (c) => {
    const body: AuthConfigResponse = authConfig
      ? {
          stub: false,
          social: [
            ...(authConfig.social.google ? (["google"] as const) : []),
            ...(authConfig.social.github ? (["github"] as const) : []),
          ],
          sso: authConfig.oidc ? { name: authConfig.oidc.name } : null,
        }
      : { stub: true, social: [], sso: null };
    return c.json(body);
  });

  // Everything under /api/* requires auth (stub in dev; 401 otherwise).
  app.use("/api/*", buildAuthMiddleware({ auth: auth ?? null, db: providers.db }));
  app.use("/api/*", refuseTeamKeyOutsideScope());

  app.route("/api/sessions", childWorkRouter);
  app.route("/api/sessions", sessionsRouter);
  // Messages + threads + file uploads + security + ratings share /api/sessions/:id/* — mounted under same prefix.
  app.route("/api/sessions", messagesRouter);
  app.route("/api/sessions", fileUploadRouter);
  app.route("/api/sessions", browserRouter);
  app.route("/api/sessions", securityRouter);
  app.route("/api/sessions", ratingsRouter);
  app.route("/api/evals", evalsRouter);
  app.route("/api/admin", adminRouter);
  app.route("/api/teams", teamDeletionRequestsRouter);
  app.route("/api/teams", teamsRouter);
  app.route("/api/teams", teamApiKeysRouter);
  app.route("/api/memory", memoryRouter);
  // Authed artifact surface (share/list/manage). The public `GET /:token`
  // half is mounted pre-auth above.
  app.route("/api/artifacts", artifactsRouter);
  app.route("/api/workspaces", workspaceRuntimeRouter);

  app.route("/api", profilePicturesRouter);
  app.route("/api/notifications", notificationsRouter);
  app.route("/api/changelog", changelogRouter);
  // Trigger routes first: workflowsRouter's `GET /:id` would otherwise
  // swallow `/triggers` and `/runs` as workflow ids.
  app.route("/api/workflows", workflowTriggersRouter);
  // Preview before the CRUD router for the same reason: `POST /:id/preview`
  // must not be read as a path under one of its routes.
  app.route("/api/workflows", workflowPreviewRouter);
  app.route("/api/workflows", workflowConversationRouter);
  app.route("/api/workflows", workflowsRouter);
  app.route("/api/templates", templatesRouter);
  app.route("/api/plugins", pluginsRouter);
  app.route("/api/skills", skillsRouter);
  app.route("/api/credentials", credentialConnectRouter);
  app.route("/api/credentials", credentialsRouter);
  app.route("/api/onepassword", onePasswordRouter);
  app.route("/api/sandbox-secrets", sandboxSecretsRouter);
  // Mounted BEFORE /api/me — defensive ordering only: meRouter today
  // registers just GET / and PATCH / (no wildcard/param routes), so there is
  // no actual collision to lose. Revisit this ordering if /api/me ever grows
  // a catch-all route that could shadow /api/me/identity-links.
  app.route("/api/me/identity-links", identityLinksRouter);
  // Mounted BEFORE /api/me for the same defensive-ordering reason as
  // identityLinksRouter above.
  app.route("/api/me/github", githubConnectRouter);
  app.route("/api/me", meRouter);
  app.route("/api/models", modelsRouter);
  app.route("/api/usage", usageRouter);
  app.route("/api/proxy", proxyUsageRouter);
  app.route("/api/org", orgRouter);
  app.route("/api/org/settings", orgSettingsRouter);
  app.route("/api/org/model-tiers", modelTiersRouter);
  app.route("/api/org/approved-models", approvedModelsRouter);
  app.route("/api/org/reasoning", orgReasoningRouter);
  app.route("/api/org/invites", orgInvitesRouter);
  app.route("/api/org/llm-providers", llmProvidersRouter);
  app.route("/api/org/policies", policiesRouter);
  app.route("/api/teams", teamPoliciesRouter);
  app.route("/api/org/action-log", actionLogRouter);
  // Same defensive-ordering note as identityLinksRouter/githubConnectRouter
  // above: meRouter has no wildcard route today, so there's no real
  // collision — mounted after /api/me for readability (grouped with the
  // other policy routes) rather than before it.
  app.route("/api/me/policy-overrides", mePolicyOverridesRouter);
  app.route("/api/me/grants", meGrantsRouter);
  app.route("/api/org/github-app", githubAppRouter);
  app.route("/api/org/linear", linearConnectRouter);
  app.route("/api/org/slack", slackAppRouter);
  app.route("/api/org/sources", sourcesRouter);
  app.route("/api/sources", sourcesPublicRouter);
  app.route("/api/repos", reposRouter);
  app.route("/api/sandbox", sandboxGitCredentialRouter);
  // Mounted at /api (not /api/events) because the router carries both the
  // /events* and /event-subscriptions* path families. Placed after every
  // more-specific /api/* router above so nothing gets shadowed.
  app.route("/api", eventReceiptsRouter);
  app.route("/api", eventsRouter);

  // WebSocket — must be registered against the same Hono instance the runtime
  // WS handler was constructed with. The adapter's `serve` (returned in
  // `startServer` below) attaches the upgrade handler at listen time (Node:
  // `injectWebSocket(server)`; Bun: `Bun.serve({ websocket })`).
  const { upgradeWebSocket, serve } = adapter.createWebSocket(app);
  registerWsRoutes(app, upgradeWebSocket);
  // Gateway reverse-proxy: WS upgrade `GET` registered before the HTTP
  // `ALL` on the same `/api/sessions/:id/gateway/*` path — `upgradeWebSocket`
  // only engages on `Upgrade: websocket`, so ordering here is what lets the
  // HTTP handler still answer everything else on that path.
  registerGatewayWsProxy(app, upgradeWebSocket);
  registerGatewayHttpProxy(app);

  // Web app static serving + SPA fallback — registered LAST (decision 3):
  // every real route above must get first crack at a request. No-op unless
  // `opts.webDistDir` points at a real build (has index.html).
  const webServed = mountWebStatic(app, opts.webDistDir);

  // Default 404 for anything no route (or the SPA fallback above) claimed —
  // JSON, not Hono's plain-text default, so `/api/*` typos and unmounted
  // `/mcp`/`/.well-known/*` routes 404 as JSON rather than falling through
  // to an HTML page.
  app.notFound((c) => c.json({ error: "not found" }, 404));

  // Final fallback for anything thrown out of a route handler. Without this,
  // Hono returns a generic 500 with the HTML error page; we want JSON.
  // Service errors that declare their own HTTP status keep it when a route
  // lets one escape — a client-caused refusal reported as 500 reads as a
  // server fault and invites retries that can never succeed. Only errors
  // that OPTED IN qualify: a ValetError subclass, or the repo's ad-hoc
  // service-error convention of a numeric `statusCode` PLUS a string
  // `code` (e.g. ArchivedAssistantError). A bare third-party error with an
  // upstream statusCode stays a 500 — relabeling it as a client fault
  // would hide a server-side failure from alerting.
  app.onError(async (err, c) => {
    if (err instanceof TeamAdminRequiredError) return c.json(await teamAdminRefusal(c.var.providers.db, c.var.user.orgId, err), 403);
    console.error(`route error ${c.req.method} ${c.req.path}:`, err);
    const duck = err as { statusCode?: unknown; code?: unknown };
    const declared =
      err instanceof ValetError
        ? err.statusCode
        : typeof duck.statusCode === "number" && typeof duck.code === "string"
          ? duck.statusCode
          : undefined;
    const status =
      typeof declared === "number" && declared >= 400 && declared <= 599 ? declared : 500;
    return c.json(
      {
        error: err.message ?? "internal error",
        code: (err as NodeJS.ErrnoException).code,
      },
      // Runtime-validated 4xx/5xx above; Hono's closed union cannot narrow
      // a checked number.
      status as ContentfulStatusCode,
    );
  });

  return {
    app,
    startServer: (startOpts) => serve(startOpts),
    webServed,
  };
}

export type App = ReturnType<typeof createApp>["app"];

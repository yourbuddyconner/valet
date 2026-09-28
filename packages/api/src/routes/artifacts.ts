/**
 * Artifact routes (2026-08-22 artifacts design; 2026-09-02 artifact-pages
 * design).
 *
 * Two routers over one table, split by trust:
 *
 *   - `buildArtifactsPublicRouter` — the token-addressed surface, mounted
 *     BEFORE `buildAuthMiddleware` in app.ts (the webhook-mount pattern).
 *     The token is the capability; each handler resolves the caller itself
 *     via `resolveOptionalIdentity` because `org`-visibility artifacts serve
 *     logged-in org members and 401 everyone else, while `public` ones
 *     (org opt-in) serve anonymously. Comments live here too — the page
 *     only knows its token — but always REQUIRE a resolved same-org user.
 *     A factory, not a module-level router, because it needs the
 *     `ValetAuth` instance and its own per-IP rate limiter.
 *   - `artifactsRouter` — share/list/manage, mounted behind the normal
 *     auth middleware. `POST /share` also serves the `mem_share` and
 *     `artifact_publish` tools via the internal-token header pair, resolved
 *     through the memory routes' `resolveScope` chokepoint.
 *
 * Share authorization is READ-level (`resolveScope(c, "read")`): sharing
 * needs no more authority than reading, because a reader can already copy
 * the content anywhere. Managing an existing artifact (widen/revoke/pin)
 * requires being its sharer or an org admin. Team ownership requires live
 * membership on reads, comments, lists, and management, regardless of visibility.
 */
import { Hono, type Context } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import type { AppEnv } from "../env.js";
import type { ValetAuth } from "../auth/index.js";
import type { AppDb } from "../lib/drizzle.js";
import { decodePageCursor, encodePageCursor, readLimit } from "../lib/page-cursor.js";
import { resolveOrgId } from "../lib/org.js";
import { agentSessions, users } from "../schema/index.js";
import { requireActingUser, requirePrincipal, requireUser, resolveOptionalIdentity, type AuthUser, type RequestIdentity } from "../middleware/auth.js";
import { userPrincipal } from "../lib/request-principal.js";
import { publicUrlFromEnv } from "../channels/host.js";
import { WorkflowWebhookRateLimiter } from "../workflows/webhook-service.js";
import { isOrgAdmin } from "../services/org.js";
import { canViewSession } from "../services/session-access.js";
import { handleServiceError, resolveScope } from "./memory.js";
import { promptAuthorFromUser, submitSessionPrompt } from "./messages.js";
import {
  addArtifactComment,
  copyArtifactToTeam,
  decideArtifactAccess,
  getAllowPublicArtifacts,
  getArtifactById,
  getArtifactByToken,
  getArtifactComment,
  hasArtifactTeamAccess,
  listArtifactComments,
  listArtifacts,
  listArtifactsForOwner,
  listArtifactVersions,
  markArtifactCommentSent,
  publishArtifact,
  resolveArtifactComment,
  resolveServedVersion,
  revokeArtifactById,
  revokeArtifactByPath,
  setArtifactSharedVersion,
  setArtifactVisibility,
  shareArtifact,
  type ArtifactScope,
  type ArtifactCommentRow,
  type ArtifactRow,
  type ArtifactSummaryRow,
} from "../services/artifacts.js";
import type {
  AddArtifactCommentRequest,
  AddArtifactCommentResponse,
  ArtifactCommentWire,
  ArtifactListItem,
  GetArtifactResponse,
  ListArtifactCommentsResponse,
  ListArtifactsResponse,
  ListArtifactVersionsResponse,
  PatchArtifactRequest,
  ShareArtifactRequest,
  ShareArtifactResponse,
} from "../wire/types.js";

/** `BETTER_AUTH_URL`'s origin, even when `publicUrlFromEnv` rejects it
 * (http, localhost, `*.localdev`). Those are still the address users load
 * the app FROM in dev and localdev deploys — unlike the request origin. */
function authUrlOrigin(env: NodeJS.ProcessEnv): string | undefined {
  if (!env.BETTER_AUTH_URL) return undefined;
  try {
    return new URL(env.BETTER_AUTH_URL).origin;
  } catch {
    return undefined;
  }
}

/** Share-link base, in trust order: the deployment's public URL
 * (`VALET_PUBLIC_URL` / public https `BETTER_AUTH_URL` — the chain
 * webhook registration uses), else `BETTER_AUTH_URL`'s origin verbatim,
 * else the origin the request arrived on. The last resort is only right
 * for browser-originated requests; a `mem_share` tool call reaches this
 * process over its own loopback (`apiBaseUrl` in `main.ts`), so without
 * the `BETTER_AUTH_URL` rung every helm/localdev deploy would mint
 * unreachable `http://127.0.0.1:8788/a/…` links. */
function shareUrlBase(c: Context<AppEnv>): string {
  return publicUrlFromEnv(process.env) ?? authUrlOrigin(process.env) ?? new URL(c.req.url).origin;
}

function shareUrl(c: Context<AppEnv>, token: string): string {
  return `${shareUrlBase(c)}/a/${token}`;
}

function toListItem(c: Context<AppEnv>, row: ArtifactSummaryRow): ArtifactListItem {
  return {
    id: row.id,
    sourceSessionId: row.sourceSessionId,
    sourceThreadId: row.sourceThreadId,
    path: row.sourceMemoryPath,
    title: row.title,
    format: row.format === "html" ? "html" : "markdown",
    icon: row.icon,
    version: row.version,
    sharedVersion: row.sharedVersion,
    token: row.token,
    url: shareUrl(c, row.token),
    visibility: row.visibility,
    ownerType: row.ownerType,
    actorUserId: row.actorUserId,
    revoked: row.revokedAt !== null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── Public read ───────────────────────────────────────────────────────

/** Generous per-IP bound on token guessing. 128-bit tokens make guessing
 * hopeless anyway; the limiter just keeps a scanner from being free. */
const PUBLIC_READ_LIMIT = 120;
const PUBLIC_READ_WINDOW_MS = 60_000;

/** The socket peer address, when the runtime exposes it. `@hono/node-server`
 * hands the raw `IncomingMessage` through `c.env.incoming`; other adapters
 * (Bun) don't, and this narrows to `undefined` there. */
function socketAddress(c: Context<AppEnv>): string | undefined {
  const env: unknown = c.env;
  if (typeof env !== "object" || env === null || !("incoming" in env)) return undefined;
  const incoming = (env as { incoming: unknown }).incoming;
  if (typeof incoming !== "object" || incoming === null || !("socket" in incoming)) return undefined;
  const socket = (incoming as { socket: unknown }).socket;
  if (typeof socket !== "object" || socket === null || !("remoteAddress" in socket)) return undefined;
  const addr = (socket as { remoteAddress: unknown }).remoteAddress;
  return typeof addr === "string" ? addr : undefined;
}

/**
 * Rate-limit key for one client. `x-forwarded-for` is client-supplied, so
 * it is only trusted when `VALET_TRUST_PROXY=1` says a proxy that strips
 * inbound XFF (the helm ingress) fronts this process — otherwise a direct
 * caller could rotate spoofed values for a fresh bucket per request.
 * Untrusted mode keys on the socket peer address, which a client cannot
 * choose. "direct" is the last resort when neither exists (non-node
 * adapters), collapsing to one shared bucket — safe, but coarse.
 */
function clientKey(c: Context<AppEnv>): string {
  if (process.env.VALET_TRUST_PROXY === "1") {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return socketAddress(c) ?? "direct";
}

/** A viewer who may also comment: logged in, same org. Anonymous readers of
 * a `public` artifact — and logged-in members of a DIFFERENT org — see the
 * page with no comment surface: there is no author identity or abuse
 * boundary to attach a comment to. */
function mayComment(artifact: ArtifactRow, user: AuthUser | undefined): user is AuthUser {
  return user !== undefined && user.orgId === artifact.orgId;
}

const TEAM_KEY_ARTIFACT_MESSAGE =
  "A team API key can only read public artifacts. Sign in or use a personal API key for org pages and comments.";

/**
 * The caller on the pre-auth artifact surface. This router is mounted
 * before `refuseTeamKeyOutsideScope`, so it applies that gate itself: a
 * team key never reads as the creating admin here. It counts as anonymous
 * (`user` undefined), which lets it read a public artifact and nothing
 * else, and `teamKey` lets the route name the fix instead of asking a
 * key to log in.
 */
async function resolveArtifactCaller(
  c: Context<AppEnv>,
  auth: ValetAuth | null,
): Promise<{ user: AuthUser | undefined; teamKey: boolean }> {
  const identity: RequestIdentity | undefined = await resolveOptionalIdentity(c, { auth, db: c.var.providers.db });
  if (identity?.principal.type === "team") return { user: undefined, teamKey: true };
  return { user: identity?.user, teamKey: false };
}

/** Resolve the artifact + caller for a token-addressed comment route.
 * Returns a Response for every failure so handlers stay linear. */
async function loadCommentContext(
  c: Context<AppEnv>,
  auth: ValetAuth | null,
): Promise<{ artifact: ArtifactRow; user: AuthUser } | { error: Response }> {
  const { db } = c.var.providers;
  const [artifact, caller] = await Promise.all([
    getArtifactByToken(db, c.req.param("token")),
    resolveArtifactCaller(c, auth),
  ]);
  if (!artifact) return { error: c.json({ error: "not found" }, 404) };
  if (caller.teamKey) return { error: c.json({ error: TEAM_KEY_ARTIFACT_MESSAGE }, 403) };
  const { user } = caller;
  const allowPublic =
    artifact.visibility === "public" ? await getAllowPublicArtifacts(db, artifact.orgId) : false;
  const access = decideArtifactAccess({
    artifact, allowPublicArtifacts: allowPublic, user,
    teamMember: await hasArtifactTeamAccess(db, artifact, user),
  });
  if (access.kind === "not_found") return { error: c.json({ error: "not found" }, 404) };
  if (access.kind !== "serve" || !mayComment(artifact, user)) {
    return {
      error: c.json(
        { error: "Comments need a logged-in member of the organization this page belongs to." },
        401,
      ),
    };
  }
  return { artifact, user };
}

/** Whether `user`'s `sendToSession` would deliver: the artifact records a
 * source session and the caller could open that session and type into it
 * (`canViewSession` — the exact check the messages route applies), so
 * sending a comment grants nothing new. The comment routes admit users
 * only (`loadCommentContext`), so the caller is that user's principal. */
async function canSendToSourceSession(
  db: AppDb,
  artifact: ArtifactRow,
  user: AuthUser,
): Promise<{ ok: false } | { ok: true; row: typeof agentSessions.$inferSelect }> {
  if (!artifact.sourceSessionId) return { ok: false };
  const rows = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.id, artifact.sourceSessionId), eq(agentSessions.orgId, artifact.orgId)))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false };
  if (!(await canViewSession(db, row, userPrincipal(user.id)))) return { ok: false };
  return { ok: true, row };
}

/** Wire projection of one comment row plus its author's display name. */
function toCommentWire(row: ArtifactCommentRow, authorName: string): ArtifactCommentWire {
  return {
    id: row.id,
    vdid: row.vdid,
    parentId: row.parentId,
    body: row.body,
    authorUserId: row.authorUserId,
    authorName,
    version: row.version,
    sentToSession: row.sentToSession,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
  };
}

/** Display names for a set of authors, one query. Falls back to email, then
 * to the raw id for a deleted account. */
async function authorNames(db: AppDb, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.id, unique));
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.id, row.name || row.email || row.id);
  return map;
}

export function buildArtifactsPublicRouter(auth: ValetAuth | null): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  // The workflow-webhook limiter is a generic per-key sliding window —
  // reused here keyed by client IP rather than duplicating the class.
  const limiter = new WorkflowWebhookRateLimiter({
    windowMs: PUBLIC_READ_WINDOW_MS,
    limit: PUBLIC_READ_LIMIT,
  });

  router.get("/:token", async (c) => {
    // Never index a share URL, whatever the outcome.
    c.header("X-Robots-Tag", "noindex");

    if (!limiter.allow(clientKey(c), Date.now())) {
      return c.json({ error: "rate limited" }, 429);
    }

    const { db } = c.var.providers;
    // Independent lookups — overlap them; this is the anonymous hot path.
    const [artifact, caller] = await Promise.all([
      getArtifactByToken(db, c.req.param("token")),
      resolveArtifactCaller(c, auth),
    ]);
    if (!artifact) return c.json({ error: "not found" }, 404);
    const { user } = caller;
    // The opt-in only matters for `public` rows — skip the orgs read for
    // the default `org` visibility (`decideArtifactAccess` ignores it).
    const allowPublic =
      artifact.visibility === "public" ? await getAllowPublicArtifacts(db, artifact.orgId) : false;

    const access = decideArtifactAccess({
      artifact, allowPublicArtifacts: allowPublic, user,
      teamMember: await hasArtifactTeamAccess(db, artifact, user),
    });
    if (access.kind === "not_found") {
      return c.json({ error: "not found" }, 404);
    }
    if (access.kind === "login") {
      if (caller.teamKey) return c.json({ error: TEAM_KEY_ARTIFACT_MESSAGE }, 403);
      return c.json({ error: "This document is shared with a Valet organization. Log in to view it." }, 401);
    }

    // Sharer attribution only for logged-in org viewers (spec: yes for
    // `org`, no for `public`) — an anonymous reader learns no names.
    let sharedBy: string | undefined;
    if (user && user.orgId === artifact.orgId) {
      const sharerRows = await db
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, artifact.actorUserId))
        .limit(1);
      sharedBy = sharerRows[0]?.name || sharerRows[0]?.email || undefined;
    }

    const served = await resolveServedVersion(db, artifact);
    const body: GetArtifactResponse = {
      title: served.title,
      content: served.content,
      rendered: served.rendered,
      format: served.format,
      description: artifact.description,
      icon: artifact.icon,
      version: served.version,
      visibility: artifact.visibility,
      ownerType: artifact.ownerType,
      updatedAt: artifact.updatedAt,
      ...(sharedBy !== undefined ? { sharedBy } : {}),
      canComment: mayComment(artifact, user),
    };
    return c.json(body);
  });

  // ── Comments (token-addressed, same-org login required) ──────────────

  router.get("/:token/comments", async (c) => {
    c.header("X-Robots-Tag", "noindex");
    const loaded = await loadCommentContext(c, auth);
    if ("error" in loaded) return loaded.error;
    const { db } = c.var.providers;

    const rows = await listArtifactComments(db, loaded.artifact.id);
    const [names, send, orgAdmin] = await Promise.all([
      authorNames(db, rows.map((r) => r.authorUserId)),
      canSendToSourceSession(db, loaded.artifact, loaded.user),
      isOrgAdmin(db, loaded.user.orgId, loaded.user.id),
    ]);
    const body: ListArtifactCommentsResponse = {
      comments: rows.map((r) => toCommentWire(r, names.get(r.authorUserId) ?? r.authorUserId)),
      canSendToSession: send.ok,
      canResolveAll: loaded.artifact.actorUserId === loaded.user.id || orgAdmin,
    };
    return c.json(body);
  });

  router.post("/:token/comments", async (c) => {
    if (!limiter.allow(clientKey(c), Date.now())) {
      return c.json({ error: "rate limited" }, 429);
    }
    const loaded = await loadCommentContext(c, auth);
    if ("error" in loaded) return loaded.error;
    const { artifact, user } = loaded;
    const providers = c.var.providers;

    let body: AddArtifactCommentRequest;
    try {
      body = await c.req.json<AddArtifactCommentRequest>();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (typeof body.body !== "string") {
      return c.json({ error: "body is required" }, 400);
    }

    try {
      const row = await addArtifactComment(providers.db, {
        artifactId: artifact.id,
        version: artifact.version,
        vdid: typeof body.vdid === "string" ? body.vdid : undefined,
        parentId: typeof body.parentId === "string" ? body.parentId : undefined,
        body: body.body,
        authorUserId: user.id,
      });

      // Delivery to the agent is best-effort and never blocks the save: the
      // response reports what actually happened, so the UI cannot claim a
      // send that silently failed.
      let sent = false;
      if (body.sendToSession === true) {
        const send = await canSendToSourceSession(providers.db, artifact, user);
        if (send.ok) {
          const anchor = row.vdid ? `element ${row.vdid}` : "page";
          const text = `[artifact comment] on "${artifact.title}" (${anchor}): ${row.body}`;
          const resp = await submitSessionPrompt(providers, send.row, text, {
            author: promptAuthorFromUser(user),
            threadId: artifact.sourceThreadId ?? undefined,
          });
          if (resp) {
            await markArtifactCommentSent(providers.db, row.id, artifact.sourceSessionId);
            row.sentToSession = artifact.sourceSessionId;
            sent = true;
          }
        }
      }

      const names = await authorNames(providers.db, [user.id]);
      const resp: AddArtifactCommentResponse = {
        comment: toCommentWire(row, names.get(user.id) ?? user.id),
        sent,
      };
      return c.json(resp);
    } catch (err) {
      const mapped = handleServiceError(err);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw err;
    }
  });

  router.post("/:token/comments/:commentId/resolve", async (c) => {
    const loaded = await loadCommentContext(c, auth);
    if ("error" in loaded) return loaded.error;
    const { artifact, user } = loaded;
    const { db } = c.var.providers;

    const comment = await getArtifactComment(db, c.req.param("commentId"));
    if (!comment || comment.artifactId !== artifact.id) {
      return c.json({ error: "not found" }, 404);
    }
    const allowed =
      comment.authorUserId === user.id ||
      artifact.actorUserId === user.id ||
      (await isOrgAdmin(db, user.orgId, user.id));
    if (!allowed) {
      return c.json({ error: "only the commenter, the sharer, or an org admin can resolve a thread" }, 403);
    }
    try {
      const row = await resolveArtifactComment(db, comment.id, user.id);
      const names = await authorNames(db, [row.authorUserId]);
      return c.json(toCommentWire(row, names.get(row.authorUserId) ?? row.authorUserId));
    } catch (err) {
      const mapped = handleServiceError(err);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw err;
    }
  });

  return router;
}

// ─── Share + management (authed) ───────────────────────────────────────

export const artifactsRouter = new Hono<AppEnv>();

artifactsRouter.post("/copy-to-team", async (c) => {
  try {
    const scope = await resolveScope(c, "read");
    const body: unknown = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || !("artifactId" in body) || typeof body.artifactId !== "string" ||
        !("teamId" in body) || typeof body.teamId !== "string" || !body.teamId.trim() ||
        !("key" in body) || typeof body.key !== "string") {
      return c.json({ error: "Provide artifactId, teamId and a new key to copy a personal artifact." }, 400);
    }
    const db = c.var.providers.db;
    const row = await copyArtifactToTeam(db, scope, await orgIdForShare(c, db), { artifactId: body.artifactId, teamId: body.teamId, key: body.key });
    return c.json({ id: row.id, path: row.sourceMemoryPath, url: shareUrl(c, row.token), visibility: row.visibility }, 201);
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

artifactsRouter.post("/share", async (c) => {
  let scope: ArtifactScope;
  try {
    const resolved = await resolveScope(c, "read");
    // Only the verified internal-token branch lacks a request principal.
    scope = { ...resolved, principal: requirePrincipal(c) ?? resolved.owner };
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }

  let body: ShareArtifactRequest;
  try {
    body = await c.req.json<ShareArtifactRequest>();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const hasPath = typeof body.path === "string" && body.path.length > 0;
  const hasKey = typeof body.key === "string" && body.key.length > 0;
  if (hasPath === hasKey) {
    return c.json({ error: "pass exactly one of `path` (memory share) or `key` (inline publish)" }, 400);
  }

  const { db } = c.var.providers;
  try {
    const orgId = await orgIdForShare(c, db);
    if (body.revoke === true) {
      // `key` and `path` share the publish-key namespace, so one revoke
      // path serves both shapes.
      await revokeArtifactByPath(db, scope, hasPath ? body.path! : body.key!, orgId);
      return c.json({ ok: true });
    }

    const sourceSessionId = c.req.header("x-valet-session-id");
    const sourceThreadId = c.req.header("x-valet-thread-id");
    if (sourceThreadId !== undefined && !sourceSessionId) {
      return c.json({ error: "Send the source session with the source thread." }, 400);
    }
    if (sourceSessionId !== undefined) {
      // Source metadata controls discovery and comment delivery. The verified
      // publishing scope must own it, including calls with an internal token.
      const [source] = await db.select({ id: agentSessions.id }).from(agentSessions).where(and(
        eq(agentSessions.id, sourceSessionId), eq(agentSessions.orgId, orgId),
        eq(agentSessions.ownerType, scope.owner.type), eq(agentSessions.ownerId, scope.owner.id),
      )).limit(1);
      if (!source) return c.json({ error: "Source work not found. Publish from work in this workspace." }, 404);
      if (sourceThreadId !== undefined &&
          !(await c.var.providers.engineStore.getThread(sourceSessionId, sourceThreadId))) {
        return c.json({ error: "Source thread not found. Publish from a thread in the source work." }, 404);
      }
    }

    let row: ArtifactRow;
    if (hasPath) {
      row = await shareArtifact(db, scope, {
        path: body.path!,
        orgId,
        sourceSessionId,
        sourceThreadId,
      });
    } else {
      if (typeof body.content !== "string" || body.content.length === 0) {
        return c.json({ error: "content is required to publish with `key`" }, 400);
      }
      row = await publishArtifact(db, scope, {
        key: body.key!,
        content: body.content,
        format: body.format === "html" ? "html" : "markdown",
        title: typeof body.title === "string" ? body.title : undefined,
        description: typeof body.description === "string" ? body.description : undefined,
        icon: typeof body.icon === "string" ? body.icon : undefined,
        orgId,
        sourceSessionId,
        sourceThreadId,
      });
    }
    const resp: ShareArtifactResponse = {
      id: row.id,
      path: row.sourceMemoryPath,
      url: shareUrl(c, row.token),
      visibility: row.visibility,
      version: row.version,
      updatedAt: row.updatedAt,
    };
    return c.json(resp);
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

/** The artifact's auth boundary. A session caller's own org; internal
 * (tool) callers carry no user, so this deployment's single org resolves
 * the same way the auth middleware resolves it for everyone. */
async function orgIdForShare(c: Context<AppEnv>, db: AppDb): Promise<string> {
  const user = requireUser(c);
  if (user) return user.orgId;
  return resolveOrgId(db);
}

/** "1" or "true" — the same loose boolean-query convention as the rest of
 * this route (an owner filter's presence, not its value, gates it; `mine`
 * needs an explicit value because its absence is the default list). */
function truthyQuery(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

artifactsRouter.get("/", async (c) => {
  const user = requireActingUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const { db } = c.var.providers;

  // Owner filter (team dashboard design): `?ownerType=team&ownerId=<id>`
  // lists that team's artifacts. All callers need current membership.
  // Non-members get 404 (existence-hiding).
  const ownerType = c.req.query("ownerType");
  const ownerId = c.req.query("ownerId");
  const mine = truthyQuery(c.req.query("mine"));
  const sourceSessionId = c.req.query("sourceSessionId");
  const sourceThreadId = c.req.query("sourceThreadId");
  if (sourceSessionId === "" || sourceThreadId === "") {
    return c.json({ error: "Use nonempty source identifiers to filter artifacts." }, 400);
  }
  if (sourceThreadId !== undefined && !sourceSessionId) {
    return c.json({ error: "Send sourceSessionId with sourceThreadId to filter artifacts." }, 400);
  }

  // `mine` composes with nothing: it names a caller-scoped view, so pairing
  // it with an owner filter is an ambiguous request rather than one where
  // either reading obviously wins. 400, like the malformed-owner-filter
  // case just below, rather than silently picking a side.
  if (mine && (ownerType !== undefined || ownerId !== undefined)) {
    return c.json({ error: "mine cannot be combined with an owner filter." }, 400);
  }

  if ((c.req.query("limit") !== undefined || c.req.query("cursor") !== undefined || sourceSessionId !== undefined) &&
      ownerType === undefined && ownerId === undefined) {
    return c.json({ error: "Send an owner filter to paginate artifacts." }, 400);
  }

  if (mine) {
    // The legacy publisher-filtered view. Force `orgAdmin: false` even
    // for an org admin caller — admin status must never leak a colleague's
    // rows into a filter whose whole point is "just mine". Client-side
    // filtering on `actorUserId` had the same intent but failed open: if
    // `/api/me` errored, the filter compared against `undefined` and every
    // row was dropped, showing a false empty state.
    const rows = await listArtifacts(db, { id: user.id, orgId: user.orgId, orgAdmin: false });
    const body: ListArtifactsResponse = { artifacts: rows.map((row) => toListItem(c, row)) };
    return c.json(body);
  }

  if (ownerType !== undefined || ownerId !== undefined) {
    if ((ownerType !== "team" && ownerType !== "user") || !ownerId) {
      return c.json({ error: "Send ownerType=user or team with an ownerId." }, 400);
    }
    if (ownerType === "user") {
      if (ownerId !== user.id) return c.json({ error: "owner not found" }, 404);
    } else {
      const allowed = await hasArtifactTeamAccess(db, { ownerType, ownerId, orgId: user.orgId }, user);
      if (!allowed) return c.json({ error: "owner not found" }, 404);
    }
    const limitParam = c.req.query("limit");
    const cursorParam = c.req.query("cursor");
    const paged = limitParam !== undefined || cursorParam !== undefined || sourceSessionId !== undefined;
    const limit = readLimit(limitParam, 50, 100);
    if (limit === undefined) return c.json({ error: "Send a positive whole number for limit." }, 400);
    const decoded = cursorParam === undefined ? undefined : decodePageCursor(cursorParam);
    let cursor: { updatedAt: number; id: string } | undefined;
    if (cursorParam !== undefined) {
      if (!decoded || typeof decoded.updatedAt !== "number" || !Number.isSafeInteger(decoded.updatedAt) ||
          typeof decoded.id !== "string" || !decoded.id ||
          decoded.ownerType !== ownerType || decoded.ownerId !== ownerId || decoded.sourceSessionId !== sourceSessionId || decoded.sourceThreadId !== sourceThreadId) {
        return c.json({ error: "Invalid artifact cursor. Remove it to start at the first page." }, 400);
      }
      cursor = { updatedAt: decoded.updatedAt, id: decoded.id };
    }
    const rows = await listArtifactsForOwner(
      db, user.orgId, { type: ownerType, id: ownerId }, paged ? { limit, cursor, sourceSessionId, sourceThreadId } : undefined,
    );
    const visible = paged ? rows.slice(0, limit) : rows;
    const last = visible.at(-1);
    const body: ListArtifactsResponse = { artifacts: visible.map((row) => toListItem(c, row)) };
    if (paged) {
      body.nextCursor = rows.length > limit && last
        ? encodePageCursor({ updatedAt: last.updatedAt, id: last.id, ownerType, ownerId, ...(sourceSessionId ? { sourceSessionId } : {}), ...(sourceThreadId ? { sourceThreadId } : {}) })
        : null;
    }
    return c.json(body);
  }

  const orgAdmin = await isOrgAdmin(db, user.orgId, user.id);
  const rows = await listArtifacts(db, { id: user.id, orgId: user.orgId, orgAdmin });
  const body: ListArtifactsResponse = { artifacts: rows.map((row) => toListItem(c, row)) };
  return c.json(body);
});

/** Sharer-or-admin gate for managing one artifact. Wrong org or no row →
 * 404 (existence-hiding); right org but neither sharer nor admin → 403. */
async function loadManagedArtifact(
  c: Context<AppEnv>,
  user: AuthUser,
): Promise<{ row: ArtifactRow } | { error: Response }> {
  const { db } = c.var.providers;
  const row = await getArtifactById(db, c.req.param("id"));
  if (!row || row.orgId !== user.orgId || !(await hasArtifactTeamAccess(db, row, user))) {
    return { error: c.json({ error: "not found" }, 404) };
  }
  if (row.actorUserId !== user.id && !(await isOrgAdmin(db, user.orgId, user.id))) {
    return { error: c.json({ error: "only the sharer or an org admin can manage this artifact" }, 403) };
  }
  return { row };
}

artifactsRouter.get("/:id/versions", async (c) => {
  const user = requireActingUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const loaded = await loadManagedArtifact(c, user);
  if ("error" in loaded) return loaded.error;

  const { db } = c.var.providers;
  const versions = await listArtifactVersions(db, loaded.row.id);
  const body: ListArtifactVersionsResponse = { versions };
  return c.json(body);
});

artifactsRouter.patch("/:id", async (c) => {
  const user = requireActingUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  let body: PatchArtifactRequest;
  try {
    body = await c.req.json<PatchArtifactRequest>();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const hasVisibility = body.visibility !== undefined;
  const hasSharedVersion = "sharedVersion" in body;
  if (!hasVisibility && !hasSharedVersion) {
    return c.json({ error: "pass visibility and/or sharedVersion" }, 400);
  }
  if (hasVisibility && body.visibility !== "org" && body.visibility !== "public") {
    return c.json({ error: "visibility must be 'org' or 'public'" }, 400);
  }
  if (
    hasSharedVersion &&
    body.sharedVersion !== null &&
    (typeof body.sharedVersion !== "number" || !Number.isInteger(body.sharedVersion) || body.sharedVersion < 1)
  ) {
    return c.json({ error: "sharedVersion must be a positive version number or null for latest" }, 400);
  }

  const loaded = await loadManagedArtifact(c, user);
  if ("error" in loaded) return loaded.error;

  const { db } = c.var.providers;
  if (body.visibility === "public" && loaded.row.ownerType === "team") {
    return c.json({ error: "Team artifacts require team membership. Share the link with members of the owning team." }, 400);
  }
  if (body.visibility === "public" && !(await getAllowPublicArtifacts(db, user.orgId))) {
    return c.json(
      {
        error:
          "Public sharing is off for this organization. An org admin can enable it in Settings → Organization.",
      },
      400,
    );
  }

  try {
    let row = loaded.row;
    if (hasVisibility) {
      row = await setArtifactVisibility(db, row.id, body.visibility!, user.id);
    }
    if (hasSharedVersion) {
      row = await setArtifactSharedVersion(db, row.id, body.sharedVersion ?? null);
    }
    return c.json(toListItem(c, row));
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

artifactsRouter.delete("/:id", async (c) => {
  const user = requireActingUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const loaded = await loadManagedArtifact(c, user);
  if ("error" in loaded) return loaded.error;

  const { db } = c.var.providers;
  await revokeArtifactById(db, loaded.row.id);
  return c.json({ ok: true });
});

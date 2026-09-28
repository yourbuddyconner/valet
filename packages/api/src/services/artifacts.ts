/**
 * Artifact publishing (2026-08-22 artifacts design; 2026-09-02 artifact-pages
 * design): snapshot content into the `artifacts` table and serve it by
 * capability token.
 *
 * An artifact is a COPY at publish time, never a live reference — the public
 * read path must not reach into `memory_files` or a session. Re-publish on
 * the same key overwrites the snapshot, appends an `artifact_versions` row,
 * and keeps the token (the link stays stable); re-publish after a revoke
 * mints a fresh token so a leaked link stays dead.
 *
 * Every artifact is a page: `content` is the source, `format` names its
 * compiler, and `rendered` is the compiled body every viewer renders in the
 * sandboxed frame. Markdown compiles through GFM here, at publish, so the
 * web client never compiles.
 *
 * Visibility rules live in `decideArtifactAccess`, a pure function so the
 * whole matrix is unit-testable without an HTTP server: `org` needs a
 * logged-in member of the artifact's org; personal `public` pages need the
 * org opt-in. Team ownership always requires live membership.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, exists, isNull, lt, ne, or } from "drizzle-orm";
import { marked } from "marked";
import {
  NotFoundError,
  ValidationError,
  artifactSizeError,
  isArtifactFormat,
  normalizeArtifactIcon,
  resolveArtifactTitle,
  type ArtifactFormat,
} from "@valet/shared";
import type { Principal } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { normalizePath } from "../lib/okf.js";
import { artifactComments, artifactVersions, artifacts, orgMembers, orgs, teamMembers, teams } from "../schema/index.js";
import { getTeamInOrg, lockTeamForOwnership } from "./teams.js";
import { readFile, type MemoryScope } from "./memory.js";

export type ArtifactRow = typeof artifacts.$inferSelect;
export type ArtifactVersionRow = typeof artifactVersions.$inferSelect;
export type ArtifactCommentRow = typeof artifactComments.$inferSelect;
export type ArtifactVisibility = "org" | "public";

export interface ArtifactScope extends MemoryScope {
  /** Verified caller. Internal tools use their authenticated owner principal. */
  principal?: Principal;
}

/** Both rows authorize a human. Mutation callers hold SHARE locks until commit,
 * so deleting either membership cannot race a successful publication or revoke. */
function artifactMemberships(db: AppDb, orgId: string, teamId: string, userId: string) {
  return db.select({ userId: orgMembers.userId }).from(orgMembers)
    .innerJoin(teamMembers, eq(teamMembers.userId, orgMembers.userId))
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(and(
      eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId),
      eq(teams.orgId, orgId), eq(teams.id, teamId),
    ));
}

async function requireTeamArtifactScope(db: AppDb, scope: ArtifactScope, orgId: string, lockMemberships = false): Promise<void> {
  const caller = scope.principal ?? { type: "user", id: scope.actorUserId };
  if (caller.type === "team" && (scope.owner.type !== "team" || scope.owner.id !== caller.id)) {
    throw new NotFoundError("owner", scope.owner.id);
  }
  if (scope.owner.type !== "team") return;
  if (caller.type === "team") {
    if (!await getTeamInOrg(db, orgId, scope.owner.id)) throw new NotFoundError("owner", scope.owner.id);
    return;
  }
  const memberships = artifactMemberships(db, orgId, scope.owner.id, caller.id);
  const rows = await (lockMemberships ? memberships.for("share", { of: [orgMembers, teamMembers] }) : memberships);
  if (!rows.length) throw new NotFoundError("owner", scope.owner.id);
}

/** 128 bits of entropy, base64url — the whole capability for a `public`
 * artifact, so no shorter. */
function mintToken(): string {
  return randomBytes(16).toString("base64url");
}

// ─── Compile ─────────────────────────────────────────────────────────────

/**
 * Compile an artifact source to the page body the frame renders. Markdown
 * goes through GFM and gets the shell's document wrapper class; HTML passes
 * verbatim. The output is NOT sanitized on purpose: it renders in a sandboxed
 * frame under the artifact CSP, where containment does not depend on the
 * compiler's output (artifact-pages design, "Why one render path").
 */
export function renderArtifactBody(content: string, format: ArtifactFormat): string {
  if (format === "html") return content;
  const body = marked.parse(content, { async: false, gfm: true });
  return `<div class="valet-artifact-doc">\n${body}\n</div>`;
}

// ─── Publish ─────────────────────────────────────────────────────────────

export interface ShareArtifactOpts {
  path: string;
  orgId: string;
  /** Session that ran the tool, when the publish came from a tool call. */
  sourceSessionId?: string;
  sourceThreadId?: string;
}

export interface PublishArtifactOpts {
  key: string;
  content: string;
  format: ArtifactFormat;
  title?: string;
  description?: string;
  icon?: string;
  orgId: string;
  sourceSessionId?: string;
  sourceThreadId?: string;
}

/** What every publish path hands the upsert, after its own validation. */
interface PublishInput {
  key: string;
  title: string;
  content: string;
  format: ArtifactFormat;
  description: string;
  icon: string;
  orgId: string;
  sourceSessionId?: string;
  sourceThreadId?: string;
}

/**
 * Snapshot the memory file at `opts.path` into an artifact (create or
 * refresh). Reads through the memory service with the caller's scope, so a
 * caller can only share what that scope can already read. Always writes
 * `visibility: "org"` on create; a refresh keeps the stored visibility —
 * widening is a separate, human-only action (`setArtifactVisibility`).
 */
export async function shareArtifact(db: AppDb, scope: ArtifactScope, opts: ShareArtifactOpts): Promise<ArtifactRow> {
  await requireTeamArtifactScope(db, scope, opts.orgId);
  if (opts.path.startsWith("team:")) {
    throw new ValidationError(
      "Team-prefixed virtual paths cannot be shared. Share from the team scope itself, or copy the file into your own memory first.",
    );
  }
  const result = await readFile(db, scope, opts.path);
  if (result.kind !== "file") {
    throw new ValidationError("Only files can be shared. Pass a file path, not a directory.");
  }
  return upsertArtifact(db, scope, {
    key: result.file.path,
    title: result.file.title,
    content: result.file.content,
    format: "markdown",
    description: (result.file.description ?? "").trim().slice(0, 1000),
    icon: "",
    orgId: opts.orgId,
    sourceSessionId: opts.sourceSessionId,
    sourceThreadId: opts.sourceThreadId,
  });
}

/**
 * Publish inline content as an artifact (create or refresh), the
 * `artifact_publish` tool's path. The key is normalized by the memory-path
 * rules so tool calls cannot mint colliding or hostile keys; it shares the
 * publish-key namespace with memory shares, which is the point — one key, one
 * artifact, one URL.
 */
export async function publishArtifact(db: AppDb, scope: ArtifactScope, opts: PublishArtifactOpts): Promise<ArtifactRow> {
  if (!isArtifactFormat(opts.format)) {
    throw new ValidationError("format must be 'markdown' or 'html'.");
  }
  const key = normalizePath(opts.key);
  if (key.endsWith("/")) {
    throw new ValidationError("The publish key must name a file-like path, not a directory.");
  }
  const sizeError = artifactSizeError(opts.content);
  if (sizeError) throw new ValidationError(sizeError);
  const title = resolveArtifactTitle({
    explicit: opts.title,
    content: opts.content,
    format: opts.format,
    key,
  });
  return upsertArtifact(db, scope, {
    key,
    title,
    content: opts.content,
    format: opts.format,
    description: opts.description?.trim().slice(0, 1000) ?? "",
    icon: normalizeArtifactIcon(opts.icon),
    orgId: opts.orgId,
    sourceSessionId: opts.sourceSessionId,
    sourceThreadId: opts.sourceThreadId,
  });
}

/** Copy the current personal snapshot. Audience grants and history do not transfer. */
export async function copyArtifactToTeam(
  db: AppDb, scope: MemoryScope, orgId: string,
  input: { artifactId: string; teamId: string; key: string },
): Promise<ArtifactRow> {
  if (scope.owner.type !== "user" || scope.owner.id !== scope.actorUserId) {
    throw new ValidationError("Copy personal artifacts from your personal assistant or workspace.");
  }
  const source = await getArtifactById(db, input.artifactId);
  if (!source || source.orgId !== orgId || source.ownerType !== "user" || source.ownerId !== scope.owner.id || source.revokedAt !== null) {
    throw new NotFoundError("artifact", input.artifactId);
  }
  const key = normalizePath(input.key);
  if (key.endsWith("/")) throw new ValidationError("Choose a file-like key for the team artifact.");
  return db.transaction(async (tx) => {
    await lockTeamForOwnership(tx, input.teamId);
    await requireTeamArtifactScope(tx, {
      owner: { type: "team", id: input.teamId }, actorUserId: scope.actorUserId,
    }, orgId, true);
    const now = Date.now();
    const [copy] = await tx.insert(artifacts).values({
      id: randomUUID(), token: mintToken(), ownerType: "team", ownerId: input.teamId,
      orgId, actorUserId: scope.actorUserId, sourceSessionId: "", sourceMemoryPath: key,
      title: source.title, content: source.content, rendered: source.rendered, format: source.format,
      description: source.description, icon: source.icon, version: 1, visibility: "org",
      createdAt: now, updatedAt: now,
    }).onConflictDoNothing().returning();
    if (!copy) throw new ValidationError("A team artifact already uses that key. Choose another key.");
    await appendVersion(tx, copy, scope.actorUserId, now);
    return copy;
  });
}

/**
 * The shared upsert: compile, bump the version counter, append the version
 * row, and refresh the denormalized current fields. Token and visibility
 * semantics are unchanged from the 2026-08-22 design: a live refresh keeps
 * both; reactivating a REVOKED row replaces the token and resets visibility
 * to `org` (revoke ended the audience decision along with the link, and the
 * tool surface must never be the thing that restores anonymous access).
 * Reactivation also clears `shared_version`: the pin was part of the revoked
 * audience decision.
 */
async function upsertArtifact(db: AppDb, scope: ArtifactScope, input: PublishInput): Promise<ArtifactRow> {
  return db.transaction(async (tx) => {
    if (scope.owner.type === "team") await lockTeamForOwnership(tx, scope.owner.id);
    await requireTeamArtifactScope(tx, scope, input.orgId, true);
    return writeArtifact(tx, scope, input);
  });
}

async function writeArtifact(db: AppDb, scope: ArtifactScope, input: PublishInput): Promise<ArtifactRow> {
  const rendered = renderArtifactBody(input.content, input.format);
  const now = Date.now();
  const existingRows = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.ownerType, scope.owner.type),
        eq(artifacts.ownerId, scope.owner.id),
        eq(artifacts.sourceMemoryPath, input.key),
        eq(artifacts.orgId, input.orgId),
      ),
    )
    .limit(1);
  const existing = existingRows[0];

  if (existing) {
    const reactivating = existing.revokedAt !== null;
    const nextVersion = existing.version + 1;
    const [row] = await db
      .update(artifacts)
      .set({
        // A revoked artifact's token may have leaked — that is usually why
        // it was revoked — so reactivation replaces it.
        token: reactivating ? mintToken() : existing.token,
        title: input.title,
        content: input.content,
        format: input.format,
        rendered,
        description: input.description,
        icon: input.icon,
        version: nextVersion,
        actorUserId: scope.actorUserId,
        sourceSessionId: input.sourceSessionId ?? existing.sourceSessionId,
        sourceThreadId: input.sourceSessionId ? input.sourceThreadId ?? null : existing.sourceThreadId,
        updatedAt: now,
        revokedAt: null,
        ...(reactivating
          ? { visibility: "org" as const, publicBy: null, sharedVersion: null }
          : {}),
      })
      .where(and(eq(artifacts.id, existing.id), eq(artifacts.orgId, input.orgId)))
      .returning();
    if (!row) throw new NotFoundError("artifact", existing.id);
    await appendVersion(db, row, scope.actorUserId, now);
    return row;
  }

  const [inserted] = await db
    .insert(artifacts)
    .values({
      id: randomUUID(),
      token: mintToken(),
      ownerType: scope.owner.type,
      ownerId: scope.owner.id,
      orgId: input.orgId,
      actorUserId: scope.actorUserId,
      sourceSessionId: input.sourceSessionId ?? "",
      sourceThreadId: input.sourceThreadId ?? null,
      sourceMemoryPath: input.key,
      title: input.title,
      content: input.content,
      format: input.format,
      rendered,
      description: input.description,
      icon: input.icon,
      version: 1,
      visibility: "org",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!inserted) throw new NotFoundError("artifact", "inserted row");
  await appendVersion(db, inserted, scope.actorUserId, now);
  return inserted;
}

async function appendVersion(db: AppDb, row: ArtifactRow, actorUserId: string, now: number): Promise<void> {
  await db.insert(artifactVersions).values({
    id: randomUUID(),
    artifactId: row.id,
    version: row.version,
    title: row.title,
    format: row.format,
    content: row.content,
    rendered: row.rendered,
    actorUserId,
    createdAt: now,
  });
}

/** Revoke the active artifact for `path` in this scope. 404 when nothing
 * is shared at that path. */
export async function revokeArtifactByPath(db: AppDb, scope: ArtifactScope, path: string, orgId: string): Promise<void> {
  const normalized = normalizePath(path);
  await db.transaction(async (tx) => {
    if (scope.owner.type === "team") await lockTeamForOwnership(tx, scope.owner.id);
    await requireTeamArtifactScope(tx, scope, orgId, true);
    const rows = await tx.update(artifacts).set({ revokedAt: Date.now() }).where(and(
      eq(artifacts.orgId, orgId),
      eq(artifacts.ownerType, scope.owner.type),
      eq(artifacts.ownerId, scope.owner.id),
      eq(artifacts.sourceMemoryPath, normalized),
      isNull(artifacts.revokedAt),
    )).returning({ id: artifacts.id });
    if (!rows.length) throw new NotFoundError("artifact", normalized);
  });
}

export async function getArtifactByToken(db: AppDb, token: string): Promise<ArtifactRow | undefined> {
  const rows = await db.select().from(artifacts).where(eq(artifacts.token, token)).limit(1);
  return rows[0];
}

export async function getArtifactById(db: AppDb, id: string): Promise<ArtifactRow | undefined> {
  const rows = await db.select().from(artifacts).where(eq(artifacts.id, id)).limit(1);
  return rows[0];
}

// ─── Served version ──────────────────────────────────────────────────────

/** The one version the public read serves: what a link holder sees. */
export interface ServedArtifactVersion {
  title: string;
  content: string;
  rendered: string;
  format: ArtifactFormat;
  version: number;
}

/**
 * Resolve the version a viewer gets. Unpinned artifacts serve the
 * denormalized current fields (no join); pinned ones load the version row. A
 * pin naming a missing row falls back to current rather than 404ing a link
 * that worked yesterday. A pre-pages row (`rendered = ""`) compiles on read.
 */
export async function resolveServedVersion(db: AppDb, artifact: ArtifactRow): Promise<ServedArtifactVersion> {
  let served: Pick<ArtifactRow, "title" | "content" | "rendered" | "format" | "version"> = artifact;
  if (artifact.sharedVersion !== null && artifact.sharedVersion !== artifact.version) {
    const rows = await db
      .select()
      .from(artifactVersions)
      .where(
        and(
          eq(artifactVersions.artifactId, artifact.id),
          eq(artifactVersions.version, artifact.sharedVersion),
        ),
      )
      .limit(1);
    if (rows[0]) served = rows[0];
  }
  const format: ArtifactFormat = served.format === "html" ? "html" : "markdown";
  return {
    title: served.title,
    content: served.content,
    rendered: served.rendered !== "" ? served.rendered : renderArtifactBody(served.content, format),
    format,
    version: served.version,
  };
}

/** Version metadata for the management surface — no content bodies. */
export interface ArtifactVersionSummary {
  version: number;
  title: string;
  format: ArtifactFormat;
  actorUserId: string;
  createdAt: number;
}

export async function listArtifactVersions(db: AppDb, artifactId: string): Promise<ArtifactVersionSummary[]> {
  const rows = await db
    .select({
      version: artifactVersions.version,
      title: artifactVersions.title,
      format: artifactVersions.format,
      actorUserId: artifactVersions.actorUserId,
      createdAt: artifactVersions.createdAt,
    })
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, artifactId))
    .orderBy(desc(artifactVersions.version));
  return rows.map((r) => ({ ...r, format: r.format === "html" ? "html" : "markdown" }));
}

/**
 * Pin viewers to one version (or null for latest). A pin must name a real
 * version row — pre-pages publishes wrote none, and pinning to a phantom
 * would serve the fallback while claiming the pin took.
 */
export async function setArtifactSharedVersion(
  db: AppDb,
  id: string,
  sharedVersion: number | null,
): Promise<ArtifactRow> {
  if (sharedVersion !== null) {
    const rows = await db
      .select({ version: artifactVersions.version })
      .from(artifactVersions)
      .where(and(eq(artifactVersions.artifactId, id), eq(artifactVersions.version, sharedVersion)))
      .limit(1);
    if (!rows[0]) {
      throw new ValidationError(`Version ${sharedVersion} does not exist for this artifact.`);
    }
  }
  const [row] = await db
    .update(artifacts)
    .set({ sharedVersion, updatedAt: Date.now() })
    .where(eq(artifacts.id, id))
    .returning();
  if (!row) throw new NotFoundError("artifact", id);
  return row;
}

// ─── List / manage ───────────────────────────────────────────────────────

/** Everything the list/manage surfaces need — deliberately WITHOUT
 * `content`: a list of shares must not drag every snapshot body out of
 * the database. */
export interface ArtifactSummaryRow {
  sourceSessionId: string | null;
  sourceThreadId: string | null;
  ownerType: string;
  id: string;
  token: string;
  sourceMemoryPath: string;
  title: string;
  format: string;
  icon: string;
  version: number;
  sharedVersion: number | null;
  visibility: "org" | "public";
  actorUserId: string;
  revokedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

const summaryColumns = {
  sourceSessionId: artifacts.sourceSessionId,
  sourceThreadId: artifacts.sourceThreadId,
  ownerType: artifacts.ownerType,
  id: artifacts.id,
  token: artifacts.token,
  sourceMemoryPath: artifacts.sourceMemoryPath,
  title: artifacts.title,
  format: artifacts.format,
  icon: artifacts.icon,
  version: artifacts.version,
  sharedVersion: artifacts.sharedVersion,
  visibility: artifacts.visibility,
  actorUserId: artifacts.actorUserId,
  revokedAt: artifacts.revokedAt,
  createdAt: artifacts.createdAt,
  updatedAt: artifacts.updatedAt,
};

/** The caller's own shares — the rows where they were the sharing actor.
 * Org admins additionally see personal artifacts in the org. Team rows
 * always require current membership, including for the publishing actor. */
export async function listArtifacts(
  db: AppDb,
  caller: { id: string; orgId: string; orgAdmin: boolean },
): Promise<ArtifactSummaryRow[]> {
  const where = and(
    eq(artifacts.orgId, caller.orgId),
    caller.orgAdmin ? undefined : eq(artifacts.actorUserId, caller.id),
    or(
      ne(artifacts.ownerType, "team"),
      exists(db.select({ id: teams.id }).from(teams)
        .innerJoin(teamMembers, eq(teamMembers.teamId, teams.id))
        .innerJoin(orgMembers, and(eq(orgMembers.orgId, teams.orgId), eq(orgMembers.userId, teamMembers.userId)))
        .where(and(
          eq(teams.id, artifacts.ownerId), eq(teams.orgId, caller.orgId),
          eq(teamMembers.userId, caller.id),
        ))),
    ),
  );
  return db.select(summaryColumns).from(artifacts).where(where).orderBy(desc(artifacts.updatedAt));
}

/** One owner's artifacts, newest first (team dashboard design). The ROUTE
 * gates access — team owners on membership — before calling this. */
export async function listArtifactsForOwner(
  db: AppDb,
  orgId: string,
  owner: { type: string; id: string },
  page?: { limit: number; cursor?: { updatedAt: number; id: string }; sourceSessionId?: string; sourceThreadId?: string },
): Promise<ArtifactSummaryRow[]> {
  const query = db
    .select(summaryColumns)
    .from(artifacts)
    .where(
      and(
        eq(artifacts.orgId, orgId),
        eq(artifacts.ownerType, owner.type),
        eq(artifacts.ownerId, owner.id),
        page?.sourceSessionId ? eq(artifacts.sourceSessionId, page.sourceSessionId) : undefined,
        page?.sourceThreadId ? eq(artifacts.sourceThreadId, page.sourceThreadId) : undefined,
        // The paged gallery omits revoked links before selecting a page.
        page ? isNull(artifacts.revokedAt) : undefined,
        page?.cursor ? or(
          lt(artifacts.updatedAt, page.cursor.updatedAt),
          and(eq(artifacts.updatedAt, page.cursor.updatedAt), lt(artifacts.id, page.cursor.id)),
        ) : undefined,
      ),
    )
    .orderBy(desc(artifacts.updatedAt), desc(artifacts.id));
  return page ? query.limit(page.limit + 1) : query;
}

export async function setArtifactVisibility(
  db: AppDb,
  id: string,
  visibility: ArtifactVisibility,
  actorUserId: string,
): Promise<ArtifactRow> {
  const [row] = await db
    .update(artifacts)
    .set({
      visibility,
      // Audit who widened; narrowing clears it — the artifact is no longer
      // public because of anyone.
      publicBy: visibility === "public" ? actorUserId : null,
      updatedAt: Date.now(),
    })
    // No existing grant mechanism authorizes an audience outside a team.
    .where(and(eq(artifacts.id, id), visibility === "public" ? ne(artifacts.ownerType, "team") : undefined))
    .returning();
  if (!row) throw new NotFoundError("artifact", id);
  return row;
}

export async function revokeArtifactById(db: AppDb, id: string): Promise<void> {
  await db.update(artifacts).set({ revokedAt: Date.now() }).where(eq(artifacts.id, id));
}

export async function getAllowPublicArtifacts(db: AppDb, orgId: string): Promise<boolean> {
  const rows = await db
    .select({ allowPublicArtifacts: orgs.allowPublicArtifacts })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);
  return rows[0]?.allowPublicArtifacts ?? false;
}

// ─── Comments ────────────────────────────────────────────────────────────

const COMMENT_BODY_MAX = 4096;

export interface AddArtifactCommentOpts {
  artifactId: string;
  version: number;
  vdid?: string;
  parentId?: string;
  body: string;
  authorUserId: string;
}

/**
 * Store one comment. Threading is one level deep: a reply's parent must be a
 * root comment on the same artifact. Anchors are stored verbatim — the vdid
 * is only meaningful to the viewer's runtime, and an id that stops resolving
 * renders as an orphaned thread, never an error.
 */
export async function addArtifactComment(db: AppDb, opts: AddArtifactCommentOpts): Promise<ArtifactCommentRow> {
  const body = opts.body.trim();
  if (body.length === 0) throw new ValidationError("Comment body is required.");
  if (body.length > COMMENT_BODY_MAX) {
    throw new ValidationError(`Comments are capped at ${COMMENT_BODY_MAX} characters.`);
  }
  if (opts.vdid !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(opts.vdid)) {
    throw new ValidationError("vdid must be a short id.");
  }
  if (opts.parentId) {
    const parents = await db
      .select({ id: artifactComments.id, parentId: artifactComments.parentId, artifactId: artifactComments.artifactId })
      .from(artifactComments)
      .where(eq(artifactComments.id, opts.parentId))
      .limit(1);
    const parent = parents[0];
    if (!parent || parent.artifactId !== opts.artifactId) {
      throw new NotFoundError("comment", opts.parentId);
    }
    if (parent.parentId !== null) {
      throw new ValidationError("Replies nest one level: reply to the thread's first comment.");
    }
  }
  const [row] = await db
    .insert(artifactComments)
    .values({
      id: randomUUID(),
      artifactId: opts.artifactId,
      version: opts.version,
      vdid: opts.vdid ?? null,
      parentId: opts.parentId ?? null,
      body,
      authorUserId: opts.authorUserId,
      createdAt: Date.now(),
    })
    .returning();
  if (!row) throw new NotFoundError("comment", "inserted row");
  return row;
}

export async function listArtifactComments(db: AppDb, artifactId: string): Promise<ArtifactCommentRow[]> {
  return db
    .select()
    .from(artifactComments)
    .where(eq(artifactComments.artifactId, artifactId))
    .orderBy(asc(artifactComments.createdAt));
}

export async function getArtifactComment(db: AppDb, id: string): Promise<ArtifactCommentRow | undefined> {
  const rows = await db.select().from(artifactComments).where(eq(artifactComments.id, id)).limit(1);
  return rows[0];
}

/** Resolve a root comment's thread. Replies are not independently
 * resolvable — resolve the root. */
export async function resolveArtifactComment(db: AppDb, id: string, resolvedBy: string): Promise<ArtifactCommentRow> {
  const existing = await getArtifactComment(db, id);
  if (!existing) throw new NotFoundError("comment", id);
  if (existing.parentId !== null) {
    throw new ValidationError("Resolve the thread's first comment, not a reply.");
  }
  const [row] = await db
    .update(artifactComments)
    .set({ resolvedAt: Date.now(), resolvedBy })
    .where(eq(artifactComments.id, id))
    .returning();
  if (!row) throw new NotFoundError("comment", id);
  return row;
}

/** Record that a comment was delivered into the source session. */
export async function markArtifactCommentSent(db: AppDb, id: string, sessionId: string): Promise<void> {
  await db.update(artifactComments).set({ sentToSession: sessionId }).where(eq(artifactComments.id, id));
}

// ─── Access decision ───────────────────────────────────────────────────

export type ArtifactAccess =
  /** Serve the document. */
  | { kind: "serve" }
  /** 401 — a login could change the answer. */
  | { kind: "login" }
  /** 404 — missing, revoked, or a caller the artifact must not confirm
   * exists for (wrong org). */
  | { kind: "not_found" };

/**
 * The whole read-authorization matrix for `GET /api/artifacts/:token`,
 * pure so every branch is unit-testable. Wrong-org callers get
 * `not_found`, not a 403 — the existence-hiding convention the memory
 * routes follow.
 */
export function decideArtifactAccess(opts: {
  artifact: Pick<ArtifactRow, "ownerType" | "orgId" | "visibility" | "revokedAt"> | undefined;
  allowPublicArtifacts: boolean;
  teamMember?: boolean;
  user: { orgId: string } | undefined;
}): ArtifactAccess {
  const { artifact, user } = opts;
  if (!artifact || artifact.revokedAt !== null) return { kind: "not_found" };
  if (artifact.ownerType === "team") {
    if (!user) return { kind: "login" };
    if (user.orgId !== artifact.orgId || opts.teamMember !== true) return { kind: "not_found" };
    return { kind: "serve" };
  }
  if (artifact.visibility === "public" && opts.allowPublicArtifacts) return { kind: "serve" };
  if (!user) return { kind: "login" };
  if (user.orgId !== artifact.orgId) return { kind: "not_found" };
  return { kind: "serve" };
}

/** Team ownership takes precedence over actor and visibility on every surface. */
export async function hasArtifactTeamAccess(
  db: AppDb,
  artifact: Pick<ArtifactRow, "ownerType" | "ownerId" | "orgId">,
  user: { id: string; orgId: string } | undefined,
): Promise<boolean> {
  if (artifact.ownerType !== "team") return true;
  if (!user || user.orgId !== artifact.orgId) return false;
  return (await artifactMemberships(db, artifact.orgId, artifact.ownerId, user.id)).length > 0;
}

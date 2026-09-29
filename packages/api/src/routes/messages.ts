/**
 * Messages + threads routes — the agent loop entry points.
 *
 * Each session has a default engine thread (`web:default`); the user can
 * create additional threads via POST /threads. Subsequent calls to
 * /messages can target any thread by id (defaults to the default thread
 * when omitted, so single-thread clients keep working).
 *
 *   GET  /api/sessions/:id/threads   → all threads for the session
 *   POST /api/sessions/:id/threads   → create a new engine thread
 *   GET  /api/sessions/:id/messages  → list messages (?threadId=…)
 *   POST /api/sessions/:id/messages  → send prompt (body.threadId optional)
 */
import { Hono, type Context } from "hono";
import { eq, inArray } from "drizzle-orm";
import {
  dispatchCommand,
  NotFoundError,
  parseReasoningLevel,
  ValidationError,
} from "@valet/engine";
import type { PromptAuthor, SessionEntry, Session as EngineSession } from "@valet/engine";
import type { AppEnv } from "../env.js";
import { ensureWorkflowSession, parseWorkflowSessionId } from "../workflows/engine-deps.js";
import { agentSessions, sessionThreads, users, workflowDefinitions } from "../schema/index.js";
import { makeCommandContext } from "../engine/command-providers.js";
import type {
  CreateThreadRequest,
  CreateThreadResponse,
  ListCommandsResponse,
  WireCommandInfo,
  ListDecisionsResponse,
  ListMessagesResponse,
  ListThreadsResponse,
  Message,
  MessagePart,
  MessageAuthor,
  MessageRole,
  MessageReplyReference,
  MessageSkillInvocation,
  PatchThreadRequest,
  PromptFileAttachment,
  PromptImageAttachment,
  ResolveDecisionRequest,
  AbortThreadRequest,
  SendPromptRequest,
  SendPromptResponse,
  ThreadSummary,
  WithdrawDecisionRequest,
} from "../wire/types.js";
import { commandResultEntryToMessage, engineGateToWire, engineSignalToWire, engineToWireParts } from "../engine/bridge.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import { canApplyAlwaysAllow, GATE_ACTION_ALWAYS_ALLOW } from "../policies/service.js";
import type { Providers } from "../providers/types.js";
import { canResolveSessionGate, canViewSession, type SessionOwnerLike } from "../services/session-access.js";
import {
  getAttachmentRefStore,
  UnknownAttachmentError,
  type AttachmentInfo,
} from "../services/attachment-refs.js";
import { isOrgAdminUser } from "./_org-admin.js";
import { assertModelSelectable } from "../services/approved-models.js";
import { assertReasoningSelectable } from "../services/reasoning.js";
import { recordSessionActivity, recordThreadActivityBestEffort, recordThreadUserActivity } from "../services/thread-activity.js";

export const messagesRouter = new Hono<AppEnv>();

/**
 * Every route in this file (threads, messages, decisions) shares this one
 * check — view access, not just direct ownership, so a team's orchestrator
 * session works the same way here as `GET /api/sessions/:id` does (see
 * `services/session-access.ts`). Session lifecycle routes (delete, pause,
 * model change — in `routes/sessions.ts`) are NOT widened by this; talking
 * to a team's orchestrator is not the same decision as reconfiguring it.
 */
export async function loadOwnedSession(c: Context<AppEnv>) {
  const { db } = c.var.providers;
  const id = c.req.param("id");
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
  const row = rows[0];
  if (!row || !(await canViewSession(db, row, c.var.principal))) return null;
  return row;
}

/**
 * Wire timestamp for an entry. Typed `number` on `BaseEntry`, but rows
 * persisted by older builds may hold an ISO string — coerce defensively.
 */
function wireCreatedAt(createdAt: number | string): number {
  const created = typeof createdAt === "number" ? createdAt : Date.parse(createdAt);
  return Number.isFinite(created) ? created : Date.now();
}

export function entryToMessage(e: SessionEntry, sessionId: string, threadId: string): Message | null {
  if (e.type === "command_result") {
    return commandResultEntryToMessage(e, sessionId, threadId);
  }
  if (e.type === "compaction") {
    // Project the compaction boundary so the UI can render a divider
    // (thread-model-pinning and compaction design, decision 7). `content`
    // carries the summary so clients without a divider renderer still
    // degrade to readable text.
    return {
      id: e.id,
      sessionId,
      threadId,
      role: "system",
      content: e.summary,
      parts: [],
      createdAt: wireCreatedAt(e.createdAt),
      sequence: e.sequence,
      compaction: {
        summary: e.summary,
        tokensBefore: e.tokenCountBefore,
        tokensAfter: e.tokenCountAfter,
        coveredEntryIds: e.coveredEntryIds,
      },
    };
  }
  if (e.type !== "message") return null;
  // Engine has 4 roles: user/assistant/tool/system. We forward as-is.
  const role: MessageRole = e.role;
  const parts: MessagePart[] = engineToWireParts(e.parts);
  // Project engine image attachments into the wire shape. The engine holds
  // either a `data:` URL or raw bytes; the wire ships one canonical
  // `data:` URL string. Skip entries missing both (nothing to render).
  const wireAttachments = projectAttachments(e.attachments);
  const skill = skillInvocationFromMetadata(e.metadata, role);
  const author = authorFromEntry(e.author, role);
  return {
    id: e.id,
    sessionId,
    threadId,
    role,
    content: e.content,
    parts,
    createdAt: wireCreatedAt(e.createdAt),
    sequence: e.sequence,
    queueItemId: e.queueItemId,
    ...(role === "assistant" ? { completed: e.stopReason === "end_turn" } : {}),
    replyTo: replyReferenceFromMetadata(e.metadata, role),
    signal: engineSignalToWire(e.signal),
    model: e.model,
    ...(skill ? { skill } : {}),
    ...(author ? { author } : {}),
    ...(wireAttachments.length > 0 ? { attachments: wireAttachments } : {}),
  };
}

/**
 * The engine `PromptAuthor` for a prompt the authenticated user typed.
 * One projection for every human-submit route (POST /messages,
 * `initialPrompt` on create) so the stamp cannot drift between them.
 * `name` is optional on the auth user; an absent or empty name is dropped
 * so downstream label fallbacks (email) engage.
 */
export function promptAuthorFromUser(user: {
  id: string;
  email: string;
  name?: string;
}): PromptAuthor {
  return { id: user.id, email: user.email, ...(user.name ? { name: user.name } : {}) };
}

/**
 * Wire projection of the engine's `PromptAuthor`. Only user entries carry a
 * human sender; `externalId` is a channel-plugin detail and stays off the
 * wire.
 */
function authorFromEntry(
  author: PromptAuthor | undefined,
  role: MessageRole,
): MessageAuthor | undefined {
  if (role !== "user" || !author) return undefined;
  return {
    id: author.id,
    ...(author.name ? { name: author.name } : {}),
    ...(author.email ? { email: author.email } : {}),
    ...(author.avatarUrl ? { avatarUrl: author.avatarUrl } : {}),
  };
}

/**
 * Wire projection of a skill-invocation stamp. Both producers write the
 * same keys: the command dispatcher stamps `{ skill, skillArgs }` on a
 * slash expansion, and `Thread.skill()` stamps `{ skill }` on a host
 * invocation. Only user entries qualify — the stamp rides the queue item
 * onto the user entry, never onto assistant output.
 */
const REPLY_METADATA_KEY = "replyTo";
const REPLY_EXCERPT_CHARS = 280;

function replyReferenceFromMetadata(
  metadata: Record<string, unknown> | undefined,
  role: MessageRole,
): MessageReplyReference | undefined {
  if (role !== "user") return undefined;
  const value = metadata?.[REPLY_METADATA_KEY];
  if (!value || typeof value !== "object") return undefined;
  const ref = value as Record<string, unknown>;
  if (typeof ref.messageId !== "string" || typeof ref.excerpt !== "string") return undefined;
  return { messageId: ref.messageId, excerpt: ref.excerpt };
}

function assistantReplyExcerpt(entry: Extract<SessionEntry, { type: "message" }>): string {
  const partText = (entry.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.type === "text" ? part.text.trim() : "")
    .filter(Boolean)
    .join(" ");
  const text = (partText || entry.content).replace(/\s+/g, " ").trim();
  const codepoints = Array.from(text);
  return codepoints.length <= REPLY_EXCERPT_CHARS
    ? text
    : codepoints.slice(0, REPLY_EXCERPT_CHARS - 1).join("").trimEnd() + "…";
}

function skillInvocationFromMetadata(
  metadata: Record<string, unknown> | undefined,
  role: MessageRole,
): MessageSkillInvocation | undefined {
  if (role !== "user" || !metadata) return undefined;
  const name = metadata.skill;
  if (typeof name !== "string" || name.length === 0) return undefined;
  const args = metadata.skillArgs;
  return { name, ...(typeof args === "string" && args ? { args } : {}) };
}

/**
 * Wire projection of `MessageEntry.attachments`. The engine keeps images as
 * either `{ url }` (already a `data:` URL — the shape the REST route
 * accepts today) or `{ data: Uint8Array }` (some day, when a plugin drops a
 * raw buffer in). The wire ships one canonical string per attachment; if
 * neither field is set, drop the entry rather than emit an empty img.
 *
 * File attachments (type: "file") are projected as `PromptFileAttachment`
 * carrying the absolute sandbox path, size, hash, and optional markdown sidecar.
 */
function projectAttachments(
  attachments: NonNullable<Extract<SessionEntry, { type: "message" }>["attachments"]> | undefined,
): Array<PromptImageAttachment | PromptFileAttachment> {
  if (!attachments || attachments.length === 0) return [];
  const out: Array<PromptImageAttachment | PromptFileAttachment> = [];
  for (const att of attachments) {
    if (att.type === "image") {
      let url: string | undefined;
      if (typeof att.url === "string" && att.url.startsWith("data:")) {
        url = att.url;
      } else if (att.data) {
        url = `data:${att.mimeType};base64,${Buffer.from(att.data).toString("base64")}`;
      } else if (typeof att.url === "string") {
        // Non-data URL (e.g. an http url) is passed through as-is; harmless
        // if the client happens to already resolve it.
        url = att.url;
      }
      if (!url) continue;
      out.push({
        kind: "image",
        url,
        mimeType: att.mimeType,
        name: att.name ?? "image",
      });
    } else if (att.type === "file") {
      out.push({
        kind: "file",
        path: att.path,
        bytes: att.bytes,
        sha256: att.sha256,
        mimeType: att.mimeType,
        markdownPath: att.markdownPath,
        extractedTo: att.extractedTo,
        extractedFiles: att.extractedFiles,
        name: att.name,
      });
    }
  }
  return out;
}

// ── Threads ───────────────────────────────────────────────────────────────

function threadToSummary(
  threadId: string,
  createdAt: number,
  sessionId: string,
  lastUserActivityAt: number,
  title?: string,
  model?: string,
  key?: string,
  archivedAt?: number,
  reasoning?: string | null,
): ThreadSummary {
  return { id: threadId, sessionId, title, createdAt, lastUserActivityAt, model, key, archivedAt, reasoning };
}

async function loadEngineSession(
  c: Context<AppEnv>,
): Promise<
  | {
      session: typeof agentSessions.$inferSelect;
      engineSession: EngineSession;
      meta: Awaited<ReturnType<typeof loadSessionMeta>>;
    }
  | { error: Response }
> {
  const session = await loadOwnedSession(c);
  if (!session) return { error: c.json({ error: "session not found" }, 404) };
  const { engineHost, db } = c.var.providers;

  // Repo bindings + git identity (GitHub/repo integration plan, Task 9) —
  // assembled centrally via `loadSessionMeta` so EVERY `sessionFor` caller
  // carries them. The first call to actually build the session (create or
  // restore) wires `prepareSandbox`; later calls are no-op reads once cached
  // (`sessionFor` returns early without touching `meta`).
  const meta = await loadSessionMeta(db, session);
  const engineSession = await engineHost.sessionFor(session.id, meta);
  return { session, engineSession, meta };
}

messagesRouter.get("/:id/threads", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;
  const { db } = c.var.providers;

  await engineSession.ensureDefaultThread();
  const threads = engineSession.listThreads();

  // Titles + archive state live in the app-side `session_threads` mirror
  // (titles populated by auto-title). One lookup by id set — small, since a
  // session has O(few) threads. Missing rows → undefined title, not archived.
  const ids = threads.map((t) => t.id);
  const metaRows = ids.length
    ? await db
        .select({
          id: sessionThreads.id,
          title: sessionThreads.title,
          archivedAt: sessionThreads.archivedAt,
          lastUserActivityAt: sessionThreads.lastUserActivityAt,
        })
        .from(sessionThreads)
        .where(inArray(sessionThreads.id, ids))
    : [];
  const metaById = new Map(
    metaRows.map(
      (r) =>
        [
          r.id,
          {
            title: r.title ?? undefined,
            archivedAt: r.archivedAt ?? undefined,
            lastUserActivityAt: r.lastUserActivityAt ?? undefined,
          },
        ] as const,
    ),
  );

  // Default list excludes archived threads; `?archived=1` lists only them.
  const wantArchived = c.req.query("archived") === "1";
  const summaries = threads
    .filter((t) => (metaById.get(t.id)?.archivedAt !== undefined) === wantArchived)
    .map((t) =>
      threadToSummary(
        t.id,
        t.toThreadData().createdAt,
        session.id,
        metaById.get(t.id)?.lastUserActivityAt ?? t.toThreadData().createdAt,
        metaById.get(t.id)?.title,
        t.modelId(),
        t.key,
        metaById.get(t.id)?.archivedAt,
        t.reasoning() ?? null,
      ),
    );
  const body: ListThreadsResponse = { threads: summaries };
  return c.json(body);
});

// ── Commands ────────────────────────────────────────────────────────────────
//
// GET /:id/commands — the merged slash-command registry for the session
// (built-ins + skills + user/repo templates + plugin commands) plus registry
// diagnostics. Building the session (via `loadEngineSession`) is what wires the
// host `workspaceSkillsProvider`/`commandContext`; the registry is built lazily and
// cached on the Session, refreshed after workspace prep.
messagesRouter.get("/:id/commands", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { engineSession } = result;

  // Refresh before reading so user templates (DB-backed, always available) and
  // repo templates (readable once the sandbox is ready) land in the registry.
  // Cheap when nothing changed: one DB read plus, only when the sandbox is
  // ready, one exec.
  await engineSession.refreshCommandRegistry();
  const registry = engineSession.commandRegistry();

  // Attach argument completions for commands whose first argument is
  // enumerable. Today that is `/model` (the org's active model catalog).
  // Failure to enumerate degrades to no completions, never a route error.
  const { db, engineCredentials } = c.var.providers;
  const commands: WireCommandInfo[] = registry.list();
  const model = commands.find((cmd) => cmd.source === "builtin" && cmd.name === "model");
  if (model) {
    try {
      const ctx = makeCommandContext(db, engineCredentials, result.session.orgId, result.session.id);
      const models = await ctx.listModels();
      model.argOptions = models.map((m) => ({ value: m.id, label: m.name }));
    } catch (err) {
      console.error(`GET /commands: model enumeration failed for ${result.session.id}:`, err);
    }
  }

  const body: ListCommandsResponse = {
    commands,
    diagnostics: registry.diagnostics(),
  };
  return c.json(body);
});

/** Maximum length for a thread title. This matches the session title limit. */
const MAX_THREAD_TITLE_CHARS = 200;

messagesRouter.patch("/:id/threads/:threadId", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;
  const { db } = c.var.providers;

  const threadId = c.req.param("threadId");
  const thread = engineSession.threadById(threadId);
  if (!thread) return c.json({ error: "thread not found" }, 404);

  let body: PatchThreadRequest;
  try {
    body = (await c.req.json()) as PatchThreadRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (
    body.model === undefined &&
    body.archived === undefined &&
    body.title === undefined &&
    body.reasoning === undefined
  ) {
    return c.json(
      { error: "nothing to patch: send model (null to clear), archived, title, and/or reasoning" },
      400,
    );
  }

  // Validate the title before changing any thread settings.
  let nextTitle: string | null | undefined;
  if (body.title !== undefined) {
    if (body.title === null) {
      nextTitle = null;
    } else if (typeof body.title !== "string") {
      return c.json(
        { error: "Set title to a string, or use null to clear it." },
        400,
      );
    } else {
      const trimmed = body.title.trim();
      if (trimmed.length === 0) {
        nextTitle = null;
      } else if (trimmed.length > MAX_THREAD_TITLE_CHARS) {
        return c.json(
          { error: `title is too long. Use ${MAX_THREAD_TITLE_CHARS} characters or fewer.` },
          400,
        );
      } else {
        nextTitle = trimmed;
      }
    }
  }

  if (body.model !== undefined && typeof body.model === "string") {
    const isAdmin = await isOrgAdminUser(c);
    const err = await assertModelSelectable(db, session.orgId, isAdmin, body.model);
    if (err) return c.json({ error: err }, 400);
  }

  // `reasoning: null` clears the override and always passes. Storage/
  // application of a thread-level override is Task 11 — this only
  // validates so a bad value 400s instead of being silently accepted.
  if (body.reasoning !== undefined && body.reasoning !== null) {
    if (typeof body.reasoning !== "string") {
      return c.json(
        { error: "reasoning must be a reasoning level string, or null to clear the override." },
        400,
      );
    }
    const normalizedReasoning = body.reasoning.trim().toLowerCase();
    const reasoningErr = await assertReasoningSelectable(db, session.orgId, normalizedReasoning);
    if (reasoningErr) return c.json({ error: reasoningErr }, 400);
  }

  if (body.model !== undefined) {
    try {
      await thread.setModel(
        typeof body.model === "string" ? body.model : null,
      );
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  }

  if (body.reasoning !== undefined) {
    try {
      await thread.setReasoning(
        typeof body.reasoning === "string" ? body.reasoning.trim().toLowerCase() : null,
      );
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  }

  // The mirror row can be missing before auto-title runs.
  const wantsArchived = body.archived !== undefined;
  const wantsTitle = nextTitle !== undefined;
  if (wantsArchived || wantsTitle) {
    const nextArchivedAt = wantsArchived
      ? (body.archived ? Date.now() : null)
      : undefined;
    await db
      .insert(sessionThreads)
      .values({
        id: thread.id,
        sessionId: session.id,
        createdAt: thread.toThreadData().createdAt,
        archivedAt: nextArchivedAt ?? null,
        title: nextTitle ?? null,
      })
      .onConflictDoUpdate({
        target: sessionThreads.id,
        set: {
          ...(wantsArchived ? { archivedAt: nextArchivedAt } : {}),
          ...(wantsTitle ? { title: nextTitle } : {}),
        },
      });
  }

  // Return the same title and archive state as a subsequent GET.
  const rows = await db
    .select({
      archivedAt: sessionThreads.archivedAt,
      title: sessionThreads.title,
      lastUserActivityAt: sessionThreads.lastUserActivityAt,
    })
    .from(sessionThreads)
    .where(eq(sessionThreads.id, thread.id))
    .limit(1);
  const archivedAt = rows[0]?.archivedAt ?? undefined;
  const title = rows[0]?.title ?? undefined;

  const summary = threadToSummary(
    thread.id,
    thread.toThreadData().createdAt,
    session.id,
    rows[0]?.lastUserActivityAt ?? thread.toThreadData().createdAt,
    title,
    thread.modelId(),
    thread.key,
    archivedAt,
    thread.reasoning() ?? null,
  );
  return c.json(summary);
});

messagesRouter.post("/:id/threads", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { session, engineSession, meta } = result;
  const { db, engineHost } = c.var.providers;

  let parsed: unknown = {};
  try {
    const text = await c.req.text();
    parsed = text ? JSON.parse(text) : {};
  } catch {
    return c.json({ error: "invalid JSON body. Send a JSON object." }, 400);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return c.json({ error: "invalid JSON body. Send a JSON object." }, 400);
  }
  const body = parsed as CreateThreadRequest;
  if (body.sourceThreadId !== undefined && typeof body.sourceThreadId !== "string") {
    return c.json({ error: "sourceThreadId must be a string. Select a thread from this session." }, 400);
  }

  const sourceThreadId = body.sourceThreadId;
  const source = sourceThreadId === undefined ? null : engineSession.threadById(sourceThreadId);
  if (sourceThreadId !== undefined && !source) {
    return c.json({ error: "thread not found. Select a thread from this session." }, 404);
  }

  const behaviorRows = await db
    .select({ newThreadBehavior: users.newThreadBehavior })
    .from(users)
    .where(eq(users.id, c.var.user.id))
    .limit(1);
  const keepCurrent = behaviorRows[0]?.newThreadBehavior !== "use_defaults";
  const settings = keepCurrent && source
    ? {
        model: source.modelId() ?? engineSession.options.modelSpec ?? engineSession.options.model.id,
        reasoning: parseReasoningLevel(
          source.reasoning() ?? engineSession.options.sampling?.reasoning,
        ),
      }
    : await engineHost.resolveFreshThreadSettings(session.id, meta, c.var.user.id);

  // Engine identifies threads by `key`; we generate a fresh one so each
  // POST creates a new thread (calling thread() with an existing key
  // returns the cached one).
  const key = `web:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const thread = await engineSession.createThread(key, settings);
  const summary: CreateThreadResponse = threadToSummary(
    thread.id,
    thread.toThreadData().createdAt,
    session.id,
    thread.toThreadData().createdAt,
    body.title,
    thread.modelId(),
    thread.key,
    undefined,
    thread.reasoning() ?? null,
  );
  return c.json(summary, 201);
});

/**
 * Resolve the target thread from a `?threadId=` query param or body field.
 * Returns either the matching engine Thread, or the session's default thread
 * when no id was supplied. Returns null if a specific id was given but no
 * thread matches — caller should 404.
 */
function resolveThread(
  engineSession: EngineSession,
  threadId: string | undefined,
) {
  if (!threadId) return engineSession.thread();
  return engineSession.threadById(threadId);
}

// ── Messages: list ────────────────────────────────────────────────────────

messagesRouter.get("/:id/messages", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;

  await engineSession.ensureDefaultThread();
  const requested = c.req.query("threadId") || undefined;
  const thread = resolveThread(engineSession, requested);
  if (!thread) return c.json({ error: "thread not found" }, 404);

  const parsedLimit = Number.parseInt(c.req.query("limit") ?? "100", 10);
  const limit = Number.isNaN(parsedLimit) ? 100 : Math.max(1, parsedLimit);
  const cursor = c.req.query("cursor") ?? undefined;
  // Read one extra row so the bounded tail can report whether older rows
  // exist. The response still contains at most the requested limit.
  const entries = await thread.readEntries({ limit: limit + 1, cursor });
  const hasMore = entries.length > limit;
  const tail = hasMore ? entries.slice(1) : entries;

  const messages = tail
    .map((e) => entryToMessage(e, session.id, thread.id))
    .filter((m): m is Message => m !== null);

  const body: ListMessagesResponse = {
    messages,
    hasMore,
    nextCursor: undefined, // engine cursor pagination is opaque; revisit if needed
  };
  return c.json(body);
});

// ── Messages: send prompt ─────────────────────────────────────────────────

/**
 * Queue one user prompt on a session's thread and touch the session row so
 * list ordering reflects recency. This is the whole submit path: the route
 * below wraps it in authorization and HTTP, and `POST /api/sessions` calls it
 * to honour `CreateSessionRequest.initialPrompt`. Slash commands live here
 * for that reason — an initial prompt that starts with "/" must dispatch the
 * same way a typed one does.
 *
 * Returns null when `threadId` names no thread of this session. The caller
 * must have authorized the session already — this function does not.
 */
export async function submitSessionPrompt(
  providers: Pick<Providers, "db" | "engineHost">,
  row: typeof agentSessions.$inferSelect,
  text: string,
  opts?: {
    threadId?: string;
    attachments?: SendPromptRequest["attachments"];
    fileRefs?: SendPromptRequest["fileRefs"];
    queueMode?: "followup" | "steer";
    promoteItemId?: string;
    /** The authenticated sender, persisted on the user entry as `MessageEntry.author`. */
    author?: PromptAuthor;
    /** False for agent-driven submissions, which must not reorder the sidebar. */
    recordUserActivity?: boolean;
    /** Server-validated assistant entry reference. */
    replyTo?: MessageReplyReference;
  },
): Promise<SendPromptResponse | null> {
  const { threadId, attachments, fileRefs, author, recordUserActivity = true, replyTo } = opts ?? {};
  const admission = { queueMode: opts?.queueMode, promoteItemId: opts?.promoteItemId };
  const { db, engineHost } = providers;
  const engineSession = await engineHost.sessionFor(row.id, await loadSessionMeta(db, row));
  // A prompt is USE: a hibernated row flips back to active here even when
  // the turn never touches the sandbox (chat-only — no ready transition
  // ever fires the attachment-side hooks).
  await engineHost.markSessionUsed(row.id);

  await engineSession.ensureDefaultThread();
  const thread = resolveThread(engineSession, threadId);
  if (!thread) return null;
  const recordActivity = (activityAt: number) => recordUserActivity
    ? recordThreadUserActivity(db, {
        sessionId: row.id,
        threadId: thread.id,
        threadCreatedAt: thread.toThreadData().createdAt,
        activityAt,
        emit: (event) => engineSession.emit(event),
      })
    : Promise.resolve();

  if (admission.promoteItemId) {
    const receipt = await thread.promoteQueuedItem(admission.promoteItemId);
    const activityAt = Date.now();
    await recordSessionActivity(db, row.id, activityAt);
    await recordThreadActivityBestEffort(() => recordActivity(activityAt));
    return {
      messageId: receipt.queueItemId || null,
      threadId: receipt.threadId,
      activityAt,
    };
  }

  // Reject reply-plus-command before consuming single-use attachment refs.
  const outcome = text.startsWith("/") ? dispatchCommand(text, engineSession.commandRegistry()) : null;
  if (replyTo && outcome?.kind === "execute") {
    throw new ValidationError("A reply must include a message. Cancel the reply before you run a slash command.");
  }

  // Resolve file attachment refs. Consumption is atomic for the whole
  // batch: the loop is synchronous, so two concurrent submits can never
  // both take the same ref (single-use holds under races). A bad ref in
  // the batch — or any failure before the prompt is queued — restores
  // every ref this request took, so the good refs survive for a retry.
  const attachmentRefStore = getAttachmentRefStore();
  const resolvedFileAttachments: AttachmentInfo[] = [];

  // The same ref listed twice in one request attaches its file once.
  const uniqueRefs = [...new Set((fileRefs ?? []).map((r) => r.ref))];
  for (const ref of uniqueRefs) {
    const info = attachmentRefStore.consume(row.id, ref);
    if (!info) {
      // Ref not found, expired, already used, or wrong session.
      attachmentRefStore.restore(resolvedFileAttachments);
      throw new UnknownAttachmentError(ref);
    }
    resolvedFileAttachments.push(info);
  }

  // Resolve "/"-text against the registry BEFORE choosing a path. Every
  // path targets the REQUESTED thread — never silently rerouted:
  // - execute-kind (builtin/plugin) → `session.prompt()` with the resolved
  //   thread id, so the command_result lands where the client is watching.
  // - expand-kind (skill/template) → expand here, then submit the expanded
  //   text to the requested thread like any prompt.
  // - pass-kind (unknown "/word", e.g. "/etc/passwd is the file") → the
  //   requested thread, text unchanged.

  // Build the prompt content once per text variant: plain text, or text +
  // attachments. The expand path swaps only the text; the attachment
  // mapping must stay identical on both paths.
  //
  // Image attachments map to the existing shape; file attachments add a
  // system-authored note and persist on MessageEntry.attachments.
  const imageAttachments =
    attachments && attachments.length > 0
      ? attachments.map((att) => ({
          type: "image" as const,
          url: att.url,
          mimeType: att.mimeType,
          name: att.name,
        }))
      : undefined;

  // Build final attachment array: images + files
  const allAttachments = [
    ...(imageAttachments ?? []),
    ...resolvedFileAttachments.map((info) => ({
      type: "file" as const,
      path: info.path,
      bytes: info.bytes,
      sha256: info.sha256,
      mimeType: info.mimeType ?? "application/octet-stream",
      markdownPath: info.markdownPath,
      extractedTo: info.extractedTo,
      extractedFiles: info.extractedFiles,
      name: info.name,
    })),
  ];

  // The file-attachment note is NOT baked into the prompt text here: the
  // engine renders it at transcript-build time from the persisted
  // MessageEntry.attachments (see `userContentBlocks` in the engine), so
  // the persisted user text stays clean and slash-command dispatch below
  // still sees text that starts with "/".
  const promptText = outcome?.kind === "expand" ? outcome.text : text;

  const withAttachments = (t: string) =>
    allAttachments.length > 0 ? { text: t, attachments: allAttachments } : t;

  // A submit failure hands the consumed refs back so a retry can resend
  // them. Once the prompt is queued the refs stay consumed — the
  // attachments are already part of the persisted prompt.
  // A context-invocation skill expansion carries the skill identity as
  // submission metadata; the persisted entry's wire projection renders it
  // as a skill card without re-parsing the text.
  const skillMetadata =
    outcome?.kind === "expand" && outcome.skill
      ? { skill: outcome.skill.source.name, skillArgs: outcome.skill.args }
      : undefined;

  // This is the user action time. Persist it only after the engine accepts
  // the prompt, so a slow command cannot overtake a later user submission.
  const activityAt = Date.now();
  let receipt;
  try {
    receipt =
      outcome && outcome.kind === "execute"
        ? await engineSession.prompt(withAttachments(promptText), {
            threadId: thread.id,
            ...(admission.queueMode ? { queueMode: admission.queueMode } : {}),
            ...(author ? { author } : {}),
            ...(replyTo ? { metadata: { [REPLY_METADATA_KEY]: replyTo } } : {}),
          })
        : await thread.submitPrompt(withAttachments(promptText), {
            ...(admission.queueMode ? { queueMode: admission.queueMode } : {}),
            ...((skillMetadata || replyTo)
              ? { metadata: { ...(skillMetadata ?? {}), ...(replyTo ? { [REPLY_METADATA_KEY]: replyTo } : {}) } }
              : {}),
            ...(outcome?.kind === "expand" && outcome.skill
              ? { skillInvocation: { skill: outcome.skill.source, path: outcome.skill.path } }
              : {}),
            ...(author ? { author } : {}),
          });
  } catch (err) {
    attachmentRefStore.restore(resolvedFileAttachments);
    throw err;
  }

  // Session recency is completion time. `activityAt` marks request start and
  // can be older than a later submission that already finished.
  const sessionTouchedAt = Date.now();
  await recordSessionActivity(db, row.id, sessionTouchedAt);
  await recordThreadActivityBestEffort(() => recordActivity(activityAt));

  return {
    // Commands take no queue item; "" would read as a real (broken) id.
    messageId: receipt.queueItemId || null,
    threadId: receipt.threadId,
    activityAt,
  };
}

messagesRouter.post("/:id/messages", async (c) => {
  const row = await loadOwnedSession(c);
  if (!row) return c.json({ error: "session not found" }, 404);

  let body: SendPromptRequest;
  try {
    body = (await c.req.json()) as SendPromptRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const promoteItemId =
    typeof body.promoteItemId === "string" && body.promoteItemId.length > 0
      ? body.promoteItemId
      : undefined;
  if (!promoteItemId && typeof body.text !== "string") {
    return c.json({ error: "text must be a string (it may be empty with attachments)" }, 400);
  }
  if (body.queueMode !== undefined && body.queueMode !== "followup" && body.queueMode !== "steer") {
    return c.json(
      { error: "queueMode must be 'followup' or 'steer'. Omit it to use the thread default." },
      400,
    );
  }
  if (body.attachments !== undefined) {
    const valid =
      Array.isArray(body.attachments) &&
      body.attachments.every(
        (a) => a !== null && typeof a === "object" && typeof a.url === "string" && typeof a.mimeType === "string",
      );
    if (!valid) {
      return c.json(
        { error: "attachments must be an array of { url, mimeType } image objects. Re-attach the images and send again." },
        400,
      );
    }
  }
  if (Array.isArray(body.attachments) && body.attachments.length > 20) {
    return c.json({ error: "At most 20 images are allowed per message." }, 400);
  }
  if (body.fileRefs !== undefined) {
    const valid =
      Array.isArray(body.fileRefs) &&
      body.fileRefs.every((a) => a !== null && typeof a === "object" && typeof a.ref === "string");
    if (!valid) {
      return c.json(
        { error: "fileRefs must be an array of { ref } objects. Re-upload the files and retry." },
        400,
      );
    }
  }

  if (!promoteItemId && !body.text.trim() && !body.attachments?.length && !body.fileRefs?.length) {
    return c.json({ error: "Add a message or an attachment." }, 400);
  }

  try {
    let replyTo: MessageReplyReference | undefined;
    if (body.replyToMessageId !== undefined) {
      if (typeof body.replyToMessageId !== "string" || body.replyToMessageId.length === 0) {
        return c.json({ error: "replyToMessageId must name an assistant message in this thread." }, 400);
      }
      const loaded = await loadEngineSession(c);
      if ("error" in loaded) return loaded.error;
      const targetThread = resolveThread(loaded.engineSession, body.threadId);
      if (!targetThread) return c.json({ error: "thread not found" }, 404);
      const entries = await targetThread.readEntries();
      const target = entries.find(
        (entry): entry is Extract<SessionEntry, { type: "message" }> =>
          entry.type === "message" && entry.id === body.replyToMessageId,
      );
      const excerpt =
        target?.role === "assistant" && target.stopReason === "end_turn"
          ? assistantReplyExcerpt(target)
          : "";
      if (!target || target.role !== "assistant" || target.stopReason !== "end_turn" || !excerpt) {
        return c.json(
          { error: "Reply target not found in this thread. Reply to a completed assistant message." },
          400,
        );
      }
      replyTo = { messageId: target.id, excerpt };
    }

    // Stamp the sender on the submission. The engine persists it on the
    // user entry (`MessageEntry.author`); on team-owned sessions several
    // members share one thread, and both the UI and the model need to tell
    // their messages apart.
    const resp = await submitSessionPrompt(c.var.providers, row, body.text ?? "", {
      threadId: body.threadId,
      attachments: body.attachments,
      fileRefs: body.fileRefs,
      ...(body.queueMode ? { queueMode: body.queueMode } : {}),
      ...(promoteItemId ? { promoteItemId } : {}),
      author: promptAuthorFromUser(c.var.user),
      ...(replyTo ? { replyTo } : {}),
    });
    if (!resp) return c.json({ error: "thread not found" }, 404);
    return c.json(resp, 202);
  } catch (err) {
    if (err instanceof UnknownAttachmentError) {
      return c.json(
        {
          error: err.message,
          corrective: "Re-upload the file and retry.",
        },
        400,
      );
    }
    if (err instanceof NotFoundError && err.resource === "queue item") {
      return c.json(
        {
          error: "That queued message was not found. Send the message again.",
        },
        404,
      );
    }
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

// ── Thread abort ──────────────────────────────────────────────────────────
//
// Mirrors the engine-spec route table: `POST .../threads/:threadId/abort`
// interrupts only the turn named by the gesture target. `Thread.interrupt()`
// stamps abort intent only if that item is still active, withdraws its gates,
// and starts the next queued submission. A delayed retry cannot abort it.
messagesRouter.post("/:id/threads/:threadId/abort", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { engineSession } = result;

  const threadId = c.req.param("threadId");
  const thread = engineSession.threadById(threadId);
  if (!thread) return c.json({ error: "thread not found" }, 404);

  const rawBody = await c.req.text();
  if (rawBody.trim().length === 0) {
    // Clients loaded before target-bound Stop cannot identify the turn that
    // the gesture saw. Never guess: a delayed bodyless retry could otherwise
    // abort the queued successor. The durable error event gives those tabs a
    // visible reload instruction instead of only a rejected fetch in console.
    await engineSession.emit({
      type: "error",
      threadId,
      code: "client_update_required",
      error: "Valet was updated. Reload this page, then select Stop again.",
      recoverable: true,
    });
    return c.json(
      {
        error: "This Stop request came from an older client.",
        corrective: "Reload this page, then select Stop again.",
      },
      409,
    );
  }

  let body: AbortThreadRequest;
  try {
    body = JSON.parse(rawBody) as AbortThreadRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof body.targetItemId !== "string" ||
    body.targetItemId.length === 0
  ) {
    return c.json({ error: "targetItemId is required. Send the active queue item as targetItemId." }, 400);
  }

  await thread.interrupt(body.targetItemId);
  return c.json({ ok: true });
});

// A queue can be busy without an active Stop target while paused or between
// durable claims. This control resumes a paused queue and kicks an unpaused
// queue without stamping abort intent on any submission.
messagesRouter.post("/:id/threads/:threadId/resume", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { engineSession } = result;

  const threadId = c.req.param("threadId");
  if (!engineSession.threadById(threadId)) return c.json({ error: "thread not found" }, 404);

  await engineSession.resume({ threadId });
  return c.json({ ok: true });
});

// ── Decision gates ────────────────────────────────────────────────────────
//
// A gate is created by a tool calling `ctx.requestDecision(...)`. The engine
// emits `decision_gate` on the bus (forwarded to the WS by the bridge) and
// suspends the thread on `blocked_on_decision_gate` status. The user resolves
// or withdraws via these endpoints, which routes to `Session.resolveDecision`
// / `Session.withdrawDecision` — which finds the thread that owns the gate
// and unblocks it.

async function canAnswerDecision(c: Context<AppEnv>, session: SessionOwnerLike): Promise<boolean> {
  if (session.ownerType === "org" && c.req.param("id").startsWith("wf:")) {
    return c.var.principal.type === "user" && session.ownerId === c.var.user.orgId
      && await isOrgAdminUser(c);
  }
  return canResolveSessionGate(c.var.providers.db, session, c.var.principal);
}

/** Workflow agent gates have a run owner, but no app session row. Only
 * decision endpoints use this fallback; it grants no sandbox or prompt access.
 */
async function loadDecisionSession(c: Context<AppEnv>) {
  const id = c.req.param("id");
  if (!id.startsWith("wf:")) return loadEngineSession(c);
  const missing = () => ({ error: c.json({ error: "session not found" }, 404) });
  let parts;
  try { parts = parseWorkflowSessionId(id); } catch { return missing(); }
  const p = c.var.providers;
  const run = await p.workflowStore.getRun(parts.runId);
  if (!run?.owner) return missing();
  const [definition] = await p.db.select({ orgId: workflowDefinitions.orgId })
    .from(workflowDefinitions).where(eq(workflowDefinitions.id, run.params.workflowId)).limit(1);
  if (!definition || definition.orgId !== c.var.user.orgId) return missing();
  const session = {
    ownerType: run.owner.ownerType, ownerId: run.owner.ownerId,
    userId: run.owner.ownerType === "user" ? run.owner.ownerId : "",
    orgId: definition.orgId,
  };
  if (!(await canAnswerDecision(c, session))) return missing();
  // A guessed node ID must not materialize a new agent on a read request.
  if (!(await p.engineStore.getSession(id))) return missing();
  const engineSession = await ensureWorkflowSession({
    db: p.db, store: p.workflowStore, engineStore: p.engineStore,
    host: p.engineHost, actionPluginByService: p.actionPluginByService,
    credentials: p.engineCredentials,
  }, id);
  return { session, engineSession };
}

messagesRouter.get("/:id/decisions", async (c) => {
  const result = await loadDecisionSession(c);
  if ("error" in result) return result.error;
  const { engineSession } = result;

  const pending = await engineSession.pendingDecisionGates();
  const body: ListDecisionsResponse = { gates: pending.map(engineGateToWire) };
  return c.json(body);
});

messagesRouter.post("/:id/decisions/:gateId/resolve", async (c) => {
  const result = await loadDecisionSession(c);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;
  const gateId = c.req.param("gateId");

  // Explicit resolve authorization, distinct from `loadEngineSession`'s
  // view check: answering a gate acts on the session's behalf. The same
  // named check gates the channel gate-callback path.
  if (!(await canAnswerDecision(c, session))) {
    return c.json(
      { error: "Only the session owner or a member of its team can resolve this approval. Ask one of them." },
      403,
    );
  }

  let body: ResolveDecisionRequest;
  try {
    body = (await c.req.json()) as ResolveDecisionRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (body.actionId === undefined && body.value === undefined) {
    return c.json({ error: "actionId or value is required" }, 400);
  }

  // Route-level 403 for `always_allow` (action-policies plan, Task 4):
  // defense-in-depth's front half — `onResolution` (T3) already fails this
  // closed for a non-admin resolver, but only after the engine has already
  // opened/consumed the gate. Rejecting here means a non-admin never sees
  // the button "work" only to fail late; the button itself should be hidden
  // client-side, this is the server-side backstop. `canApplyAlwaysAllow` is
  // the shared guard (also called by the channel gate-callback path) and is
  // checked against the SESSION's org, the scope the policy write lands in.
  if (body.actionId === GATE_ACTION_ALWAYS_ALLOW) {
    // A team key carries the minting admin as `c.var.user` for audit only;
    // an org-wide policy is that admin's decision to make signed in, never
    // a CI key's. Every other org-admin gate short-circuits the same way
    // (`_org-admin.ts`).
    if (c.var.principal.type === "team") {
      return c.json(
        { error: "A team API key cannot grant an always-allow policy. Sign in as an organization admin to apply it." },
        403,
      );
    }
    if (!(await canApplyAlwaysAllow(c.var.providers.db, session.orgId, c.var.user.id))) {
      return c.json({ error: "org admin required for always_allow" }, 403);
    }
  }

  // Confirm the gate is actually pending in this session before resolving.
  // Without this check, a stale gateId from the client would silently no-op.
  const pending = await engineSession.pendingDecisionGates();
  const gate = pending.find((g) => g.id === gateId);
  if (!gate) return c.json({ error: "gate not pending" }, 404);

  if (gate.context?.browser) {
    const policy = c.var.providers.engineHost.browserPolicy();
    if (c.var.principal.type !== 'user' || !policy) {
      return c.json({ error: 'A browser approval requires an authorized user. Sign in to Valet.' }, 403);
    }
    try {
      await policy.authorize({ protocolVersion: '1.0', sessionId: c.req.param('id'),
        threadId: gate.threadId, actorId: c.var.user.id, ownerId: session.ownerId });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Browser access changed. Reopen the session.' }, 403);
    }
  }

  await engineSession.resolveDecision(gateId, {
    actionId: body.actionId,
    value: body.value,
    resolvedBy: c.var.user.id,
    resolvedAt: Date.now(),
    source: { channelType: "web" },
  });
  return c.json({ ok: true });
});

messagesRouter.post("/:id/decisions/:gateId/withdraw", async (c) => {
  const result = await loadDecisionSession(c);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;
  const gateId = c.req.param("gateId");

  // Same explicit resolve authorization as the resolve route above —
  // withdrawing settles the gate too.
  if (!(await canAnswerDecision(c, session))) {
    return c.json(
      { error: "Only the session owner or a member of its team can resolve this approval. Ask one of them." },
      403,
    );
  }

  let body: WithdrawDecisionRequest = {};
  try {
    const text = await c.req.text();
    body = text ? (JSON.parse(text) as WithdrawDecisionRequest) : {};
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  // The user-initiated path should always be `cancel`. `steer` and `abort`
  // are engine-internal reasons; reject them so we don't end up with
  // misleading audit records.
  const reason = body.reason ?? "cancel";
  if (reason !== "cancel") {
    return c.json({ error: "only reason='cancel' is allowed from clients" }, 400);
  }

  const pending = await engineSession.pendingDecisionGates();
  const gate = pending.find((g) => g.id === gateId);
  if (!gate) return c.json({ error: "gate not pending" }, 404);

  await engineSession.withdrawDecision(gateId, reason);
  return c.json({ ok: true });
});

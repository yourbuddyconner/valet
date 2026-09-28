/**
 * Assistants — the rows behind every `assistant:{id}` session.
 *
 * An assistant is a named agent a principal owns. The principal is its
 * OWNER and SCOPE, not its identity, so one principal owns any number.
 * `docs/specs/2026-08-13-assistants-design.md` is the contract.
 *
 * Two entry points, and no third:
 *
 *   - `resolveDefaultAssistant` turns a principal into its default
 *     assistant, creating that assistant on first use. Every machine-driven
 *     path — a workflow `orchestrator` node, an event subscription, a
 *     channel binding — says "prompt the team's assistant" and has no basis
 *     for choosing between several, so they all resolve through here.
 *   - `ensureDefaultAssistantSession` adds the two things an HTTP caller
 *     needs on top: the woken engine session, and the `agent_sessions` app
 *     row the session routes read.
 *
 * Callers that already hold an assistant id (a session address the client
 * sent back) go to `EngineHost.assistantSessionFor` directly instead.
 */
import { assistantSessionId, type Principal, type Session } from "@valet/engine";
import { and, asc, desc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { EngineHost } from "../engine/host.js";
import type { AppDb, AppQueryable } from "../lib/drizzle.js";
import { agentSessions, assistants, type AssistantRow } from "../schema/index.js";
import type { AssistantBehavior, AssistantSummary } from "../wire/types.js";
import { parseAssistantBehavior, serializeAssistantBehavior, validateAssistantBehavior } from "./behavior.js";
import { PERSONALITY_INJECT_CAP } from "./persona.js";

/** Compatibility writes cannot reintroduce multiple customizable profiles. */
export const WORKSPACE_ASSISTANT_MESSAGE = "Each personal space and team has one assistant. Manage workspace settings or start a new thread instead.";

/** Server cap on `avatarUrl` length. Slack truncates nothing here; the cap
 * only keeps a pathological value out of the row. */
export const AVATAR_URL_CAP = 2048;

/** Raised when a request would leave a principal with no default assistant. */
export class DefaultAssistantArchiveError extends Error {
  readonly code = "assistant_is_default";
  readonly statusCode = 409;
  constructor() {
    super(
      "This is the default assistant. Promote another assistant to default first, then archive this one.",
    );
    this.name = "DefaultAssistantArchiveError";
  }
}

/** Raised when a request targets an assistant that is already archived. */
export class ArchivedAssistantError extends Error {
  readonly code = "assistant_archived";
  readonly statusCode = 409;
  constructor() {
    super("This assistant is archived. Create a new assistant instead.");
    this.name = "ArchivedAssistantError";
  }
}

/** The wire shape of one row. `name` is absent until someone sets it. */
export function toAssistantSummary(row: AssistantRow): AssistantSummary {
  return {
    id: row.id,
    owner: { type: row.ownerType, id: row.ownerId },
    ...(row.name !== null ? { name: row.name } : {}),
    ...(row.avatarUrl !== null ? { avatarUrl: row.avatarUrl } : {}),
    ...(row.personality !== null ? { personality: row.personality } : {}),
    ...(() => {
      const behavior = parseAssistantBehavior(row.behavior, row.id);
      return behavior !== null ? { behavior } : {};
    })(),
    sessionId: row.sessionId,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    model: row.model,
    reasoning: row.reasoning,
  };
}

function ownerMatch(orgId: string, principal: Principal): SQL | undefined {
  return and(
    eq(assistants.orgId, orgId),
    eq(assistants.ownerType, principal.type),
    eq(assistants.ownerId, principal.id),
  );
}

/** One row by id. Returns undefined for an id that does not exist. */
export async function loadAssistant(db: AppQueryable, assistantId: string): Promise<AssistantRow | undefined> {
  const rows = await db.select().from(assistants).where(eq(assistants.id, assistantId)).limit(1);
  return rows[0];
}

/**
 * Check that `assistantId` names a live assistant of `owner` inside `orgId`.
 * Returns a message to refuse the write with, or null when the pairing is
 * good. Shared by every automation that can name an assistant — event
 * subscriptions and schedules — so the rule cannot drift between them.
 *
 * The message never distinguishes "no such assistant" from "someone else's
 * assistant": an id the caller may not reach must read the same as one that
 * does not exist, the same 404-not-403 convention the routes use for teams
 * and workflows.
 */
export async function checkAssistantForOwner(
  db: AppQueryable,
  orgId: string,
  owner: { type: "user" | "team" | "org"; id: string },
  assistantId: string,
): Promise<string | null> {
  const row = await loadAssistant(db, assistantId);
  if (
    row === undefined ||
    row.orgId !== orgId ||
    row.ownerType !== owner.type ||
    row.ownerId !== owner.id ||
    row.archivedAt !== null
  ) {
    return `unknown assistant: ${assistantId}`;
  }
  return null;
}

export function assistantSenderIdentity(
  row: Pick<AssistantRow, "name" | "avatarUrl">,
): { displayName?: string; avatarUrl?: string } | undefined {
  const displayName = row.name ?? undefined;
  const avatarUrl = row.avatarUrl ?? undefined;
  return displayName === undefined && avatarUrl === undefined
    ? undefined
    : {
        ...(displayName !== undefined ? { displayName } : {}),
        ...(avatarUrl !== undefined ? { avatarUrl } : {}),
      };
}

/**
 * The assistant that owns `sessionId`, if any. The assistants table is the
 * authority on which session ids are assistant sessions (the
 * `assistants_session` unique index): rows migrated from
 * `orchestrator_identities` keep legacy `orchestrator:*` ids that a
 * `parseAssistantSessionId` prefix parse cannot recognize. Callers deciding
 * "is this session an assistant's?" must use this lookup, not the prefix.
 */
export async function loadAssistantBySessionId(
  db: AppQueryable,
  sessionId: string,
): Promise<AssistantRow | undefined> {
  const rows = await db
    .select()
    .from(assistants)
    .where(eq(assistants.sessionId, sessionId))
    .limit(1);
  return rows[0];
}

/**
 * The principal's default assistant if it has one, creating nothing. The
 * read half of `resolveDefaultAssistant`, exported for the routes that must
 * stay side-effect-free.
 *
 * Matches the partial unique index exactly: `is_default` alone identifies
 * the row. A default row is always live, so no `archived_at` filter is
 * needed here — adding one would hide a row the index still counts, and
 * the resolver below would then try to create a second default and fail.
 * Two writers hold that invariant: `archiveAssistant` refuses the default,
 * and `retireAssistant` (session delete) clears `is_default` in the same
 * update that archives.
 */
export async function findDefaultAssistant(
  db: AppQueryable,
  orgId: string,
  principal: Principal,
): Promise<AssistantRow | undefined> {
  const rows = await db
    .select()
    .from(assistants)
    .where(and(ownerMatch(orgId, principal), eq(assistants.isDefault, true)))
    .limit(1);
  return rows[0];
}

function newAssistantRow(args: {
  orgId: string;
  principal: Principal;
  name: string | null;
  isDefault: boolean;
  personality?: string | null;
  behavior?: string | null;
}): AssistantRow {
  const id = `asst_${randomUUID()}`;
  return {
    id,
    orgId: args.orgId,
    ownerType: args.principal.type,
    ownerId: args.principal.id,
    name: args.name,
    avatarUrl: null,
    personality: args.personality ?? null,
    behavior: args.behavior ?? null,
    model: null,
    reasoning: null,
    sessionId: assistantSessionId(id),
    isDefault: args.isDefault,
    createdAt: Date.now(),
    archivedAt: null,
  };
}

/**
 * The principal's default assistant, created on first use.
 *
 * This is the ONLY way a principal becomes a session address. Nothing
 * derives a session id from a principal any more — a principal owns any
 * number of assistants, so only this lookup can say which one automation
 * means.
 *
 * Takes `AppQueryable` so a writer that creates the principal can seed its
 * default inside the same transaction (`createTeam`, TKAI-337): if the
 * team insert rolls back, the assistant goes with it.
 *
 * Concurrent first calls (two tabs, or a workflow racing a human) both see
 * no default and both insert. The partial unique index picks one winner;
 * `onConflictDoNothing` turns the loser's insert into a no-op instead of an
 * uncaught constraint throw, and the re-read returns the winner's row.
 */
export async function resolveDefaultAssistant(
  db: AppQueryable,
  orgId: string,
  principal: Principal,
): Promise<AssistantRow> {
  const existing = await findDefaultAssistant(db, orgId, principal);
  if (existing) return existing;

  const row = newAssistantRow({ orgId, principal, name: null, isDefault: true });
  const inserted = await db.insert(assistants).values(row).onConflictDoNothing().returning();
  if (inserted[0]) return inserted[0];

  const winner = await findDefaultAssistant(db, orgId, principal);
  if (!winner) {
    throw new Error(
      `assistants: no default assistant for ${principal.type}:${principal.id} after an insert conflict — ` +
        `the partial unique index rejected the insert but no default row exists`,
    );
  }
  return winner;
}

/**
 * Get-or-create the session of `principal`'s DEFAULT assistant.
 *
 * Returns the engine session plus the assistant row it belongs to. Also
 * backfills the `agent_sessions` app row, which is what makes the ordinary
 * session routes (messages, threads, decisions, the WS) work against this
 * session id. Idempotent: a second call finds the row from the first.
 * Concurrent first calls can both see no row and both insert, so the insert
 * is `onConflictDoNothing` on the primary key.
 */
export async function ensureDefaultAssistantSession(
  deps: { db: AppDb; engineHost: EngineHost },
  principal: Principal,
  meta: { actorUserId: string; orgId: string },
): Promise<{ assistant: AssistantRow; sessionId: string; session: Session }> {
  const assistant = await resolveDefaultAssistant(deps.db, meta.orgId, principal);
  return ensureAssistantSession(deps, assistant, meta);
}

/**
 * Get-or-create the session of ONE assistant, default or not.
 *
 * Creating an assistant writes only the `assistants` row — an assistant with
 * no conversation has no session to hold. The session and its
 * `agent_sessions` app row are materialized here, the first time somebody
 * opens it. Without this an assistant you just created would list fine and
 * 404 the moment you clicked it, because every ordinary session route reads
 * the app row.
 *
 * Deliberately not restricted to the default. The default is only the one a
 * machine picks when nobody chose; nothing about materializing a session
 * depends on it, and a version of this that resolved the default would be
 * unreachable for every other assistant.
 */
export async function ensureAssistantSession(
  deps: { db: AppDb; engineHost: EngineHost },
  assistant: AssistantRow,
  meta: { actorUserId: string; orgId: string },
): Promise<{ assistant: AssistantRow; sessionId: string; session: Session }> {
  const principal: Principal = { type: assistant.ownerType, id: assistant.ownerId };
  const session = await deps.engineHost.assistantSessionFor(assistant.id, meta, {
    sessionId: assistant.sessionId,
  });
  const sessionId = session.id;
  // Every caller of this function intends USE (channel delivery, event
  // dispatch, workflow orchestrator node, the explicit open-conversation
  // route) — never a passive read. A hibernated row heals to active here;
  // chat-only assistant turns make no ready transition, so the
  // attachment-side hooks cannot.
  await deps.engineHost.markSessionUsed(sessionId);

  const existingRows = await deps.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  if (!existingRows[0]) {
    const now = Date.now();
    const data = await session.toData();
    await deps.db
      .insert(agentSessions)
      .values({
        id: sessionId,
        userId: meta.actorUserId,
        orgId: meta.orgId,
        workspace: data.workspace,
        title: assistant.name ?? "Assistant",
        status: "active",
        ownerType: principal.type,
        ownerId: principal.id,
        // A new team assistant resolves credentials as the team (team
        // credentials design, deviation 13).
        credentialOwnerMode: "owner",
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
      })
      .onConflictDoNothing();
  }

  return { assistant, sessionId, session };
}

// ── Listing ───────────────────────────────────────────────────────────────

/**
 * Live assistants owned by any of `owners`, default first, then oldest
 * first, in one query. The unfiltered list passes the caller plus every
 * team the caller belongs to; the filtered list passes the one owner it was
 * asked for.
 */
export async function listAssistantsForOwners(
  db: AppDb,
  orgId: string,
  owners: Principal[],
): Promise<AssistantRow[]> {
  if (owners.length === 0) return [];
  const byOwner = owners.map((p) =>
    and(eq(assistants.ownerType, p.type), eq(assistants.ownerId, p.id)),
  );
  return db
    .select()
    .from(assistants)
    .where(and(eq(assistants.orgId, orgId), isNull(assistants.archivedAt), or(...byOwner)))
    .orderBy(desc(assistants.isDefault), asc(assistants.createdAt));
}

// ── Mutations ─────────────────────────────────────────────────────────────

/**
 * Create an assistant for `principal`.
 *
 * The new assistant becomes the default only when the principal has none —
 * a principal must never hold zero defaults, or every automation targeting
 * it strands. A concurrent creation can take the default slot between the
 * check and the insert; the partial unique index catches that, and the
 * retry re-inserts the SAME id as an ordinary assistant.
 *
 * `config.personality` is the raw persona text. It is trimmed and an empty
 * result stored as null at CREATE time — a brand-new assistant with no
 * personality is "never configured" and keeps the memory-file fallback.
 * (`patchAssistant` differs: an explicit clear there stores `""`, the
 * neutral persona.) `config.behavior` is the parsed
 * `AssistantBehavior`; this function serializes it to JSON before writing so
 * callers never touch the wire format directly.
 */
export async function createAssistant(
  db: AppDb,
  orgId: string,
  principal: Principal,
  name: string | null,
  config?: { personality?: string | null; behavior?: AssistantBehavior | null },
): Promise<AssistantRow> {
  const hasDefault = (await findDefaultAssistant(db, orgId, principal)) !== undefined;
  const trimmedPersonality =
    config?.personality == null ? null : config.personality.trim() || null;
  const row = newAssistantRow({
    orgId,
    principal,
    name,
    isDefault: !hasDefault,
    personality: trimmedPersonality,
    behavior: serializeAssistantBehavior(config?.behavior),
  });

  const inserted = await db.insert(assistants).values(row).onConflictDoNothing().returning();
  if (inserted[0]) return inserted[0];

  const retried = await db
    .insert(assistants)
    .values({ ...row, isDefault: false })
    .returning();
  const created = retried[0];
  if (!created) {
    throw new Error(`assistants: insert of ${row.id} returned no row`);
  }
  return created;
}

/**
 * Rename, promote, and/or rewrite persona/behavior for one assistant,
 * atomically.
 *
 * Promotion demotes the previous default in the SAME transaction. Between
 * the two statements the principal briefly holds no default, and that gap
 * must never be visible: a reader that saw it would resolve no assistant
 * and strand the dispatch it was resolving. Demote-then-promote is also the
 * only order the partial unique index accepts — promoting first collides
 * with the row still holding the slot.
 *
 * Promoting the current default is a no-op by construction: the demote
 * clears it and the promote sets it again.
 *
 * `personality` and `behavior` are optional in the patch object. When
 * present they overwrite the stored value; `null` clears it (`personality:
 * null` stores `""` — the neutral persona — because a stored null means
 * "never configured" and falls back to the memory file). Absent means
 * "do not touch". This function serializes `AssistantBehavior` to JSON via
 * `serializeAssistantBehavior`; the route then evicts the cached engine
 * session so the next wake picks up the new persona and filters.
 */
/**
 * THE profile-patch validator, shared by every editing surface (the
 * assistants routes, the orchestrator /info route, and the assistants.*
 * actions) — one rule set, so a config one surface accepts is never
 * rejected by another. Name typing stays at the edges: the surfaces
 * disagree on whether null clears it, by contract.
 */
export function validateProfilePatch(patch: {
  personality?: string | null;
  behavior?: unknown;
  avatarUrl?: string | null;
}): string | null {
  if (patch.avatarUrl !== undefined && patch.avatarUrl !== null) {
    if (typeof patch.avatarUrl !== "string") {
      return "avatarUrl must be an https:// image URL, or null to clear it.";
    }
    try {
      const parsed = new URL(patch.avatarUrl);
      if (parsed.protocol !== "https:" || !parsed.hostname || /\s/.test(patch.avatarUrl)) {
        return "avatarUrl must be an https:// image URL, or null to clear it.";
      }
    } catch {
      return "avatarUrl must be an https:// image URL, or null to clear it.";
    }
    if (patch.avatarUrl.length > AVATAR_URL_CAP) {
      return `avatarUrl is limited to ${AVATAR_URL_CAP} characters. Use a shorter URL.`;
    }
  }
  if (patch.personality !== undefined && patch.personality !== null && typeof patch.personality !== "string") {
    return "personality must be a string, or null to clear it.";
  }
  if (typeof patch.personality === "string" && patch.personality.length > PERSONALITY_INJECT_CAP) {
    return `personality is limited to ${PERSONALITY_INJECT_CAP} characters. Shorten it.`;
  }
  if (patch.behavior !== undefined && patch.behavior !== null) {
    return validateAssistantBehavior(patch.behavior);
  }
  return null;
}

/**
 * `patchAssistant` plus THE eviction predicate — the single place that
 * knows which fields a cached session bakes in (name feeds the persona
 * prefix; personality and behavior feed prompt and filters). Every editing
 * surface goes through here so a new persona input added to the patch can
 * never be added to one surface's evict check and missed by another's.
 * `evict` is cache-only (never destroy()): an in-flight turn finishes on
 * the old config, the next wake rebuilds.
 */
export async function applyProfilePatch(
  db: AppDb,
  row: AssistantRow,
  patch: {
    name?: string | null;
    /** Outbound-post avatar (TKAI-387). Not part of the eviction check
     * below: channel delivery reads it from the row on every post, so a
     * cached session bakes nothing in. */
    avatarUrl?: string | null;
    isDefault?: true;
    personality?: string | null;
    behavior?: AssistantBehavior | null;
    /** Model-selector-overhaul Task 9. Not part of the eviction check below:
     * unlike name/personality/behavior, the model/reasoning cascade is
     * consulted only at session BUILD time, and restore-no-clobber means a
     * live session's persisted model already won and stays put until the
     * cache is next evicted for some other reason — same as a team or org
     * default-model change, which also does not evict. */
    model?: string | null;
    reasoning?: string | null;
  },
  evict: (sessionId: string) => void,
): Promise<AssistantRow> {
  const updated = await patchAssistant(db, row, patch);
  if (
    row.name !== updated.name ||
    row.personality !== updated.personality ||
    row.behavior !== updated.behavior
  ) {
    evict(updated.sessionId);
  }
  return updated;
}

export async function patchAssistant(
  db: AppDb,
  row: AssistantRow,
  patch: {
    name?: string | null;
    /** https URL, or null to clear. Callers validate with
     * `validateProfilePatch` before calling. */
    avatarUrl?: string | null;
    isDefault?: true;
    personality?: string | null;
    behavior?: AssistantBehavior | null;
    /** Tier token or catalog model id, or null to clear. Callers validate
     * with `assertModelSelectable` before calling — this function trusts
     * the value verbatim. */
    model?: string | null;
    /** A reasoning level, already normalized (trim + lowercase) by the
     * caller, or null to clear. Callers validate with
     * `assertReasoningSelectable` before calling. */
    reasoning?: string | null;
  },
): Promise<AssistantRow> {
  if (row.archivedAt !== null) throw new ArchivedAssistantError();

  // All changed fields in ONE UPDATE (plus the demote when promoting): each
  // statement is a network round trip on the prod node-postgres store, and a
  // longer transaction widens the window where the default slot sits demoted.
  const changes: {
    name?: string | null;
    avatarUrl?: string | null;
    personality?: string | null;
    behavior?: string | null;
    isDefault?: boolean;
    model?: string | null;
    reasoning?: string | null;
  } = {};
  if (patch.name !== undefined) changes.name = patch.name;
  if (patch.avatarUrl !== undefined) changes.avatarUrl = patch.avatarUrl;
  if (patch.personality !== undefined) {
    // An explicit clear stores "" (neutral persona), NOT null: null means
    // "never configured" and falls back to the legacy
    // assistant/personality.md memory file at wake. A clear that stored null
    // would resurrect a file persona the editor never displayed.
    changes.personality = patch.personality === null ? "" : patch.personality.trim();
  }
  if (patch.behavior !== undefined) changes.behavior = serializeAssistantBehavior(patch.behavior);
  if (patch.isDefault === true) changes.isDefault = true;
  if (patch.model !== undefined) changes.model = patch.model;
  if (patch.reasoning !== undefined) changes.reasoning = patch.reasoning;

  return db.transaction(async (tx) => {
    if (patch.isDefault === true) {
      await tx
        .update(assistants)
        .set({ isDefault: false })
        .where(
          and(
            ownerMatch(row.orgId, { type: row.ownerType, id: row.ownerId }),
            eq(assistants.isDefault, true),
          ),
        );
    }
    if (Object.keys(changes).length === 0) return row;
    const updated = await tx
      .update(assistants)
      .set(changes)
      // The archived check above ran on a row the ROUTE loaded, before this
      // transaction. `retireAssistant` (session delete) can archive the row
      // in between; without this guard, a racing promote would stamp
      // `is_default` onto an archived row — a default every list hides and
      // `findDefaultAssistant` returns forever.
      .where(and(eq(assistants.id, row.id), isNull(assistants.archivedAt)))
      .returning();
    const result = updated[0];
    if (!result) {
      // Zero rows means the row archived under us (no hard-delete path
      // exists); the archived refusal is the right answer, just later.
      throw new ArchivedAssistantError();
    }
    return result;
  });
}

/**
 * Archive one assistant. The conversation it held survives — archiving
 * hides the assistant, it does not destroy it.
 *
 * The default cannot be archived while it is the default, because every
 * automation that targets this principal resolves to it.
 */
export async function archiveAssistant(db: AppDb, row: AssistantRow): Promise<AssistantRow> {
  if (row.isDefault) throw new DefaultAssistantArchiveError();
  if (row.archivedAt !== null) return row;

  const updated = await db
    .update(assistants)
    .set({ archivedAt: Date.now() })
    .where(eq(assistants.id, row.id))
    .returning();
  const result = updated[0];
  if (!result) {
    throw new Error(`assistants: ${row.id} disappeared during its own archive`);
  }
  return result;
}

/**
 * Retire one assistant because its SESSION was deleted (TKAI-296).
 *
 * Session delete is the "remove this assistant" action for a team's
 * assistant, so — unlike `archiveAssistant` — the default is not refused.
 * Both fields move in ONE update, which is what keeps
 * `findDefaultAssistant`'s invariant ("a row with is_default is never
 * archived"): `archived_at` drops the row from every list and rail, and
 * clearing `is_default` frees the `assistants_default_owner` partial
 * unique slot so `resolveDefaultAssistant` mints a fresh default on the
 * owner's next access.
 *
 * Takes `AppQueryable` so the caller can run it in the same transaction
 * as the session soft-delete.
 */
export async function retireAssistant(db: AppQueryable, assistantId: string): Promise<void> {
  const updated = await db
    .update(assistants)
    .set({
      // COALESCE keeps the first archive stamp when the row was archived
      // before its session died; `is_default` still clears so the slot
      // frees either way.
      archivedAt: sql`COALESCE(${assistants.archivedAt}, ${Date.now()})`,
      isDefault: false,
    })
    .where(eq(assistants.id, assistantId))
    .returning();
  if (!updated[0]) {
    throw new Error(`assistants: ${assistantId} disappeared during its own retire`);
  }
}

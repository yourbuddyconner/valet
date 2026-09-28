/** Workspace runtime identities. Each personal or team workspace owns one
 * assistant; all channels, workflow threads and subscriptions resolve it by
 * ownership. The database enforces this invariant, including retired rows.
 */
import { assistantSessionId, type Principal, type Session } from "@valet/engine";
import { and, asc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { EngineHost } from "../engine/host.js";
import type { AppDb, AppQueryable } from "../lib/drizzle.js";
import { agentSessions, assistants, type AssistantRow } from "../schema/index.js";
import type { AssistantSummary } from "../wire/types.js";
import { parseAssistantBehavior } from "./behavior.js";

/** Reject assistant selection in workspace-owned writes. */
export const WORKSPACE_ASSISTANT_MESSAGE = "Each personal space and team has one assistant. Manage workspace settings or start a new thread instead.";

/** Raised when a request targets an assistant that is already archived. */
export class ArchivedAssistantError extends Error {
  readonly code = "assistant_archived";
  readonly statusCode = 409;
  constructor() {
    super("This workspace assistant has been retired.");
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

/** Find the workspace identity without creating it. Retired rows remain
 * visible here so callers cannot create a replacement for the same owner. */
export async function findDefaultAssistant(
  db: AppQueryable,
  orgId: string,
  principal: Principal,
): Promise<AssistantRow | undefined> {
  const rows = await db
    .select()
    .from(assistants)
    .where(ownerMatch(orgId, principal))
    .limit(1);
  return rows[0];
}

function newAssistantRow(args: {
  orgId: string;
  principal: Principal;
  name: string | null;
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
    createdAt: Date.now(),
    archivedAt: null,
  };
}

/** Resolve the sole workspace identity. Concurrent first use converges via
 * the unconditional owner unique index. Accepts transactions so team creation
 * and its runtime identity commit or roll back together. */
export async function resolveDefaultAssistant(
  db: AppQueryable,
  orgId: string,
  principal: Principal,
): Promise<AssistantRow> {
  const existing = await findDefaultAssistant(db, orgId, principal);
  if (existing) {
    if (existing.archivedAt !== null) throw new ArchivedAssistantError();
    return existing;
  }

  const row = newAssistantRow({ orgId, principal, name: null });
  const inserted = await db.insert(assistants).values(row).onConflictDoNothing().returning();
  if (inserted[0]) return inserted[0];

  const winner = await findDefaultAssistant(db, orgId, principal);
  if (!winner) {
    throw new Error(
      `assistants: no default assistant for ${principal.type}:${principal.id} after an insert conflict — ` +
        `the workspace unique index rejected the insert but no owner row exists`,
    );
  }
  if (winner.archivedAt !== null) throw new ArchivedAssistantError();
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

/** Materialize the workspace runtime and its API session record on first use. */
async function ensureAssistantSession(
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
 * Live workspace runtimes owned by any of `owners`, oldest
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
    .orderBy(asc(assistants.createdAt));
}

export async function retireAssistant(db: AppQueryable, assistantId: string): Promise<void> {
  const updated = await db
    .update(assistants)
    .set({
      // Preserve the first retirement timestamp; the workspace slot stays reserved.
      archivedAt: sql`COALESCE(${assistants.archivedAt}, ${Date.now()})`,
    })
    .where(eq(assistants.id, assistantId))
    .returning();
  if (!updated[0]) {
    throw new Error(`assistants: ${assistantId} disappeared during its own retire`);
  }
}

import type { D1Database } from '@cloudflare/workers-types';
import type {
  AgentSession,
  SessionGitState,
  AdoptionMetrics,
  SessionSourceType,
  PRState,
  FileChangeStatus,
  SessionFileChanged,
  ChildSessionSummary,
  SessionParticipant,
  SessionParticipantRole,
  SessionParticipantSummary,
  SessionShareLink,
  SessionPurpose,
} from '@valet/shared';
import { eq, and, or, ne, lt, gt, desc, asc, sql, inArray, isNull, isNotNull, not } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { getDb, toDate } from '../drizzle.js';
import {
  sessions,
  sessionGitState,
  sessionFilesChanged,
  sessionParticipants,
  sessionShareLinks,
  messages,
} from '../schema/index.js';
import { users } from '../schema/users.js';
import { agentPersonas } from '../schema/personas.js';
import { generateShareToken, ROLE_HIERARCHY, ACTIVE_SESSION_STATUSES, DEFAULT_MAX_ACTIVE_SESSIONS } from './constants.js';
import { getOrgSettings } from './org.js';

// ─── Exported Types ─────────────────────────────────────────────────────────

export type SessionOwnershipFilter = 'all' | 'mine' | 'shared';

export interface GetChildSessionsOptions {
  limit?: number;
  cursor?: string;
  status?: string;
  excludeStatuses?: string[];
  /** When set, return children of ALL orchestrator sessions for this user. */
  userId?: string;
}

export interface PaginatedChildSessions {
  children: ChildSessionSummary[];
  cursor?: string;
  hasMore: boolean;
  totalCount: number;
}

export interface ConcurrencyCheckResult {
  allowed: boolean;
  reason?: string;
  activeCount: number;
  limit: number;
}

// ─── Row-to-Domain Converters ───────────────────────────────────────────────

function rowToSession(row: typeof sessions.$inferSelect & { personaName?: string | null }): AgentSession {
  return {
    id: row.id,
    userId: row.userId,
    workspace: row.workspace,
    status: row.status as AgentSession['status'],
    title: row.title || undefined,
    parentSessionId: row.parentSessionId || undefined,
    containerId: row.containerId || undefined,
    metadata: row.metadata || undefined,
    errorMessage: row.errorMessage || undefined,
    personaId: row.personaId || undefined,
    personaName: (row as any).personaName || undefined,
    isOrchestrator: row.isOrchestrator || undefined,
    activeSeconds: row.activeSeconds || 0,
    purpose: (row.purpose as SessionPurpose) || 'interactive',
    createdAt: toDate(row.createdAt),
    lastActiveAt: toDate(row.lastActiveAt),
  };
}

function rowToGitState(row: typeof sessionGitState.$inferSelect): SessionGitState {
  return {
    id: row.id,
    sessionId: row.sessionId,
    sourceType: (row.sourceType as SessionSourceType) || null,
    sourcePrNumber: row.sourcePrNumber ?? null,
    sourceIssueNumber: row.sourceIssueNumber ?? null,
    sourceRepoFullName: row.sourceRepoFullName || null,
    sourceRepoUrl: row.sourceRepoUrl || null,
    branch: row.branch || null,
    ref: row.ref || null,
    baseBranch: row.baseBranch || null,
    commitCount: row.commitCount ?? 0,
    prNumber: row.prNumber ?? null,
    prTitle: row.prTitle || null,
    prState: (row.prState as PRState) || null,
    prUrl: row.prUrl || null,
    prCreatedAt: row.prCreatedAt || null,
    prMergedAt: row.prMergedAt || null,
    agentAuthored: !!row.agentAuthored,
    createdAt: row.createdAt!,
    updatedAt: row.updatedAt!,
  };
}

function rowToShareLink(row: typeof sessionShareLinks.$inferSelect): SessionShareLink {
  return {
    id: row.id,
    sessionId: row.sessionId,
    token: row.token,
    role: row.role as SessionParticipantRole,
    createdBy: row.createdBy,
    expiresAt: row.expiresAt ? toDate(row.expiresAt) : undefined,
    maxUses: row.maxUses ?? undefined,
    useCount: row.useCount ?? 0,
    active: !!row.active,
    createdAt: toDate(row.createdAt),
  };
}

// ─── Session CRUD ───────────────────────────────────────────────────────────

export async function createSession(
  db: AppDb,
  data: { id: string; userId: string; workspace: string; title?: string; parentSessionId?: string; containerId?: string; metadata?: Record<string, unknown>; personaId?: string; isOrchestrator?: boolean; purpose?: SessionPurpose }
): Promise<AgentSession> {
  const purpose = data.purpose || (data.isOrchestrator ? 'orchestrator' : 'interactive');

  await db.insert(sessions).values({
    id: data.id,
    userId: data.userId,
    workspace: data.workspace,
    status: 'initializing',
    containerId: data.containerId || null,
    metadata: data.metadata || null,
    title: data.title || null,
    parentSessionId: data.parentSessionId || null,
    personaId: data.personaId || null,
    isOrchestrator: data.isOrchestrator ?? false,
    purpose,
  });

  return {
    id: data.id,
    userId: data.userId,
    workspace: data.workspace,
    status: 'initializing',
    title: data.title,
    parentSessionId: data.parentSessionId,
    containerId: data.containerId,
    metadata: data.metadata,
    personaId: data.personaId,
    isOrchestrator: data.isOrchestrator,
    purpose,
    createdAt: new Date(),
    lastActiveAt: new Date(),
  };
}

export async function getSession(db: AppDb, id: string): Promise<AgentSession | null> {
  const row = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, id))
    .get();
  return row ? rowToSession(row) : null;
}

export async function getUserSessions(
  db: D1Database,
  userId: string,
  options: { limit?: number; cursor?: string; status?: string; ownership?: SessionOwnershipFilter } = {}
): Promise<{ sessions: AgentSession[]; cursor?: string; hasMore: boolean }> {
  const limit = options.limit || 20;
  const ownership = options.ownership || 'all';

  // This query involves a complex dynamic JOIN with DISTINCT and subqueries,
  // so we keep it as raw SQL per the migration guidelines.
  let query = `
    SELECT DISTINCT
      s.*,
      owner.name as owner_name,
      owner.email as owner_email,
      owner.avatar_url as owner_avatar_url,
      ap.name as persona_name,
      (SELECT COUNT(*) FROM session_participants sp2 WHERE sp2.session_id = s.id) as participant_count
    FROM sessions s
    JOIN users owner ON owner.id = s.user_id
    LEFT JOIN agent_personas ap ON ap.id = s.persona_id
    LEFT JOIN session_participants sp ON sp.session_id = s.id AND sp.user_id = ?
    WHERE `;

  const params: (string | number)[] = [userId];

  // Apply ownership filter
  if (ownership === 'mine') {
    query += 's.user_id = ?';
    params.push(userId);
  } else if (ownership === 'shared') {
    query += 's.user_id != ? AND sp.user_id IS NOT NULL';
    params.push(userId);
  } else {
    // 'all' - owned by user OR user is a participant
    query += '(s.user_id = ? OR sp.user_id IS NOT NULL)';
    params.push(userId);
  }

  // Orchestrator sessions are private to their owner and should never appear
  // in other users' lists even if they were previously shared.
  query += ' AND (s.is_orchestrator = 0 OR s.user_id = ?)';
  params.push(userId);

  // Workflow sessions are internal runtime sessions and are hidden from standard lists.
  query += " AND COALESCE(s.purpose, 'interactive') != 'workflow'";

  if (options.status) {
    query += ' AND s.status = ?';
    params.push(options.status);
  }

  if (options.cursor) {
    query += ' AND s.created_at < ?';
    params.push(options.cursor);
  }

  query += ' ORDER BY s.created_at DESC LIMIT ?';
  params.push(limit + 1);

  const stmt = db.prepare(query);
  const result = await stmt.bind(...params).all();
  const rows = result.results || [];

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);

  // Fetch participants for all sessions in batch
  const sessionIds = pageRows.map((row: any) => row.id);
  const participantsBySession = await getParticipantsForSessions(getDb(db), sessionIds);

  const mappedSessions = pageRows.map((row: any) => {
    // Map with snake_case raw SQL row (not Drizzle camelCase)
    const base: AgentSession = {
      id: row.id,
      userId: row.user_id,
      workspace: row.workspace,
      status: row.status,
      title: row.title || undefined,
      parentSessionId: row.parent_session_id || undefined,
      containerId: row.container_id || undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      errorMessage: row.error_message || undefined,
      personaId: row.persona_id || undefined,
      personaName: row.persona_name || undefined,
      isOrchestrator: !!row.is_orchestrator || undefined,
      purpose: row.purpose || 'interactive',
      createdAt: new Date(row.created_at),
      lastActiveAt: new Date(row.last_active_at),
      ownerName: row.owner_name || undefined,
      ownerEmail: row.owner_email || undefined,
      ownerAvatarUrl: row.owner_avatar_url || undefined,
      participantCount: row.participant_count ?? 0,
      participants: participantsBySession.get(row.id) || [],
      isOwner: row.user_id === userId,
    };
    return base;
  });

  return {
    sessions: mappedSessions,
    // Use the raw DB string (YYYY-MM-DD HH:MM:SS) so it matches SQLite's format
    cursor: hasMore ? String((pageRows[pageRows.length - 1] as any).created_at) : undefined,
    hasMore,
  };
}

async function getParticipantsForSessions(
  db: AppDb,
  sessionIds: string[]
): Promise<Map<string, SessionParticipantSummary[]>> {
  if (sessionIds.length === 0) return new Map();

  const rows = await db
    .select({
      sessionId: sessionParticipants.sessionId,
      userId: sessionParticipants.userId,
      role: sessionParticipants.role,
      name: users.name,
      email: users.email,
      avatarUrl: users.avatarUrl,
    })
    .from(sessionParticipants)
    .innerJoin(users, eq(users.id, sessionParticipants.userId))
    .where(inArray(sessionParticipants.sessionId, sessionIds))
    .orderBy(asc(sessionParticipants.createdAt));

  const map = new Map<string, SessionParticipantSummary[]>();
  for (const row of rows) {
    const sid = row.sessionId;
    if (!map.has(sid)) {
      map.set(sid, []);
    }
    map.get(sid)!.push({
      userId: row.userId,
      name: row.name || undefined,
      email: row.email || undefined,
      avatarUrl: row.avatarUrl || undefined,
      role: row.role as SessionParticipantRole,
    });
  }
  return map;
}

export async function updateSessionStatus(
  db: AppDb,
  id: string,
  status: AgentSession['status'],
  containerId?: string,
  errorMessage?: string
): Promise<void> {
  await db
    .update(sessions)
    .set({
      status,
      containerId: containerId !== undefined ? sql`COALESCE(${containerId}, ${sessions.containerId})` : undefined,
      errorMessage: errorMessage || null,
      lastActiveAt: sql`datetime('now')`,
    })
    .where(eq(sessions.id, id));
}

export async function deleteSession(db: AppDb, id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id));
}

// Session metrics (flushed from DO)
export async function updateSessionMetrics(
  db: AppDb,
  id: string,
  metrics: { messageCount: number; toolCallCount: number }
): Promise<void> {
  await db
    .update(sessions)
    .set({
      messageCount: metrics.messageCount,
      toolCallCount: metrics.toolCallCount,
      lastActiveAt: sql`datetime('now')`,
    })
    .where(eq(sessions.id, id));
}

export async function addActiveSeconds(
  db: AppDb,
  id: string,
  seconds: number
): Promise<void> {
  if (seconds <= 0) return;
  await db
    .update(sessions)
    .set({
      activeSeconds: sql`${sessions.activeSeconds} + ${Math.round(seconds)}`,
    })
    .where(eq(sessions.id, id));
}

// Session title update
export async function updateSessionTitle(db: AppDb, sessionId: string, title: string): Promise<void> {
  await db
    .update(sessions)
    .set({
      title,
      lastActiveAt: sql`datetime('now')`,
    })
    .where(eq(sessions.id, sessionId));
}

// ─── Session Git State ──────────────────────────────────────────────────────

export async function createSessionGitState(
  db: AppDb,
  data: {
    sessionId: string;
    sourceType?: SessionSourceType;
    sourcePrNumber?: number;
    sourceIssueNumber?: number;
    sourceRepoFullName?: string;
    sourceRepoUrl?: string;
    branch?: string;
    ref?: string;
    baseBranch?: string;
  }
): Promise<SessionGitState> {
  const id = crypto.randomUUID();

  await db.insert(sessionGitState).values({
    id,
    sessionId: data.sessionId,
    sourceType: data.sourceType || null,
    sourcePrNumber: data.sourcePrNumber ?? null,
    sourceIssueNumber: data.sourceIssueNumber ?? null,
    sourceRepoFullName: data.sourceRepoFullName || null,
    sourceRepoUrl: data.sourceRepoUrl || null,
    branch: data.branch || null,
    ref: data.ref || null,
    baseBranch: data.baseBranch || null,
  });

  return {
    id,
    sessionId: data.sessionId,
    sourceType: data.sourceType || null,
    sourcePrNumber: data.sourcePrNumber ?? null,
    sourceIssueNumber: data.sourceIssueNumber ?? null,
    sourceRepoFullName: data.sourceRepoFullName || null,
    sourceRepoUrl: data.sourceRepoUrl || null,
    branch: data.branch || null,
    ref: data.ref || null,
    baseBranch: data.baseBranch || null,
    commitCount: 0,
    prNumber: null,
    prTitle: null,
    prState: null,
    prUrl: null,
    prCreatedAt: null,
    prMergedAt: null,
    agentAuthored: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function updateSessionGitState(
  db: AppDb,
  sessionId: string,
  updates: Partial<{
    branch: string;
    ref: string;
    baseBranch: string;
    commitCount: number;
    prNumber: number;
    prTitle: string;
    prState: PRState;
    prUrl: string;
    prCreatedAt: string;
    prMergedAt: string;
  }>
): Promise<void> {
  const setValues: Record<string, unknown> = {};

  if (updates.branch !== undefined) setValues.branch = updates.branch;
  if (updates.ref !== undefined) setValues.ref = updates.ref;
  if (updates.baseBranch !== undefined) setValues.baseBranch = updates.baseBranch;
  if (updates.commitCount !== undefined) setValues.commitCount = updates.commitCount;
  if (updates.prNumber !== undefined) setValues.prNumber = updates.prNumber;
  if (updates.prTitle !== undefined) setValues.prTitle = updates.prTitle;
  if (updates.prState !== undefined) setValues.prState = updates.prState;
  if (updates.prUrl !== undefined) setValues.prUrl = updates.prUrl;
  if (updates.prCreatedAt !== undefined) setValues.prCreatedAt = updates.prCreatedAt;
  if (updates.prMergedAt !== undefined) setValues.prMergedAt = updates.prMergedAt;

  if (Object.keys(setValues).length === 0) return;

  setValues.updatedAt = sql`datetime('now')`;

  await db
    .update(sessionGitState)
    .set(setValues)
    .where(eq(sessionGitState.sessionId, sessionId));
}

export async function getSessionGitState(db: AppDb, sessionId: string): Promise<SessionGitState | null> {
  const row = await db
    .select()
    .from(sessionGitState)
    .where(eq(sessionGitState.sessionId, sessionId))
    .get();
  return row ? rowToGitState(row) : null;
}

export async function getAdoptionMetrics(db: AppDb, periodDays: number): Promise<AdoptionMetrics> {
  const result = await db
    .select({
      totalPrsCreated: sql<number>`COUNT(CASE WHEN ${sessionGitState.prNumber} IS NOT NULL AND ${sessionGitState.agentAuthored} = 1 THEN 1 END)`,
      totalPrsMerged: sql<number>`COUNT(CASE WHEN ${sessionGitState.prState} = 'merged' AND ${sessionGitState.agentAuthored} = 1 THEN 1 END)`,
      totalCommits: sql<number>`COALESCE(SUM(${sessionGitState.commitCount}), 0)`,
    })
    .from(sessionGitState)
    .where(gt(sessionGitState.createdAt, sql`datetime('now', '-' || ${periodDays} || ' days')`))
    .get();

  const totalCreated = result?.totalPrsCreated ?? 0;
  const totalMerged = result?.totalPrsMerged ?? 0;

  return {
    totalPRsCreated: totalCreated,
    totalPRsMerged: totalMerged,
    mergeRate: totalCreated > 0 ? Math.round((totalMerged / totalCreated) * 100) : 0,
    totalCommits: result?.totalCommits ?? 0,
  };
}

// ─── Child Sessions ─────────────────────────────────────────────────────────

export async function getChildSessions(
  db: D1Database,
  parentSessionId: string,
  options: GetChildSessionsOptions = {}
): Promise<PaginatedChildSessions> {
  const { limit = 20, cursor, status, excludeStatuses, userId } = options;

  // Build WHERE clauses — raw SQL is used here because of dynamic NOT IN
  // and the LEFT JOIN with session_git_state for child summaries.
  //
  // When userId is provided, widen the query to include children of ALL
  // orchestrator sessions for that user. This ensures thread history
  // survives orchestrator session rotation (new rotation UUID on restore).
  const whereClauses: string[] = [];
  const binds: (string | number)[] = [];

  if (userId) {
    whereClauses.push(
      `s.parent_session_id IN (SELECT id FROM sessions WHERE user_id = ? AND purpose = 'orchestrator')`
    );
    binds.push(userId);
  } else {
    whereClauses.push('s.parent_session_id = ?');
    binds.push(parentSessionId);
  }

  if (status) {
    whereClauses.push('s.status = ?');
    binds.push(status);
  }

  if (excludeStatuses && excludeStatuses.length > 0) {
    const placeholders = excludeStatuses.map(() => '?').join(',');
    whereClauses.push(`s.status NOT IN (${placeholders})`);
    binds.push(...excludeStatuses);
  }

  if (cursor) {
    whereClauses.push('s.created_at < ?');
    binds.push(cursor);
  }

  const whereStr = whereClauses.join(' AND ');

  // Count query (without cursor/limit for total)
  const countClauses = whereClauses.filter((c) => !c.startsWith('s.created_at <'));
  const countBinds = binds.filter((_, i) => !whereClauses[i]?.startsWith('s.created_at <'));
  const countResult = await db
    .prepare(`SELECT COUNT(*) as count FROM sessions s WHERE ${countClauses.join(' AND ')}`)
    .bind(...countBinds)
    .first<{ count: number }>();
  const totalCount = countResult?.count ?? 0;

  // Fetch limit + 1 to detect hasMore
  const fetchLimit = limit + 1;
  const result = await db
    .prepare(
      `SELECT s.id, s.title, s.status, s.workspace, s.created_at,
              g.pr_number, g.pr_state, g.pr_url, g.pr_title
       FROM sessions s
       LEFT JOIN session_git_state g ON g.session_id = s.id
       WHERE ${whereStr}
       ORDER BY s.created_at DESC
       LIMIT ?`
    )
    .bind(...binds, fetchLimit)
    .all();

  const rows = result.results || [];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const children = pageRows.map((row: any) => ({
    id: row.id,
    title: row.title || undefined,
    status: row.status,
    workspace: row.workspace,
    prNumber: row.pr_number ?? undefined,
    prState: row.pr_state || undefined,
    prUrl: row.pr_url || undefined,
    prTitle: row.pr_title || undefined,
    createdAt: row.created_at,
  }));

  return {
    children,
    cursor: hasMore ? (pageRows[pageRows.length - 1]?.created_at as string | undefined) : undefined,
    hasMore,
    totalCount,
  };
}

// ─── Session Concurrency ────────────────────────────────────────────────────

export async function checkSessionConcurrency(
  db: AppDb,
  userId: string
): Promise<ConcurrencyCheckResult> {
  // Get user's custom limit (NULL = default)
  const user = await db
    .select({ maxActiveSessions: users.maxActiveSessions })
    .from(users)
    .where(eq(users.id, userId))
    .get();

  const limit = user?.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS;

  // Count active sessions (exclude orchestrator and workflow sessions)
  const result = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        inArray(sessions.status, ACTIVE_SESSION_STATUSES),
        or(
          isNull(sessions.parentSessionId),
          not(sql`${sessions.parentSessionId} LIKE 'orchestrator:%'`)
        ),
        not(sql`${sessions.id} LIKE 'orchestrator:%'`)
      )
    )
    .get();

  const activeCount = result?.count ?? 0;

  if (activeCount >= limit) {
    return {
      allowed: false,
      reason: `You have ${activeCount} active sessions (limit: ${limit}). Terminate some sessions before creating new ones.`,
      activeCount,
      limit,
    };
  }

  return { allowed: true, activeCount, limit };
}

// ─── Session Files Changed ──────────────────────────────────────────────────

export async function upsertSessionFileChanged(
  db: AppDb,
  sessionId: string,
  file: { filePath: string; status: string; additions?: number; deletions?: number }
): Promise<void> {
  const id = `${sessionId}:${file.filePath}`;
  await db.insert(sessionFilesChanged).values({
    id,
    sessionId,
    filePath: file.filePath,
    status: file.status,
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
  }).onConflictDoUpdate({
    target: [sessionFilesChanged.sessionId, sessionFilesChanged.filePath],
    set: {
      status: sql`excluded.status`,
      additions: sql`excluded.additions`,
      deletions: sql`excluded.deletions`,
      updatedAt: sql`datetime('now')`,
    },
  });
}

export async function getSessionFilesChanged(db: AppDb, sessionId: string): Promise<SessionFileChanged[]> {
  const rows = await db
    .select()
    .from(sessionFilesChanged)
    .where(eq(sessionFilesChanged.sessionId, sessionId))
    .orderBy(asc(sessionFilesChanged.filePath));

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.sessionId,
    filePath: row.filePath,
    status: row.status as FileChangeStatus,
    additions: row.additions ?? 0,
    deletions: row.deletions ?? 0,
    createdAt: row.createdAt!,
    updatedAt: row.updatedAt!,
  }));
}

// ─── Session Participants ───────────────────────────────────────────────────

export async function getSessionParticipants(db: AppDb, sessionId: string): Promise<SessionParticipant[]> {
  const rows = await db
    .select({
      id: sessionParticipants.id,
      sessionId: sessionParticipants.sessionId,
      userId: sessionParticipants.userId,
      role: sessionParticipants.role,
      addedBy: sessionParticipants.addedBy,
      createdAt: sessionParticipants.createdAt,
      userName: users.name,
      userEmail: users.email,
      userAvatarUrl: users.avatarUrl,
    })
    .from(sessionParticipants)
    .innerJoin(users, eq(users.id, sessionParticipants.userId))
    .where(eq(sessionParticipants.sessionId, sessionId))
    .orderBy(asc(sessionParticipants.createdAt));

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.sessionId,
    userId: row.userId,
    role: row.role as SessionParticipantRole,
    addedBy: row.addedBy || undefined,
    createdAt: toDate(row.createdAt),
    userName: row.userName || undefined,
    userEmail: row.userEmail || undefined,
    userAvatarUrl: row.userAvatarUrl || undefined,
  }));
}

export async function addSessionParticipant(
  db: AppDb,
  sessionId: string,
  userId: string,
  role: SessionParticipantRole = 'collaborator',
  addedBy?: string
): Promise<void> {
  const id = crypto.randomUUID();
  await db.insert(sessionParticipants).values({
    id,
    sessionId,
    userId,
    role,
    addedBy: addedBy || null,
  }).onConflictDoNothing({
    target: [sessionParticipants.sessionId, sessionParticipants.userId],
  });
}

export async function removeSessionParticipant(db: AppDb, sessionId: string, userId: string): Promise<void> {
  await db
    .delete(sessionParticipants)
    .where(and(eq(sessionParticipants.sessionId, sessionId), eq(sessionParticipants.userId, userId)));
}

export async function getSessionParticipant(
  db: AppDb,
  sessionId: string,
  userId: string
): Promise<SessionParticipant | null> {
  const row = await db
    .select({
      id: sessionParticipants.id,
      sessionId: sessionParticipants.sessionId,
      userId: sessionParticipants.userId,
      role: sessionParticipants.role,
      addedBy: sessionParticipants.addedBy,
      createdAt: sessionParticipants.createdAt,
      userName: users.name,
      userEmail: users.email,
      userAvatarUrl: users.avatarUrl,
    })
    .from(sessionParticipants)
    .innerJoin(users, eq(users.id, sessionParticipants.userId))
    .where(and(eq(sessionParticipants.sessionId, sessionId), eq(sessionParticipants.userId, userId)))
    .get();

  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.sessionId,
    userId: row.userId,
    role: row.role as SessionParticipantRole,
    addedBy: row.addedBy || undefined,
    createdAt: toDate(row.createdAt),
    userName: row.userName || undefined,
    userEmail: row.userEmail || undefined,
    userAvatarUrl: row.userAvatarUrl || undefined,
  };
}

export async function isSessionParticipant(db: AppDb, sessionId: string, userId: string): Promise<boolean> {
  const row = await db
    .select({ id: sessionParticipants.id })
    .from(sessionParticipants)
    .where(and(eq(sessionParticipants.sessionId, sessionId), eq(sessionParticipants.userId, userId)))
    .get();
  return !!row;
}

// ─── Session Share Links ────────────────────────────────────────────────────

export async function createShareLink(
  db: AppDb,
  sessionId: string,
  role: SessionParticipantRole,
  createdBy: string,
  expiresAt?: string,
  maxUses?: number
): Promise<SessionShareLink> {
  const id = crypto.randomUUID();
  const token = generateShareToken();

  await db.insert(sessionShareLinks).values({
    id,
    sessionId,
    token,
    role,
    createdBy,
    expiresAt: expiresAt || null,
    maxUses: maxUses ?? null,
  });

  return {
    id,
    sessionId,
    token,
    role,
    createdBy,
    expiresAt: expiresAt ? new Date(expiresAt) : undefined,
    maxUses,
    useCount: 0,
    active: true,
    createdAt: new Date(),
  };
}

export async function getShareLink(db: AppDb, token: string): Promise<SessionShareLink | null> {
  const row = await db
    .select()
    .from(sessionShareLinks)
    .where(and(eq(sessionShareLinks.token, token), eq(sessionShareLinks.active, true)))
    .get();

  if (!row) return null;
  return rowToShareLink(row);
}

export async function getShareLinkById(db: AppDb, id: string): Promise<SessionShareLink | null> {
  const row = await db
    .select()
    .from(sessionShareLinks)
    .where(eq(sessionShareLinks.id, id))
    .get();

  if (!row) return null;
  return rowToShareLink(row);
}

export async function getSessionShareLinks(db: AppDb, sessionId: string): Promise<SessionShareLink[]> {
  const rows = await db
    .select()
    .from(sessionShareLinks)
    .where(eq(sessionShareLinks.sessionId, sessionId))
    .orderBy(desc(sessionShareLinks.createdAt));

  return rows.map(rowToShareLink);
}

export async function redeemShareLink(
  db: AppDb,
  token: string,
  userId: string
): Promise<{ sessionId: string; role: SessionParticipantRole } | null> {
  const link = await getShareLink(db, token);
  if (!link) return null;

  // Check expiry
  if (link.expiresAt && new Date(link.expiresAt) < new Date()) return null;

  // Check max uses
  if (link.maxUses !== undefined && link.maxUses !== null && link.useCount >= link.maxUses) return null;

  // Increment use count
  await db
    .update(sessionShareLinks)
    .set({ useCount: sql`${sessionShareLinks.useCount} + 1` })
    .where(eq(sessionShareLinks.token, token));

  // Add user as participant
  await addSessionParticipant(db, link.sessionId, userId, link.role, link.createdBy ?? undefined);

  return { sessionId: link.sessionId, role: link.role };
}

export async function deactivateShareLink(db: AppDb, id: string): Promise<void> {
  await db
    .update(sessionShareLinks)
    .set({ active: false })
    .where(eq(sessionShareLinks.id, id));
}

// ─── Session Access Helpers ─────────────────────────────────────────────────

export function roleAtLeast(role: SessionParticipantRole, required: SessionParticipantRole): boolean {
  return (ROLE_HIERARCHY[role] ?? -1) >= (ROLE_HIERARCHY[required] ?? 999);
}

/**
 * Check if a user has access to a session with at least the given role.
 * Returns the session if accessible, throws NotFoundError otherwise.
 */
export async function assertSessionAccess(
  database: AppDb,
  sessionId: string,
  userId: string,
  requiredRole: SessionParticipantRole = 'viewer'
): Promise<AgentSession> {
  const session = await getSession(database, sessionId);
  if (!session) {
    const { NotFoundError } = await import('@valet/shared');
    throw new NotFoundError('Session', sessionId);
  }

  // Owner always has access
  if (session.userId === userId) return session;

  // Orchestrator sessions are never accessible to non-owners.
  if (session.isOrchestrator || session.purpose === 'workflow') {
    const { NotFoundError } = await import('@valet/shared');
    throw new NotFoundError('Session', sessionId);
  }

  // Check participant table
  const participant = await getSessionParticipant(database, sessionId, userId);
  if (participant && roleAtLeast(participant.role, requiredRole)) return session;

  // Check org-wide visibility
  try {
    const orgSettings = await getOrgSettings(database);
    const visibility = (orgSettings as any).defaultSessionVisibility || 'private';
    if (visibility === 'org_joinable') return session;
    if (visibility === 'org_visible' && requiredRole === 'viewer') return session;
  } catch {
    // org_settings column may not exist yet
  }

  const { NotFoundError } = await import('@valet/shared');
  throw new NotFoundError('Session', sessionId);
}

// ─── Bulk Operations ─────────────────────────────────────────────────────

export async function filterOwnedSessionIds(
  db: AppDb,
  sessionIds: string[],
  userId: string
): Promise<string[]> {
  if (sessionIds.length === 0) return [];
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(inArray(sessions.id, sessionIds), eq(sessions.userId, userId)));
  return rows.map((r) => r.id);
}

export async function bulkDeleteSessionRecords(
  db: AppDb,
  sessionIds: string[],
  userId: string
): Promise<void> {
  if (sessionIds.length === 0) return;
  await db
    .delete(sessions)
    .where(and(inArray(sessions.id, sessionIds), eq(sessions.userId, userId)));
}

export async function bulkDeleteSessionMessages(
  db: AppDb,
  sessionIds: string[]
): Promise<void> {
  if (sessionIds.length === 0) return;
  await db
    .delete(messages)
    .where(inArray(messages.sessionId, sessionIds));
}

// ─── Cron Archive Helpers ────────────────────────────────────────────────────

export async function getArchivableSessions(
  db: D1Database,
  cutoff: string,
  limit: number = 50,
): Promise<string[]> {
  const rows = await db.prepare(
    `SELECT id FROM sessions
     WHERE status IN ('terminated', 'error')
       AND is_orchestrator = 0
       AND last_active_at < ?
     LIMIT ?`
  ).bind(cutoff, limit).all<{ id: string }>();
  return rows.results?.map((r) => r.id) ?? [];
}

export async function markSessionsArchived(
  db: D1Database,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  await db.prepare(
    `UPDATE sessions SET status = 'archived' WHERE id IN (${placeholders}) AND status IN ('terminated', 'error')`
  ).bind(...ids).run();
}

export async function countActiveUserSessions(
  db: AppDb,
  userId: string,
): Promise<number> {
  const row = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        inArray(sessions.status, ACTIVE_SESSION_STATUSES),
      )
    )
    .get();
  return row?.count ?? 0;
}

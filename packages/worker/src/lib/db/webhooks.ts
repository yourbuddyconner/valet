import type { D1Database } from '@cloudflare/workers-types';
import { eq, and, or, sql } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { sessionGitState } from '../schema/index.js';

// ─── Data Access ─────────────────────────────────────────────────────────────

// lookupWebhookTrigger uses json_extract + JOIN — stays as raw SQL
export async function lookupWebhookTrigger(db: D1Database, webhookPath: string) {
  return db.prepare(`
    SELECT t.*, w.id as workflow_id, w.name as workflow_name, w.user_id, w.version, w.data
    FROM triggers t
    JOIN workflows w ON t.workflow_id = w.id
    WHERE t.type = 'webhook'
      AND t.enabled = 1
      AND json_extract(t.config, '$.path') = ?
  `).bind(webhookPath).first<{
    id: string;
    workflow_id: string;
    workflow_name: string;
    user_id: string;
    version: string | null;
    data: string;
    config: string;
    variable_mapping: string | null;
  }>();
}

export async function findSessionsByPR(
  db: AppDb,
  repoFullName: string,
  prNumber: number
) {
  const rows = await db
    .select({ session_id: sessionGitState.sessionId })
    .from(sessionGitState)
    .where(
      and(
        eq(sessionGitState.sourceRepoFullName, repoFullName),
        or(eq(sessionGitState.prNumber, prNumber), eq(sessionGitState.sourcePrNumber, prNumber)),
      )
    );
  return { results: rows };
}

export async function findSessionsByRepoBranch(
  db: AppDb,
  repoFullName: string,
  branch: string
) {
  const rows = await db
    .select({
      session_id: sessionGitState.sessionId,
      commit_count: sessionGitState.commitCount,
    })
    .from(sessionGitState)
    .where(
      and(eq(sessionGitState.sourceRepoFullName, repoFullName), eq(sessionGitState.branch, branch))
    );
  return { results: rows };
}

// ─── Cron Reconciliation Helpers ────────────────────────────────────────────

export interface TrackedGitHubResourceRow {
  session_id: string;
  user_id: string;
  session_status: string;
  source_repo_full_name: string | null;
  source_repo_url: string | null;
  tracked_pr_number: number | string;
  pr_state: string | null;
  pr_title: string | null;
  pr_url: string | null;
  pr_merged_at: string | null;
}

export async function getTrackedGitHubResources(db: D1Database): Promise<TrackedGitHubResourceRow[]> {
  const result = await db.prepare(
    `SELECT
       g.session_id,
       s.user_id,
       s.status as session_status,
       g.source_repo_full_name,
       g.source_repo_url,
       COALESCE(g.pr_number, g.source_pr_number) as tracked_pr_number,
       g.pr_state,
       g.pr_title,
       g.pr_url,
       g.pr_merged_at
     FROM session_git_state g
     JOIN sessions s ON s.id = g.session_id
     WHERE s.status != 'archived'
       AND COALESCE(g.pr_number, g.source_pr_number) IS NOT NULL
       AND (g.pr_state IS NULL OR g.pr_state IN ('open', 'draft'))
     ORDER BY g.updated_at DESC`
  ).all<TrackedGitHubResourceRow>();
  return result.results || [];
}


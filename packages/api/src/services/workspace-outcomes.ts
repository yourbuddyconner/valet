import type { Principal } from "@valet/engine";
import { sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { encodePageCursor } from "../lib/page-cursor.js";
import type { WorkspaceOutcome, WorkspaceOutcomesResponse } from "../wire/types.js";

export interface OutcomeCursor { at: number; id: string; }
interface OutcomeRow {
  id: string;
  kind: WorkspaceOutcome["kind"];
  occurred_at: string | number;
  session_id: string | null;
  thread_id: string | null;
  workflow_run_id: string | null;
  title: string | null;
  url: string | null;
}

/** Only source links are exposed. Credentials and non-web schemes are rejected. */
export function safeOutcomeUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

export async function listWorkspaceOutcomes(
  db: AppDb, orgId: string, owner: Principal, limit: number, cursor?: OutcomeCursor,
): Promise<WorkspaceOutcomesResponse> {
  const owned = sql`(s.id IS NULL OR s.status<>'deleted') AND COALESCE(s.org_id,d.org_id) = ${orgId}
    AND COALESCE(s.owner_type,r.owner_type) = ${owner.type}
    AND COALESCE(NULLIF(s.owner_id,''), CASE WHEN s.owner_type='user' THEN s.user_id END,r.owner_id) = ${owner.id}`;
  const after = cursor ? sql`WHERE (occurred_at,id) < (${cursor.at},${cursor.id})` : sql``;
  // Compact usage facts identify confirmed writes before touching source results.
  // Terminal parts are read only for entries that already have outcome markers.
  const result = await db.execute(sql`WITH outcomes AS (
    SELECT 'action:' || a.invocation_id AS id,
      CASE f.outcome_kind WHEN 'pull_request_created' THEN 'pull_request'
        WHEN 'review_submitted' THEN 'review' ELSE 'message' END AS kind,
      f.created_at AS occurred_at,s.id AS session_id,NULL::text AS thread_id,r.id AS workflow_run_id,
      CASE WHEN f.outcome_kind='pull_request_created' THEN a.result->'data'->>'title' END AS title,
      COALESCE(a.result->'data'->>'html_url',a.result->'data'->>'permalink',a.result->'data'->>'url',a.result->>'url') AS url
    FROM usage_action_facts f JOIN action_invocations a ON a.invocation_id=f.invocation_id
    LEFT JOIN agent_sessions s ON s.id=f.session_id
    LEFT JOIN workflow_runs r ON r.id=COALESCE(f.workflow_execution_id,
      CASE WHEN f.session_id LIKE 'wf:%' THEN split_part(f.session_id,':',2) END)
    LEFT JOIN workflow_definitions d ON d.id=r.workflow_id
    WHERE f.org_id=${orgId}
      AND f.outcome_kind IN ('pull_request_created','review_submitted','slack_message_sent','slack_dm_sent') AND ${owned}
    UNION ALL
    SELECT 'terminal:' || e.id || ':' || p.ordinality::text,
      CASE p.part->'result'->'details'->'outcome'->>'kind'
        WHEN 'pull_request_created' THEN 'pull_request' ELSE 'review' END,
      f.created_at,s.id,e.thread_id,r.id,NULL::text,
      p.part->'result'->'details'->'outcome'->>'url'
    FROM usage_entry_facts f
    LEFT JOIN agent_sessions s ON s.id=f.session_id
    LEFT JOIN workflow_runs r ON r.id=f.workflow_run_id
    LEFT JOIN workflow_definitions d ON d.id=r.workflow_id
    JOIN engine_entries e ON e.id=f.entry_id AND e.session_id=f.session_id
    CROSS JOIN LATERAL jsonb_array_elements(replace(e.parts,chr(92)||'u0000',chr(92)||'uFFFD')::jsonb)
      WITH ORDINALITY AS p(part,ordinality)
    WHERE (f.pull_requests>0 OR f.reviews>0) AND ${owned}
      AND p.part->>'type'='tool_call' AND p.part->>'toolName'='bash' AND p.part->>'status'='completed'
      AND p.part->'result'->'details'->'outcome'->>'kind' IN ('pull_request_created','review_submitted')
  ) SELECT * FROM outcomes ${after} ORDER BY occurred_at DESC,id DESC LIMIT ${limit + 1}`) as { rows: OutcomeRow[] };
  const page = result.rows.slice(0, limit);
  const items = page.map((row): WorkspaceOutcome => {
    const url = safeOutcomeUrl(row.url);
    return {
      id: row.id, kind: row.kind, occurredAt: Number(row.occurred_at),
      title: row.title?.trim().slice(0, 300) || ({ pull_request: "Pull request opened", review: "Review submitted", message: "Slack message sent" }[row.kind]),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.thread_id ? { threadId: row.thread_id } : {}),
      ...(row.workflow_run_id ? { workflowRunId: row.workflow_run_id } : {}),
      ...(url ? { url } : {}),
    };
  });
  const last = items.at(-1);
  return { items, nextCursor: result.rows.length > limit && last
    ? encodePageCursor({ feed: "outcomes", orgId, ownerType: owner.type, ownerId: owner.id, at: last.occurredAt, id: last.id }) : null };
}

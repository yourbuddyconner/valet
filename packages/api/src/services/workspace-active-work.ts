import type { Principal } from "@valet/engine";
import { sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { encodePageCursor } from "../lib/page-cursor.js";
import { deriveRunState, type RunStateSubmission } from "../sessions/run-state.js";
import type { WorkspaceActiveWorkItem, WorkspaceActiveWorkResponse } from "../wire/types.js";
import type { OutcomeCursor } from "./workspace-outcomes.js";

interface ActiveWorkRow {
  id: string;
  session_id: string;
  thread_id: string;
  title: string | null;
  status: RunStateSubmission["status"];
  outcome: string | null;
  updated_at: string | number;
}

export async function listWorkspaceActiveWork(
  db: AppDb, orgId: string, owner: Principal, limit: number, cursor?: OutcomeCursor,
): Promise<WorkspaceActiveWorkResponse> {
  const after = cursor ? sql`AND (q.updated_at,q.id)<(${cursor.at},${cursor.id})` : sql``;
  // Filter queue work before paging; newer idle sessions cannot hide old work.
  const result = await db.execute(sql`
    SELECT q.id,q.session_id,q.thread_id,q.status,q.outcome,q.updated_at,
      COALESCE(NULLIF(t.title,''),NULLIF(s.title,'')) AS title
    FROM engine_queue_items q JOIN agent_sessions s ON s.id=q.session_id
    LEFT JOIN session_threads t ON t.session_id=q.session_id AND t.id=q.thread_id
    WHERE s.status<>'deleted' AND s.org_id=${orgId} AND s.owner_type=${owner.type}
      AND COALESCE(NULLIF(s.owner_id,''),CASE WHEN s.owner_type='user' THEN s.user_id END)=${owner.id}
      AND q.status<>'settled'
      AND (q.status IN ('blocked_on_decision_gate','collecting','queued','running') OR q.outcome='failed')
      ${after}
    ORDER BY q.updated_at DESC,q.id DESC LIMIT ${limit + 1}`) as { rows: ActiveWorkRow[] };
  const items: WorkspaceActiveWorkItem[] = result.rows.slice(0,limit).map(row => {
    const updatedAt = Number(row.updated_at);
    const state = deriveRunState({ status: "active", updatedAt }, [{ status: row.status, updatedAt,
      outcome: row.outcome === "failed" ? { outcome: "failed" } : undefined }]);
    if (state !== "working" && state !== "needs_you" && state !== "failed") {
      throw new Error("Active work state is invalid. Refresh the work list.");
    }
    return { id: row.id, sessionId: row.session_id, threadId: row.thread_id,
      title: row.title || "Conversation", state, updatedAt };
  });
  const last = items.at(-1);
  return { items, nextCursor: result.rows.length > limit && last
    ? encodePageCursor({ feed: "active-work", orgId, ownerType: owner.type, ownerId: owner.id, at: last.updatedAt, id: last.id }) : null };
}

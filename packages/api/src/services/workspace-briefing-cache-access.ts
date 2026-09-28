import { sql } from "drizzle-orm";
import type { Principal } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { WorkspaceBriefingsResponse } from "../wire/types.js";

/** Check source IDs and ownership on every cache read, without fetching narrative text. */
export async function canReadCachedBriefingSources(db: AppDb, orgId: string, owner: Principal, response: WorkspaceBriefingsResponse): Promise<boolean> {
  const sources = [...new Map(response.briefings.flatMap(brief => brief.sources).map(source => [source.id,source])).values()];
  if (!sources.length) return response.briefings.length === 0;
  const references = sources.map(source => ({ id: source.id, kind: source.kind, session_id: source.sessionId ?? null,
    thread_id: source.threadId ?? null, run_id: source.runId ?? null, token: source.token ?? null,
    action_id: source.id.startsWith("action:") ? source.id.slice(7) : null,
    entry_id: source.id.startsWith("terminal:") ? source.id.slice(9).replace(/:\d+$/,"") : null,
    artifact_id: source.kind === "artifact" ? source.id.slice(9) : null,
  }));
  const result = await db.execute(sql`SELECT COUNT(*)::int AS valid FROM
    jsonb_to_recordset(${JSON.stringify(references)}::jsonb) AS v(id text,kind text,session_id text,thread_id text,run_id text,token text,action_id text,entry_id text,artifact_id text)
    LEFT JOIN agent_sessions s ON s.id=v.session_id AND s.org_id=${orgId} AND s.owner_type=${owner.type}
      AND COALESCE(NULLIF(s.owner_id,''),CASE WHEN s.owner_type='user' THEN s.user_id END)=${owner.id} AND s.status<>'deleted'
    LEFT JOIN session_threads t ON t.id=v.thread_id AND t.session_id=s.id
    LEFT JOIN workflow_runs r ON r.id=v.run_id AND r.owner_type=${owner.type} AND r.owner_id=${owner.id}
    LEFT JOIN workflow_definitions d ON d.id=r.workflow_id AND d.org_id=${orgId}
    LEFT JOIN artifacts a ON a.id=v.artifact_id AND a.token=v.token AND a.org_id=${orgId}
      AND a.owner_type=${owner.type} AND a.owner_id=${owner.id} AND a.revoked_at IS NULL
    LEFT JOIN action_invocations i ON i.invocation_id=v.action_id AND i.org_id=${orgId}
    LEFT JOIN engine_entries e ON e.id=v.entry_id
    WHERE (v.session_id IS NULL OR s.id IS NOT NULL)
      AND (v.run_id IS NULL OR d.id IS NOT NULL)
      AND (v.thread_id IS NULL OR t.id IS NOT NULL OR (v.session_id IS NULL AND d.id IS NOT NULL))
      AND CASE v.kind
        WHEN 'thread' THEN t.id IS NOT NULL
        WHEN 'workflow' THEN d.id IS NOT NULL
        WHEN 'artifact' THEN a.id IS NOT NULL
        ELSE (i.invocation_id IS NOT NULL AND (
          (s.id IS NOT NULL AND i.session_id=s.id) OR
          (d.id IS NOT NULL AND COALESCE(i.workflow_execution_id,CASE WHEN i.session_id LIKE 'wf:%' THEN split_part(i.session_id,':',2) END)=r.id)))
          OR (e.id IS NOT NULL AND ((s.id IS NOT NULL AND e.session_id=s.id)
            OR (d.id IS NOT NULL AND e.session_id LIKE 'wf:%' AND split_part(e.session_id,':',2)=r.id)))
      END`) as { rows: { valid: number }[] };
  return result.rows[0]?.valid === sources.length;
}

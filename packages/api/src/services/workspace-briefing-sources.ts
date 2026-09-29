import type { Principal } from "@valet/engine";
import { sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import type { WorkspaceBriefingSource } from "../wire/types.js";
import { listWorkspaceOutcomes } from "./workspace-outcomes.js";

export interface BriefingEvidence {
  source: WorkspaceBriefingSource;
  content: string;
  state: "needs_attention" | "in_progress" | "updated";
}
interface ThreadRow {
  session_id: string; thread_id: string; title: string; updated_at: number | string;
  role: string; text: string; message_at: number | string;
  needs_attention: boolean; in_progress: boolean;
}
interface RunRow {
  id: string; title: string; updated_at: number | string; status: string;
  needs_attention: boolean; prompt: string | null; output: string | null; wait_description: string | null;
}
interface ArtifactRow {
  id: string; token: string; title: string; updated_at: number | string; content: string;
  session_id: string | null; thread_id: string | null;
}

/** Every read is owner-scoped before its limit. Only narrative text enters model context. */
export async function collectWorkspaceBriefingSources(db: AppDb, orgId: string, owner: Principal): Promise<BriefingEvidence[]> {
  const scopedSession = sql`s.status<>'deleted' AND s.org_id=${orgId} AND s.owner_type=${owner.type}
    AND COALESCE(NULLIF(s.owner_id,''),CASE WHEN s.owner_type='user' THEN s.user_id END)=${owner.id}`;
  const hasNarrative = sql`(NULLIF(e.content,'') IS NOT NULL OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(COALESCE(replace(e.parts,chr(92)||'u0000',chr(92)||'uFFFD')::jsonb,'[]'::jsonb)) p
    WHERE p->>'type'='text' AND NULLIF(p->>'text','') IS NOT NULL))`;
  const [threadResult, runResult, artifactResult, outcomes] = await Promise.all([
    db.execute(sql`WITH recent_threads AS MATERIALIZED (
      SELECT s.id AS session_id,t.id AS thread_id,COALESCE(NULLIF(t.title,''),NULLIF(s.title,''),'Conversation') AS title,
        latest.created_at AS updated_at
      FROM session_threads t JOIN agent_sessions s ON s.id=t.session_id
      JOIN LATERAL (SELECT e.created_at FROM engine_entries e
        WHERE e.session_id=s.id AND e.thread_id=t.id AND e.entry_type='message' AND e.role IN ('user','assistant') AND ${hasNarrative}
        ORDER BY e.created_at DESC,e.id DESC LIMIT 1) latest ON true
      WHERE ${scopedSession} ORDER BY latest.created_at DESC,t.id DESC LIMIT 30
    ) SELECT t.*,m.role,m.text,m.created_at AS message_at,
      EXISTS(SELECT 1 FROM engine_queue_items q WHERE q.session_id=t.session_id AND q.thread_id=t.thread_id
        AND (q.status='blocked_on_decision_gate' OR (q.status<>'settled' AND q.outcome='failed'))) AS needs_attention,
      EXISTS(SELECT 1 FROM engine_queue_items q WHERE q.session_id=t.session_id AND q.thread_id=t.thread_id
        AND q.status IN ('collecting','queued','running')) AS in_progress
    FROM recent_threads t JOIN LATERAL (
      WITH selected AS (
        (SELECT e.* FROM engine_entries e WHERE e.session_id=t.session_id AND e.thread_id=t.thread_id
          AND e.entry_type='message' AND e.role IN ('user','assistant') AND ${hasNarrative}
          ORDER BY e.created_at DESC,e.id DESC LIMIT 5)
        UNION
        (SELECT e.* FROM engine_entries e WHERE e.session_id=t.session_id AND e.thread_id=t.thread_id
          AND e.entry_type='message' AND e.role='user' AND ${hasNarrative}
          ORDER BY e.created_at ASC,e.id ASC LIMIT 1)
      )
      SELECT e.role,e.created_at,e.id,left(COALESCE(NULLIF(e.content,''),
        (SELECT string_agg(p->>'text',E'\n') FROM jsonb_array_elements(
          COALESCE(replace(e.parts,chr(92)||'u0000',chr(92)||'uFFFD')::jsonb,'[]'::jsonb)) p
          WHERE p->>'type'='text'),'') ,2000) AS text
      FROM selected e
    ) m ON true ORDER BY t.updated_at DESC,t.thread_id DESC,m.created_at ASC,m.id ASC`) as Promise<{ rows: ThreadRow[] }>,
    db.execute(sql`WITH recent_runs AS MATERIALIZED (
      SELECT r.id,d.name AS title,r.updated_at,r.status,r.outcome,r.waiting_on,r.definition
      FROM workflow_runs r JOIN workflow_definitions d ON d.id=r.workflow_id
      WHERE d.org_id=${orgId} AND r.owner_type=${owner.type} AND r.owner_id=${owner.id}
        AND d.owner_type=r.owner_type AND d.owner_id=r.owner_id
        AND NOT EXISTS (SELECT 1 FROM workflow_runs newer
          WHERE newer.workflow_id=r.workflow_id AND newer.owner_type=r.owner_type AND newer.owner_id=r.owner_id
            AND (newer.created_at,newer.id) > (r.created_at,r.id))
      ORDER BY r.updated_at DESC,r.id DESC LIMIT 12
    ) SELECT r.id,r.title,r.updated_at,r.status,
      CASE WHEN r.status='parked' THEN left((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'kind',w->>'kind','node',w->>'nodeId','signal',w->>'signalType','wakeAt',w->'wakeAt')))::text
        FROM (SELECT value AS w FROM jsonb_array_elements(r.waiting_on) LIMIT 6) waits),1000) END AS wait_description,
      (r.outcome='failed' OR (r.status='parked' AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.waiting_on) w
        WHERE w->>'kind'='signal' AND w->>'signalType' LIKE 'approval:%'))) AS needs_attention,
      left((SELECT string_agg(n->>'prompt',E'\n') FROM jsonb_path_query(r.definition,'$.** ? (@.type == "approval")') n
        WHERE r.status='parked' AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.waiting_on) w WHERE w->>'nodeId'=n->>'id')),2000) AS prompt,
      (SELECT string_agg(c.output,E'\n') FROM (
        SELECT left(COALESCE(cp.error,cp.result->>'response',cp.result->>'text',cp.result->>'message',cp.result->>'output',''),3000) AS output
        FROM workflow_checkpoints cp WHERE cp.run_id=r.id AND cp.status IN ('completed','failed')
          AND (cp.status='failed' OR EXISTS(SELECT 1 FROM jsonb_path_query(r.definition,'$.** ? (exists (@.id))') n
            WHERE n->>'id'=cp.node_id AND n->>'type' IN ('stop','session','thread','llm')))
        ORDER BY cp.created_at DESC,cp.node_id DESC LIMIT 3
      ) c) AS output FROM recent_runs r ORDER BY r.updated_at DESC,r.id DESC`) as Promise<{ rows: RunRow[] }>,
    db.execute(sql`SELECT a.id,a.token,a.title,a.updated_at,left(a.content,2000) AS content,s.id AS session_id,t.id AS thread_id
      FROM artifacts a
      LEFT JOIN agent_sessions s ON s.id=a.source_session_id AND ${scopedSession}
      LEFT JOIN session_threads t ON t.session_id=s.id AND t.id=a.source_thread_id
      WHERE a.org_id=${orgId} AND a.owner_type=${owner.type} AND a.owner_id=${owner.id} AND a.revoked_at IS NULL
      ORDER BY a.updated_at DESC,a.id DESC LIMIT 10`) as Promise<{ rows: ArtifactRow[] }>,
    listWorkspaceOutcomes(db,orgId,owner,15),
  ]);
  const threads = new Map<string, BriefingEvidence>();
  for (const row of threadResult.rows) {
    if (!row.text.trim()) continue;
    const id = `thread:${row.session_id}:${row.thread_id}`;
    let evidence = threads.get(id);
    if (!evidence) {
      evidence = { source: { id, kind: "thread", title: row.title, updatedAt: Number(row.updated_at), sessionId: row.session_id, threadId: row.thread_id },
        content: "", state: row.needs_attention ? "needs_attention" : row.in_progress ? "in_progress" : "updated" };
      threads.set(id,evidence);
    }
    evidence.content += `${row.role}: ${briefingExcerpt(row.text,evidence.content ? 250 : 500)}\n`;
  }
  const candidates: BriefingEvidence[] = [...threads.values()];
  for (const row of runResult.rows) {
    const content = [row.prompt ? `Pending approval: ${row.prompt}` : "", row.output || "", row.wait_description ? `Pending workflow wait: ${row.wait_description}` : ""].filter(Boolean).join("\n");
    if (!content.trim()) continue;
    candidates.push({ source: { id: `workflow:${row.id}`, kind: "workflow", title: row.title, updatedAt: Number(row.updated_at), runId: row.id },
      content, state: row.needs_attention ? "needs_attention" : ["pending","running","parked","terminalizing"].includes(row.status) ? "in_progress" : "updated" });
  }
  for (const row of artifactResult.rows) candidates.push({
    source: { id: `artifact:${row.id}`, kind: "artifact", title: row.title, updatedAt: Number(row.updated_at), token: row.token,
      ...(row.session_id ? { sessionId: row.session_id } : {}), ...(row.thread_id ? { threadId: row.thread_id } : {}) },
    content: row.content, state: "updated",
  });
  for (const outcome of outcomes.items) candidates.push({
    source: { id: outcome.id, kind: outcome.kind, title: outcome.title, updatedAt: outcome.occurredAt,
      ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}), ...(outcome.threadId ? { threadId: outcome.threadId } : {}),
      ...(outcome.workflowRunId ? { runId: outcome.workflowRunId } : {}), ...(outcome.url ? { url: outcome.url } : {}) },
    content: `Confirmed effect: ${outcome.title}`, state: "updated",
  });
  return budgetBriefingEvidence(candidates);
}

function briefingExcerpt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit/3);
  return `${text.slice(0,head)}\n[…]\n${text.slice(-(limit-head-5))}`;
}

/** Reserve context and confirmed effects even when recent conversations fill the budget. */
export function budgetBriefingEvidence(candidates: readonly BriefingEvidence[]): BriefingEvidence[] {
  const sorted = [...candidates].filter(item => item.content.trim()).sort((a,b) =>
    b.source.updatedAt-a.source.updatedAt || a.source.id.localeCompare(b.source.id));
  const threads = sorted.filter(item => item.source.kind === "thread");
  const context = sorted.filter(item => item.source.kind === "workflow" || item.source.kind === "artifact");
  const effects = sorted.filter(item => !["thread","workflow","artifact"].includes(item.source.kind));
  const demand = (items: BriefingEvidence[]) => items.reduce((sum,item) => sum+Math.min(1800,item.content.length),0);
  const contextBudget = Math.min(3000,demand(context));
  const effectBudget = Math.min(3000,demand(effects));
  const allocate = (items: BriefingEvidence[], budget: number) => {
    if (demand(items) <= budget) return items.map(item => ({ ...item, content: briefingExcerpt(item.content,1800) }));
    const allowance = Math.min(1800,Math.floor(budget/Math.max(1,items.length)));
    return allowance < 6 ? [] : items.map(item => ({ ...item, content: briefingExcerpt(item.content,allowance) }));
  };
  return [...allocate(threads,24_000-contextBudget-effectBudget),...allocate(context,contextBudget),...allocate(effects,effectBudget)];
}

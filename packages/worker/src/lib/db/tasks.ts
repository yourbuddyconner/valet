import type { D1Database } from '@cloudflare/workers-types';
import type { SessionTask } from '@valet/shared';
import { eq, and, sql } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { sessionTasks, sessionTaskDependencies } from '../schema/index.js';

function mapTaskRow(row: any): SessionTask {
  return {
    id: row.id,
    orchestratorSessionId: row.orchestrator_session_id,
    sessionId: row.session_id || undefined,
    title: row.title,
    description: row.description || undefined,
    status: row.status,
    result: row.result || undefined,
    parentTaskId: row.parent_task_id || undefined,
    blockedBy: row.blocked_by_ids ? row.blocked_by_ids.split(',').filter(Boolean) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sessionTitle: row.session_title || undefined,
  };
}

export async function createSessionTask(
  db: AppDb,
  data: {
    orchestratorSessionId: string;
    sessionId?: string;
    title: string;
    description?: string;
    status?: string;
    parentTaskId?: string;
    blockedBy?: string[];
  },
): Promise<SessionTask> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const status = data.blockedBy?.length ? 'blocked' : (data.status || 'pending');

  await db.insert(sessionTasks).values({
    id,
    orchestratorSessionId: data.orchestratorSessionId,
    sessionId: data.sessionId || null,
    title: data.title,
    description: data.description || null,
    status,
    parentTaskId: data.parentTaskId || null,
    createdAt: now,
    updatedAt: now,
  });

  if (data.blockedBy?.length) {
    for (const blockedById of data.blockedBy) {
      await db.insert(sessionTaskDependencies).values({
        taskId: id,
        blockedByTaskId: blockedById,
      });
    }
  }

  return {
    id,
    orchestratorSessionId: data.orchestratorSessionId,
    sessionId: data.sessionId,
    title: data.title,
    description: data.description,
    status: status as SessionTask['status'],
    parentTaskId: data.parentTaskId,
    blockedBy: data.blockedBy,
    createdAt: now,
    updatedAt: now,
  };
}

export async function getSessionTasks(
  db: D1Database,
  orchestratorSessionId: string,
  opts?: { status?: string; limit?: number },
): Promise<SessionTask[]> {
  // GROUP_CONCAT + GROUP BY + LEFT JOIN — keep as raw SQL
  const conditions = ['t.orchestrator_session_id = ?'];
  const params: (string | number)[] = [orchestratorSessionId];

  if (opts?.status) {
    conditions.push('t.status = ?');
    params.push(opts.status);
  }

  const limit = opts?.limit ?? 100;
  params.push(limit);

  const result = await db
    .prepare(
      `SELECT t.*,
              s.title AS session_title,
              GROUP_CONCAT(d.blocked_by_task_id) AS blocked_by_ids
       FROM session_tasks t
       LEFT JOIN sessions s ON t.session_id = s.id
       LEFT JOIN session_task_dependencies d ON t.id = d.task_id
       WHERE ${conditions.join(' AND ')}
       GROUP BY t.id
       ORDER BY t.created_at DESC
       LIMIT ?`,
    )
    .bind(...params)
    .all();

  return (result.results || []).map(mapTaskRow);
}

export async function getMyTasks(
  db: D1Database,
  sessionId: string,
  opts?: { status?: string; limit?: number },
): Promise<SessionTask[]> {
  // GROUP_CONCAT + GROUP BY — keep as raw SQL
  const conditions = ['t.session_id = ?'];
  const params: (string | number)[] = [sessionId];

  if (opts?.status) {
    conditions.push('t.status = ?');
    params.push(opts.status);
  }

  const limit = opts?.limit ?? 100;
  params.push(limit);

  const result = await db
    .prepare(
      `SELECT t.*,
              GROUP_CONCAT(d.blocked_by_task_id) AS blocked_by_ids
       FROM session_tasks t
       LEFT JOIN session_task_dependencies d ON t.id = d.task_id
       WHERE ${conditions.join(' AND ')}
       GROUP BY t.id
       ORDER BY t.created_at DESC
       LIMIT ?`,
    )
    .bind(...params)
    .all();

  return (result.results || []).map(mapTaskRow);
}

export async function updateSessionTask(
  db: D1Database,
  taskId: string,
  updates: { status?: string; result?: string; description?: string; sessionId?: string; title?: string },
): Promise<SessionTask | null> {
  // Dynamic SET — keep as raw SQL
  const setClauses: string[] = ["updated_at = datetime('now')"];
  const params: (string | null)[] = [];

  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    params.push(updates.status);
  }
  if (updates.result !== undefined) {
    setClauses.push('result = ?');
    params.push(updates.result);
  }
  if (updates.description !== undefined) {
    setClauses.push('description = ?');
    params.push(updates.description);
  }
  if (updates.sessionId !== undefined) {
    setClauses.push('session_id = ?');
    params.push(updates.sessionId);
  }
  if (updates.title !== undefined) {
    setClauses.push('title = ?');
    params.push(updates.title);
  }

  params.push(taskId);

  await db
    .prepare(`UPDATE session_tasks SET ${setClauses.join(', ')} WHERE id = ?`)
    .bind(...params)
    .run();

  const row = await db
    .prepare(
      `SELECT t.*, GROUP_CONCAT(d.blocked_by_task_id) AS blocked_by_ids
       FROM session_tasks t
       LEFT JOIN session_task_dependencies d ON t.id = d.task_id
       WHERE t.id = ?
       GROUP BY t.id`,
    )
    .bind(taskId)
    .first();

  return row ? mapTaskRow(row) : null;
}

export async function addTaskDependency(db: AppDb, taskId: string, blockedByTaskId: string): Promise<void> {
  await db.insert(sessionTaskDependencies).values({
    taskId,
    blockedByTaskId,
  }).onConflictDoNothing();
  await db
    .update(sessionTasks)
    .set({ status: 'blocked', updatedAt: sql`datetime('now')` })
    .where(and(eq(sessionTasks.id, taskId), eq(sessionTasks.status, 'pending')));
}

export async function getTaskDependencies(db: AppDb, taskId: string): Promise<string[]> {
  const rows = await db
    .select({ blockedByTaskId: sessionTaskDependencies.blockedByTaskId })
    .from(sessionTaskDependencies)
    .where(eq(sessionTaskDependencies.taskId, taskId));
  return rows.map((r) => r.blockedByTaskId);
}

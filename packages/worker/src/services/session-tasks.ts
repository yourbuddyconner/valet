import type { D1Database } from '@cloudflare/workers-types';
import type { SessionTask } from '@valet/shared';
import type { AppDb } from '../lib/drizzle.js';
import {
  getSession,
  createSessionTask,
  getSessionTasks,
  getMyTasks,
  updateSessionTask,
} from '../lib/db.js';

// ─── taskCreate ──────────────────────────────────────────────────────────────

export type TaskCreateParams = {
  sessionId?: string;
  title: string;
  description?: string;
  parentTaskId?: string;
  blockedBy?: string[];
};

export type TaskCreateResult =
  | { task: SessionTask; error?: undefined }
  | { error: string; task?: undefined };

export async function taskCreate(
  db: AppDb,
  _envDB: D1Database,
  sessionId: string | null | undefined,
  _userId: string | null | undefined,
  params: TaskCreateParams,
): Promise<TaskCreateResult> {
  if (!sessionId) {
    return { error: 'No session ID' };
  }

  // Determine orchestrator session ID: own session for orchestrators,
  // or look up parent for child sessions
  let orchestratorSessionId = sessionId;
  const session = await getSession(db, sessionId);
  if (session?.parentSessionId) {
    orchestratorSessionId = session.parentSessionId;
  }

  const task = await createSessionTask(db, {
    orchestratorSessionId,
    sessionId: params.sessionId,
    title: params.title,
    description: params.description,
    parentTaskId: params.parentTaskId,
    blockedBy: params.blockedBy,
  });

  return { task };
}

// ─── taskList ────────────────────────────────────────────────────────────────

export type TaskListResult =
  | { tasks: SessionTask[]; error?: undefined }
  | { error: string; tasks?: undefined };

export async function taskList(
  db: AppDb,
  envDB: D1Database,
  sessionId: string | null | undefined,
  status?: string,
  limit?: number,
): Promise<TaskListResult> {
  if (!sessionId) {
    return { error: 'No session ID' };
  }

  let orchestratorSessionId = sessionId;
  const session = await getSession(db, sessionId);
  if (session?.parentSessionId) {
    orchestratorSessionId = session.parentSessionId;
  }

  const tasks = await getSessionTasks(envDB, orchestratorSessionId, { status, limit });
  return { tasks };
}

// ─── taskUpdate ──────────────────────────────────────────────────────────────

export type TaskUpdateParams = {
  status?: string;
  result?: string;
  description?: string;
  sessionId?: string;
  title?: string;
};

export type TaskUpdateResult =
  | { task: SessionTask; error?: undefined }
  | { error: string; task?: undefined };

export async function taskUpdate(
  _db: AppDb,
  envDB: D1Database,
  _sessionId: string | null | undefined,
  taskId: string,
  params: TaskUpdateParams,
): Promise<TaskUpdateResult> {
  const task = await updateSessionTask(envDB, taskId, {
    status: params.status,
    result: params.result,
    description: params.description,
    sessionId: params.sessionId,
    title: params.title,
  });

  if (!task) {
    return { error: 'Task not found' };
  }

  return { task };
}

// ─── taskMy ──────────────────────────────────────────────────────────────────

export type TaskMyResult =
  | { tasks: SessionTask[]; error?: undefined }
  | { error: string; tasks?: undefined };

export async function taskMy(
  _db: AppDb,
  envDB: D1Database,
  sessionId: string | null | undefined,
  status?: string,
): Promise<TaskMyResult> {
  if (!sessionId) {
    return { error: 'No session ID' };
  }

  const tasks = await getMyTasks(envDB, sessionId, { status });
  return { tasks };
}

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { Env, Variables } from '../env.js';
import * as db from '../lib/db.js';

export const tasksRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// ─── Validation Schemas ──────────────────────────────────────────────────

const createTaskSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  sessionId: z.string().optional(),
  parentTaskId: z.string().optional(),
  blockedBy: z.array(z.string()).optional(),
});

const updateTaskSchema = z.object({
  status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'blocked']).optional(),
  result: z.string().max(10000).optional(),
  description: z.string().max(5000).optional(),
  sessionId: z.string().optional(),
  title: z.string().min(1).max(500).optional(),
});

// ─── Task Routes (mounted on /api/sessions) ─────────────────────────────

/**
 * GET /api/sessions/:sessionId/tasks
 * List tasks for an orchestrator's board.
 */
tasksRouter.get('/:sessionId/tasks', async (c) => {
  const { sessionId } = c.req.param();
  const status = c.req.query('status') || undefined;
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;

  const tasks = await db.getSessionTasks(c.env.DB, sessionId, { status, limit });
  return c.json({ tasks });
});

/**
 * POST /api/sessions/:sessionId/tasks
 * Create a task on the orchestrator's board.
 */
tasksRouter.post('/:sessionId/tasks', zValidator('json', createTaskSchema), async (c) => {
  const { sessionId } = c.req.param();
  const body = c.req.valid('json');

  const task = await db.createSessionTask(c.get('db'), {
    orchestratorSessionId: sessionId,
    sessionId: body.sessionId,
    title: body.title,
    description: body.description,
    parentTaskId: body.parentTaskId,
    blockedBy: body.blockedBy,
  });

  return c.json({ task }, 201);
});

/**
 * PUT /api/sessions/:sessionId/tasks/:taskId
 * Update a task's status, result, etc.
 */
tasksRouter.put('/:sessionId/tasks/:taskId', zValidator('json', updateTaskSchema), async (c) => {
  const { taskId } = c.req.param();
  const body = c.req.valid('json');

  const task = await db.updateSessionTask(c.env.DB, taskId, body);
  if (!task) {
    return c.json({ error: 'Task not found' }, 404);
  }

  return c.json({ task });
});

/**
 * GET /api/sessions/:sessionId/my-tasks
 * Tasks assigned to this session (child view).
 */
tasksRouter.get('/:sessionId/my-tasks', async (c) => {
  const { sessionId } = c.req.param();
  const status = c.req.query('status') || undefined;

  const tasks = await db.getMyTasks(c.env.DB, sessionId, { status });
  return c.json({ tasks });
});

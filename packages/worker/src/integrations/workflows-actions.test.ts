import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { users } from '../lib/schema/index.js';
import { workflowApprovals } from '../lib/schema/workflow-approvals.js';
import { workflowExecutionNodes } from '../lib/schema/workflow-execution-nodes.js';
import { workflowExecutions } from '../lib/schema/workflows.js';
import { createWorkflow } from '../services/workflows.js';
import { saveDraft } from '../services/workflow-versions.js';
import { workflowActions } from './workflows-actions.js';
import type { Env } from '../env.js';

const USER_ID = 'workflow-actions-user';

describe('workflowActions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('lists workflow lifecycle actions', async () => {
    const actions = await workflowActions.listActions();

    expect(actions.map((action) => action.id)).toEqual([
      'workflows.list',
      'workflows.get',
      'workflows.create',
      'workflows.save_draft',
      'workflows.schema',
      'workflows.validate',
      'workflows.publish',
      'workflows.test_run',
      'workflows.get_execution',
    ]);
    expect(actions.find((action) => action.id === 'workflows.publish')?.riskLevel).toBe('high');
  });

  it('lists workflows owned by the calling user', async () => {
    const { db } = createTestDb();
    db.insert(users).values({ id: USER_ID, email: 'workflow-actions@example.com' }).run();
    db.insert(users).values({ id: 'other-user', email: 'other-workflow-actions@example.com' }).run();
    const own = await createWorkflow(db as any, USER_ID, { name: 'Daily triage', slug: 'daily-triage' });
    await createWorkflow(db as any, 'other-user', { name: 'Private workflow' });

    const result = await workflowActions.execute('workflows.list', {}, {
      credentials: {},
      userId: USER_ID,
      appDb: db,
      env: {} as Env,
    } as any);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      workflows: [{
        id: own.workflow.id,
        slug: 'daily-triage',
        name: 'Daily triage',
      }],
    });
  });

  it('returns workflow schema discovery data for agents', async () => {
    const { db } = createTestDb();
    db.insert(users).values({ id: USER_ID, email: 'workflow-actions@example.com' }).run();

    const result = await workflowActions.execute('workflows.schema', {}, {
      credentials: {},
      userId: USER_ID,
      appDb: db,
      env: {} as Env,
    } as any);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      version: 'dag/v1',
      validNodeTypes: ['trigger', 'llm', 'tool', 'set', 'if', 'wait', 'approval', 'foreach', 'orchestrator', 'session', 'stop'],
      legacyNodeTypeAliases: {
        agent_prompt: 'llm',
        http: 'tool',
        loop: 'foreach',
        sleep: 'wait',
      },
      foreachBodyTypes: ['llm', 'tool', 'set', 'stop', 'orchestrator', 'session'],
    });
    expect(result.data).toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({ type: 'llm', required: expect.arrayContaining(['id', 'type', 'prompt']) }),
        expect.objectContaining({ type: 'foreach', required: expect.arrayContaining(['id', 'type', 'items', 'body']) }),
      ]),
    });
  });

  it('validates the current draft', async () => {
    const { db } = createTestDb();
    db.insert(users).values({ id: USER_ID, email: 'workflow-actions@example.com' }).run();
    const created = await createWorkflow(db as any, USER_ID, { name: 'Validate me' });
    await saveDraft(db as any, created.workflow.id, {
      version: 'dag/v1',
      nodes: [
        { id: 'start', type: 'trigger' },
        { id: 'finish', type: 'stop', output: { ok: true } },
      ],
      edges: [{ from: 'start', to: 'finish' }],
    } as any);

    const result = await workflowActions.execute('workflows.validate', {
      workflowId: created.workflow.id,
    }, {
      credentials: {},
      userId: USER_ID,
      appDb: db,
      env: {} as Env,
    } as any);

    if (!result.success) {
      throw new Error(result.error ?? 'workflow validation failed');
    }
    expect(result.data).toEqual({ errors: [], warnings: [] });
  });

  it('separates validation warnings from blocking errors', async () => {
    const { db } = createTestDb();
    db.insert(users).values({ id: USER_ID, email: 'workflow-actions@example.com' }).run();

    const result = await workflowActions.execute('workflows.validate', {
      definition: {
        version: 'dag/v1',
        nodes: [
          { id: 'extract', type: 'llm', model: 'anthropic:claude-sonnet-4-20250514', prompt: 'Summarize {{trigger.data.text}}' },
          { id: 'done', type: 'stop' },
        ],
        edges: [{ from: 'extract', to: 'done' }],
      },
    }, {
      credentials: {},
      userId: USER_ID,
      appDb: db,
      env: { ANTHROPIC_API_KEY: 'test-key' } as Env,
    } as any);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      errors: [],
      warnings: [expect.objectContaining({ code: 'llm_maxoutput_warning' })],
    });
  });

  it('returns validation and does not save malformed drafts', async () => {
    const { db } = createTestDb();
    db.insert(users).values({ id: USER_ID, email: 'workflow-actions@example.com' }).run();
    const created = await createWorkflow(db as any, USER_ID, { name: 'Save validate' });

    const result = await workflowActions.execute('workflows.save_draft', {
      workflowId: created.workflow.id,
      validate: true,
      draft: {
        version: 'dag/v1',
        nodes: [
          { id: 'start', type: 'trigger' },
          { id: 'route', type: 'if', conditions: [{ left: 'trigger.data.ok', dataType: 'boolean', op: 'equals' }] },
        ],
        edges: [],
      },
    }, {
      credentials: {},
      userId: USER_ID,
      appDb: db,
      env: {} as Env,
    } as any);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      ok: false,
      saved: false,
      workflowId: created.workflow.id,
      validation: {
        errors: [expect.objectContaining({
          code: 'malformed_definition',
          message: expect.stringContaining('nodes.1 (id: "route", type: "if")'),
        })],
        warnings: [],
      },
    });
  });

  it('can validate while saving a typed draft', async () => {
    const { db } = createTestDb();
    db.insert(users).values({ id: USER_ID, email: 'workflow-actions@example.com' }).run();
    const created = await createWorkflow(db as any, USER_ID, { name: 'Save validate typed' });

    const result = await workflowActions.execute('workflows.save_draft', {
      workflowId: created.workflow.id,
      validate: true,
      draft: {
        version: 'dag/v1',
        nodes: [
          { id: 'trigger', type: 'trigger' },
          { id: 'done', type: 'stop', outcome: 'success' },
        ],
        edges: [{ from: 'trigger', to: 'done' }],
      },
    }, {
      credentials: {},
      userId: USER_ID,
      appDb: db,
      env: {} as Env,
    } as any);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      ok: true,
      saved: true,
      workflowId: created.workflow.id,
      validation: { errors: [], warnings: [] },
    });
  });

  it('inspects an execution with node traces and approvals', async () => {
    const { db, sqlite } = createTestDb();
    db.insert(users).values({ id: USER_ID, email: 'workflow-actions@example.com' }).run();
    const created = await createWorkflow(db as any, USER_ID, { name: 'Inspectable' });
    const now = new Date('2026-06-17T18:00:00.000Z').toISOString();

    db.insert(workflowExecutions).values({
      id: 'exec-1',
      workflowId: created.workflow.id,
      userId: USER_ID,
      triggerId: null,
      status: 'completed',
      triggerType: 'manual',
      triggerMetadata: { source: 'test' },
      inputs: JSON.stringify({ name: 'Conner' }),
      outputs: { branch: 'normal_path' },
      startedAt: now,
      completedAt: now,
      mode: 'test',
    }).run();
    db.insert(workflowExecutionNodes).values({
      id: 'trace-1',
      executionId: 'exec-1',
      nodeId: 'normal_path',
      nodeType: 'set',
      status: 'completed',
      inputPreview: '{"name":"Conner"}',
      inputTruncated: false,
      output: '{"ok":true}',
      outputTruncated: false,
      retryAttempts: 0,
      expiresAt: now,
      createdAt: now,
    }).run();
    db.insert(workflowApprovals).values({
      id: 'approval-1',
      executionId: 'exec-1',
      nodeId: 'approval',
      kind: 'explicit',
      workflowInstanceId: 'exec-1',
      eventType: 'approval_approval',
      prompt: 'Approve?',
      summary: 'Approval summary',
      details: JSON.stringify({ issue: 123 }),
      status: 'approved',
      resolvedBy: USER_ID,
      resolvedAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();

    const result = await workflowActions.execute('workflows.get_execution', {
      executionId: 'exec-1',
    }, {
      credentials: {},
      userId: USER_ID,
      appDb: db,
      env: testEnv(sqlite),
    } as any);

    if (!result.success) {
      throw new Error(result.error ?? 'workflow get_execution failed');
    }
    expect(result.data).toMatchObject({
      execution: {
        id: 'exec-1',
        workflowId: created.workflow.id,
        workflowName: 'Inspectable',
        status: 'completed',
        triggerMetadata: { source: 'test' },
        inputs: { name: 'Conner' },
        outputs: { branch: 'normal_path' },
        mode: 'test',
        nodes: [{
          id: 'trace-1',
          nodeId: 'normal_path',
          nodeType: 'set',
          status: 'completed',
          output: '{"ok":true}',
        }],
        approvals: [{
          id: 'approval-1',
          nodeId: 'approval',
          status: 'approved',
          details: { issue: 123 },
        }],
      },
    });
  });

  it('requires worker context at execution time', async () => {
    const result = await workflowActions.execute('workflows.list', {}, {
      credentials: {},
      userId: USER_ID,
    } as any);

    expect(result.success).toBe(false);
    expect(result.error).toContain('worker context');
  });
});

type SqliteDb = ReturnType<typeof createTestDb>['sqlite'];

function testEnv(sqlite: SqliteDb): Env {
  return { DB: makeD1(sqlite) } as Env;
}

function makeD1(sqlite: SqliteDb): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          const statement = sqlite.prepare(sql);
          return {
            async run() {
              const result = statement.run(...params);
              return {
                success: true,
                meta: { changes: result.changes },
              };
            },
            async all<T = Record<string, unknown>>() {
              return {
                success: true,
                results: statement.all(...params) as T[],
              };
            },
            async first<T = Record<string, unknown>>() {
              return (statement.get(...params) ?? null) as T | null;
            },
          };
        },
      };
    },
  } as D1Database;
}

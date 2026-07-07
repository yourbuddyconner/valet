import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { users } from '../lib/schema/users.js';
import { workflows, workflowExecutions } from '../lib/schema/workflows.js';
import { workflowDefinitionVersions } from '../lib/schema/workflow-definition-versions.js';
import { eq } from 'drizzle-orm';
import type { Env } from '../env.js';
import type { AppDb } from '../lib/drizzle.js';
import { setOrgLlmKey } from './admin.js';
import type { WorkflowDefinition } from '@valet/shared';

let db: AppDb;
let createdInstances: Array<{ id: string; params: unknown }> = [];
const ENCRYPTION_KEY = 'k';

vi.mock('../lib/drizzle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/drizzle.js')>();
  return {
    ...actual,
    getDb: () => db,
  };
});

import { createExecution, WorkflowExecutionStartError } from './workflow-executions.js';

function makeEnv(): Env {
  type WorkflowCreateInput = Parameters<Env['WORKFLOW_INTERPRETER']['create']>[0];
  type WorkflowInstance = Awaited<ReturnType<Env['WORKFLOW_INTERPRETER']['create']>>;
  const workflowInstance = (id: string): WorkflowInstance => ({ id }) as WorkflowInstance;
  const captureWorkflowInput = (input: WorkflowCreateInput): string => {
    if (!input?.id) throw new Error('workflow mock requires an id');
    createdInstances.push({ id: input.id, params: input.params });
    return input.id;
  };
  const workflowInterpreter: Env['WORKFLOW_INTERPRETER'] = {
    async create(input: WorkflowCreateInput) {
      return workflowInstance(captureWorkflowInput(input));
    },
    async get(id: string) {
      return workflowInstance(id);
    },
    async createBatch(inputs: WorkflowCreateInput[]) {
      const ids: string[] = [];
      for (const input of inputs) {
        ids.push(captureWorkflowInput(input));
      }
      return ids.map(workflowInstance);
    },
  };

  return {
    DB: {} as Env['DB'],
    SESSIONS: {} as Env['SESSIONS'],
    EVENT_BUS: {} as Env['EVENT_BUS'],
    WORKFLOW_INTERPRETER: workflowInterpreter,
    ENCRYPTION_KEY,
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    MODAL_BACKEND_URL: '',
    FRONTEND_URL: '',
  } as Env;
}

// Create a workflow AND a published version linked via published_version_id
// so createExecution's gate finds something to run. Each helper call
// generates a unique version row id so multiple workflows can coexist.
let versionIdCounter = 0;
function makeWorkflow(id: string, defJson: object) {
  db.insert(workflows).values({
    id, userId: 'u1', name: 'W', version: '1', data: JSON.stringify(defJson),
  }).run();
  const versionId = `ver-${id}-${++versionIdCounter}`;
  db.insert(workflowDefinitionVersions).values({
    id: versionId,
    workflowId: id,
    version: 1,
    definition: JSON.stringify(defJson),
    definitionHash: 'h',
  }).run();
  db.update(workflows).set({ publishedVersionId: versionId }).where(eq(workflows.id, id)).run();
}

function dagWithSet() {
  return {
    version: 'dag/v1',
    nodes: [
      { id: 'a', type: 'set', values: { ok: '{{trigger.data.x}}' } },
      { id: 'done', type: 'stop' },
    ],
    edges: [{ from: 'a', to: 'done' }],
  };
}

beforeEach(() => {
  ({ db } = createTestDb() as { db: AppDb });
  createdInstances = [];
  db.insert(users).values([{ id: 'u1', email: 'u1@example.com' }, { id: 'u2', email: 'u2@example.com' }]).run();
});

describe('createExecution', () => {
  it('inserts a workflow_executions row and creates a CF Workflow instance', async () => {
    makeWorkflow('wf1', dagWithSet());
    const env = makeEnv();
    const result = await createExecution(env, {
      workflowId: 'wf1',
      user: { id: 'u1' },
      trigger: { type: 'manual', timestamp: 't', data: { x: 'hi' }, metadata: {} },
    });
    expect(result.status).toBe('pending');
    expect(createdInstances).toHaveLength(1);
    expect(createdInstances[0]!.id).toBe(result.executionId);

    const row = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, result.executionId)).get();
    expect(row?.workflowId).toBe('wf1');
    expect(row?.userId).toBe('u1');
    expect(row?.mode).toBe('production');
  });

  it('rejects when the workflow is not owned by the caller', async () => {
    makeWorkflow('wf1', dagWithSet());
    const env = makeEnv();
    await expect(createExecution(env, {
      workflowId: 'wf1',
      user: { id: 'u2' },
      trigger: { type: 'manual', timestamp: 't', data: {}, metadata: {} },
    })).rejects.toThrow();
  });

  it('rejects when trigger data validation fails', async () => {
    makeWorkflow('wf1', {
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger', dataSchema: { region: { type: 'string', required: true } } },
        { id: 'a', type: 'set', values: { ok: '{{trigger.data.region}}' } },
      ],
      edges: [{ from: 'trigger', to: 'a' }],
    });
    const env = makeEnv();
    await expect(createExecution(env, {
      workflowId: 'wf1',
      user: { id: 'u1' },
      trigger: { type: 'manual', timestamp: 't', data: {}, metadata: {} },
    })).rejects.toBeInstanceOf(WorkflowExecutionStartError);
  });

  it('rejects when an llm node has no configured provider key', async () => {
    makeWorkflow('wf1', {
      version: 'dag/v1',
      nodes: [
        { id: 'l', type: 'llm', model: 'anthropic:claude-sonnet-4-5', prompt: 'x', maxOutputTokens: 100 },
        { id: 'done', type: 'stop' },
      ],
      edges: [{ from: 'l', to: 'done' }],
    });
    const env = makeEnv();
    // No ANTHROPIC_API_KEY set.
    await expect(createExecution(env, {
      workflowId: 'wf1',
      user: { id: 'u1' },
      trigger: { type: 'manual', timestamp: 't', data: {}, metadata: {} },
    })).rejects.toBeInstanceOf(WorkflowExecutionStartError);
  });

  it('uses org DB LLM provider keys when starting an execution', async () => {
    makeWorkflow('wf1', {
      version: 'dag/v1',
      nodes: [
        { id: 'l', type: 'llm', model: 'anthropic:claude-sonnet-4-5', prompt: 'x', maxOutputTokens: 100 },
        { id: 'done', type: 'stop' },
      ],
      edges: [{ from: 'l', to: 'done' }],
    });
    await setOrgLlmKey(db, ENCRYPTION_KEY, {
      provider: 'anthropic',
      key: 'sk-ant-db',
      setBy: 'u1',
      models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }],
      showAllModels: false,
    });

    const result = await createExecution(makeEnv(), {
      workflowId: 'wf1',
      user: { id: 'u1' },
      trigger: { type: 'manual', timestamp: 't', data: {}, metadata: {} },
    });

    expect(result.status).toBe('pending');
    expect(createdInstances).toHaveLength(1);
  });

  it('rejects when the workflow has no published version', async () => {
    // Insert a workflow row directly (without makeWorkflow's auto-publish).
    db.insert(workflows).values({
      id: 'wf-unpublished', userId: 'u1', name: 'W', version: '1',
      data: JSON.stringify({ version: 'dag/v1', nodes: [], edges: [] }),
    }).run();
    const env = makeEnv();
    await expect(createExecution(env, {
      workflowId: 'wf-unpublished',
      user: { id: 'u1' },
      trigger: { type: 'manual', timestamp: 't', data: {}, metadata: {} },
    })).rejects.toBeInstanceOf(WorkflowExecutionStartError);
  });

  it('rejects when the published version contains a non-dag/v1 definition', async () => {
    db.insert(workflows).values({
      id: 'wf-steps', userId: 'u1', name: 'W', version: '1', data: '{}',
    }).run();
    db.insert(workflowDefinitionVersions).values({
      id: 'ver-steps', workflowId: 'wf-steps', version: 1,
      definition: JSON.stringify({ version: 'steps', steps: [] }), definitionHash: 'h',
    }).run();
    db.update(workflows).set({ publishedVersionId: 'ver-steps' }).where(eq(workflows.id, 'wf-steps')).run();
    const env = makeEnv();
    await expect(createExecution(env, {
      workflowId: 'wf-steps',
      user: { id: 'u1' },
      trigger: { type: 'manual', timestamp: 't', data: {}, metadata: {} },
    })).rejects.toBeInstanceOf(WorkflowExecutionStartError);
  });

  it('loads the published version when published_version_id is set', async () => {
    // Insert manually so the published version has a known id we can assert.
    const publishedDef = dagWithSet();
    db.insert(workflows).values({
      id: 'wf-pub', userId: 'u1', name: 'W', version: '1', data: '{}',
    }).run();
    db.insert(workflowDefinitionVersions).values({
      id: 'ver-pub-1',
      workflowId: 'wf-pub',
      version: 7,
      definition: JSON.stringify(publishedDef),
      definitionHash: 'h',
    }).run();
    db.update(workflows).set({ publishedVersionId: 'ver-pub-1' }).where(eq(workflows.id, 'wf-pub')).run();

    const env = makeEnv();
    const result = await createExecution(env, {
      workflowId: 'wf-pub',
      user: { id: 'u1' },
      trigger: { type: 'manual', timestamp: 't', data: { x: 'hi' }, metadata: {} },
    });
    expect(createdInstances[0]!.params).toMatchObject({
      definition: publishedDef,
    });
    const row = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, result.executionId)).get();
    expect(row?.definitionVersionId).toBe('ver-pub-1');
    expect(row?.workflowVersion).toBe('7');
  });

  it('loads the draft when definitionSource=draft', async () => {
    // Use a clearly different shape so we know which one was loaded.
    const draftDef = {
      version: 'dag/v1',
      nodes: [
        { id: 's', type: 'set', values: { drafted: true } },
        { id: 'd', type: 'stop' },
      ],
      edges: [{ from: 's', to: 'd' }],
    };
    db.insert(workflows).values({
      id: 'wf-draft',
      userId: 'u1',
      name: 'WD',
      version: '1',
      data: JSON.stringify({ version: 'dag/v1', nodes: [], edges: [] }),
      draftDefinition: JSON.stringify(draftDef),
    }).run();

    const env = makeEnv();
    await createExecution(env, {
      workflowId: 'wf-draft',
      user: { id: 'u1' },
      trigger: { type: 'manual', timestamp: 't', data: {}, metadata: {} },
      definitionSource: 'draft',
      mode: 'test',
    });
    expect(createdInstances[0]!.params).toMatchObject({ definition: draftDef, mode: 'test' });
  });

  it('runs an explicit snapshot when definitionSource=snapshot', async () => {
    const publishedDef = dagWithSet();
    const snapshotDef = {
      version: 'dag/v1',
      nodes: [
        { id: 'from_snapshot', type: 'set', values: { value: '{{trigger.data.x}}' } },
        { id: 'done', type: 'stop' },
      ],
      edges: [{ from: 'from_snapshot', to: 'done' }],
    } satisfies WorkflowDefinition;
    makeWorkflow('wf-snapshot', publishedDef);

    const env = makeEnv();
    const result = await createExecution(env, {
      workflowId: 'wf-snapshot',
      user: { id: 'u1' },
      trigger: { type: 'manual', timestamp: 't', data: { x: 'retry' }, metadata: { retryOfExecutionId: 'exec-old' } },
      definitionSource: 'snapshot',
      definitionSnapshot: snapshotDef,
      mode: 'test',
    });

    expect(createdInstances[0]!.params).toMatchObject({ definition: snapshotDef, mode: 'test' });
    const row = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, result.executionId)).get();
    expect(JSON.parse(row?.definitionSnapshot ?? '{}')).toEqual(snapshotDef);
    expect(row?.workflowVersion).toBe('snapshot');
    expect(row?.definitionVersionId).toBeNull();
  });

  it('rejects test-run when no draft exists', async () => {
    makeWorkflow('wf-no-draft', dagWithSet());
    const env = makeEnv();
    await expect(createExecution(env, {
      workflowId: 'wf-no-draft',
      user: { id: 'u1' },
      trigger: { type: 'manual', timestamp: 't', data: {}, metadata: {} },
      definitionSource: 'draft',
    })).rejects.toBeInstanceOf(WorkflowExecutionStartError);
  });
});

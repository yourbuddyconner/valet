import { describe, expect, it } from 'vitest';

import type { SubmissionResult } from '@valet/engine';

import type { ThreadNode } from '../dag/nodes.js';
import type { WorkflowDefinition } from '../dag/shape.js';
import type { WorkflowEngineDeps, WorkflowPromptOrchestratorResult } from '../engine-deps.js';
import { driveUntilPark } from '../interpreter.js';
import { InMemoryWorkflowStore } from '../memory-store.js';
import type { RunParams } from '../store.js';
import { executeThread } from './thread.js';

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function runParams(overrides: Partial<RunParams> = {}): RunParams {
  return {
    workflowId: 'wf-1',
    definitionVersionId: 'v1',
    input: { type: 'manual', timestamp: '2026-01-01T00:00:00Z', data: {}, metadata: {} },
    ...overrides,
  };
}

const OWNER = { ownerType: 'user', ownerId: 'user-1' };

async function claimAttempt(store: InMemoryWorkflowStore, runId: string, ownerId = 'owner'): Promise<number> {
  const claim = await store.claimRun(runId, ownerId, 30_000);
  if (!claim) throw new Error(`could not claim run ${runId}`);
  return claim.attempt;
}

function threadDefinition(node: Partial<ThreadNode> = {}): WorkflowDefinition {
  const orchestrator: ThreadNode = {
    id: 'o',
    type: 'thread',
    prompt: 'do the thing for {{trigger.data.thing}}',
    ...node,
  };
  return {
    version: 'dag/v1',
    nodes: [
      { id: 't', type: 'trigger' },
      orchestrator,
      { id: 'e', type: 'stop', outcome: 'success' },
    ],
    edges: [
      { from: 't', to: 'o' },
      { from: 'o', to: 'e' },
    ],
  };
}

interface RecordedCall {
  kind: 'promptOrchestrator' | 'awaitResult' | 'abort' | 'isSettled';
  [key: string]: unknown;
}

/** A scriptable, call-recording fake `WorkflowEngineDeps` for the thread node. */
function makeEngine(
  config: {
    awaitResultQueue?: Array<Omit<SubmissionResult, 'queueItemId'>>;
    isSettledQueue?: boolean[];
    sessionId?: string;
  } = {},
): { engine: WorkflowEngineDeps; calls: RecordedCall[]; receiptsByDispatch: Map<string, WorkflowPromptOrchestratorResult> } {
  const calls: RecordedCall[] = [];
  const receiptsByDispatch = new Map<string, WorkflowPromptOrchestratorResult>();
  let receiptCounter = 0;
  const sessionId = config.sessionId ?? 'orchestrator:user-1';
  const awaitResultQueue = [...(config.awaitResultQueue ?? [{ outcome: 'completed' as const, text: 'ok' }])];
  const isSettledQueue = [...(config.isSettledQueue ?? [true])];

  function nextFrom<T>(queue: T[]): T {
    const value = queue.length > 1 ? queue.shift() : queue[0];
    if (value === undefined) throw new Error('scripted queue exhausted');
    return value;
  }

  const engine: WorkflowEngineDeps = {
    createSession: async () => {
      throw new Error('createSession not exercised by this fixture');
    },
    prompt: async () => {
      throw new Error('prompt not exercised by this fixture');
    },
    awaitResult: async (sessionIdArg, threadId, queueItemId, opts) => {
      calls.push({ kind: 'awaitResult', sessionId: sessionIdArg, threadId, queueItemId, resultSchema: opts?.resultSchema });
      const scripted = nextFrom(awaitResultQueue);
      return { ...scripted, queueItemId };
    },
    abort: async (sessionIdArg, threadId) => {
      calls.push({ kind: 'abort', sessionId: sessionIdArg, threadId });
    },
    isSettled: async (sessionIdArg, queueItemId) => {
      calls.push({ kind: 'isSettled', sessionId: sessionIdArg, queueItemId });
      return nextFrom(isSettledQueue);
    },
    llmComplete: async () => {
      throw new Error('llmComplete not exercised by this fixture');
    },
    promptOrchestrator: async (prompt, opts) => {
      calls.push({ kind: 'promptOrchestrator', prompt, dispatchId: opts.dispatchId, queueMode: opts.queueMode, ownerHint: opts.ownerHint });
      let receipt = receiptsByDispatch.get(opts.dispatchId);
      if (!receipt) {
        receiptCounter += 1;
        receipt = { sessionId, threadId: `thread-${receiptCounter}`, queueItemId: `queue-${receiptCounter}` };
        receiptsByDispatch.set(opts.dispatchId, receipt);
      }
      return receipt;
    },
    invokeAction: async () => {
      throw new Error('invokeAction not exercised by this fixture');
    },
  };

  return { engine, calls, receiptsByDispatch };
}

// ─── 1. Deterministic ids + queueMode/ownerHint on dispatch ──────────────────

describe('executeThread: dispatch shape', () => {
  it('uses workflow:{runId}:{nodeId} as dispatchId, queueMode "followup", and the run owner as ownerHint', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine, calls } = makeEngine();

    await store.createRun('run-1', runParams(), threadDefinition(), 'v1', OWNER);
    const attempt = await claimAttempt(store, 'run-1');
    const park = await driveUntilPark('run-1', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('parked');
    const dispatchCall = calls.find((c) => c.kind === 'promptOrchestrator');
    expect(dispatchCall?.dispatchId).toBe('workflow:run-1:o');
    expect(dispatchCall?.queueMode).toBe('followup');
    expect(dispatchCall?.ownerHint).toEqual(OWNER);
  });
});

// ─── 2. Crash between dispatch and receipt persist ───────────────────────────

describe('executeThread: crash between dispatch and receipt persist', () => {
  it('re-dispatches with an identical dispatchId on reclaim; the engine dedupes to a single receipt', async () => {
    const clock = makeClock();
    const store = new InMemoryWorkflowStore(clock.now);
    const { engine, calls, receiptsByDispatch } = makeEngine();

    let putIntentCount = 0;
    const originalPutIntent = store.putIntent.bind(store);
    store.putIntent = async (cp) => {
      if (cp.nodeId === 'o') {
        putIntentCount += 1;
        if (putIntentCount === 2) {
          throw new Error('simulated crash before receipt persisted');
        }
      }
      return originalPutIntent(cp);
    };

    await store.createRun('run-2', runParams(), threadDefinition(), 'v1', OWNER);
    const attempt1 = await claimAttempt(store, 'run-2');
    await expect(driveUntilPark('run-2', attempt1, { store, engine, clock: clock.now })).rejects.toThrow(
      'simulated crash before receipt persisted',
    );

    store.putIntent = originalPutIntent;

    clock.advance(30_001);
    const attempt2 = await claimAttempt(store, 'run-2', 'owner-2');
    expect(attempt2).toBeGreaterThan(attempt1);
    const park2 = await driveUntilPark('run-2', attempt2, { store, engine, clock: clock.now });
    expect(park2.status).toBe('parked');

    const dispatchCalls = calls.filter((c) => c.kind === 'promptOrchestrator');
    expect(dispatchCalls).toHaveLength(2); // dispatched once before the crash, once on retry
    expect(new Set(dispatchCalls.map((c) => c.dispatchId)).size).toBe(1); // identical dispatchId both times
    expect(receiptsByDispatch.size).toBe(1); // exactly one distinct receipt was ever issued

    const byNode = new Map((await store.getCheckpoints('run-2')).map((cp) => [cp.nodeId, cp]));
    const persistedReceipt = receiptsByDispatch.get('workflow:run-2:o');
    expect(byNode.get('o')?.effects?.receipt).toEqual({
      threadId: persistedReceipt?.threadId,
      queueItemId: persistedReceipt?.queueItemId,
    });
    expect(byNode.get('o')?.effects?.sessionId).toBe(persistedReceipt?.sessionId);
  });
});

// ─── 3. wait.mode 'none' completes without parking ───────────────────────────

describe('executeThread: wait.mode "none"', () => {
  it('completes immediately with { sessionId, receipt } without parking', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine, calls } = makeEngine();

    await store.createRun('run-3', runParams(), threadDefinition({ wait: { mode: 'none' } }), 'v1', OWNER);
    const attempt = await claimAttempt(store, 'run-3');
    const park = await driveUntilPark('run-3', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');
    expect(calls.some((c) => c.kind === 'awaitResult' || c.kind === 'isSettled')).toBe(false);

    const byNode = new Map((await store.getCheckpoints('run-3')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('o')?.status).toBe('completed');
    expect(byNode.get('o')?.result).toMatchObject({ sessionId: 'orchestrator:user-1', threadId: 'thread-1' });
  });
});

// ─── 4. Settled completed + valid output ─────────────────────────────────────

describe('executeThread: settled completed with valid output', () => {
  it('completes the node with { sessionId, response, output }', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const outputSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    const { engine } = makeEngine({
      isSettledQueue: [true],
      awaitResultQueue: [{ outcome: 'completed', text: 'The answer is 42', output: { answer: '42' } }],
    });

    await store.createRun('run-4', runParams(), threadDefinition({ outputSchema }), 'v1', OWNER);
    const attempt1 = await claimAttempt(store, 'run-4');
    const park1 = await driveUntilPark('run-4', attempt1, { store, engine, clock: clock.now });
    expect(park1.status).toBe('parked');

    const attempt2 = await claimAttempt(store, 'run-4', 'owner-2');
    const park2 = await driveUntilPark('run-4', attempt2, { store, engine, clock: clock.now });
    expect(park2.status).toBe('settled');
    expect(park2.outcome).toBe('completed');

    const byNode = new Map((await store.getCheckpoints('run-4')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('o')?.status).toBe('completed');
    expect(byNode.get('o')?.result).toEqual({
      sessionId: 'orchestrator:user-1',
      threadId: 'thread-1',
      response: 'The answer is 42',
      output: { answer: '42' },
    });
  });
});

// ─── 5. isSettled false on re-entry: re-parks without calling awaitResult ────

describe('executeThread: isSettled false on re-entry', () => {
  it('re-parks on the same submission (spurious wake) without calling awaitResult', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine, calls } = makeEngine({ isSettledQueue: [false] });

    await store.createRun('run-5', runParams(), threadDefinition(), 'v1', OWNER);
    const attempt1 = await claimAttempt(store, 'run-5');
    const park1 = await driveUntilPark('run-5', attempt1, { store, engine, clock: clock.now });
    expect(park1.status).toBe('parked');

    const attempt2 = await claimAttempt(store, 'run-5', 'owner-2');
    const park2 = await driveUntilPark('run-5', attempt2, { store, engine, clock: clock.now });

    expect(park2.status).toBe('parked');
    expect(park2.waitingOn).toEqual(park1.waitingOn);
    expect(calls.some((c) => c.kind === 'isSettled')).toBe(true);
    expect(calls.some((c) => c.kind === 'awaitResult')).toBe(false);
  });
});

// ─── 6. Validation failure triggers exactly one repair, via promptOrchestrator ─

describe('executeThread: schema validation failure triggers exactly one repair', () => {
  it('dispatches dispatchId+":repair" with queueMode "followup" and the ownerHint, schema + error in the prompt, then parks', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const outputSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    const { engine, calls } = makeEngine({
      isSettledQueue: [true],
      awaitResultQueue: [{ outcome: 'completed', text: 'not json', error: 'result did not match schema: /answer: missing value' }],
    });

    await store.createRun('run-6', runParams(), threadDefinition({ outputSchema }), 'v1', OWNER);
    const attempt1 = await claimAttempt(store, 'run-6');
    await driveUntilPark('run-6', attempt1, { store, engine, clock: clock.now });

    const attempt2 = await claimAttempt(store, 'run-6', 'owner-2');
    const park2 = await driveUntilPark('run-6', attempt2, { store, engine, clock: clock.now });
    expect(park2.status).toBe('parked');

    const repairCalls = calls.filter((c) => c.kind === 'promptOrchestrator' && c.dispatchId === 'workflow:run-6:o:repair');
    expect(repairCalls).toHaveLength(1);
    expect(repairCalls[0]?.queueMode).toBe('followup');
    expect(repairCalls[0]?.ownerHint).toEqual(OWNER);
    const repairText = String(repairCalls[0]?.prompt);
    expect(repairText).toContain(JSON.stringify(outputSchema));
    expect(repairText).toContain('missing value');

    const byNode = new Map((await store.getCheckpoints('run-6')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('o')?.status).toBe('intent'); // still parked on the repair submission, not terminal
    expect(byNode.get('o')?.effects?.repairAttempted).toBe(true);
  });
});

// ─── 7. Second validation failure fails the node ─────────────────────────────

describe('executeThread: second validation failure fails the node', () => {
  it('fails the node (and the run) once repairAttempted is already true', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const outputSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    const { engine, calls } = makeEngine({
      isSettledQueue: [true],
      awaitResultQueue: [
        { outcome: 'completed', text: 'nope', error: 'first validation error' },
        { outcome: 'completed', text: 'still nope', error: 'second validation error' },
      ],
    });

    await store.createRun('run-7', runParams(), threadDefinition({ outputSchema }), 'v1', OWNER);
    const attempt1 = await claimAttempt(store, 'run-7');
    await driveUntilPark('run-7', attempt1, { store, engine, clock: clock.now }); // dispatch, park

    const attempt2 = await claimAttempt(store, 'run-7', 'owner-2');
    const park2 = await driveUntilPark('run-7', attempt2, { store, engine, clock: clock.now }); // 1st failure -> repair, park
    expect(park2.status).toBe('parked');

    const attempt3 = await claimAttempt(store, 'run-7', 'owner-3');
    const park3 = await driveUntilPark('run-7', attempt3, { store, engine, clock: clock.now }); // 2nd failure -> node failed
    expect(park3.status).toBe('settled');
    expect(park3.outcome).toBe('failed');

    const byNode = new Map((await store.getCheckpoints('run-7')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('o')?.status).toBe('failed');
    expect(byNode.get('o')?.error).toMatch(/second validation error/);

    const repairCalls = calls.filter((c) => c.kind === 'promptOrchestrator' && c.dispatchId === 'workflow:run-7:o:repair');
    expect(repairCalls).toHaveLength(1); // exactly one repair attempt, ever
  });
});

// ─── 8. aborted outcome fails the node ────────────────────────────────────────

describe('executeThread: non-completed outcome fails the node', () => {
  it('fails the node with the submission error for an aborted outcome', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine } = makeEngine({
      isSettledQueue: [true],
      awaitResultQueue: [{ outcome: 'aborted', error: 'cancelled by user' }],
    });

    await store.createRun('run-8', runParams(), threadDefinition(), 'v1', OWNER);
    const attempt1 = await claimAttempt(store, 'run-8');
    await driveUntilPark('run-8', attempt1, { store, engine, clock: clock.now });

    const attempt2 = await claimAttempt(store, 'run-8', 'owner-2');
    const park2 = await driveUntilPark('run-8', attempt2, { store, engine, clock: clock.now });
    expect(park2.status).toBe('settled');
    expect(park2.outcome).toBe('failed');

    const byNode = new Map((await store.getCheckpoints('run-8')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('o')?.status).toBe('failed');
    expect(byNode.get('o')?.error).toBe('cancelled by user');
  });
});

// ─── 9. Missing run owner fails the node without dispatching ─────────────────

describe('executeThread: missing run owner', () => {
  it('fails the node immediately with a clear error, never calling promptOrchestrator', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine, calls } = makeEngine();

    await store.createRun('run-9', runParams(), threadDefinition(), 'v1'); // no owner
    const attempt = await claimAttempt(store, 'run-9');
    const park = await driveUntilPark('run-9', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('failed');
    expect(calls).toHaveLength(0);

    const byNode = new Map((await store.getCheckpoints('run-9')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('o')?.status).toBe('failed');
    expect(byNode.get('o')?.error).toMatch(/requires a run owner/);
  });
});

// ─── 10. iteration > 0: id suffix + checkpoint keyed at the iteration ────────

describe('executeThread: iteration > 0', () => {
  it('appends :{iteration} to the dispatchId and checkpoints at that iteration', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine, calls } = makeEngine();

    const definition = threadDefinition({ wait: { mode: 'none' } });
    await store.createRun('run-10', runParams(), definition, 'v1', OWNER);
    const attempt = await claimAttempt(store, 'run-10');
    const run = await store.getRun('run-10');
    if (!run) throw new Error('run vanished');
    const node = definition.nodes.find((n): n is ThreadNode => n.id === 'o')!;

    const result = await executeThread({
      run,
      node,
      attempt,
      iteration: 1,
      templateContext: { trigger: undefined, nodes: {} },
      store,
      clock: clock.now,
      engine,
    });

    expect(result.status).toBe('completed');
    const dispatchCall = calls.find((c) => c.kind === 'promptOrchestrator');
    expect(dispatchCall?.dispatchId).toBe('workflow:run-10:o:1');

    const checkpoints = await store.getCheckpoints('run-10');
    const cp = checkpoints.find((c) => c.nodeId === 'o' && c.iteration === 1);
    expect(cp).toBeDefined();
    expect(cp?.status).toBe('completed');
    expect(checkpoints.some((c) => c.nodeId === 'o' && c.iteration === 0)).toBe(false);
  });
});

// ─── 11. aliases merge into the template context ─────────────────────────────

describe('executeThread: aliases', () => {
  it('resolves {{item}} from aliases when rendering the prompt', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const { engine, calls } = makeEngine();

    const definition = threadDefinition({ prompt: 'process {{item}} at index {{index}}', wait: { mode: 'none' } });
    await store.createRun('run-11', runParams(), definition, 'v1', OWNER);
    const attempt = await claimAttempt(store, 'run-11');
    const run = await store.getRun('run-11');
    if (!run) throw new Error('run vanished');
    const node = definition.nodes.find((n): n is ThreadNode => n.id === 'o')!;

    await executeThread({
      run,
      node,
      attempt,
      iteration: 1,
      aliases: { item: 'widget-7', index: 1 },
      templateContext: { trigger: undefined, nodes: {} },
      store,
      clock: clock.now,
      engine,
    });

    const dispatchCall = calls.find((c) => c.kind === 'promptOrchestrator');
    expect(dispatchCall?.prompt).toBe('process widget-7 at index 1');
  });
});

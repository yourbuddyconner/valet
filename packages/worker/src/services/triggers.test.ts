import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  dispatchOrchestratorPromptMock,
  dispatchWorkflowExecutionMock,
  checkWorkflowConcurrencyMock,
  checkIdempotencyKeyMock,
  getDbMock,
  getTriggerForRunMock,
  updateTriggerLastRunUncheckedMock,
} = vi.hoisted(() => ({
  dispatchOrchestratorPromptMock: vi.fn(),
  dispatchWorkflowExecutionMock: vi.fn(),
  checkWorkflowConcurrencyMock: vi.fn(),
  checkIdempotencyKeyMock: vi.fn(),
  getDbMock: vi.fn(),
  getTriggerForRunMock: vi.fn(),
  updateTriggerLastRunUncheckedMock: vi.fn(),
}));

vi.mock('./orchestrator.js', () => ({
  dispatchOrchestratorPrompt: dispatchOrchestratorPromptMock,
}));

vi.mock('./workflow-dispatch.js', () => ({
  dispatchWorkflowExecution: dispatchWorkflowExecutionMock,
}));

vi.mock('./executions.js', () => ({
  checkWorkflowConcurrency: checkWorkflowConcurrencyMock,
}));

vi.mock('../lib/drizzle.js', () => ({
  getDb: getDbMock,
}));

vi.mock('../lib/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/db.js')>();
  return {
    ...actual,
    checkIdempotencyKey: checkIdempotencyKeyMock,
    getTriggerForRun: getTriggerForRunMock,
    updateTriggerLastRunUnchecked: updateTriggerLastRunUncheckedMock,
  };
});

import { runTrigger } from './triggers.js';

describe('runTrigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDbMock.mockReturnValue({});
    dispatchOrchestratorPromptMock.mockResolvedValue({
      dispatched: true,
      sessionId: 'orchestrator:user-1',
    });
    dispatchWorkflowExecutionMock.mockResolvedValue({
      executionId: 'exec-1',
      status: 'pending',
    });
    checkWorkflowConcurrencyMock.mockResolvedValue({
      allowed: true,
      activeUser: 0,
      activeGlobal: 0,
    });
    checkIdempotencyKeyMock.mockResolvedValue(null);
    getTriggerForRunMock.mockResolvedValue({
      wf_id: null,
      workflow_name: null,
      config: JSON.stringify({
        type: 'schedule',
        target: 'orchestrator',
        prompt: 'Daily triage',
        timezone: 'UTC',
        cron: '0 9 * * *',
      }),
    });
  });

  it('marks manually invoked orchestrator-targeted triggers as automation origin', async () => {
    const env = { DB: {} } as Parameters<typeof runTrigger>[0];

    await runTrigger(env, 'trigger-1', 'user-1', { clientRequestId: 'manual-run' }, 'http://worker.test');

    expect(dispatchOrchestratorPromptMock).toHaveBeenCalledWith(env, expect.objectContaining({
      forceNewThread: true,
      threadOrigin: {
        originType: 'automation',
        originTriggerId: 'trigger-1',
        originTriggerType: 'schedule',
      },
    }));
  });

  it('passes explicit trigger data and input overrides separately for workflow triggers', async () => {
    const env = { DB: {} } as Parameters<typeof runTrigger>[0];
    getTriggerForRunMock.mockResolvedValue({
      wf_id: 'workflow-1',
      workflow_name: 'Customer onboarding',
      workflow_data: '{}',
      config: JSON.stringify({ type: 'manual' }),
      variable_mapping: null,
    });

    await runTrigger(env, 'trigger-1', 'user-1', {
      clientRequestId: 'manual-run',
      triggerData: { email: 'conner@example.com', raw: { plan: 'enterprise' } },
      inputs: { plan: 'enterprise' },
    }, 'http://worker.test');

    expect(dispatchWorkflowExecutionMock).toHaveBeenCalledWith(env, expect.objectContaining({
      trigger: expect.objectContaining({
        data: { email: 'conner@example.com', raw: { plan: 'enterprise' } },
      }),
      inputOverrides: { plan: 'enterprise' },
    }));
  });
});

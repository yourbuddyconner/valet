import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  dispatchOrchestratorPromptMock,
  getDbMock,
  getTriggerForRunMock,
  updateTriggerLastRunMock,
} = vi.hoisted(() => ({
  dispatchOrchestratorPromptMock: vi.fn(),
  getDbMock: vi.fn(),
  getTriggerForRunMock: vi.fn(),
  updateTriggerLastRunMock: vi.fn(),
}));

vi.mock('./orchestrator.js', () => ({
  dispatchOrchestratorPrompt: dispatchOrchestratorPromptMock,
}));

vi.mock('../lib/drizzle.js', () => ({
  getDb: getDbMock,
}));

vi.mock('../lib/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/db.js')>();
  return {
    ...actual,
    getTriggerForRun: getTriggerForRunMock,
    updateTriggerLastRun: updateTriggerLastRunMock,
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
    const env = { DB: {} } as any;

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
});

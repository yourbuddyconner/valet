import { describe, expect, it } from 'vitest';
import type { Execution } from './executions';
import {
  getExecutionDetailRefetchInterval,
  getExecutionListRefetchInterval,
  isActiveExecutionStatus,
  LIVE_EXECUTION_REFETCH_INTERVAL_MS,
} from './executions';

const baseExecution: Execution = {
  id: 'exec-1',
  workflowId: 'workflow-1',
  workflowName: 'Workflow',
  triggerId: null,
  triggerName: null,
  status: 'running',
  triggerType: 'manual',
  triggerMetadata: null,
  triggerData: null,
  outputs: null,
  error: null,
  startedAt: '2026-06-18T00:00:00.000Z',
  completedAt: null,
};

describe('execution polling helpers', () => {
  it('treats pending and waiting statuses as active', () => {
    expect(isActiveExecutionStatus('pending')).toBe(true);
    expect(isActiveExecutionStatus('running')).toBe(true);
    expect(isActiveExecutionStatus('waiting_approval')).toBe(true);
    expect(isActiveExecutionStatus('waiting_time')).toBe(true);
    expect(isActiveExecutionStatus('cancelling')).toBe(true);
  });

  it('treats terminal statuses as inactive', () => {
    expect(isActiveExecutionStatus('completed')).toBe(false);
    expect(isActiveExecutionStatus('failed')).toBe(false);
    expect(isActiveExecutionStatus('cancelled')).toBe(false);
  });

  it('polls execution details only while execution is active', () => {
    expect(getExecutionDetailRefetchInterval({ execution: baseExecution })).toBe(
      LIVE_EXECUTION_REFETCH_INTERVAL_MS,
    );
    expect(
      getExecutionDetailRefetchInterval({
        execution: {
          ...baseExecution,
          status: 'completed',
          completedAt: '2026-06-18T00:00:01.000Z',
        },
      }),
    ).toBe(false);
  });

  it('polls execution lists when any listed execution is active', () => {
    expect(
      getExecutionListRefetchInterval([
        { ...baseExecution, status: 'completed', completedAt: '2026-06-18T00:00:01.000Z' },
        { ...baseExecution, id: 'exec-2', status: 'waiting_time' },
      ]),
    ).toBe(LIVE_EXECUTION_REFETCH_INTERVAL_MS);

    expect(
      getExecutionListRefetchInterval([
        { ...baseExecution, status: 'failed', completedAt: '2026-06-18T00:00:01.000Z' },
        {
          ...baseExecution,
          id: 'exec-2',
          status: 'cancelled',
          completedAt: '2026-06-18T00:00:01.000Z',
        },
      ]),
    ).toBe(false);
  });
});

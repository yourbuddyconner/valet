import { describe, it, expect } from 'vitest';
import { buildTimelineViewModel } from './use-execution-timeline';
import type { ExecutionStepTrace } from '@/api/executions';
import type { WorkflowData } from '@/api/workflows';

function mkRow(over: Partial<ExecutionStepTrace> & { stepId: string }): ExecutionStepTrace {
  return {
    id: `r-${Math.random()}`,
    executionId: 'ex',
    stepId: over.stepId,
    attempt: over.attempt ?? 1,
    iterationPath: over.iterationPath ?? '',
    status: over.status ?? 'completed',
    input: over.input ?? null,
    output: over.output ?? null,
    error: over.error ?? null,
    startedAt: over.startedAt ?? null,
    completedAt: over.completedAt ?? null,
    createdAt: over.createdAt ?? '',
    workflowStepIndex: over.workflowStepIndex ?? null,
    sequence: over.sequence ?? 0,
  };
}

const def: WorkflowData = {
  id: 'def',
  name: 'def',
  steps: [
    { id: 'A', name: 'A', type: 'bash' },
    {
      id: 'L', name: 'L', type: 'loop',
      steps: [
        { id: 'inner', name: 'inner', type: 'bash' },
        {
          id: 'P', name: 'P', type: 'parallel',
          steps: [
            { id: 'leaf1', name: 'leaf1', type: 'bash' },
            { id: 'leaf2', name: 'leaf2', type: 'bash' },
          ],
        },
      ],
    },
  ],
};

describe('buildTimelineViewModel', () => {
  it('places top-level steps in static-definition order', () => {
    const vm = buildTimelineViewModel(def, [
      mkRow({ stepId: 'A', iterationPath: '' }),
      mkRow({ stepId: 'L', iterationPath: '' }),
    ]);
    expect(vm.map((n) => n.step.stepId)).toEqual(['A', 'L']);
  });

  it('nests recursively: loop -> iter -> inner parallel -> branch -> leaf', () => {
    const vm = buildTimelineViewModel(def, [
      mkRow({ stepId: 'L', iterationPath: '' }),
      mkRow({ stepId: 'inner', iterationPath: 'L:i0' }),
      mkRow({ stepId: 'P', iterationPath: 'L:i0' }),
      mkRow({ stepId: 'leaf1', iterationPath: 'L:i0/P:b0' }),
      mkRow({ stepId: 'leaf2', iterationPath: 'L:i0/P:b1' }),
    ]);
    const loop = vm.find((n) => n.step.stepId === 'L');
    expect(loop?.children?.map((c) => c.step.stepId)).toContain('P');
    const parallelNode = loop?.children?.find((c) => c.step.stepId === 'P');
    expect(parallelNode?.children?.map((c) => c.step.stepId).sort()).toEqual(['leaf1', 'leaf2']);
  });

  it('emits a placeholder node for a static step with no row yet', () => {
    const vm = buildTimelineViewModel(def, [
      mkRow({ stepId: 'A', iterationPath: '' }),
    ]);
    const loop = vm.find((n) => n.step.stepId === 'L');
    expect(loop).toBeTruthy();
    expect(loop?.placeholder).toBe(true);
    expect(loop?.step.status).toBe('pending');
  });

  it('falls back to flat createdAt order when workflowDef is null', () => {
    const vm = buildTimelineViewModel(null, [
      mkRow({ stepId: 'b', iterationPath: '', createdAt: '2026-01-02' }),
      mkRow({ stepId: 'a', iterationPath: '', createdAt: '2026-01-01' }),
    ]);
    expect(vm.map((n) => n.step.stepId)).toEqual(['a', 'b']);
  });
});

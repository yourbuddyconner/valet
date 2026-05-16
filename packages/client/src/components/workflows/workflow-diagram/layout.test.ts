import { describe, it, expect } from 'vitest';
import { layoutWorkflow } from './layout';
import type { WorkflowData } from '@/api/workflows';

const linear: WorkflowData = {
  id: 'wf',
  name: 'Linear',
  steps: [
    { id: 'a', name: 'A', type: 'bash', command: 'echo a' },
    { id: 'b', name: 'B', type: 'bash', command: 'echo b' },
  ],
};

const branched: WorkflowData = {
  id: 'wf',
  name: 'Branched',
  steps: [
    {
      id: 'gate',
      name: 'Gate',
      type: 'conditional',
      condition: 'x > 0',
      then: [{ id: 't1', name: 'T1', type: 'bash', command: 'echo t' }],
      else: [{ id: 'e1', name: 'E1', type: 'bash', command: 'echo e' }],
    },
  ],
};

describe('layoutWorkflow', () => {
  it('produces start, step nodes, and end for a linear workflow', () => {
    const { nodes, edges } = layoutWorkflow(linear);
    const ids = nodes.map(n => n.id);
    expect(ids).toContain('__start__');
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).toContain('__end__');
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: '__start__', target: 'a' }),
      expect.objectContaining({ source: 'a', target: 'b' }),
      expect.objectContaining({ source: 'b', target: '__end__' }),
    ]));
  });

  it('forks then/else under a conditional and merges back', () => {
    const { nodes, edges } = layoutWorkflow(branched);
    const ids = nodes.map(n => n.id);
    expect(ids).toContain('gate');
    expect(ids).toContain('t1');
    expect(ids).toContain('e1');
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'gate', target: 't1', label: 'THEN' }),
      expect.objectContaining({ source: 'gate', target: 'e1', label: 'ELSE' }),
    ]));
  });

  it('assigns numeric x/y positions to every node', () => {
    const { nodes } = layoutWorkflow(linear);
    for (const node of nodes) {
      expect(typeof node.position.x).toBe('number');
      expect(typeof node.position.y).toBe('number');
    }
  });

  it('handles workflows with no steps without throwing', () => {
    const { nodes, edges } = layoutWorkflow({ id: 'empty', name: 'Empty', steps: [] });
    expect(nodes.length).toBeGreaterThanOrEqual(2); // start + end
    expect(edges.length).toBeGreaterThanOrEqual(1);
  });

  it('routes an approval step like any leaf step', () => {
    const wf: WorkflowData = {
      id: 'wf',
      name: 'Approval',
      steps: [
        { id: 'a', name: 'A', type: 'bash', command: 'echo a' },
        { id: 'ok', name: 'OK?', type: 'approval' },
        { id: 'b', name: 'B', type: 'bash', command: 'echo b' },
      ],
    };
    const { nodes, edges } = layoutWorkflow(wf);
    const ids = nodes.map(n => n.id);
    expect(ids).toEqual(expect.arrayContaining(['a', 'ok', 'b']));
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'a', target: 'ok' }),
      expect.objectContaining({ source: 'ok', target: 'b' }),
    ]));
  });
});

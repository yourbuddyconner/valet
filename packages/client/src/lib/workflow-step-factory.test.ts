import { describe, it, expect } from 'vitest';
import type { WorkflowStep } from '@/api/workflows';
import {
  makeStepOfType,
  insertAfter,
  insertInto,
  removeStep,
  collectAllStepIds,
} from './workflow-step-factory';

function tree(): WorkflowStep[] {
  return [
    { id: 'a', name: 'A', type: 'bash', command: 'echo a' },
    {
      id: 'gate',
      name: 'Gate',
      type: 'conditional',
      condition: 'x',
      then: [{ id: 't1', name: 'T1', type: 'bash', command: 't' }],
      else: [{ id: 'e1', name: 'E1', type: 'bash', command: 'e' }],
    },
    {
      id: 'par',
      name: 'Par',
      type: 'parallel',
      steps: [{ id: 'p1', name: 'P1', type: 'bash', command: 'p' }],
    },
  ];
}

describe('makeStepOfType', () => {
  it('produces a step with id, default name, type-specific defaults', () => {
    const ids = new Set<string>();
    const s = makeStepOfType('bash', ids);
    expect(s.type).toBe('bash');
    expect(s.id.startsWith('bash_')).toBe(true);
    expect(s.command).toBe('');
    expect(s.name).toBeTruthy();
  });

  it('seeds container types with empty branch/steps arrays', () => {
    const ids = new Set<string>();
    const cond = makeStepOfType('conditional', ids);
    expect(cond.then).toEqual([]);
    expect(cond.else).toEqual([]);
    expect(cond.condition).toBe('');
    const par = makeStepOfType('parallel', ids);
    expect(par.steps).toEqual([]);
    const loop = makeStepOfType('loop', ids);
    expect(loop.steps).toEqual([]);
    expect(loop.over).toBe('');
    expect(loop.itemVar).toBe('item');
  });

  it('avoids existing IDs', () => {
    const ids = new Set<string>(['bash_aaaa']);
    for (let i = 0; i < 10; i++) {
      const s = makeStepOfType('bash', ids);
      expect(ids.has(s.id)).toBe(false);
      ids.add(s.id);
    }
  });
});

describe('insertAfter', () => {
  it('inserts at root level', () => {
    const steps = tree();
    const ns: WorkflowStep = { id: 'new', name: 'N', type: 'bash', command: '' };
    const out = insertAfter(steps, 'a', ns);
    expect(out.map((s) => s.id)).toEqual(['a', 'new', 'gate', 'par']);
  });

  it('inserts inside a conditional then-branch', () => {
    const steps = tree();
    const ns: WorkflowStep = { id: 'new', name: 'N', type: 'bash', command: '' };
    const out = insertAfter(steps, 't1', ns);
    const gate = out.find((s) => s.id === 'gate');
    expect(gate?.then?.map((s) => s.id)).toEqual(['t1', 'new']);
  });

  it('inserts inside a parallel container', () => {
    const steps = tree();
    const ns: WorkflowStep = { id: 'new', name: 'N', type: 'bash', command: '' };
    const out = insertAfter(steps, 'p1', ns);
    const par = out.find((s) => s.id === 'par');
    expect(par?.steps?.map((s) => s.id)).toEqual(['p1', 'new']);
  });
});

describe('insertInto', () => {
  it('appends to a conditional then-branch', () => {
    const steps = tree();
    const ns: WorkflowStep = { id: 'new', name: 'N', type: 'bash', command: '' };
    const out = insertInto(steps, 'gate', 'then', ns);
    const gate = out.find((s) => s.id === 'gate');
    expect(gate?.then?.map((s) => s.id)).toEqual(['t1', 'new']);
    expect(gate?.else?.map((s) => s.id)).toEqual(['e1']);
  });

  it('appends to a conditional else-branch', () => {
    const steps = tree();
    const ns: WorkflowStep = { id: 'new', name: 'N', type: 'bash', command: '' };
    const out = insertInto(steps, 'gate', 'else', ns);
    const gate = out.find((s) => s.id === 'gate');
    expect(gate?.else?.map((s) => s.id)).toEqual(['e1', 'new']);
  });

  it('appends to a parallel container', () => {
    const steps = tree();
    const ns: WorkflowStep = { id: 'new', name: 'N', type: 'bash', command: '' };
    const out = insertInto(steps, 'par', 'steps', ns);
    const par = out.find((s) => s.id === 'par');
    expect(par?.steps?.map((s) => s.id)).toEqual(['p1', 'new']);
  });

  it('appends into a container nested inside another container', () => {
    const steps: WorkflowStep[] = [
      {
        id: 'outer',
        name: 'O',
        type: 'conditional',
        condition: 'x',
        then: [
          {
            id: 'inner',
            name: 'I',
            type: 'parallel',
            steps: [],
          },
        ],
        else: [],
      },
    ];
    const ns: WorkflowStep = { id: 'new', name: 'N', type: 'bash', command: '' };
    const out = insertInto(steps, 'inner', 'steps', ns);
    const outer = out[0];
    const inner = outer.then?.[0];
    expect(inner?.steps?.map((s) => s.id)).toEqual(['new']);
  });
});

describe('removeStep', () => {
  it('removes from root level', () => {
    const steps = tree();
    const out = removeStep(steps, 'a');
    expect(out.map((s) => s.id)).toEqual(['gate', 'par']);
  });

  it('removes from inside a conditional branch', () => {
    const steps = tree();
    const out = removeStep(steps, 't1');
    const gate = out.find((s) => s.id === 'gate');
    expect(gate?.then).toEqual([]);
    expect(gate?.else?.map((s) => s.id)).toEqual(['e1']);
  });

  it('removes a container and all of its descendants', () => {
    const steps = tree();
    const out = removeStep(steps, 'gate');
    expect(out.map((s) => s.id)).toEqual(['a', 'par']);
    // 't1' should be gone too — there's no record of it anywhere.
    expect(collectAllStepIds(out).has('t1')).toBe(false);
  });
});

describe('collectAllStepIds', () => {
  it('walks the whole tree including container children', () => {
    const ids = collectAllStepIds(tree());
    expect(ids.has('a')).toBe(true);
    expect(ids.has('gate')).toBe(true);
    expect(ids.has('t1')).toBe(true);
    expect(ids.has('e1')).toBe(true);
    expect(ids.has('par')).toBe(true);
    expect(ids.has('p1')).toBe(true);
  });
});

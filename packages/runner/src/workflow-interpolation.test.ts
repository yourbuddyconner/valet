import { describe, it, expect } from 'bun:test';
import { resolveInterpolation, resolveStepFields } from './workflow-interpolation';

const ctx = {
  variables: { name: 'Alice', count: 3, ready: true, none: null },
  outputs: {
    digest: { summary: 'all green', failed: 0 },
    list: [1, 2, 3],
  },
};

describe('resolveInterpolation', () => {
  it('returns the template unchanged when no tokens present', () => {
    const r = resolveInterpolation('hello world', ctx);
    expect(r.text).toBe('hello world');
    expect(r.missingPaths).toEqual([]);
  });

  it('resolves a single variables token', () => {
    const r = resolveInterpolation('hi {{variables.name}}', ctx);
    expect(r.text).toBe('hi Alice');
    expect(r.missingPaths).toEqual([]);
  });

  it('resolves nested outputs paths', () => {
    const r = resolveInterpolation('Summary: {{outputs.digest.summary}}', ctx);
    expect(r.text).toBe('Summary: all green');
  });

  it('renders numbers and booleans as strings', () => {
    const r = resolveInterpolation('{{variables.count}} - {{variables.ready}}', ctx);
    expect(r.text).toBe('3 - true');
  });

  it('renders arrays and objects as JSON', () => {
    const r = resolveInterpolation('{{outputs.list}} :: {{outputs.digest}}', ctx);
    expect(r.text).toBe('[1,2,3] :: {"summary":"all green","failed":0}');
  });

  it('renders null literally', () => {
    const r = resolveInterpolation('{{variables.none}}', ctx);
    expect(r.text).toBe('null');
  });

  it('reports missing paths and renders empty', () => {
    const r = resolveInterpolation('hi {{variables.missing}} and {{outputs.nope.x}}', ctx);
    expect(r.text).toBe('hi  and ');
    expect(r.missingPaths).toEqual(['variables.missing', 'outputs.nope.x']);
  });

  it('treats unknown roots as missing', () => {
    const r = resolveInterpolation('{{secret.token}}', ctx);
    expect(r.text).toBe('');
    expect(r.missingPaths).toEqual(['secret.token']);
  });

  it('resolves {{loop.item}} and {{loop.index}} from ctx.variables.loop', () => {
    const loopCtx = {
      variables: { loop: { item: 'apple', index: 2 } },
      outputs: {},
    };
    const r = resolveInterpolation('item={{loop.item}} idx={{loop.index}}', loopCtx);
    expect(r.text).toBe('item=apple idx=2');
    expect(r.missingPaths).toEqual([]);
  });

  it('reports loop paths as missing when no loop is active', () => {
    const r = resolveInterpolation('{{loop.item}}', ctx);
    expect(r.text).toBe('');
    expect(r.missingPaths).toEqual(['loop.item']);
  });

  it('resolves complex loop items (objects)', () => {
    const loopCtx = {
      variables: { loop: { item: { name: 'Bob', score: 9 }, index: 0 } },
      outputs: {},
    };
    const r = resolveInterpolation('hello {{loop.item.name}} - {{loop.item.score}}', loopCtx);
    expect(r.text).toBe('hello Bob - 9');
  });

  it('trims whitespace inside tokens', () => {
    const r = resolveInterpolation('hi {{  variables.name  }}', ctx);
    expect(r.text).toBe('hi Alice');
  });

  it('resolves multiple tokens in one template', () => {
    const r = resolveInterpolation(
      '{{variables.name}} reports {{outputs.digest.failed}} failures',
      ctx,
    );
    expect(r.text).toBe('Alice reports 0 failures');
  });
});

describe('resolveStepFields', () => {
  it('resolves content, prompt, command, and arguments strings', () => {
    const { step, missingPaths } = resolveStepFields(
      {
        type: 'notify',
        content: 'Hello {{variables.name}}',
        prompt: 'Run for {{variables.name}}',
        command: 'echo {{variables.count}}',
        arguments: { who: '{{variables.name}}', n: 5 },
      },
      ctx,
    );
    expect(step.content).toBe('Hello Alice');
    expect(step.prompt).toBe('Run for Alice');
    expect(step.command).toBe('echo 3');
    expect(step.arguments).toEqual({ who: 'Alice', n: 5 });
    expect(missingPaths).toEqual([]);
  });

  it('aggregates missing paths from all fields', () => {
    const { missingPaths } = resolveStepFields(
      { type: 'notify', content: '{{variables.x}}', command: '{{outputs.y}}' },
      ctx,
    );
    expect(missingPaths.sort()).toEqual(['outputs.y', 'variables.x']);
  });

  it('leaves non-string arguments untouched', () => {
    const args = { a: 1, b: true, c: [1, 2], d: { nested: 'x' } };
    const { step } = resolveStepFields(
      { type: 'tool', tool: 'x', arguments: args },
      ctx,
    );
    expect(step.arguments).toEqual(args);
  });
});

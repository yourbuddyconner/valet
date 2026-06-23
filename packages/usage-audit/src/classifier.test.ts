import { describe, expect, it } from 'vitest';
import { parseClassification } from './classifier.js';

describe('parseClassification', () => {
  it('parses a valid tool input', () => {
    const out = parseClassification({
      task_type: 'debugging',
      cost_driver: 'long-tool-loop',
      outcome: 'completed',
      summary: 'fixed a flaky test',
      confidence: 'high',
    });
    expect(out).toEqual({
      taskType: 'debugging',
      costDriver: 'long-tool-loop',
      outcome: 'completed',
      summary: 'fixed a flaky test',
      confidence: 'high',
    });
  });

  it('downgrades unknown confidence to low', () => {
    const out = parseClassification({
      task_type: 'docs',
      cost_driver: 'normal',
      outcome: 'completed',
      summary: 'wrote a readme',
      confidence: 'very-high',
    });
    expect(out.confidence).toBe('low');
  });

  it('throws on missing required fields', () => {
    expect(() => parseClassification({})).toThrow(/task_type/);
    expect(() =>
      parseClassification({
        task_type: 'docs',
        cost_driver: 'normal',
        outcome: 'completed',
        summary: '',
        confidence: 'high',
      }),
    ).toThrow(/summary/);
  });

  it('throws when input is not an object', () => {
    expect(() => parseClassification(null)).toThrow();
    expect(() => parseClassification('not-an-object')).toThrow();
  });
});

import { describe, it, expect } from 'vitest';
import { parseJobLog } from './parse-job-log.js';
import type { ParseJobLogOptions } from './parse-job-log.js';

const defaults: ParseJobLogOptions = {
  failedOnly: false,
  tailLines: 500,
  includeTimestamps: false,
};

function makeLogs(steps: Array<{ name: string; lines: string[] }>): string {
  return steps
    .map((s) => [
      `2024-01-15T10:30:00.0000000Z ##[group]${s.name}`,
      ...s.lines.map((l) => `2024-01-15T10:30:01.0000000Z ${l}`),
      `2024-01-15T10:30:02.0000000Z ##[endgroup]`,
    ].join('\n'))
    .join('\n');
}

describe('parseJobLog', () => {
  it('parses steps from group markers', () => {
    const raw = makeLogs([
      { name: 'Run checkout', lines: ['Cloning repo...', 'Done.'] },
      { name: 'Run tests', lines: ['PASS test_a', 'PASS test_b'] },
    ]);
    const steps = [
      { name: 'Run checkout', conclusion: 'success' },
      { name: 'Run tests', conclusion: 'success' },
    ];

    const result = parseJobLog(raw, steps, defaults);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Run checkout');
    expect(result[0].conclusion).toBe('success');
    expect(result[0].log).toContain('Cloning repo...');
    expect(result[1].name).toBe('Run tests');
  });

  it('filters to failed steps when failedOnly=true', () => {
    const raw = makeLogs([
      { name: 'Run checkout', lines: ['OK'] },
      { name: 'Run build', lines: ['error: something broke'] },
    ]);
    const steps = [
      { name: 'Run checkout', conclusion: 'success' },
      { name: 'Run build', conclusion: 'failure' },
    ];

    const result = parseJobLog(raw, steps, { ...defaults, failedOnly: true });

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Run build');
    expect(result[0].conclusion).toBe('failure');
  });

  it('filters by step name (case-insensitive partial match)', () => {
    const raw = makeLogs([
      { name: 'Run checkout', lines: ['OK'] },
      { name: 'Run cargo build', lines: ['compiling...'] },
    ]);
    const steps = [
      { name: 'Run checkout', conclusion: 'success' },
      { name: 'Run cargo build', conclusion: 'success' },
    ];

    const result = parseJobLog(raw, steps, { ...defaults, stepName: 'cargo' });

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Run cargo build');
  });

  it('strips timestamps by default', () => {
    const raw = '2024-01-15T10:30:00.0000000Z ##[group]Step\n2024-01-15T10:30:01.0000000Z hello world\n2024-01-15T10:30:02.0000000Z ##[endgroup]';
    const steps = [{ name: 'Step', conclusion: 'success' }];

    const result = parseJobLog(raw, steps, defaults);

    expect(result[0].log).toBe('hello world');
    expect(result[0].log).not.toContain('2024-01-15');
  });

  it('preserves timestamps when includeTimestamps=true', () => {
    const raw = '2024-01-15T10:30:00.0000000Z ##[group]Step\n2024-01-15T10:30:01.0000000Z hello world\n2024-01-15T10:30:02.0000000Z ##[endgroup]';
    const steps = [{ name: 'Step', conclusion: 'success' }];

    const result = parseJobLog(raw, steps, { ...defaults, includeTimestamps: true });

    expect(result[0].log).toContain('2024-01-15');
  });

  it('truncates to tailLines and preserves ##[error] lines from head', () => {
    const logLines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    logLines[5] = '##[error]Root cause error here';
    const raw = makeLogs([{ name: 'Build', lines: logLines }]);
    const steps = [{ name: 'Build', conclusion: 'failure' }];

    const result = parseJobLog(raw, steps, { ...defaults, tailLines: 10 });

    expect(result[0].truncated).toBe(true);
    expect(result[0].total_lines).toBe(100);
    // ##[error] line from the head should be preserved
    expect(result[0].log).toContain('Root cause error here');
    // Last line should be the tail
    expect(result[0].log).toContain('line 99');
    // Truncation marker should be present
    expect(result[0].log).toContain('[truncated');
  });

  it('strips ANSI escape codes', () => {
    const raw = '2024-01-15T10:30:00.0000000Z ##[group]Step\n2024-01-15T10:30:01.0000000Z \x1b[31merror\x1b[0m: bad thing\n2024-01-15T10:30:02.0000000Z ##[endgroup]';
    const steps = [{ name: 'Step', conclusion: 'failure' }];

    const result = parseJobLog(raw, steps, defaults);

    expect(result[0].log).toBe('error: bad thing');
    expect(result[0].log).not.toContain('\x1b');
  });

  it('handles logs without group markers as a single unnamed step', () => {
    const raw = '2024-01-15T10:30:01.0000000Z just some output\n2024-01-15T10:30:02.0000000Z more output';
    const steps = [{ name: 'Run tests', conclusion: 'failure' }];

    const result = parseJobLog(raw, steps, defaults);

    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].log).toContain('just some output');
  });

  it('returns empty array when failedOnly=true and no steps failed', () => {
    const raw = makeLogs([{ name: 'Step', lines: ['OK'] }]);
    const steps = [{ name: 'Step', conclusion: 'success' }];

    const result = parseJobLog(raw, steps, { ...defaults, failedOnly: true });

    expect(result).toHaveLength(0);
  });

  it('does not truncate when under tailLines limit', () => {
    const raw = makeLogs([{ name: 'Step', lines: ['line 1', 'line 2', 'line 3'] }]);
    const steps = [{ name: 'Step', conclusion: 'success' }];

    const result = parseJobLog(raw, steps, { ...defaults, tailLines: 500 });

    expect(result[0].truncated).toBe(false);
    expect(result[0].total_lines).toBe(3);
  });
});

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

// Steps metadata is no longer used for matching (log group names don't match
// API step names), but we still pass it per the function signature.
const unusedSteps = [{ name: 'unused', conclusion: 'success' }];

describe('parseJobLog', () => {
  it('parses steps from group markers', () => {
    const raw = makeLogs([
      { name: 'Run checkout', lines: ['Cloning repo...', 'Done.'] },
      { name: 'Run tests', lines: ['PASS test_a', 'PASS test_b'] },
    ]);

    const result = parseJobLog(raw, unusedSteps, defaults);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Run checkout');
    expect(result[0].conclusion).toBe('success');
    expect(result[0].log).toContain('Cloning repo...');
    expect(result[1].name).toBe('Run tests');
  });

  it('classifies sections with ##[error] as failure', () => {
    const raw = makeLogs([
      { name: 'Run checkout', lines: ['OK'] },
      { name: 'Run build', lines: ['compiling...', '##[error]Build failed!'] },
    ]);

    const result = parseJobLog(raw, unusedSteps, defaults);

    expect(result[0].conclusion).toBe('success');
    expect(result[1].conclusion).toBe('failure');
  });

  it('filters to failed sections when failedOnly=true', () => {
    const raw = makeLogs([
      { name: 'Run checkout', lines: ['OK'] },
      { name: 'Run build', lines: ['error output', '##[error]Process completed with exit code 1.'] },
    ]);

    const result = parseJobLog(raw, unusedSteps, { ...defaults, failedOnly: true });

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Run build');
    expect(result[0].conclusion).toBe('failure');
  });

  it('filters by step name (case-insensitive partial match)', () => {
    const raw = makeLogs([
      { name: 'Run checkout', lines: ['OK'] },
      { name: 'Run cargo build', lines: ['compiling...'] },
    ]);

    const result = parseJobLog(raw, unusedSteps, { ...defaults, stepName: 'cargo' });

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Run cargo build');
  });

  it('strips timestamps by default', () => {
    const raw = '2024-01-15T10:30:00.0000000Z ##[group]Step\n2024-01-15T10:30:01.0000000Z hello world\n2024-01-15T10:30:02.0000000Z ##[endgroup]';

    const result = parseJobLog(raw, unusedSteps, defaults);

    expect(result[0].log).toBe('hello world');
    expect(result[0].log).not.toContain('2024-01-15');
  });

  it('preserves timestamps when includeTimestamps=true', () => {
    const raw = '2024-01-15T10:30:00.0000000Z ##[group]Step\n2024-01-15T10:30:01.0000000Z hello world\n2024-01-15T10:30:02.0000000Z ##[endgroup]';

    const result = parseJobLog(raw, unusedSteps, { ...defaults, includeTimestamps: true });

    expect(result[0].log).toContain('2024-01-15');
  });

  it('truncates to tailLines and preserves ##[error] lines from head', () => {
    const logLines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    logLines[5] = '##[error]Root cause error here';
    const raw = makeLogs([{ name: 'Build', lines: logLines }]);

    const result = parseJobLog(raw, unusedSteps, { ...defaults, tailLines: 10 });

    expect(result[0].truncated).toBe(true);
    expect(result[0].total_lines).toBe(100);
    expect(result[0].log).toContain('Root cause error here');
    expect(result[0].log).toContain('line 99');
    expect(result[0].log).toContain('[truncated');
  });

  it('strips ANSI escape codes', () => {
    const raw = '2024-01-15T10:30:00.0000000Z ##[group]Step\n2024-01-15T10:30:01.0000000Z \x1b[31merror\x1b[0m: bad thing\n2024-01-15T10:30:02.0000000Z ##[endgroup]';

    const result = parseJobLog(raw, unusedSteps, defaults);

    expect(result[0].log).toBe('error: bad thing');
    expect(result[0].log).not.toContain('\x1b');
  });

  it('handles logs without group markers as a single unnamed step', () => {
    const raw = '2024-01-15T10:30:01.0000000Z just some output\n2024-01-15T10:30:02.0000000Z more output';

    const result = parseJobLog(raw, unusedSteps, defaults);

    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].log).toContain('just some output');
  });

  it('returns empty array when failedOnly=true and no sections have errors', () => {
    const raw = makeLogs([{ name: 'Step', lines: ['OK'] }]);

    const result = parseJobLog(raw, unusedSteps, { ...defaults, failedOnly: true });

    expect(result).toHaveLength(0);
  });

  it('does not truncate when under tailLines limit', () => {
    const raw = makeLogs([{ name: 'Step', lines: ['line 1', 'line 2', 'line 3'] }]);

    const result = parseJobLog(raw, unusedSteps, { ...defaults, tailLines: 500 });

    expect(result[0].truncated).toBe(false);
    expect(result[0].total_lines).toBe(3);
  });

  it('clamps truncation counter to zero when most head lines are errors', () => {
    const logLines = Array.from({ length: 20 }, (_, i) => `##[error]error at line ${i}`);
    const raw = makeLogs([{ name: 'Build', lines: logLines }]);

    const result = parseJobLog(raw, unusedSteps, { ...defaults, tailLines: 10 });

    expect(result[0].truncated).toBe(true);
    expect(result[0].log).not.toContain('-');
    expect(result[0].log).toContain('[truncated 0 lines]');
  });

  it('does not treat ##[group] mid-line as a step boundary', () => {
    const raw = makeLogs([
      { name: 'Run build', lines: ['output: ##[group]not a real step', 'more output'] },
    ]);

    const result = parseJobLog(raw, unusedSteps, defaults);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Run build');
    expect(result[0].log).toContain('##[group]not a real step');
  });

  it('works with real GitHub log format where group names differ from API step names', () => {
    // Simulates real GitHub logs: group names are "Run npm run lint-all",
    // not "Lint" as the API would call it.
    const raw = makeLogs([
      { name: 'Run actions/checkout@abc123', lines: ['Cloning...', 'Done.'] },
      { name: 'Run npm run typecheck-all', lines: ['Checking types...', 'OK'] },
      { name: 'Run npm run lint-all', lines: [
        'Running ESLint...',
        '##[error]  24:13  error  Expected { after \'if\' condition  curly',
        '##[error]Process completed with exit code 1.',
      ]},
    ]);
    const apiSteps = [
      { name: 'Checkout sources', conclusion: 'success' },
      { name: 'Typecheck', conclusion: 'success' },
      { name: 'Lint', conclusion: 'failure' },
    ];

    const result = parseJobLog(raw, apiSteps, { ...defaults, failedOnly: true });

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Run npm run lint-all');
    expect(result[0].conclusion).toBe('failure');
    expect(result[0].log).toContain('Expected { after');
  });
});

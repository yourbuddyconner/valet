import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileLabelRegistry,
  MemoryLabelRegistry,
  labelsIntroducedSince,
  normalizeLabel,
  snapshotLabels,
} from './labels.js';

describe('normalizeLabel', () => {
  it('lowercases and collapses spaces/underscores to dashes', () => {
    expect(normalizeLabel('Debugging Tests')).toBe('debugging-tests');
    expect(normalizeLabel('debugging_tests')).toBe('debugging-tests');
    expect(normalizeLabel('  Long Tool Loop  ')).toBe('long-tool-loop');
    expect(normalizeLabel('feature-impl')).toBe('feature-impl');
  });

  it('strips non-alphanumeric chars and collapses runs of dashes', () => {
    expect(normalizeLabel('debug!! tests??')).toBe('debug-tests');
    expect(normalizeLabel('---test---')).toBe('test');
  });
});

describe('MemoryLabelRegistry', () => {
  it('seeds with the default vocabulary by default', async () => {
    const reg = new MemoryLabelRegistry();
    const taskTypes = await reg.list('taskType');
    expect(taskTypes.map((e) => e.label)).toContain('debugging');
    expect(taskTypes.map((e) => e.label)).toContain('feature-impl');
  });

  it('add returns added=false for a seed label and added=true for a new one', async () => {
    const reg = new MemoryLabelRegistry();
    const r1 = await reg.add('taskType', 'debugging', 'th-1', 'fixed a bug');
    expect(r1.added).toBe(false);

    const r2 = await reg.add('taskType', 'Tracing investigation', 'th-2', 'tracing');
    expect(r2.added).toBe(true);
    expect(r2.normalized).toBe('tracing-investigation');

    const r3 = await reg.add('taskType', 'tracing_investigation', 'th-3', 'tracing');
    expect(r3.added).toBe(false); // already present (normalized match)
    expect(r3.normalized).toBe('tracing-investigation');
  });

  it('records firstSeenThreadId and summary for new labels', async () => {
    const reg = new MemoryLabelRegistry();
    await reg.add('costDriver', 'json-parsing-storm', 'th-7', 'spent all run parsing JSON');
    const entries = await reg.list('costDriver');
    const e = entries.find((x) => x.label === 'json-parsing-storm');
    expect(e?.firstSeenThreadId).toBe('th-7');
    expect(e?.firstSeenSummary).toBe('spent all run parsing JSON');
  });
});

describe('FileLabelRegistry', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'labels-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('seeds default labels into JSON files on first load', async () => {
    const reg = await FileLabelRegistry.load(dir);
    const raw = await readFile(join(dir, 'task_types.json'), 'utf-8');
    const arr = JSON.parse(raw) as Array<{ label: string }>;
    expect(arr.some((x) => x.label === 'debugging')).toBe(true);
    expect(await reg.list('taskType')).toHaveLength(arr.length);
  });

  it('persists newly added labels to disk', async () => {
    const reg = await FileLabelRegistry.load(dir);
    await reg.add('outcome', 'rolled-back', 'th-9', 'reverted the change');
    const raw = await readFile(join(dir, 'outcomes.json'), 'utf-8');
    expect(raw).toContain('rolled-back');
    expect(raw).toContain('th-9');
  });

  it('loads existing registry files without re-seeding', async () => {
    // Pre-write a registry file with only a non-seed label.
    await writeFile(
      join(dir, 'task_types.json'),
      JSON.stringify([
        { label: 'custom-only', firstSeenThreadId: 't', firstSeenSummary: '', addedAt: '' },
      ]),
    );
    const reg = await FileLabelRegistry.load(dir);
    const taskTypes = await reg.list('taskType');
    // We do top up with any new seed labels — but the existing label sticks.
    expect(taskTypes.some((e) => e.label === 'custom-only')).toBe(true);
  });
});

describe('labelsIntroducedSince', () => {
  it('returns labels that are not in the initial snapshot and not seed entries', async () => {
    const reg = new MemoryLabelRegistry();
    const before = await snapshotLabels(reg);
    await reg.add('taskType', 'new-label', 'th-1', 'first');
    await reg.add('costDriver', 'json-storm', 'th-2', 'second');
    const introduced = await labelsIntroducedSince(reg, before);
    expect(introduced.taskType.map((e) => e.label)).toEqual(['new-label']);
    expect(introduced.costDriver.map((e) => e.label)).toEqual(['json-storm']);
    expect(introduced.outcome).toEqual([]);
  });
});

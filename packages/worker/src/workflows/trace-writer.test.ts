import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../env.js';

interface CapturedTraceRow {
  output?: string | null;
  outputTruncated?: boolean;
}

const capturedRows: CapturedTraceRow[] = [];

vi.mock('../lib/drizzle.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/drizzle.js')>();
  return {
    ...original,
    getDb: () => ({
      insert: () => ({
        values: (row: CapturedTraceRow) => {
          capturedRows.push(row);
          return {
            onConflictDoUpdate: () => ({
              run: async () => undefined,
            }),
          };
        },
      }),
    }),
  };
});

describe('createD1TraceWriter', () => {
  it('persists large completed node outputs intact', async () => {
    capturedRows.length = 0;
    const now = '2026-06-25T00:00:00.000Z';
    const { createD1TraceWriter } = await import('./trace-writer.js');
    const writer = createD1TraceWriter({
      env: { DB: {} as Env['DB'] } as Env,
      mode: 'test',
    });
    const largeText = 'x'.repeat(40 * 1024);
    const output = {
      companies: [{ name: 'Example Co', description: largeText }],
      totalCount: 1,
    };

    await writer.recordTransition({
      executionId: 'exec-large-output',
      nodeId: 'scrape_yc',
      nodeType: 'session',
      status: 'completed',
      startedAt: now,
      completedAt: now,
      durationMs: 1,
      output,
    });

    expect(capturedRows.at(-1)?.output).toBe(JSON.stringify(output));
    expect(capturedRows.at(-1)?.outputTruncated).toBe(false);
  });
});

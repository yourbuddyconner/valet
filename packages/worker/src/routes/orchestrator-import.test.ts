import { describe, it, expect } from 'vitest';
import { importMemorySchema } from './orchestrator.js';

// Regression coverage for the memory-import 400 ("Import failed"). The import
// route validates the envelope only; per-file validity (path length/depth,
// empty content) is handled by importMemoryFiles, which skips-and-reports
// instead of failing the whole bundle.
describe('importMemorySchema', () => {
  it('accepts a file whose content exceeds the old 50k cap', () => {
    // This is THE regression — was `too_big` (400) before the fix.
    const big = '#' + 'a'.repeat(60_000);
    const result = importMemorySchema.safeParse({ files: [{ path: 'notes/big.md', content: big }] });
    expect(result.success).toBe(true);
  });

  it('the envelope accepts more than the old 500-file cap (validation only)', () => {
    // Schema-level only — the 200-file cap and durable write path are covered by
    // the importMemoryFiles cap tests in memory-files-export.test.ts.
    const files = Array.from({ length: 600 }, (_, i) => ({ path: `notes/n-${i}.md`, content: '# x' }));
    expect(importMemorySchema.safeParse({ files }).success).toBe(true);
  });

  it('accepts empty content (importMemoryFiles reports it as skipped, not a 400)', () => {
    expect(importMemorySchema.safeParse({ files: [{ path: 'notes/empty.md', content: '' }] }).success).toBe(true);
  });

  it('still rejects an empty bundle (min 1)', () => {
    expect(importMemorySchema.safeParse({ files: [] }).success).toBe(false);
  });

  it('still rejects a path over 256 chars', () => {
    const longPath = 'x'.repeat(257);
    expect(importMemorySchema.safeParse({ files: [{ path: longPath, content: 'a' }] }).success).toBe(false);
  });

  it('rejects a non-array files field', () => {
    expect(importMemorySchema.safeParse({ files: 'nope' }).success).toBe(false);
  });

  it('rejects items missing a path or with non-string content', () => {
    expect(importMemorySchema.safeParse({ files: [{ content: 'x' }] }).success).toBe(false);
    expect(importMemorySchema.safeParse({ files: [{ path: '', content: 'x' }] }).success).toBe(false);
    expect(importMemorySchema.safeParse({ files: [{ path: 'a.md', content: 123 }] }).success).toBe(false);
  });
});

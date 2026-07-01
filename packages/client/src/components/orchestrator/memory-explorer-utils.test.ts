import { describe, expect, it } from 'vitest';
import { extractImportFiles } from './memory-explorer-utils';

describe('extractImportFiles', () => {
  it('extracts files from an export bundle', () => {
    const bundle = {
      version: 1,
      exportedAt: '2026-06-23T00:00:00.000Z',
      count: 2,
      files: [
        { path: 'projects/valet/overview.md', content: '# Valet', pinned: false },
        { path: 'preferences/style.md', content: '# Style', pinned: true },
      ],
    };
    expect(extractImportFiles(bundle)).toEqual([
      { path: 'projects/valet/overview.md', content: '# Valet' },
      { path: 'preferences/style.md', content: '# Style' },
    ]);
  });

  it('accepts a bare array of files', () => {
    const arr = [{ path: 'notes/a.md', content: 'a' }];
    expect(extractImportFiles(arr)).toEqual([{ path: 'notes/a.md', content: 'a' }]);
  });

  it('drops entries with a missing or non-string path', () => {
    const input = {
      files: [
        { path: 'ok.md', content: 'keep' },
        { content: 'no path' },
        { path: 42, content: 'numeric path' },
        { path: '   ', content: 'whitespace path' },
      ],
    };
    expect(extractImportFiles(input)).toEqual([{ path: 'ok.md', content: 'keep' }]);
  });

  it('drops entries whose content is not a string', () => {
    const input = { files: [{ path: 'a.md', content: 123 }, { path: 'b.md' }] };
    expect(extractImportFiles(input)).toEqual([]);
  });

  it('returns an empty array for malformed input', () => {
    expect(extractImportFiles(null)).toEqual([]);
    expect(extractImportFiles({})).toEqual([]);
    expect(extractImportFiles('nope')).toEqual([]);
    expect(extractImportFiles({ files: 'not-an-array' })).toEqual([]);
  });
});

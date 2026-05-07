import { describe, it, expect } from 'vitest';
import {
  extractTitle,
  buildFTS5Query,
  normalizeBM25,
  extractSnippet,
  pathBoost,
} from './memory-search-helpers.js';

describe('extractTitle', () => {
  it('extracts first H1 heading', () => {
    const content = '# My Project\n\nSome content here.';
    expect(extractTitle(content, 'projects/myproject/overview.md')).toBe('My Project');
  });

  it('falls back to filename when no H1', () => {
    const content = '## Section\n\nNo H1 here.';
    expect(extractTitle(content, 'projects/valet/notes.md')).toBe('notes');
  });

  it('handles H1 with no trailing newline', () => {
    const content = '# Single Line Title';
    expect(extractTitle(content, 'any/file.md')).toBe('Single Line Title');
  });

  it('strips .md from fallback filename', () => {
    expect(extractTitle('no heading', 'preferences/coding-style.md')).toBe('coding-style');
  });

  it('handles path with no slash', () => {
    expect(extractTitle('no heading', 'readme.md')).toBe('readme');
  });
});

describe('buildFTS5Query', () => {
  it('wraps single term with prefix wildcard', () => {
    expect(buildFTS5Query('deploy')).toBe('"deploy"*');
  });

  it('ANDs multiple terms with prefix wildcards', () => {
    expect(buildFTS5Query('valet deploy')).toBe('"valet"* AND "deploy"*');
  });

  it('handles quoted phrase as exact match without prefix wildcard', () => {
    expect(buildFTS5Query('"deploy process"')).toBe('"deploy process"');
  });

  it('handles negation', () => {
    expect(buildFTS5Query('deploy -staging')).toBe('"deploy"* NOT "staging"*');
  });

  it('skips single-character terms', () => {
    expect(buildFTS5Query('a deploy')).toBe('"deploy"*');
  });

  it('returns empty string for blank input', () => {
    expect(buildFTS5Query('   ')).toBe('');
  });

  it('sanitizes special characters from plain terms', () => {
    expect(buildFTS5Query('deploy!')).toBe('"deploy"*');
  });

  it('splits hyphenated terms to match FTS5 tokenization', () => {
    expect(buildFTS5Query('valet-demo-feedback-board')).toBe(
      '"valet"* AND "demo"* AND "feedback"* AND "board"*',
    );
  });

  it('splits dotted terms to match FTS5 tokenization', () => {
    expect(buildFTS5Query('my.project.name')).toBe(
      '"my"* AND "project"* AND "name"*',
    );
  });

  it('handles multiple negations with OR grouping', () => {
    expect(buildFTS5Query('deploy -staging -prod')).toBe('"deploy"* NOT ("staging"* OR "prod"*)');
  });
});

describe('normalizeBM25', () => {
  it('converts strong match to near-1', () => {
    expect(normalizeBM25(-10)).toBeCloseTo(0.909, 2);
  });

  it('converts moderate match', () => {
    expect(normalizeBM25(-2)).toBeCloseTo(0.667, 2);
  });

  it('converts weak match', () => {
    expect(normalizeBM25(-0.5)).toBeCloseTo(0.333, 2);
  });

  it('returns 0 for score of 0', () => {
    expect(normalizeBM25(0)).toBe(0);
  });
});

describe('extractSnippet', () => {
  it('returns the line with the most term matches', () => {
    const content = 'Introduction.\n\nThe deployment process runs in CI.\n\nConclusion.';
    const snippet = extractSnippet(content, ['deploy', 'process']);
    expect(snippet).toContain('deployment process');
  });

  it('includes context lines around the best match', () => {
    const lines = ['line 1', 'line 2', 'match term here', 'line 4', 'line 5'];
    const content = lines.join('\n');
    const snippet = extractSnippet(content, ['term']);
    expect(snippet).toContain('line 2');
    expect(snippet).toContain('match term here');
    expect(snippet).toContain('line 4');
  });

  it('adds [...] prefix when match is deep in the file', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    lines[8] = 'matching term here';
    const snippet = extractSnippet(lines.join('\n'), ['term']);
    expect(snippet).toContain('[...]');
  });

  it('returns content when no terms match', () => {
    const content = 'line 1\nline 2\nline 3';
    const snippet = extractSnippet(content, ['nomatch']);
    expect(snippet).toBeTruthy();
  });
});

describe('pathBoost', () => {
  it('returns 0.2 when any query term matches path', () => {
    expect(pathBoost('projects/valet/overview.md', ['valet', 'deploy'])).toBe(0.2);
  });

  it('returns 0 when no query terms match path', () => {
    expect(pathBoost('projects/valet/overview.md', ['deploy', 'staging'])).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(pathBoost('projects/Valet/overview.md', ['valet'])).toBe(0.2);
  });
});

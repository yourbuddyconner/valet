import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const toolsDir = join(root, 'tools');

describe('runtime OpenCode tools packaging', () => {
  it('keeps top-level tools as runtime files only', () => {
    const entries = readdirSync(toolsDir);
    const invalid = entries.filter((entry) => {
      const fullPath = join(toolsDir, entry);
      if (!statSync(fullPath).isFile()) return true;
      return /\.(test|spec)\.[cm]?[tj]sx?$/.test(entry);
    });

    expect(invalid).toEqual([]);
  });
});

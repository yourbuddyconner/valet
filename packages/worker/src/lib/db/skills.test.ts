import { describe, it, expect, vi } from 'vitest';
import { upsertSkillFromSync } from './skills.js';

describe('skills FTS sync', () => {
  it('uses the raw D1 client for FTS writes when available', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const prepare = vi.fn((query: string) => ({
      bind: vi.fn((...args: unknown[]) => ({
        run: vi.fn().mockResolvedValue({ query, args }),
      })),
    }));

    const db = {
      all: vi.fn().mockResolvedValue([
        {
          rowid: 2,
          name: 'Google Calendar',
          description: '',
          content: 'x'.repeat(2500),
        },
      ]),
      run,
      session: {
        client: {
          prepare,
        },
      },
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn().mockResolvedValue(undefined),
      })),
    } as any;

    await upsertSkillFromSync(db, {
      id: 'skill:default:google-calendar',
      orgId: 'default',
      source: 'plugin',
      name: 'Google Calendar',
      slug: 'google-calendar',
      content: 'original content',
      visibility: 'shared',
    });

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenNthCalledWith(1, 'DELETE FROM skills_fts WHERE rowid = ?');
    expect(prepare).toHaveBeenNthCalledWith(
      2,
      'INSERT INTO skills_fts(rowid, name, description, content) VALUES (?, ?, ?, ?)',
    );
    expect(run).not.toHaveBeenCalledWith(expect.objectContaining({ queryChunks: expect.anything() }));
    const insertBind = prepare.mock.results[1].value.bind;
    expect(insertBind).toHaveBeenCalledWith(2, 'Google Calendar', '', 'x'.repeat(2000));
  });
});

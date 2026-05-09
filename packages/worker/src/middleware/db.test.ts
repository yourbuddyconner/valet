import { describe, it, expect, vi } from 'vitest';

const { fakeDrizzle } = vi.hoisted(() => {
  const fakeDrizzle = { __drizzle: true };
  return { fakeDrizzle };
});
vi.mock('../lib/drizzle.js', () => ({
  getDb: vi.fn().mockReturnValue(fakeDrizzle),
}));

import { getDb } from '../lib/drizzle.js';
import { dbMiddleware } from './db.js';

describe('dbMiddleware', () => {
  it('creates a Drizzle instance from env.DB and sets it on context', async () => {
    const fakeD1 = { prepare: vi.fn() };
    const set = vi.fn();
    const next = vi.fn().mockResolvedValue(undefined);

    const fakeContext = {
      env: { DB: fakeD1 },
      set,
    } as any;

    await dbMiddleware(fakeContext, next);

    expect(getDb).toHaveBeenCalledWith(fakeD1);
    expect(set).toHaveBeenCalledWith('db', fakeDrizzle);
    expect(next).toHaveBeenCalledOnce();
  });
});

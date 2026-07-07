import { describe, expect, it } from 'vitest';
import type { User } from '@valet/shared';
import { applyAuthMeResponse } from './login-form-utils';

const user: User = {
  id: 'user-1',
  email: 'user@example.com',
  role: 'member',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('login form auth response helpers', () => {
  it('stores org model preferences returned by auth/me', () => {
    const calls: unknown[][] = [];

    applyAuthMeResponse({
      token: 'session-token',
      response: {
        user,
        orgModelPreferences: ['anthropic/claude-sonnet-4-5'],
      },
      setAuth: (...args) => {
        calls.push(args);
      },
    });

    expect(calls).toEqual([
      ['session-token', user, ['anthropic/claude-sonnet-4-5']],
    ]);
  });
});

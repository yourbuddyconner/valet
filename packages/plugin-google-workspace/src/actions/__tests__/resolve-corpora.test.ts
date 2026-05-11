import { describe, expect, it } from 'vitest';
import { resolveCorpora } from '../drive-actions.js';
import type { ActionContext } from '@valet/sdk/integrations';

function makeCtx(guardConfig?: Record<string, unknown>): ActionContext {
  return {
    credentials: { access_token: 'test' },
    userId: 'user-1',
    guardConfig,
  };
}

describe('resolveCorpora', () => {
  it('returns "user" when guardConfig is missing', () => {
    expect(resolveCorpora(makeCtx())).toBe('user');
  });

  it('returns "user" when driveCorpora key is missing', () => {
    expect(resolveCorpora(makeCtx({}))).toBe('user');
  });

  it('returns "user" when driveCorpora is not a string', () => {
    expect(resolveCorpora(makeCtx({ driveCorpora: 42 }))).toBe('user');
    expect(resolveCorpora(makeCtx({ driveCorpora: true }))).toBe('user');
    expect(resolveCorpora(makeCtx({ driveCorpora: null }))).toBe('user');
  });

  it('returns "user" for an invalid string value', () => {
    expect(resolveCorpora(makeCtx({ driveCorpora: 'everything' }))).toBe('user');
    expect(resolveCorpora(makeCtx({ driveCorpora: '' }))).toBe('user');
  });

  it('returns "user" when set to "user"', () => {
    expect(resolveCorpora(makeCtx({ driveCorpora: 'user' }))).toBe('user');
  });

  it('returns "domain" when set to "domain"', () => {
    expect(resolveCorpora(makeCtx({ driveCorpora: 'domain' }))).toBe('domain');
  });

  it('returns "allDrives" when set to "allDrives"', () => {
    expect(resolveCorpora(makeCtx({ driveCorpora: 'allDrives' }))).toBe('allDrives');
  });
});

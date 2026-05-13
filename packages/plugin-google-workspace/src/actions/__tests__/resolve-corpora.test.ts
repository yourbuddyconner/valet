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

  it('returns "drive" when set to "drive"', () => {
    expect(resolveCorpora(makeCtx({ driveCorpora: 'drive' }))).toBe('drive');
  });

  // Per-request override tests
  describe('per-request override', () => {
    it('override takes precedence over guardConfig', () => {
      expect(resolveCorpora(makeCtx({ driveCorpora: 'domain' }), 'user')).toBe('user');
      expect(resolveCorpora(makeCtx({ driveCorpora: 'user' }), 'domain')).toBe('domain');
      expect(resolveCorpora(makeCtx({ driveCorpora: 'user' }), 'allDrives')).toBe('allDrives');
      expect(resolveCorpora(makeCtx({ driveCorpora: 'user' }), 'drive')).toBe('drive');
    });

    it('falls back to guardConfig when override is undefined', () => {
      expect(resolveCorpora(makeCtx({ driveCorpora: 'domain' }), undefined)).toBe('domain');
    });

    it('falls back to guardConfig when override is invalid', () => {
      expect(resolveCorpora(makeCtx({ driveCorpora: 'domain' }), 'invalid')).toBe('domain');
      expect(resolveCorpora(makeCtx({ driveCorpora: 'domain' }), '')).toBe('domain');
    });

    it('falls back to "user" when both override and guardConfig are invalid', () => {
      expect(resolveCorpora(makeCtx({ driveCorpora: 'invalid' }), 'also-invalid')).toBe('user');
      expect(resolveCorpora(makeCtx(), 'invalid')).toBe('user');
    });

    it('override works when guardConfig is missing', () => {
      expect(resolveCorpora(makeCtx(), 'domain')).toBe('domain');
      expect(resolveCorpora(makeCtx(), 'drive')).toBe('drive');
      expect(resolveCorpora(makeCtx(), 'allDrives')).toBe('allDrives');
    });
  });
});

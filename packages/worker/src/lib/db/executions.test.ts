import { describe, it, expect } from 'vitest';
import { isUniqueConstraintError } from './executions.js';

describe('isUniqueConstraintError', () => {
  it('detects standard SQLite UNIQUE constraint message', () => {
    const err = new Error('D1_ERROR: UNIQUE constraint failed: workflow_executions.idempotency_key');
    expect(isUniqueConstraintError(err)).toBe(true);
  });

  it('detects the SQLITE_CONSTRAINT_UNIQUE variant', () => {
    const err = new Error('SQLITE_CONSTRAINT_UNIQUE: column idempotency_key is not unique');
    expect(isUniqueConstraintError(err)).toBe(true);
  });

  it('detects on plain object with message', () => {
    // D1 sometimes throws object-shaped errors rather than Error instances; sniff
    // the message field directly so both shapes are handled.
    expect(isUniqueConstraintError({ message: 'UNIQUE constraint failed: triggers.id' })).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isUniqueConstraintError(new Error('connection refused'))).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
    expect(isUniqueConstraintError(undefined)).toBe(false);
    expect(isUniqueConstraintError('string error')).toBe(false);
    expect(isUniqueConstraintError({})).toBe(false);
    expect(isUniqueConstraintError({ message: 42 })).toBe(false);
  });
});

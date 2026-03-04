import { describe, it, expect } from 'vitest';
import {
  ValetError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
  RateLimitError,
  IntegrationError,
  ErrorCodes,
} from './errors.js';

describe('ErrorCodes', () => {
  it('has expected constants', () => {
    expect(ErrorCodes.NOT_FOUND).toBe('NOT_FOUND');
    expect(ErrorCodes.UNAUTHORIZED).toBe('UNAUTHORIZED');
    expect(ErrorCodes.FORBIDDEN).toBe('FORBIDDEN');
    expect(ErrorCodes.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
    expect(ErrorCodes.RATE_LIMIT_EXCEEDED).toBe('RATE_LIMIT_EXCEEDED');
    expect(ErrorCodes.INTEGRATION_AUTH_FAILED).toBe('INTEGRATION_AUTH_FAILED');
    expect(ErrorCodes.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
  });
});

describe('ValetError', () => {
  it('constructs with message, code, statusCode, details', () => {
    const err = new ValetError('something broke', ErrorCodes.INTERNAL_ERROR, 500, { foo: 1 });
    expect(err.message).toBe('something broke');
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(err.statusCode).toBe(500);
    expect(err.details).toEqual({ foo: 1 });
    expect(err.name).toBe('ValetError');
  });

  it('defaults statusCode to 500', () => {
    const err = new ValetError('err', ErrorCodes.INTERNAL_ERROR);
    expect(err.statusCode).toBe(500);
  });

  it('toJSON returns error, code, details', () => {
    const err = new ValetError('msg', ErrorCodes.INTERNAL_ERROR, 500, { x: 1 });
    expect(err.toJSON()).toEqual({
      error: 'msg',
      code: 'INTERNAL_ERROR',
      details: { x: 1 },
    });
  });

  it('is instanceof Error', () => {
    const err = new ValetError('msg', ErrorCodes.INTERNAL_ERROR);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ValetError);
  });
});

describe('NotFoundError', () => {
  it('sets 404 status and NOT_FOUND code', () => {
    const err = new NotFoundError('Session');
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('Session not found');
  });

  it('includes id in message when provided', () => {
    const err = new NotFoundError('Session', 'abc-123');
    expect(err.message).toBe("Session with id 'abc-123' not found");
  });

  it('instanceof chain: NotFoundError → ValetError → Error', () => {
    const err = new NotFoundError('X');
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toBeInstanceOf(ValetError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('UnauthorizedError', () => {
  it('sets 401 status and UNAUTHORIZED code', () => {
    const err = new UnauthorizedError();
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.message).toBe('Unauthorized');
  });

  it('accepts custom message', () => {
    const err = new UnauthorizedError('Token expired');
    expect(err.message).toBe('Token expired');
  });

  it('instanceof chain', () => {
    const err = new UnauthorizedError();
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err).toBeInstanceOf(ValetError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('ForbiddenError', () => {
  it('sets 403 status and FORBIDDEN code', () => {
    const err = new ForbiddenError();
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
    expect(err.message).toBe('Forbidden');
  });

  it('accepts custom message', () => {
    const err = new ForbiddenError('Admin only');
    expect(err.message).toBe('Admin only');
  });
});

describe('ValidationError', () => {
  it('sets 400 status and VALIDATION_ERROR code', () => {
    const err = new ValidationError('Invalid input');
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('Invalid input');
  });

  it('includes details', () => {
    const details = { field: 'email', issue: 'required' };
    const err = new ValidationError('Validation failed', details);
    expect(err.details).toEqual(details);
    expect(err.toJSON().details).toEqual(details);
  });
});

describe('RateLimitError', () => {
  it('sets 429 status and RATE_LIMIT_EXCEEDED code', () => {
    const err = new RateLimitError();
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(err.message).toBe('Rate limit exceeded');
  });

  it('includes retryAfter in details', () => {
    const err = new RateLimitError(30);
    expect(err.details).toEqual({ retryAfter: 30 });
  });
});

describe('IntegrationError', () => {
  it('sets 400 status with default INTEGRATION_AUTH_FAILED code', () => {
    const err = new IntegrationError('GitHub auth failed');
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('INTEGRATION_AUTH_FAILED');
    expect(err.message).toBe('GitHub auth failed');
  });

  it('accepts custom code', () => {
    const err = new IntegrationError('Sync failed', ErrorCodes.SYNC_FAILED);
    expect(err.code).toBe('SYNC_FAILED');
  });

  it('accepts details', () => {
    const err = new IntegrationError('Error', ErrorCodes.INTEGRATION_AUTH_FAILED, { provider: 'slack' });
    expect(err.details).toEqual({ provider: 'slack' });
  });
});

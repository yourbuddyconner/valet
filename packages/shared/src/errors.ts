export const ErrorCodes = {
  // Session errors
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_TERMINATED: 'SESSION_TERMINATED',
  SESSION_INIT_FAILED: 'SESSION_INIT_FAILED',

  // Integration errors
  INTEGRATION_NOT_FOUND: 'INTEGRATION_NOT_FOUND',
  INTEGRATION_AUTH_FAILED: 'INTEGRATION_AUTH_FAILED',
  INTEGRATION_ALREADY_EXISTS: 'INTEGRATION_ALREADY_EXISTS',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  SYNC_FAILED: 'SYNC_FAILED',
  SYNC_IN_PROGRESS: 'SYNC_IN_PROGRESS',

  // Auth errors
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',

  // Rate limiting
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',

  // Validation errors
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_REQUEST: 'INVALID_REQUEST',

  // Container errors
  CONTAINER_START_FAILED: 'CONTAINER_START_FAILED',
  CONTAINER_NOT_FOUND: 'CONTAINER_NOT_FOUND',
  CONTAINER_TIMEOUT: 'CONTAINER_TIMEOUT',

  // Storage errors
  STORAGE_ERROR: 'STORAGE_ERROR',
  ENCRYPTION_ERROR: 'ENCRYPTION_ERROR',

  // General
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class ValetError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly statusCode: number = 500,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ValetError';
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      details: this.details,
    };
  }
}

export class NotFoundError extends ValetError {
  constructor(resource: string, id?: string) {
    super(
      id ? `${resource} with id '${id}' not found` : `${resource} not found`,
      ErrorCodes.NOT_FOUND,
      404
    );
  }
}

export class UnauthorizedError extends ValetError {
  constructor(message = 'Unauthorized') {
    super(message, ErrorCodes.UNAUTHORIZED, 401);
  }
}

export class ForbiddenError extends ValetError {
  constructor(message = 'Forbidden') {
    super(message, ErrorCodes.FORBIDDEN, 403);
  }
}

export class ValidationError extends ValetError {
  constructor(message: string, details?: unknown) {
    super(message, ErrorCodes.VALIDATION_ERROR, 400, details);
  }
}

export class RateLimitError extends ValetError {
  constructor(retryAfter?: number) {
    super('Rate limit exceeded', ErrorCodes.RATE_LIMIT_EXCEEDED, 429, { retryAfter });
  }
}

export class IntegrationError extends ValetError {
  constructor(message: string, code: ErrorCode = ErrorCodes.INTEGRATION_AUTH_FAILED, details?: unknown) {
    super(message, code, 400, details);
  }
}

import { describe, expect, it } from 'vitest';
import { resolveAuthRedirectOrigin } from './auth-redirect-origin.js';
import type { Env } from '../env.js';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    FRONTEND_URL: 'https://dev-valet-client.pages.dev',
    FRONTEND_PREVIEW_ORIGIN_SUFFIX: 'dev-valet-client.pages.dev',
    ENCRYPTION_KEY: 'test-key',
    DB: {} as Env['DB'],
    STORAGE: {} as Env['STORAGE'],
    SESSIONS: {} as Env['SESSIONS'],
    EVENT_BUS: {} as Env['EVENT_BUS'],
    WORKFLOW_INTERPRETER: {} as Env['WORKFLOW_INTERPRETER'],
    GOOGLE_CLIENT_ID: 'google-client-id',
    GOOGLE_CLIENT_SECRET: 'google-client-secret',
    MODAL_BACKEND_URL: 'https://modal.example.com/{label}',
    ...overrides,
  };
}

describe('resolveAuthRedirectOrigin', () => {
  it('allows the configured frontend origin', () => {
    expect(resolveAuthRedirectOrigin(buildEnv(), 'https://dev-valet-client.pages.dev/login')).toBe(
      'https://dev-valet-client.pages.dev',
    );
  });

  it('allows Cloudflare Pages preview subdomains for the configured project suffix', () => {
    expect(resolveAuthRedirectOrigin(buildEnv(), 'https://pr-123.dev-valet-client.pages.dev')).toBe(
      'https://pr-123.dev-valet-client.pages.dev',
    );
  });

  it('rejects unrelated origins', () => {
    expect(resolveAuthRedirectOrigin(buildEnv(), 'https://evil.example.com')).toBeUndefined();
  });
});

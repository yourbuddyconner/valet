import { describe, expect, it } from 'vitest';
import { buildAuthRedirectUrl } from './auth-redirect';

describe('buildAuthRedirectUrl', () => {
  it('includes the current origin for preview-aware OAuth redirects', () => {
    expect(
      buildAuthRedirectUrl({
        workerUrl: 'https://dev-worker.example.com',
        providerId: 'github',
        origin: 'https://pr-123.dev-valet-client.pages.dev',
      }),
    ).toBe(
      'https://dev-worker.example.com/auth/github?return_to_origin=https%3A%2F%2Fpr-123.dev-valet-client.pages.dev',
    );
  });

  it('preserves invite codes alongside the current origin', () => {
    expect(
      buildAuthRedirectUrl({
        workerUrl: 'https://dev-worker.example.com/',
        providerId: 'google',
        inviteCode: 'abc 123',
        origin: 'https://pr-123.dev-valet-client.pages.dev',
      }),
    ).toBe(
      'https://dev-worker.example.com/auth/google?invite_code=abc+123&return_to_origin=https%3A%2F%2Fpr-123.dev-valet-client.pages.dev',
    );
  });
});

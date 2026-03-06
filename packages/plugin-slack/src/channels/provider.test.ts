import { describe, it, expect } from 'vitest';
import { slackProvider } from './provider.js';

describe('slackProvider', () => {
  it('has correct service name', () => {
    expect(slackProvider.service).toBe('slack');
  });

  it('has correct display name', () => {
    expect(slackProvider.displayName).toBe('Slack');
  });

  it('uses oauth2 auth type', () => {
    expect(slackProvider.authType).toBe('oauth2');
  });
});

import { describe, expect, it } from 'vitest';
import { buildDoWebSocketUrl } from './do-ws-url.js';

describe('buildDoWebSocketUrl', () => {
  it('uses the configured public API URL for synthetic workflow request URLs', () => {
    const url = buildDoWebSocketUrl({
      env: { API_PUBLIC_URL: 'https://api.example.com' },
      sessionId: 'session-1',
      requestUrl: 'workflow://exec/execution-1',
    });

    expect(url).toBe('wss://api.example.com/api/sessions/session-1/ws');
  });

  it('allows local request origins for development', () => {
    const url = buildDoWebSocketUrl({
      env: {},
      sessionId: 'session-1',
      requestUrl: 'http://localhost:8787/api/sessions',
    });

    expect(url).toBe('ws://localhost:8787/api/sessions/session-1/ws');
  });

  it('does not trust non-local request origins when API_PUBLIC_URL is missing', () => {
    expect(() => buildDoWebSocketUrl({
      env: {},
      sessionId: 'session-1',
      requestUrl: 'https://attacker.example.com/api/sessions',
      requestHost: 'attacker.example.com',
    })).toThrow('API_PUBLIC_URL is required');
  });
});

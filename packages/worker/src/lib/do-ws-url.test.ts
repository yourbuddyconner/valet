import { describe, expect, it } from 'vitest';
import { buildDoWebSocketUrl } from './do-ws-url.js';

describe('buildDoWebSocketUrl', () => {
  it('ignores synthetic workflow request URLs when deriving runner websocket origins', () => {
    const url = buildDoWebSocketUrl({
      env: { FRONTEND_URL: 'https://app.example.com' },
      sessionId: 'session-1',
      requestUrl: 'workflow://exec/execution-1',
    });

    expect(url).toBe('wss://api.example.com/api/sessions/session-1/ws');
  });
});

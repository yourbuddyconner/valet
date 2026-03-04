import { describe, expect, it } from 'vitest';
import { extractBearerToken } from '../lib/ws-auth';

describe('extractBearerToken', () => {
  it('reads Authorization bearer token', () => {
    const req = new Request('https://example.com/api/sessions/1/ws?role=client', {
      headers: { Authorization: 'Bearer secret-token' },
    });
    expect(extractBearerToken(req)).toBe('secret-token');
  });

  it('reads websocket token from Sec-WebSocket-Protocol', () => {
    const req = new Request('https://example.com/api/sessions/1/ws?role=client', {
      headers: { 'Sec-WebSocket-Protocol': 'valet, bearer.ws-token-123' },
    });
    expect(extractBearerToken(req)).toBe('ws-token-123');
  });

  it('ignores token in query params', () => {
    const req = new Request('https://example.com/api/sessions/1/ws?role=client&token=legacy-token');
    expect(extractBearerToken(req)).toBeNull();
  });
});

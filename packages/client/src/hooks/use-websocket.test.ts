import { describe, expect, it, vi } from 'vitest';
import { sendWebSocketMessage } from './use-websocket';

describe('sendWebSocketMessage', () => {
  it('reports false when no open socket is available', () => {
    const send = vi.fn();

    expect(sendWebSocketMessage(null, { type: 'ping' })).toBe(false);
    expect(sendWebSocketMessage({ readyState: 3, send }, { type: 'ping' })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('reports true after sending on an open socket', () => {
    const send = vi.fn();

    expect(sendWebSocketMessage({ readyState: 1, send }, { type: 'ping' })).toBe(true);
    expect(send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping' }));
  });

  it('reports false when an open socket fails to send', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi.fn(() => {
      throw new Error('closed');
    });

    expect(sendWebSocketMessage({ readyState: 1, send }, { type: 'ping' })).toBe(false);
    expect(consoleError).toHaveBeenCalledWith('[ws] send failed:', expect.any(Error));

    consoleError.mockRestore();
  });
});

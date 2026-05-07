import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RunnerLink, type RunnerLinkDeps, type RunnerToDOMessage, type DOToRunnerMessage, type RunnerMessageHandlers } from './runner-link.js';

// ─── Mock Helpers ─────────────────────────────────────────────────────────────

function createMockDeps(overrides?: Partial<RunnerLinkDeps>): RunnerLinkDeps & {
  state: Map<string, string>;
  sockets: Array<{ send: ReturnType<typeof vi.fn>; closed: boolean }>;
  addSocket: () => void;
} {
  const state = new Map<string, string>();
  const sockets: Array<{ send: ReturnType<typeof vi.fn>; closed: boolean }> = [];

  return {
    state,
    sockets,
    addSocket() {
      sockets.push({ send: vi.fn(), closed: false });
    },
    getRunnerSockets: overrides?.getRunnerSockets ?? (() => sockets as unknown as WebSocket[]),
    getState: overrides?.getState ?? ((key: string) => state.get(key)),
    setState: overrides?.setState ?? ((key: string, value: string) => { state.set(key, value); }),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RunnerLink', () => {
  let deps: ReturnType<typeof createMockDeps>;
  let link: RunnerLink;

  beforeEach(() => {
    deps = createMockDeps();
    link = new RunnerLink(deps);
  });

  // ─── Connection State ─────────────────────────────────────────────

  describe('isConnected', () => {
    it('returns false when no sockets', () => {
      expect(link.isConnected).toBe(false);
    });

    it('returns true when socket exists', () => {
      deps.addSocket();
      expect(link.isConnected).toBe(true);
    });
  });

  describe('isReady', () => {
    it('returns false when no sockets even if state is not false', () => {
      // No sockets, state not explicitly set
      expect(link.isReady).toBe(false);
    });

    it('returns false when state is false', () => {
      deps.addSocket();
      deps.state.set('runnerReady', 'false');
      expect(link.isReady).toBe(false);
    });

    it('returns true when connected and state is true', () => {
      deps.addSocket();
      deps.state.set('runnerReady', 'true');
      expect(link.isReady).toBe(true);
    });

    it('returns true when connected and state is not explicitly false', () => {
      deps.addSocket();
      // State not set at all — defaults to ready (matches DO behavior)
      expect(link.isReady).toBe(true);
    });
  });

  describe('ready setter', () => {
    it('sets runnerReady state', () => {
      link.ready = false;
      expect(deps.state.get('runnerReady')).toBe('false');

      link.ready = true;
      expect(deps.state.get('runnerReady')).toBe('true');
    });
  });

  describe('token', () => {
    it('returns undefined when not set', () => {
      expect(link.token).toBeUndefined();
    });

    it('reads from state', () => {
      deps.state.set('runnerToken', 'abc123');
      expect(link.token).toBe('abc123');
    });

    it('writes to state', () => {
      link.token = 'xyz789';
      expect(deps.state.get('runnerToken')).toBe('xyz789');
    });
  });

  // ─── Send ─────────────────────────────────────────────────────────

  describe('send', () => {
    it('returns false when no sockets connected', () => {
      const result = link.send({ type: 'pong' });
      expect(result).toBe(false);
    });

    it('sends JSON to all runner sockets', () => {
      deps.addSocket();
      deps.addSocket();
      const msg: DOToRunnerMessage = { type: 'pong' };

      const result = link.send(msg);

      expect(result).toBe(true);
      const expected = JSON.stringify(msg);
      expect(deps.sockets[0].send).toHaveBeenCalledWith(expected);
      expect(deps.sockets[1].send).toHaveBeenCalledWith(expected);
    });

    it('returns true even if some sockets fail', () => {
      deps.addSocket();
      deps.addSocket();
      deps.sockets[0].send.mockImplementation(() => { throw new Error('disconnected'); });

      const result = link.send({ type: 'pong' });

      expect(result).toBe(true); // second socket succeeded
    });

    it('returns false if all sockets fail', () => {
      deps.addSocket();
      deps.sockets[0].send.mockImplementation(() => { throw new Error('disconnected'); });

      const result = link.send({ type: 'pong' });

      expect(result).toBe(false);
    });

    it('logs prompt messages with messageId', () => {
      deps.addSocket();
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

      link.send({ type: 'prompt', messageId: 'msg-1', content: 'hello' });

      expect(spy).toHaveBeenCalledWith(expect.stringContaining('messageId=msg-1'));
      spy.mockRestore();
    });
  });

  // ─── Message Dispatch ─────────────────────────────────────────────

  describe('handleMessage', () => {
    it('dispatches to the correct handler', async () => {
      const handler = vi.fn();
      const handlers: RunnerMessageHandlers = {
        'complete': handler,
      };

      const msg: RunnerToDOMessage = { type: 'complete' };
      await link.handleMessage(msg, handlers);

      expect(handler).toHaveBeenCalledWith(msg);
    });

    it('awaits async handlers', async () => {
      const order: string[] = [];
      const handlers: RunnerMessageHandlers = {
        'complete': async () => {
          await new Promise((r) => setTimeout(r, 10));
          order.push('handler-done');
        },
      };

      await link.handleMessage({ type: 'complete' }, handlers);
      order.push('after-dispatch');

      expect(order).toEqual(['handler-done', 'after-dispatch']);
    });

    it('propagates handler errors', async () => {
      const handlers: RunnerMessageHandlers = {
        'error': () => { throw new Error('handler boom'); },
      };

      await expect(
        link.handleMessage({ type: 'error', messageId: '', error: '' } as RunnerToDOMessage, handlers),
      ).rejects.toThrow('handler boom');
    });

    it('logs warning for unhandled types', async () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await link.handleMessage({ type: 'ping' }, {});

      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Unhandled runner message type: ping'));
      spy.mockRestore();
    });

    it('calls onActivity for activity types', async () => {
      const onActivity = vi.fn();
      const handler = vi.fn();
      const handlers: RunnerMessageHandlers = {
        'agentStatus': handler,
        'message.create': handler,
        'message.part.text-delta': handler,
        'message.part.tool-update': handler,
        'message.finalize': handler,
      };

      const activityMessages: RunnerToDOMessage[] = [
        { type: 'agentStatus', status: 'idle' },
        { type: 'message.create', turnId: 't1' },
        { type: 'message.part.text-delta', turnId: 't1', delta: '' },
        { type: 'message.part.tool-update', turnId: 't1', callId: 'c1', toolName: 'test', status: 'running' },
        { type: 'message.finalize', turnId: 't1', reason: 'end_turn' },
      ];

      for (const msg of activityMessages) {
        onActivity.mockClear();
        await link.handleMessage(msg, handlers, onActivity);
        expect(onActivity).toHaveBeenCalledTimes(1);
      }
    });

    it('does not call onActivity for non-activity types', async () => {
      const onActivity = vi.fn();
      const handler = vi.fn();
      const handlers: RunnerMessageHandlers = {
        'complete': handler,
        'error': handler,
        'ping': handler,
        'models': handler,
      };

      const nonActivityMessages: RunnerToDOMessage[] = [
        { type: 'complete' },
        { type: 'error', messageId: '', error: '' },
        { type: 'ping' },
        { type: 'models', models: [] },
      ];

      for (const msg of nonActivityMessages) {
        onActivity.mockClear();
        await link.handleMessage(msg, handlers, onActivity);
        expect(onActivity).not.toHaveBeenCalled();
      }
    });

    it('does not error when onActivity is not provided', async () => {
      const handler = vi.fn();
      const handlers: RunnerMessageHandlers = { 'agentStatus': handler };

      // Should not throw
      await link.handleMessage({ type: 'agentStatus', status: 'idle' }, handlers);

      expect(handler).toHaveBeenCalled();
    });
  });

  // ─── Connection Lifecycle ─────────────────────────────────────────

  describe('connectedAt', () => {
    it('is null by default', () => {
      expect(link.connectedAt).toBeNull();
    });

    it('stores and retrieves a timestamp', () => {
      link.connectedAt = Date.now();
      expect(link.connectedAt).toBeGreaterThan(0);
    });

    it('clears when set to null', () => {
      link.connectedAt = Date.now();
      link.connectedAt = null;
      expect(link.connectedAt).toBeNull();
    });
  });

  describe('onConnect', () => {
    it('sets ready to false', () => {
      deps.state.set('runnerReady', 'true');
      link.onConnect();
      expect(deps.state.get('runnerReady')).toBe('false');
    });
  });

  describe('onDisconnect', () => {
    it('sets ready to false', () => {
      deps.state.set('runnerReady', 'true');
      link.onDisconnect();
      expect(deps.state.get('runnerReady')).toBe('false');
    });
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionState, type SessionStartParams, type TunnelEntry } from './session-state.js';

// ─── Mock SqlStorage ──────────────────────────────────────────────────────────

function createMockSql() {
  const state = new Map<string, string>();

  return {
    state,
    exec(query: string, ...params: unknown[]) {
      if (query.includes('SELECT value FROM state')) {
        const key = params[0] as string;
        const val = state.get(key);
        return {
          toArray: () => val !== undefined ? [{ value: val }] : [],
        };
      }
      if (query.includes('INSERT OR REPLACE INTO state')) {
        const key = params[0] as string;
        const value = params[1] as string;
        state.set(key, value);
        return { toArray: () => [] };
      }
      return { toArray: () => [] };
    },
  } as unknown as SqlStorage;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SessionState', () => {
  let sql: ReturnType<typeof createMockSql>;
  let ss: SessionState;

  beforeEach(() => {
    sql = createMockSql();
    ss = new SessionState(sql as unknown as SqlStorage);
  });

  // ─── Raw Access ───────────────────────────────────────────────────

  describe('get/set', () => {
    it('returns undefined for missing keys', () => {
      expect(ss.get('nonexistent')).toBeUndefined();
    });

    it('round-trips values', () => {
      ss.set('foo', 'bar');
      expect(ss.get('foo')).toBe('bar');
    });
  });

  // ─── Identity ─────────────────────────────────────────────────────

  describe('identity', () => {
    it('returns empty string for unset sessionId/userId/workspace', () => {
      expect(ss.sessionId).toBe('');
      expect(ss.userId).toBe('');
      expect(ss.workspace).toBe('');
    });

    it('reads sessionId from state', () => {
      ss.set('sessionId', 'sess-1');
      expect(ss.sessionId).toBe('sess-1');
    });

    it('reads/writes title', () => {
      expect(ss.title).toBeUndefined();
      ss.title = 'My Session';
      expect(ss.title).toBe('My Session');
    });

    it('reads isOrchestrator', () => {
      expect(ss.isOrchestrator).toBe(false);
      ss.set('isOrchestrator', 'true');
      expect(ss.isOrchestrator).toBe(true);
    });
  });

  // ─── Lifecycle ────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('defaults status to initializing', () => {
      expect(ss.status).toBe('initializing');
    });

    it('reads/writes status', () => {
      ss.status = 'running';
      expect(ss.status).toBe('running');
      ss.status = 'hibernated';
      expect(ss.status).toBe('hibernated');
    });

    it('reads/writes sandboxId', () => {
      expect(ss.sandboxId).toBeUndefined();
      ss.sandboxId = 'sb-123';
      expect(ss.sandboxId).toBe('sb-123');
      ss.sandboxId = undefined;
      expect(ss.sandboxId).toBeUndefined();
    });

    it('reads/writes snapshotImageId', () => {
      expect(ss.snapshotImageId).toBeUndefined();
      ss.snapshotImageId = 'img-456';
      expect(ss.snapshotImageId).toBe('img-456');
    });
  });

  // ─── Backend URLs ─────────────────────────────────────────────────

  describe('backend URLs', () => {
    it('returns undefined for unset URLs', () => {
      expect(ss.backendUrl).toBeUndefined();
      expect(ss.terminateUrl).toBeUndefined();
      expect(ss.hibernateUrl).toBeUndefined();
      expect(ss.restoreUrl).toBeUndefined();
    });

    it('reads set URLs', () => {
      ss.set('backendUrl', 'https://backend.example.com');
      expect(ss.backendUrl).toBe('https://backend.example.com');
    });
  });

  // ─── Spawn & Child Sessions ───────────────────────────────────────

  describe('spawnRequest', () => {
    it('returns undefined when not set', () => {
      expect(ss.spawnRequest).toBeUndefined();
    });

    it('round-trips JSON objects', () => {
      const req = { doWsUrl: 'ws://example.com', envVars: { FOO: 'bar' } };
      ss.spawnRequest = req;
      expect(ss.spawnRequest).toEqual(req);
    });

    it('handles invalid JSON gracefully', () => {
      ss.set('spawnRequest', 'not-json');
      expect(ss.spawnRequest).toBeUndefined();
    });

    it('clears on undefined', () => {
      ss.spawnRequest = { a: 1 };
      ss.spawnRequest = undefined;
      expect(ss.spawnRequest).toBeUndefined();
    });
  });

  describe('parentThreadId', () => {
    it('reads/writes', () => {
      expect(ss.parentThreadId).toBeUndefined();
      ss.parentThreadId = 'thread-1';
      expect(ss.parentThreadId).toBe('thread-1');
      ss.parentThreadId = undefined;
      expect(ss.parentThreadId).toBeUndefined();
    });
  });

  // ─── Timing ───────────────────────────────────────────────────────

  describe('timing', () => {
    it('defaults idleTimeoutMs to 900000', () => {
      expect(ss.idleTimeoutMs).toBe(900_000);
    });

    it('reads/writes idleTimeoutMs', () => {
      ss.idleTimeoutMs = 60_000;
      expect(ss.idleTimeoutMs).toBe(60_000);
    });

    it('defaults lastUserActivityAt to 0', () => {
      expect(ss.lastUserActivityAt).toBe(0);
    });

    it('reads/writes lastUserActivityAt', () => {
      ss.lastUserActivityAt = 1234567890;
      expect(ss.lastUserActivityAt).toBe(1234567890);
    });

    it('reads/writes runningStartedAt', () => {
      expect(ss.runningStartedAt).toBe(0);
      ss.runningStartedAt = 9999;
      expect(ss.runningStartedAt).toBe(9999);
    });

    it('reads/writes sandboxWakeStartedAt', () => {
      expect(ss.sandboxWakeStartedAt).toBe(0);
      ss.sandboxWakeStartedAt = 5555;
      expect(ss.sandboxWakeStartedAt).toBe(5555);
      ss.sandboxWakeStartedAt = 0;
      expect(ss.sandboxWakeStartedAt).toBe(0);
    });
  });

  // ─── Tunnels ──────────────────────────────────────────────────────

  describe('tunnels', () => {
    it('defaults tunnelUrls to null', () => {
      expect(ss.tunnelUrls).toBeNull();
    });

    it('round-trips tunnelUrls', () => {
      ss.tunnelUrls = { opencode: 'https://a.com', gateway: 'https://b.com' };
      expect(ss.tunnelUrls).toEqual({ opencode: 'https://a.com', gateway: 'https://b.com' });
    });

    it('handles invalid JSON tunnelUrls', () => {
      ss.set('tunnelUrls', 'bad');
      expect(ss.tunnelUrls).toBeNull();
    });

    it('clears tunnelUrls to null', () => {
      ss.tunnelUrls = { opencode: 'https://a.com' };
      ss.tunnelUrls = null;
      expect(ss.tunnelUrls).toBeNull();
    });

    it('defaults tunnels to empty array', () => {
      expect(ss.tunnels).toEqual([]);
    });

    it('round-trips tunnel entries', () => {
      const entries: TunnelEntry[] = [
        { name: 'web', port: 8080, path: '/', url: 'https://tunnel.example.com' },
      ];
      ss.tunnels = entries;
      expect(ss.tunnels).toEqual(entries);
    });
  });

  // ─── Models ───────────────────────────────────────────────────────

  describe('availableModels', () => {
    it('returns undefined when not set', () => {
      expect(ss.availableModels).toBeUndefined();
    });

    it('round-trips model data', () => {
      const models = [{ provider: 'anthropic', models: [{ id: 'claude-3', name: 'Claude 3' }] }];
      ss.availableModels = models;
      expect(ss.availableModels).toEqual(models);
    });

    it('clears on undefined', () => {
      ss.availableModels = [{ provider: 'x', models: [] }];
      ss.availableModels = undefined;
      expect(ss.availableModels).toBeUndefined();
    });
  });

  // ─── Initial Prompt/Model ─────────────────────────────────────────

  describe('initialPrompt / initialModel', () => {
    it('reads/writes initialPrompt', () => {
      expect(ss.initialPrompt).toBeUndefined();
      ss.initialPrompt = 'Fix the bug';
      expect(ss.initialPrompt).toBe('Fix the bug');
      ss.initialPrompt = undefined;
      expect(ss.initialPrompt).toBeUndefined();
    });

    it('reads/writes initialModel', () => {
      expect(ss.initialModel).toBeUndefined();
      ss.initialModel = 'claude-opus-4-6';
      expect(ss.initialModel).toBe('claude-opus-4-6');
    });
  });

  // ─── Channel Follow-up ───────────────────────────────────────────

  describe('channelFollowupIntervalMs', () => {
    it('defaults to 300000', () => {
      expect(ss.channelFollowupIntervalMs).toBe(300_000);
    });

    it('reads/writes', () => {
      ss.channelFollowupIntervalMs = 120_000;
      expect(ss.channelFollowupIntervalMs).toBe(120_000);
    });
  });

  // ─── Parent Idle Notification ─────────────────────────────────────

  describe('parent idle notification', () => {
    it('reads/writes lastParentIdleNotice', () => {
      expect(ss.lastParentIdleNotice).toBeUndefined();
      ss.lastParentIdleNotice = 'notice-1';
      expect(ss.lastParentIdleNotice).toBe('notice-1');
      ss.lastParentIdleNotice = undefined;
      expect(ss.lastParentIdleNotice).toBeUndefined();
    });

    it('reads/writes parentIdleNotifyAt', () => {
      expect(ss.parentIdleNotifyAt).toBe(0);
      ss.parentIdleNotifyAt = 12345;
      expect(ss.parentIdleNotifyAt).toBe(12345);
      ss.parentIdleNotifyAt = 0;
      expect(ss.parentIdleNotifyAt).toBe(0);
    });
  });

  // ─── Bulk Initialization ──────────────────────────────────────────

  describe('initialize', () => {
    it('sets required fields', () => {
      ss.initialize({
        sessionId: 'sess-1',
        userId: 'user-1',
        workspace: '/workspace',
      });

      expect(ss.sessionId).toBe('sess-1');
      expect(ss.userId).toBe('user-1');
      expect(ss.workspace).toBe('/workspace');
      expect(ss.status).toBe('initializing');
    });

    it('sets optional fields when provided', () => {
      ss.initialize({
        sessionId: 'sess-2',
        userId: 'user-2',
        workspace: '/ws',
        backendUrl: 'https://backend.com',
        idleTimeoutMs: 60_000,
        initialPrompt: 'Hello',
        parentThreadId: 'thread-1',
      });

      expect(ss.backendUrl).toBe('https://backend.com');
      expect(ss.idleTimeoutMs).toBe(60_000);
      expect(ss.initialPrompt).toBe('Hello');
      expect(ss.parentThreadId).toBe('thread-1');
    });

    it('does not set optional fields when omitted', () => {
      ss.initialize({
        sessionId: 'sess-3',
        userId: 'user-3',
        workspace: '/ws',
      });

      expect(ss.backendUrl).toBeUndefined();
      expect(ss.initialPrompt).toBeUndefined();
      expect(ss.parentThreadId).toBeUndefined();
    });
  });
});

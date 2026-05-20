import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveActionPolicy } from './session-tools.js';
import { createTestDb } from '../test-utils/db.js';
import { upsertActionPolicy } from '../lib/db/actions.js';
import { upsertMcpToolCache } from '../lib/db/mcp-tool-cache.js';
import { integrations, sessions, users } from '../lib/schema/index.js';
import { integrationRegistry } from '../integrations/registry.js';
import type { Env } from '../env.js';

const USER_ID = 'mcp-policy-user';
const SESSION_ID = 'mcp-policy-session';

function mockD1(): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        all: vi.fn(async () => ({ results: [] })),
      })),
    })),
  } as unknown as D1Database;
}

function emptyCredentialCache() {
  return {
    get: vi.fn(() => null),
    set: vi.fn(),
    invalidate: vi.fn(),
  };
}

describe('resolveActionPolicy', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('uses cached MCP risk metadata when runtime listActions misses the tool', async () => {
    const { db } = createTestDb();
    db.insert(users).values({ id: USER_ID, email: 'mcp-policy@example.com' }).run();
    db.insert(sessions).values({
      id: SESSION_ID,
      userId: USER_ID,
      workspace: '/tmp/mcp-policy',
      status: 'running',
    }).run();
    db.insert(integrations).values({
      id: 'integration-mcp',
      userId: USER_ID,
      service: 'mcp_service',
      config: { entities: [] },
      status: 'active',
    }).run();
    await upsertActionPolicy(db as any, {
      id: 'deny-critical',
      riskLevel: 'critical',
      mode: 'deny',
      createdBy: USER_ID,
    });
    await upsertMcpToolCache(db as any, [{
      service: 'mcp_service',
      actionId: 'dangerous_tool',
      name: 'Dangerous Tool',
      description: 'Known critical MCP tool',
      riskLevel: 'critical',
    }]);
    vi.spyOn(integrationRegistry, 'getActions').mockReturnValue({
      listActions: vi.fn(async () => []),
      execute: vi.fn(),
    } as any);
    vi.spyOn(integrationRegistry, 'getProvider').mockReturnValue({ authType: 'none' } as any);

    const result = await resolveActionPolicy(
      db as any,
      mockD1(),
      {} as Env,
      USER_ID,
      'mcp_service:dangerous_tool',
      {},
      {
        sessionId: SESSION_ID,
        discoveredToolRiskLevels: new Map(),
        credentialCache: emptyCredentialCache(),
        disabledPluginServicesCache: null,
      },
    );

    expect(result).toMatchObject({
      outcome: 'denied',
      riskLevel: 'critical',
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { D1Database, DurableObjectId, DurableObjectNamespace, DurableObjectStub } from '@cloudflare/workers-types';
import type { Env, Variables } from '../env.js';
import { errorHandler } from '../middleware/error-handler.js';

const {
  assertSessionAccessMock,
  getCurrentOrchestratorSessionMock,
  getSessionMock,
} = vi.hoisted(() => ({
  assertSessionAccessMock: vi.fn(),
  getCurrentOrchestratorSessionMock: vi.fn(),
  getSessionMock: vi.fn(),
}));

vi.mock('../lib/db.js', () => ({
  assertSessionAccess: assertSessionAccessMock,
  getCurrentOrchestratorSession: getCurrentOrchestratorSessionMock,
  getSession: getSessionMock,
}));

import { filesRouter } from './files.js';

function createDurableObjectId(name: string): DurableObjectId {
  return {
    name,
    toString: () => name,
    equals: (other: DurableObjectId) => other.toString() === name,
  };
}

function createDurableObjectStub(id: DurableObjectId, fetchMock: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): DurableObjectStub {
  return {
    id,
    name: id.name,
    fetch: fetchMock,
    connect: () => {
      throw new Error('connect is not used in files route tests');
    },
  };
}

function createSessionsNamespace(
  idFromName: (name: string) => DurableObjectId,
  fetchMock: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): DurableObjectNamespace {
  let namespace: DurableObjectNamespace;
  namespace = {
    newUniqueId: () => createDurableObjectId('unique'),
    idFromName,
    idFromString: (id: string) => createDurableObjectId(id),
    get: (id: DurableObjectId) => createDurableObjectStub(id, fetchMock),
    getByName: (name: string) => createDurableObjectStub(createDurableObjectId(name), fetchMock),
    jurisdiction: () => namespace,
  };
  return namespace;
}

function buildApp() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', { id: 'user-1', email: 'user@example.com', role: 'member' });
    c.set('db', {} as Variables['db']);
    c.set('requestId', 'req-test');
    await next();
  });
  app.route('/', filesRouter);
  return app;
}

describe('filesRouter GET /list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentOrchestratorSessionMock.mockResolvedValue(null);
    getSessionMock.mockResolvedValue(null);
  });

  it('resolves the orchestrator alias before proxying file listings', async () => {
    getCurrentOrchestratorSessionMock.mockResolvedValue({
      id: 'orchestrator:user-1:new',
      userId: 'user-1',
      purpose: 'orchestrator',
      isOrchestrator: true,
    });

    assertSessionAccessMock.mockResolvedValue({
      id: 'orchestrator:user-1:new',
      userId: 'user-1',
      purpose: 'orchestrator',
      isOrchestrator: true,
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([
        {
          name: 'packages',
          path: '/packages',
          absolute: '/workspace/packages',
          type: 'directory',
          ignored: false,
        },
      ]), { status: 200 })
    );
    const idFromName = vi.fn((name: string) => createDurableObjectId(`do:${name}`));
    const sessionsNamespace = createSessionsNamespace(idFromName, fetchMock);

    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/list?sessionId=orchestrator&path=/'),
      {
        DB: {} as D1Database,
        SESSIONS: sessionsNamespace,
      } as Env
    );

    expect(res.status).toBe(200);
    expect(getCurrentOrchestratorSessionMock).toHaveBeenCalledWith({}, 'user-1');
    expect(assertSessionAccessMock).toHaveBeenCalledWith({}, 'orchestrator:user-1:new', 'user-1', 'viewer');
    expect(idFromName).toHaveBeenCalledWith('orchestrator:user-1:new');
    expect(fetchMock).toHaveBeenCalledWith(expect.objectContaining({
      url: 'http://do/proxy/file?path=%2F',
    }));
    expect(await res.json()).toEqual({
      files: [{ name: 'packages', path: '/packages', type: 'directory' }],
    });
  });
});

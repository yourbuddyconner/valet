import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { errorHandler } from '../middleware/error-handler.js';

const {
  loadGitHubAppMock,
  getGithubInstallationByLoginMock,
} = vi.hoisted(() => ({
  loadGitHubAppMock: vi.fn(),
  getGithubInstallationByLoginMock: vi.fn(),
}));

vi.mock('../services/github-app.js', () => ({
  loadGitHubApp: loadGitHubAppMock,
}));

vi.mock('../lib/db/github-installations.js', () => ({
  getGithubInstallationByLogin: getGithubInstallationByLoginMock,
}));

// The triggers router pulls in other DB helpers via barrel imports; the
// available-events route never touches them, so default to empty stubs.
vi.mock('../services/triggers.js', () => ({
  runWorkflowManually: vi.fn(),
  runTrigger: vi.fn(),
}));

import { triggersRouter } from './triggers.js';

type TestUser = { id: string; email: string; role: 'admin' | 'member' };

function buildApp(user: TestUser) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', user);
    // The route only reads `c.get('db')` to pass through to mocked helpers,
    // so an empty object satisfies the typing without leaking into queries.
    c.set('db', {} as Variables['db']);
    c.set('requestId', 'req-test');
    await next();
  });
  app.route('/', triggersRouter);
  return app;
}

interface OctokitMock {
  request: ReturnType<typeof vi.fn>;
}

function mockAppWith(requestImpl: (route: string, params?: Record<string, unknown>) => Promise<{ data: unknown }>) {
  const octokit: OctokitMock = { request: vi.fn(requestImpl) };
  loadGitHubAppMock.mockResolvedValue({ octokit });
  return octokit;
}

const APP_EVENTS = ['push', 'pull_request', 'issues', 'issue_comment'];

const MEMBER: TestUser = { id: 'user-1', email: 'u@example.com', role: 'member' };

describe('GET /api/triggers/github/available-events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns App-level events when no repo is supplied', async () => {
    mockAppWith(async (route) => {
      if (route === 'GET /app') return { data: { events: APP_EVENTS } };
      throw new Error(`unexpected route ${route}`);
    });

    const res = await buildApp(MEMBER).request('http://localhost/github/available-events');
    expect(res.status).toBe(200);
    const body = await res.json() as { events: string[]; byRepo: Record<string, string[]>; notInstalled: string[] };
    expect(body.events).toEqual(APP_EVENTS);
    expect(body.byRepo).toEqual({});
    expect(body.notInstalled).toEqual([]);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=60');
  });

  it('returns 503 when the GitHub App is not configured', async () => {
    loadGitHubAppMock.mockResolvedValue(null);

    const res = await buildApp(MEMBER).request('http://localhost/github/available-events');
    expect(res.status).toBe(503);
  });

  it('returns events for a single repo', async () => {
    mockAppWith(async (route, params) => {
      if (route === 'GET /app') return { data: { events: APP_EVENTS } };
      if (route === 'GET /repos/{owner}/{repo}/installation') {
        expect(params).toEqual({ owner: 'acme', repo: 'web' });
        return { data: { events: ['push', 'pull_request'] } };
      }
      throw new Error(`unexpected route ${route}`);
    });
    getGithubInstallationByLoginMock.mockResolvedValue({
      id: 'inst-row',
      linkedUserId: MEMBER.id,
    });

    const res = await buildApp(MEMBER).request('http://localhost/github/available-events?repo=acme/web');
    expect(res.status).toBe(200);
    const body = await res.json() as { events: string[]; byRepo: Record<string, string[]> };
    expect(body.byRepo).toEqual({ 'acme/web': ['push', 'pull_request'] });
    expect(body.events.sort()).toEqual(['pull_request', 'push']);
  });

  it('returns the union and per-repo events for multiple repos', async () => {
    const perRepo: Record<string, string[]> = {
      'acme/web': ['push', 'pull_request'],
      'acme/api': ['push', 'issues'],
    };
    mockAppWith(async (route, params) => {
      if (route === 'GET /app') return { data: { events: APP_EVENTS } };
      if (route === 'GET /repos/{owner}/{repo}/installation') {
        const key = `${params!.owner as string}/${params!.repo as string}`;
        return { data: { events: perRepo[key] ?? [] } };
      }
      throw new Error(`unexpected route ${route}`);
    });
    getGithubInstallationByLoginMock.mockResolvedValue({
      id: 'inst-row',
      linkedUserId: MEMBER.id,
    });

    const res = await buildApp(MEMBER).request(
      'http://localhost/github/available-events?repo=acme/web&repo=acme/api',
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      events: string[];
      byRepo: Record<string, string[]>;
      unsubscribed: string[];
    };
    expect(body.byRepo).toEqual(perRepo);
    expect([...body.events].sort()).toEqual(['issues', 'pull_request', 'push']);
    // issue_comment is in the App-level list but not delivered to any queried
    // installation — it shows up as unsubscribed.
    expect(body.unsubscribed).toEqual(['issue_comment']);
  });

  it('lists repos as notInstalled when GitHub returns 404', async () => {
    mockAppWith(async (route) => {
      if (route === 'GET /app') return { data: { events: APP_EVENTS } };
      if (route === 'GET /repos/{owner}/{repo}/installation') {
        const err: Error & { status?: number } = new Error('Not Found');
        err.status = 404;
        throw err;
      }
      throw new Error(`unexpected route ${route}`);
    });
    getGithubInstallationByLoginMock.mockResolvedValue({
      id: 'inst-row',
      linkedUserId: MEMBER.id,
    });

    const res = await buildApp(MEMBER).request('http://localhost/github/available-events?repo=acme/web');
    expect(res.status).toBe(200);
    const body = await res.json() as { byRepo: Record<string, string[]>; notInstalled: string[] };
    expect(body.byRepo).toEqual({});
    expect(body.notInstalled).toEqual(['acme/web']);
  });

  it('rejects access with 403 when the installation belongs to a different user', async () => {
    mockAppWith(async (route) => {
      if (route === 'GET /app') return { data: { events: APP_EVENTS } };
      throw new Error(`unexpected route ${route}`);
    });
    getGithubInstallationByLoginMock.mockResolvedValue({
      id: 'inst-row',
      linkedUserId: 'someone-else',
    });

    const res = await buildApp(MEMBER).request('http://localhost/github/available-events?repo=acme/web');
    expect(res.status).toBe(403);
  });

  it('allows admins to query installs not linked to them', async () => {
    mockAppWith(async (route) => {
      if (route === 'GET /app') return { data: { events: APP_EVENTS } };
      if (route === 'GET /repos/{owner}/{repo}/installation') {
        return { data: { events: ['push'] } };
      }
      throw new Error(`unexpected route ${route}`);
    });
    getGithubInstallationByLoginMock.mockResolvedValue({
      id: 'inst-row',
      linkedUserId: null,
    });

    const admin: TestUser = { id: 'admin-1', email: 'a@example.com', role: 'admin' };
    const res = await buildApp(admin).request('http://localhost/github/available-events?repo=acme/web');
    expect(res.status).toBe(200);
    const body = await res.json() as { byRepo: Record<string, string[]> };
    expect(body.byRepo).toEqual({ 'acme/web': ['push'] });
  });

  it('rejects malformed repo strings with 400', async () => {
    mockAppWith(async (route) => {
      if (route === 'GET /app') return { data: { events: APP_EVENTS } };
      throw new Error(`unexpected route ${route}`);
    });

    const res = await buildApp(MEMBER).request('http://localhost/github/available-events?repo=not-a-repo');
    expect(res.status).toBe(400);
  });
});

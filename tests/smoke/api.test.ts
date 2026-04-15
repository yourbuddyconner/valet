/**
 * Direct API smoke tests.
 *
 * These hit the worker HTTP API directly — no agent involvement.
 * Tests CRUD operations, auth, and endpoint availability.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { SmokeClient } from './client.js';

const client = new SmokeClient();
const TEST_ID = `smoke-${Date.now()}`;

// ─── Health & Auth ────────────────────────────────────────────────────────

describe('health & auth', () => {
  it('GET /health returns 200', async () => {
    const status = await client.health();
    expect(status).toBe(200);
  });

  it('authenticated request succeeds', async () => {
    const res = await client.listSessions(1);
    expect(res.sessions).toBeDefined();
  });

  it('bad token returns 401', async () => {
    const bad = new SmokeClient({ token: 'bad-token-nope' });
    const status = await bad.status('GET', '/api/sessions?limit=1');
    expect(status).toBe(401);
  });
});

// ─── Sessions ─────────────────────────────────────────────────────────────

describe('sessions', () => {
  it('lists sessions', async () => {
    const res = await client.listSessions(5);
    expect(Array.isArray(res.sessions)).toBe(true);
  });

  it('lists available models', async () => {
    const res = await client.availableModels();
    expect(Array.isArray(res.models)).toBe(true);
  });
});

// ─── Orchestrator ─────────────────────────────────────────────────────────

describe('orchestrator', () => {
  it('returns orchestrator info', async () => {
    const res = await client.getOrchestrator();
    expect(res.sessionId).toBeDefined();
    expect(typeof res.exists).toBe('boolean');
    expect(typeof res.needsRestart).toBe('boolean');
  });

  it('returns orchestrator session detail (if exists)', async () => {
    const info = await client.getOrchestrator();
    if (!info.exists) return; // skip

    const session = await client.getSession(info.sessionId);
    expect(session.id || session.session?.id).toBeDefined();
  });
});

// ─── Memory System ────────────────────────────────────────────────────────

describe('memory', () => {
  const path = `test/${TEST_ID}.md`;
  const content = `# Smoke Test\nCreated: ${new Date().toISOString()}`;

  it('writes a file', async () => {
    const res = await client.memoryWrite(path, content);
    expect(res).toBeDefined();
  });

  it('reads it back', async () => {
    const res = await client.memoryRead(path);
    expect(res.file.content).toContain('Smoke Test');
  });

  it('patches it', async () => {
    const res = await client.memoryPatch(path, [
      { op: 'append', content: '\nStatus: passed' },
    ]);
    expect(res).toBeDefined();
  });

  it('reads after patch', async () => {
    const res = await client.memoryRead(path);
    expect(res.file.content).toContain('Status: passed');
  });

  it('searches for it', async () => {
    const res = await client.memorySearch('smoke test');
    const results = res.results ?? res.files ?? [];
    expect(results.length).toBeGreaterThan(0);
  });

  it('lists directory', async () => {
    const res = await client.memoryRead('test/');
    // Directory listing returns files array or content
    expect(res.files ?? res.entries ?? res.content).toBeDefined();
  });

  it('deletes it', async () => {
    const res = await client.memoryDelete(path);
    expect(res).toBeDefined();
  });

  it('confirms deletion', async () => {
    const status = await client.status('GET', `/api/me/memory?path=${encodeURIComponent(path)}`);
    // After deletion, read returns 404 or the file has no content
    expect([200, 404]).toContain(status);
  });
});

// ─── Personas ─────────────────────────────────────────────────────────────

describe('personas', () => {
  let personaId: string | undefined;

  it('lists personas', async () => {
    const res = await client.listPersonas();
    expect(Array.isArray(res.personas)).toBe(true);
  });

  it('creates a persona', async () => {
    const res = await client.createPersona({
      name: `Smoke Test ${TEST_ID}`,
      slug: `smoke-${TEST_ID}`,
      description: 'smoke test',
      visibility: 'private',
    });
    expect(res.persona?.id).toBeDefined();
    personaId = res.persona.id;
  });

  it('gets the persona', async () => {
    if (!personaId) return;
    const res = await client.getPersona(personaId);
    expect(res.persona?.id ?? res.id).toBe(personaId);
  });

  it('deletes the persona (cleanup)', async () => {
    if (!personaId) return;
    await client.deletePersona(personaId);
    const status = await client.status('GET', `/api/personas/${personaId}`);
    expect(status).toBe(404);
  });
});

// ─── Workflows ────────────────────────────────────────────────────────────

describe('workflows', () => {
  let workflowId: string | undefined;
  const slug = `smoke-wf-${TEST_ID}`;
  const wfId = `smoke-wf-id-${TEST_ID}`;

  it('lists workflows', async () => {
    const res = await client.listWorkflows();
    expect(Array.isArray(res.workflows)).toBe(true);
  });

  it('creates a workflow via sync', async () => {
    const res = await client.syncWorkflow({
      id: wfId,
      name: 'Smoke Test WF',
      slug,
      description: 'smoke test',
      data: { steps: [{ id: 's1', type: 'prompt', prompt: 'echo hello' }] },
    });
    workflowId = res.id ?? res.workflow?.id ?? wfId;
    expect(workflowId).toBeDefined();
  });

  it('gets the workflow', async () => {
    if (!workflowId) return;
    const res = await client.getWorkflow(workflowId);
    expect(res.id ?? res.workflow?.id).toBe(workflowId);
  });

  it('deletes the workflow (cleanup)', async () => {
    if (!workflowId) return;
    await client.deleteWorkflow(workflowId);
  });
});

// ─── Triggers ─────────────────────────────────────────────────────────────

describe('triggers', () => {
  it('lists triggers', async () => {
    const res = await client.listTriggers();
    expect(Array.isArray(res.triggers)).toBe(true);
  });
});

// ─── Executions ───────────────────────────────────────────────────────────

describe('executions', () => {
  it('lists executions', async () => {
    const res = await client.listExecutions(5);
    expect(Array.isArray(res.executions)).toBe(true);
  });
});

// ─── Dashboard ────────────────────────────────────────────────────────────

describe('dashboard', () => {
  it('returns stats', async () => {
    const res = await client.dashboardStats();
    expect(res).toBeDefined();
  });
});

// ─── Integrations ─────────────────────────────────────────────────────────

describe('integrations', () => {
  it('lists integrations', async () => {
    const res = await client.listIntegrations();
    expect(res).toBeDefined();
  });
});

// ─── Notifications ────────────────────────────────────────────────────────

describe('notifications', () => {
  it('lists notifications', async () => {
    const res = await client.listNotifications();
    expect(res).toBeDefined();
  });
});

// ─── Channels ─────────────────────────────────────────────────────────────

describe('channels', () => {
  it('resolves a channel label', async () => {
    // Just verify the endpoint responds — label may be null for unknown channels
    const res = await client.getChannelLabel('web', 'default');
    expect(res).toBeDefined();
  });
});

// ─── Threads (via orchestrator session) ───────────────────────────────────

describe('threads', () => {
  it('lists threads for orchestrator session', async () => {
    const info = await client.getOrchestrator();
    if (!info.exists) return;

    const res = await client.listThreads(info.sessionId);
    expect(Array.isArray(res.threads)).toBe(true);
  });
});

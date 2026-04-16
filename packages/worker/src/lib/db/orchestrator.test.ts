import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { getCurrentOrchestratorSession } from './orchestrator.js';

function makeSessionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'orchestrator:user-1:new',
    user_id: 'user-1',
    workspace: 'orchestrator',
    status: 'running',
    title: 'Agent (Orchestrator)',
    parent_session_id: null,
    container_id: null,
    metadata: null,
    error_message: null,
    persona_id: null,
    persona_name: null,
    is_orchestrator: 1,
    purpose: 'orchestrator',
    created_at: '2026-04-02 00:00:00',
    last_active_at: '2026-04-02 00:00:00',
    ...overrides,
  };
}

function makeDb(firstResults: Array<Record<string, unknown> | null>): D1Database {
  const queue = [...firstResults];
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => queue.shift() ?? null),
      })),
    })),
  } as unknown as D1Database;
}

describe('getCurrentOrchestratorSession', () => {
  it('returns null when the user only has terminal orchestrator sessions', async () => {
    const db = makeDb([
      null,
      makeSessionRow({
        id: 'orchestrator:user-1:terminated',
        status: 'terminated',
      }),
    ]);

    const session = await getCurrentOrchestratorSession(db, 'user-1');

    expect(session).toBeNull();
  });

  it('returns the latest non-terminal orchestrator session when one exists', async () => {
    const db = makeDb([makeSessionRow()]);

    const session = await getCurrentOrchestratorSession(db, 'user-1');

    expect(session?.id).toBe('orchestrator:user-1:new');
    expect(session?.status).toBe('running');
  });
});

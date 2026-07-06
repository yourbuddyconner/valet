import { describe, expect, it } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { createTestDb } from '../../test-utils/db.js';
import { getUsageByWorkflowModel } from './analytics.js';

/**
 * Regression: pre-fix getUsageByWorkflowModel joined workflow_executions
 * ON we.session_id = ae.session_id — a column that never existed, so the
 * query 500'd against real D1. This test locks in the new join path
 * through sessions.workflow_execution_id and verifies attribution rolls
 * up by (workflow, trigger, model) even after workflow_spawned_sessions
 * rows have been pruned (the whole reason for the durable column).
 */

function d1(sqlite: BetterSqlite3.Database) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async all() {
              const stmt = sqlite.prepare(sql);
              const results = stmt.all(...args);
              return { results };
            },
          };
        },
      };
    },
  } as unknown as import('@cloudflare/workers-types').D1Database;
}

function exec(sqlite: BetterSqlite3.Database, sql: string, ...args: unknown[]) {
  sqlite.prepare(sql).run(...args);
}

describe('getUsageByWorkflowModel', () => {
  it('attributes usage per workflow+trigger via sessions.workflow_execution_id', async () => {
    const { sqlite } = createTestDb();

    exec(sqlite, `INSERT INTO users (id, email) VALUES (?, ?)`, 'u1', 'u1@example.com');
    exec(sqlite, `INSERT INTO workflows (id, user_id, name, data) VALUES (?, ?, ?, ?)`, 'wf1', 'u1', 'Nightly digest', '{}');
    exec(sqlite, `INSERT INTO workflows (id, user_id, name, data) VALUES (?, ?, ?, ?)`, 'wf2', 'u1', 'PR checker', '{}');
    exec(sqlite, `INSERT INTO triggers (id, user_id, workflow_id, name, type, config) VALUES (?, ?, ?, ?, ?, ?)`, 't-sched', 'u1', 'wf1', 't-sched', 'schedule', '{}');
    exec(sqlite, `INSERT INTO triggers (id, user_id, workflow_id, name, type, config) VALUES (?, ?, ?, ?, ?, ?)`, 't-wh', 'u1', 'wf2', 't-wh', 'webhook', '{}');
    exec(sqlite,
      `INSERT INTO workflow_executions (id, workflow_id, user_id, trigger_id, status, trigger_type, started_at) VALUES (?, ?, ?, ?, 'completed', 'schedule', datetime('now'))`,
      'exec-a', 'wf1', 'u1', 't-sched',
    );
    exec(sqlite,
      `INSERT INTO workflow_executions (id, workflow_id, user_id, trigger_id, status, trigger_type, started_at) VALUES (?, ?, ?, ?, 'completed', 'webhook', datetime('now'))`,
      'exec-b', 'wf2', 'u1', 't-wh',
    );
    // exec-c: manual (NULL trigger_id) — must surface as trigger_type='manual'
    exec(sqlite,
      `INSERT INTO workflow_executions (id, workflow_id, user_id, trigger_id, status, trigger_type, started_at) VALUES (?, ?, ?, NULL, 'completed', 'manual', datetime('now'))`,
      'exec-c', 'wf1', 'u1',
    );

    // Three sessions: one per execution. workflow_spawned_sessions
    // intentionally NOT populated — proves the join works after cleanup pruned those rows.
    exec(sqlite, `INSERT INTO sessions (id, user_id, workspace, status, purpose, workflow_execution_id) VALUES (?, ?, ?, ?, ?, ?)`, 's-a', 'u1', 'ws', 'completed', 'workflow', 'exec-a');
    exec(sqlite, `INSERT INTO sessions (id, user_id, workspace, status, purpose, workflow_execution_id) VALUES (?, ?, ?, ?, ?, ?)`, 's-b', 'u1', 'ws', 'completed', 'workflow', 'exec-b');
    exec(sqlite, `INSERT INTO sessions (id, user_id, workspace, status, purpose, workflow_execution_id) VALUES (?, ?, ?, ?, ?, ?)`, 's-c', 'u1', 'ws', 'completed', 'workflow', 'exec-c');
    // Interactive session — must NOT appear in workflow attribution.
    exec(sqlite, `INSERT INTO sessions (id, user_id, workspace, status, purpose) VALUES (?, ?, ?, ?, ?)`, 's-int', 'u1', 'ws', 'completed', 'interactive');

    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    exec(sqlite, `INSERT INTO analytics_events (id, event_type, session_id, model, input_tokens, output_tokens, created_at) VALUES (?, 'llm_call', ?, ?, ?, ?, ?)`, 'ae1', 's-a', 'claude-sonnet-4', 100, 200, past);
    exec(sqlite, `INSERT INTO analytics_events (id, event_type, session_id, model, input_tokens, output_tokens, created_at) VALUES (?, 'llm_call', ?, ?, ?, ?, ?)`, 'ae2', 's-a', 'claude-sonnet-4', 50, 75, past);
    exec(sqlite, `INSERT INTO analytics_events (id, event_type, session_id, model, input_tokens, output_tokens, created_at) VALUES (?, 'llm_call', ?, ?, ?, ?, ?)`, 'ae3', 's-b', 'gpt-5', 10, 20, past);
    exec(sqlite, `INSERT INTO analytics_events (id, event_type, session_id, model, input_tokens, output_tokens, created_at) VALUES (?, 'llm_call', ?, ?, ?, ?, ?)`, 'ae4', 's-c', 'claude-sonnet-4', 5, 6, past);
    // Should be excluded by session-purpose filter (interactive session)
    exec(sqlite, `INSERT INTO analytics_events (id, event_type, session_id, model, input_tokens, output_tokens, created_at) VALUES (?, 'llm_call', ?, ?, ?, ?, ?)`, 'ae-int', 's-int', 'claude-sonnet-4', 9999, 9999, past);

    const rows = await getUsageByWorkflowModel(d1(sqlite), new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    // Three (workflow, trigger, model) buckets — interactive row excluded.
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ workflowId: 'wf1', workflowName: 'Nightly digest', triggerType: 'schedule', model: 'claude-sonnet-4', inputTokens: 150, outputTokens: 275, callCount: 2 }),
      expect.objectContaining({ workflowId: 'wf2', workflowName: 'PR checker', triggerType: 'webhook', model: 'gpt-5', inputTokens: 10, outputTokens: 20, callCount: 1 }),
      expect.objectContaining({ workflowId: 'wf1', workflowName: 'Nightly digest', triggerType: 'manual', model: 'claude-sonnet-4', inputTokens: 5, outputTokens: 6, callCount: 1 }),
    ]));
  });

  it('returns empty when no session has workflow_execution_id set', async () => {
    const { sqlite } = createTestDb();
    exec(sqlite, `INSERT INTO users (id, email) VALUES ('u', 'u@e.com')`);
    exec(sqlite, `INSERT INTO sessions (id, user_id, workspace, status, purpose) VALUES ('s', 'u', 'ws', 'idle', 'interactive')`);
    exec(sqlite, `INSERT INTO analytics_events (id, event_type, session_id, model, input_tokens, output_tokens, created_at) VALUES ('ae', 'llm_call', 's', 'claude-sonnet-4', 100, 200, datetime('now'))`);

    const rows = await getUsageByWorkflowModel(d1(sqlite), new Date(Date.now() - 60_000).toISOString());
    expect(rows).toEqual([]);
  });
});

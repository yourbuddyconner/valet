import Database from 'better-sqlite3';
import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '../../migrations');

function applyMigrationsUpTo(sqlite: Database.Database, exclusive: string) {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && f < exclusive)
    .sort();
  for (const file of files) {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf-8'));
  }
}

function applyMigration(sqlite: Database.Database, file: string) {
  sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf-8'));
}

const MIGRATION = '0022_unified_action_policies.sql';

describe('0022_unified_action_policies', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    applyMigrationsUpTo(sqlite, MIGRATION);

    // Fixture: user, session, existing admin policy, three UAPOs, three audit rows
    // that reference each UAPO via user_override_id; plus a workflow execution
    // and a pair of workflow_approvals (one explicit, one tool_policy) so we
    // exercise the workflow_approvals retirement at the end of migration 0022.
    sqlite.exec(`
      INSERT INTO users (id, email) VALUES ('user_1', 'u1@example.com');
      INSERT INTO sessions (id, user_id, workspace) VALUES ('sess_1', 'user_1', 'ws1');

      -- Workflow + execution for the workflow_approvals fixture below.
      INSERT INTO workflows (id, user_id, name, data)
        VALUES ('wf_1', 'user_1', 'wf', '{"version":"dag/v1"}');
      INSERT INTO workflow_executions (id, workflow_id, user_id, status, trigger_type, started_at)
        VALUES ('exec_1', 'wf_1', 'user_1', 'running', 'manual', datetime('now'));

      -- Two workflow_approvals rows: one explicit (must migrate into
      -- action_invocations), one tool_policy (should be dropped since its
      -- corresponding action_invocations row already exists).
      INSERT INTO action_invocations (id, workflow_execution_id, user_id, service, action_id, risk_level, resolved_mode, status)
        VALUES ('wa_tool_policy', 'exec_1', 'user_1', 'gmail', 'send_email', 'medium', 'require_approval', 'pending');
      INSERT INTO workflow_approvals (id, execution_id, node_id, kind, workflow_instance_id, event_type, prompt, summary, details, status, timeout_at)
        VALUES ('wa_tool_policy', 'exec_1', 'tool_node', 'tool_policy', 'exec_1', 'approval_tool_node', 'Approve gmail.send_email?', 'send email', '{"to":"a@b"}', 'pending', '2099-01-01T00:00:00Z');
      INSERT INTO workflow_approvals (id, execution_id, node_id, kind, workflow_instance_id, event_type, prompt, summary, details, status, timeout_at)
        VALUES ('wa_explicit', 'exec_1', 'approval_node', 'explicit', 'exec_1', 'approval_approval_node', 'Continue with deploy?', 'deploy gate', '{"env":"prod"}', 'pending', '2099-01-01T00:00:00Z');

      -- Pre-existing admin policy (created via the legacy settings flow).
      INSERT INTO action_policies (id, service, action_id, risk_level, mode, created_by)
        VALUES ('admin_pol_1', 'github', 'repo.create', NULL, 'require_approval', 'user_1');

      -- UAPO rows.
      INSERT INTO user_action_policy_overrides (id, user_id, service, action_id, mode, lifetime)
        VALUES ('uapo_persist', 'user_1', 'gmail', 'send_email', 'allow', 'persistent');
      INSERT INTO user_action_policy_overrides (id, user_id, service, action_id, mode, lifetime, expires_at)
        VALUES ('uapo_timed', 'user_1', 'gmail', 'create_draft', 'allow', 'timed', '2099-01-01T00:00:00Z');
      INSERT INTO user_action_policy_overrides (id, user_id, service, action_id, mode, lifetime, session_id)
        VALUES ('uapo_session', 'user_1', 'github', 'issue.comment', 'allow', 'session', 'sess_1');

      -- action_invocations that reference each UAPO via user_override_id.
      INSERT INTO action_invocations
        (id, user_id, service, action_id, risk_level, resolved_mode, user_override_id, status)
        VALUES ('inv_persist', 'user_1', 'gmail', 'send_email', 'medium', 'allow', 'uapo_persist', 'executed');
      INSERT INTO action_invocations
        (id, user_id, service, action_id, risk_level, resolved_mode, user_override_id, status)
        VALUES ('inv_timed', 'user_1', 'gmail', 'create_draft', 'medium', 'allow', 'uapo_timed', 'executed');
      INSERT INTO action_invocations
        (id, user_id, service, action_id, risk_level, resolved_mode, user_override_id, status)
        VALUES ('inv_session', 'user_1', 'github', 'issue.comment', 'medium', 'allow', 'uapo_session', 'executed');
    `);
  });

  describe('schema extensions', () => {
    it('extends action_policies with the new ownership/target/audit columns', () => {
      applyMigration(sqlite, MIGRATION);
      const cols = sqlite.prepare(`PRAGMA table_info(action_policies)`).all() as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      for (const expected of [
        'org_id', 'managed_by', 'principal_type', 'principal_id', 'subject_type',
        'subject_label', 'workflow_id', 'workflow_version_id', 'node_id',
        'param_matchers', 'matcher_summary', 'user_grant_behavior', 'origin',
        'source_approval_id', 'last_matched_at', 'expires_at', 'revoked_at',
      ]) {
        expect(names.has(expected), `missing column: ${expected}`).toBe(true);
      }
    });

    it('creates the runtime_grants table', () => {
      applyMigration(sqlite, MIGRATION);
      const row = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_grants'`).get();
      expect(row).toBeDefined();
    });

    it('extends workflow_spawned_sessions with workflow_id and workflow_version_id', () => {
      applyMigration(sqlite, MIGRATION);
      const cols = sqlite.prepare(`PRAGMA table_info(workflow_spawned_sessions)`).all() as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      expect(names.has('workflow_id')).toBe(true);
      expect(names.has('workflow_version_id')).toBe(true);
    });

    it('extends action_invocations with matched_policy_id and matched_grant_id', () => {
      applyMigration(sqlite, MIGRATION);
      const cols = sqlite.prepare(`PRAGMA table_info(action_invocations)`).all() as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      expect(names.has('matched_policy_id')).toBe(true);
      expect(names.has('matched_grant_id')).toBe(true);
    });
  });

  describe('legacy index and trigger removal', () => {
    it('drops the old partial unique indexes on action_policies', () => {
      applyMigration(sqlite, MIGRATION);
      const indexes = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as Array<{ name: string }>;
      const names = new Set(indexes.map((i) => i.name));
      expect(names.has('idx_ap_action')).toBe(false);
      expect(names.has('idx_ap_service')).toBe(false);
      expect(names.has('idx_ap_risk')).toBe(false);
    });

    it('drops the 0014 discriminator triggers', () => {
      applyMigration(sqlite, MIGRATION);
      const triggers = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`).all() as Array<{ name: string }>;
      const names = new Set(triggers.map((t) => t.name));
      expect(names.has('validate_action_policies_target_insert')).toBe(false);
      expect(names.has('validate_action_policies_target_update')).toBe(false);
    });

    it('adds the new scope-aware indexes', () => {
      applyMigration(sqlite, MIGRATION);
      const indexes = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as Array<{ name: string }>;
      const names = new Set(indexes.map((i) => i.name));
      for (const expected of [
        'idx_ap_unique', 'idx_ap_lookup_subject', 'idx_ap_lookup_principal',
        'idx_ap_lookup_workflow', 'idx_ap_expires',
        'idx_rg_session_policy_key', 'idx_rg_execution_policy_key',
        'idx_rg_session', 'idx_rg_execution',
      ]) {
        expect(names.has(expected), `missing index: ${expected}`).toBe(true);
      }
    });
  });

  describe('backfill of existing action_policies rows', () => {
    it('marks existing rows as origin=migration with admin/org defaults', () => {
      applyMigration(sqlite, MIGRATION);
      const row = sqlite.prepare(`SELECT * FROM action_policies WHERE id = ?`).get('admin_pol_1') as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.org_id).toBe('default');
      expect(row.managed_by).toBe('admin');
      expect(row.principal_type).toBe('org');
      expect(row.principal_id).toBe('default');
      expect(row.subject_type).toBe('tool_action');
      expect(row.param_matchers).toBe('[]');
      expect(row.user_grant_behavior).toBe('allowed');
      expect(row.origin).toBe('migration');
      expect(row.expires_at).toBeNull();
    });
  });

  describe('UAPO → action_policies migration (persistent / timed)', () => {
    it('copies persistent overrides into action_policies as user-managed grants', () => {
      applyMigration(sqlite, MIGRATION);
      const row = sqlite.prepare(`SELECT * FROM action_policies WHERE id = ?`).get('uapo_persist') as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.managed_by).toBe('user');
      expect(row.principal_type).toBe('user');
      expect(row.principal_id).toBe('user_1');
      expect(row.service).toBe('gmail');
      expect(row.action_id).toBe('send_email');
      expect(row.mode).toBe('allow');
      expect(row.origin).toBe('migration');
      expect(row.expires_at).toBeNull();
    });

    it('preserves expires_at for timed overrides', () => {
      applyMigration(sqlite, MIGRATION);
      const row = sqlite.prepare(`SELECT * FROM action_policies WHERE id = ?`).get('uapo_timed') as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.managed_by).toBe('user');
      expect(row.expires_at).toBe('2099-01-01T00:00:00Z');
    });

    it('does not copy session overrides into action_policies', () => {
      applyMigration(sqlite, MIGRATION);
      const row = sqlite.prepare(`SELECT * FROM action_policies WHERE id = ?`).get('uapo_session');
      expect(row).toBeUndefined();
    });
  });

  describe('UAPO → runtime_grants migration (session)', () => {
    it('copies session overrides into runtime_grants with the session id', () => {
      applyMigration(sqlite, MIGRATION);
      const row = sqlite.prepare(`SELECT * FROM runtime_grants WHERE id = ?`).get('uapo_session') as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.session_id).toBe('sess_1');
      expect(row.workflow_execution_id).toBeNull();
      expect(row.user_id).toBe('user_1');
      expect(row.service).toBe('github');
      expect(row.action_id).toBe('issue.comment');
      expect(row.subject_type).toBe('tool_action');
      expect(row.param_matchers).toBe('[]');
    });

    it('produces a deterministic policy_key for session overrides', () => {
      applyMigration(sqlite, MIGRATION);
      const row = sqlite.prepare(`SELECT policy_key FROM runtime_grants WHERE id = ?`).get('uapo_session') as { policy_key: string };
      expect(row.policy_key).toBe('session:sess_1:github.issue.comment:');
    });

    it('leaves runtime_grants empty for persistent / timed UAPO rows', () => {
      applyMigration(sqlite, MIGRATION);
      const rows = sqlite.prepare(`SELECT id FROM runtime_grants`).all() as Array<{ id: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('uapo_session');
    });
  });

  describe('action_invocations.matched_* backfill', () => {
    it('points matched_policy_id at the migrated action_policies row for persistent / timed', () => {
      applyMigration(sqlite, MIGRATION);
      const persist = sqlite.prepare(`SELECT matched_policy_id, matched_grant_id FROM action_invocations WHERE id = ?`).get('inv_persist') as Record<string, unknown>;
      expect(persist.matched_policy_id).toBe('uapo_persist');
      expect(persist.matched_grant_id).toBeNull();

      const timed = sqlite.prepare(`SELECT matched_policy_id, matched_grant_id FROM action_invocations WHERE id = ?`).get('inv_timed') as Record<string, unknown>;
      expect(timed.matched_policy_id).toBe('uapo_timed');
      expect(timed.matched_grant_id).toBeNull();
    });

    it('points matched_grant_id at the migrated runtime_grants row for session', () => {
      applyMigration(sqlite, MIGRATION);
      const session = sqlite.prepare(`SELECT matched_policy_id, matched_grant_id FROM action_invocations WHERE id = ?`).get('inv_session') as Record<string, unknown>;
      expect(session.matched_grant_id).toBe('uapo_session');
      expect(session.matched_policy_id).toBeNull();
    });

    it('preserves user_override_id for historical reads', () => {
      applyMigration(sqlite, MIGRATION);
      const persist = sqlite.prepare(`SELECT user_override_id FROM action_invocations WHERE id = ?`).get('inv_persist') as { user_override_id: string };
      expect(persist.user_override_id).toBe('uapo_persist');
    });
  });

  describe('UAPO table retention', () => {
    it('leaves user_action_policy_overrides populated for the existing resolver', () => {
      applyMigration(sqlite, MIGRATION);
      const rows = sqlite.prepare(`SELECT id FROM user_action_policy_overrides`).all() as Array<{ id: string }>;
      expect(rows).toHaveLength(3);
    });
  });

  describe('runtime_grants CHECK constraint', () => {
    it('rejects a row with both session_id and workflow_execution_id null', () => {
      applyMigration(sqlite, MIGRATION);
      expect(() =>
        sqlite.prepare(`
          INSERT INTO runtime_grants (id, user_id, subject_type, policy_key)
          VALUES ('rg_bad', 'user_1', 'tool_action', 'k')
        `).run()
      ).toThrow(/CHECK/i);
    });

    it('rejects a row with both session_id and workflow_execution_id set', () => {
      // wf_1 and exec_1 are already in the fixture (used by the workflow_approvals
      // retirement tests); FK targets exist before the CHECK fires.
      applyMigration(sqlite, MIGRATION);
      expect(() =>
        sqlite.prepare(`
          INSERT INTO runtime_grants (id, user_id, session_id, workflow_execution_id, subject_type, policy_key)
          VALUES ('rg_bad', 'user_1', 'sess_1', 'exec_1', 'tool_action', 'k')
        `).run()
      ).toThrow(/CHECK/i);
    });
  });

  describe('workflow_approvals retirement', () => {
    it('adds node_id and iteration_index columns to action_invocations', () => {
      applyMigration(sqlite, MIGRATION);
      const cols = sqlite.prepare(`PRAGMA table_info(action_invocations)`).all() as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      expect(names.has('node_id')).toBe(true);
      expect(names.has('iteration_index')).toBe(true);
    });

    it('drops the workflow_approvals table', () => {
      applyMigration(sqlite, MIGRATION);
      const row = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_approvals'`).get();
      expect(row).toBeUndefined();
    });

    it('migrates explicit workflow_approvals into action_invocations as workflows.request_approval', () => {
      applyMigration(sqlite, MIGRATION);
      const row = sqlite.prepare(`SELECT * FROM action_invocations WHERE id = ?`).get('wa_explicit') as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.service).toBe('workflows');
      expect(row.action_id).toBe('request_approval');
      expect(row.workflow_execution_id).toBe('exec_1');
      expect(row.node_id).toBe('approval_node');
      expect(row.user_id).toBe('user_1');
      expect(row.status).toBe('pending');
      expect(row.resolved_mode).toBe('require_approval');
      expect(row.risk_level).toBe('medium');
      // Prompt/summary/details land in params JSON for explicit approval rows.
      const params = JSON.parse(String(row.params));
      expect(params.prompt).toBe('Continue with deploy?');
      expect(params.summary).toBe('deploy gate');
      expect(params.details).toBe('{"env":"prod"}');
    });

    it('does NOT migrate tool_policy workflow_approvals (the action_invocations row already covered them)', () => {
      applyMigration(sqlite, MIGRATION);
      // The tool_policy fixture row's id ('wa_tool_policy') was inserted as an
      // action_invocation BEFORE the migration. The migration's NOT EXISTS guard
      // skips it. So there's still exactly one row by that id, with the original
      // tool service (not 'workflows').
      const rows = sqlite.prepare(`SELECT id, service, action_id FROM action_invocations WHERE id = ?`).all('wa_tool_policy') as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0].service).toBe('gmail');
      expect(rows[0].action_id).toBe('send_email');
    });

    it('adds idx_ai_workflow_node lookup index', () => {
      applyMigration(sqlite, MIGRATION);
      const indexes = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as Array<{ name: string }>;
      const names = new Set(indexes.map((i) => i.name));
      expect(names.has('idx_ai_workflow_node')).toBe(true);
    });
  });
});

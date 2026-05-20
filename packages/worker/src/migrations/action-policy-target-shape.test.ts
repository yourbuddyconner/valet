import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '../../migrations');

function readMigration(name: string): string {
  return fs.readFileSync(path.join(migrationsDir, name), 'utf-8');
}

describe('action policy target-shape migration', () => {
  it('removes legacy malformed policy rows before installing shape triggers', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(readMigration('0001_initial.sql'));
    sqlite.prepare(`
      INSERT INTO action_policies (id, service, action_id, risk_level, mode)
      VALUES ('legacy-service-risk-deny', 'github', NULL, 'critical', 'deny')
    `).run();

    sqlite.exec(readMigration('0014_action_policy_target_shape_triggers.sql'));

    expect(sqlite.prepare('SELECT id FROM action_policies WHERE id = ?').get('legacy-service-risk-deny')).toBeUndefined();
    expect(() => sqlite.prepare(`
      INSERT INTO action_policies (id, service, action_id, risk_level, mode)
      VALUES ('new-service-risk-deny', 'github', NULL, 'critical', 'deny')
    `).run()).toThrow(/must target exactly one/);
  });
});

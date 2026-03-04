import { eq, and, isNull, or } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { disabledActions } from '../schema/index.js';

export async function listDisabledActions(db: AppDb) {
  return db
    .select()
    .from(disabledActions)
    .orderBy(disabledActions.service, disabledActions.actionId)
    .all();
}

/**
 * Returns an index for efficient bulk filtering in handleListTools.
 * - disabledServices: set of service names where the entire service is disabled
 * - disabledActions: set of "service:actionId" composite keys for individually disabled actions
 */
export async function getDisabledActionsIndex(db: AppDb) {
  const rows = await db.select().from(disabledActions).all();

  const disabledServiceSet = new Set<string>();
  const disabledActionSet = new Set<string>();

  for (const row of rows) {
    if (row.actionId) {
      disabledActionSet.add(`${row.service}:${row.actionId}`);
    } else {
      disabledServiceSet.add(row.service);
    }
  }

  return { disabledServices: disabledServiceSet, disabledActions: disabledActionSet };
}

/**
 * Single-action check for handleCallTool safety net.
 */
export async function isActionDisabled(db: AppDb, service: string, actionId: string): Promise<boolean> {
  const row = await db
    .select({ id: disabledActions.id })
    .from(disabledActions)
    .where(
      or(
        // Entire service disabled
        and(eq(disabledActions.service, service), isNull(disabledActions.actionId)),
        // Specific action disabled
        and(eq(disabledActions.service, service), eq(disabledActions.actionId, actionId)),
      ),
    )
    .get();
  return !!row;
}

/**
 * Bulk upsert per service using D1 batch for atomicity.
 * Deletes all existing rows for the service, then re-inserts new state in a single batch.
 */
export async function setServiceDisabledState(
  d1: D1Database,
  service: string,
  serviceDisabled: boolean,
  disabledActionIds: string[],
  disabledBy: string,
) {
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [
    d1.prepare('DELETE FROM disabled_actions WHERE service = ?').bind(service),
  ];

  if (serviceDisabled) {
    stmts.push(
      d1.prepare(
        'INSERT INTO disabled_actions (id, service, action_id, disabled_by, created_at) VALUES (?, ?, NULL, ?, ?)',
      ).bind(crypto.randomUUID(), service, disabledBy, now),
    );
  } else {
    for (const actionId of disabledActionIds) {
      stmts.push(
        d1.prepare(
          'INSERT INTO disabled_actions (id, service, action_id, disabled_by, created_at) VALUES (?, ?, ?, ?, ?)',
        ).bind(crypto.randomUUID(), service, actionId, disabledBy, now),
      );
    }
  }

  await d1.batch(stmts);
}

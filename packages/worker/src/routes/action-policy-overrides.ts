import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { NotFoundError, ValidationError } from '@valet/shared';
import type { ActionRiskLevel } from '@valet/shared';
import {
  deleteActionPolicy,
  getActionPolicy,
  listUserDurableActionPolicies,
  resolveAdminPolicyMatch,
  upsertActionPolicy,
} from '../lib/db.js';
import { listMcpToolCache } from '../lib/db/mcp-tool-cache.js';
import type { AppDb } from '../lib/drizzle.js';
import { integrationRegistry } from '../integrations/registry.js';

export const actionPolicyOverridesRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

type OverrideMode = 'allow' | 'require_approval' | 'deny';

const VALID_MODES = new Set<OverrideMode>(['allow', 'require_approval', 'deny']);
const VALID_RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const satisfies readonly ActionRiskLevel[];
const VALID_RISK_LEVEL_SET = new Set<string>(VALID_RISK_LEVELS);

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function validateMode(value: unknown): OverrideMode {
  if (typeof value !== 'string' || !VALID_MODES.has(value as OverrideMode)) {
    throw new ValidationError(`Invalid mode: ${String(value)}. Must be one of: ${Array.from(VALID_MODES).join(', ')}`);
  }
  return value as OverrideMode;
}

function validateTarget(body: { service?: unknown; actionId?: unknown; riskLevel?: unknown }) {
  const service = nullableString(body.service);
  const actionId = nullableString(body.actionId);
  const riskLevel = nullableString(body.riskLevel);

  if (riskLevel && !VALID_RISK_LEVEL_SET.has(riskLevel)) {
    throw new ValidationError(`Invalid risk level: ${riskLevel}. Must be one of: ${VALID_RISK_LEVELS.join(', ')}`);
  }

  if (actionId && !service) {
    throw new ValidationError('actionId requires a service to be specified');
  }

  const isActionScope = Boolean(service && actionId && !riskLevel);
  const isServiceScope = Boolean(service && !actionId && !riskLevel);
  const isRiskScope = Boolean(!service && !actionId && riskLevel);
  const targetCount = [isActionScope, isServiceScope, isRiskScope].filter(Boolean).length;

  if (targetCount !== 1) {
    throw new ValidationError('Override must target exactly one of: action, service, or riskLevel');
  }

  return { service, actionId, riskLevel };
}

async function resolveCatalogRiskLevel(db: AppDb, service: string, actionId: string): Promise<string | null> {
  try {
    const actions = await (integrationRegistry.getActions(service)?.listActions() ?? []);
    const staticRisk = actions.find((action) => action.id === actionId)?.riskLevel;
    if (staticRisk) return staticRisk;

    const cached = await listMcpToolCache(db, service);
    return cached.find((action) => action.service === service && action.actionId === actionId)?.riskLevel ?? null;
  } catch (err) {
    console.warn('[action-policy-overrides] Failed to resolve action risk level:', err);
    return null;
  }
}

/**
 * Shape-preserving row mapper. The UI was written against the legacy
 * `user_action_policy_overrides` shape; map our new `action_policies` rows
 * into that shape so the client doesn't have to change yet. Sessions-scoped
 * grants now live in `runtime_grants` and are not surfaced here — the
 * legacy UI only ever created durable rows through this endpoint.
 */
function toOverrideShape(row: Awaited<ReturnType<typeof listUserDurableActionPolicies>>[number]) {
  return {
    id: row.id,
    userId: row.principalId,
    service: row.service,
    actionId: row.actionId,
    riskLevel: row.riskLevel,
    mode: row.mode,
    lifetime: row.expiresAt ? 'timed' : 'persistent',
    sessionId: null,
    expiresAt: row.expiresAt,
    source: row.origin,
    sourceInvocationId: row.sourceApprovalId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// GET /api/action-policy-overrides
actionPolicyOverridesRouter.get('/', async (c) => {
  const user = c.get('user');
  const rows = await listUserDurableActionPolicies(c.get('db'), user.id);
  return c.json(rows.map(toOverrideShape));
});

// PUT /api/action-policy-overrides/:id
actionPolicyOverridesRouter.put('/:id', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');
  const body = await c.req.json<{
    service?: string | null;
    actionId?: string | null;
    riskLevel?: string | null;
    mode?: string;
  }>();

  const mode = validateMode(body.mode);
  // Per spec safety rule: user-managed policies can only create allow
  // decisions. The unified resolver filters user rows to mode='allow'
  // at match time anyway — accepting other modes here would silently
  // save a no-op policy, which is confusing UX.
  if (mode !== 'allow') {
    throw new ValidationError(`User policies may only set mode='allow' (got "${mode}"). Admin-managed deny / require_approval policies live under the admin action policy API.`);
  }
  const { service, actionId, riskLevel } = validateTarget(body);

  const existing = await getActionPolicy(c.get('db'), id);
  if (existing && existing.principalId !== user.id) {
    throw new NotFoundError('Action policy override', id);
  }

  if (mode === 'allow' && service && actionId) {
    const resolvedRiskLevel = await resolveCatalogRiskLevel(c.get('db'), service, actionId);
    const explicitAdmin = await resolveAdminPolicyMatch(c.get('db'), service, actionId, resolvedRiskLevel ?? '__unknown__');
    if (explicitAdmin?.mode === 'deny') {
      throw new ValidationError('This target is denied by organization policy and cannot be allowed by a user override');
    }
  }

  const savedId = await upsertActionPolicy(c.get('db'), {
    id,
    service,
    actionId,
    riskLevel,
    mode,
    managedBy: 'user',
    principalType: 'user',
    principalId: user.id,
    subjectType: 'tool_action',
    origin: 'settings',
    createdBy: user.id,
  });

  return c.json({ ok: true, id: savedId });
});

// DELETE /api/action-policy-overrides/:id
actionPolicyOverridesRouter.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');
  const existing = await getActionPolicy(c.get('db'), id);

  if (!existing || existing.principalId !== user.id || existing.managedBy !== 'user') {
    throw new NotFoundError('Action policy override', id);
  }

  await deleteActionPolicy(c.get('db'), id);
  return c.json({ ok: true });
});

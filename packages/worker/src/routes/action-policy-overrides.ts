import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { NotFoundError, ValidationError } from '@valet/shared';
import type { ActionRiskLevel } from '@valet/shared';
import {
  deleteUserActionPolicyOverride,
  getUserActionPolicyOverride,
  listUserActionPolicyOverrides,
  resolveOrgPolicyMatch,
  upsertUserActionPolicyOverride,
} from '../lib/db.js';
import type { ActionPolicyLifetime } from '../lib/db/actions.js';
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

// GET /api/action-policy-overrides
actionPolicyOverridesRouter.get('/', async (c) => {
  const user = c.get('user');
  const rows = await listUserActionPolicyOverrides(c.get('db'), user.id);
  return c.json(rows);
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
  const { service, actionId, riskLevel } = validateTarget(body);

  const existing = await getUserActionPolicyOverride(c.get('db'), id);
  if (existing && existing.userId !== user.id) {
    throw new NotFoundError('Action policy override', id);
  }

  if (mode === 'allow' && service && actionId) {
    const resolvedRiskLevel = await resolveCatalogRiskLevel(c.get('db'), service, actionId);
    const explicitOrg = await resolveOrgPolicyMatch(c.get('db'), service, actionId, resolvedRiskLevel ?? '__unknown__');
    if (explicitOrg?.mode === 'deny') {
      throw new ValidationError('This target is denied by organization policy and cannot be allowed by a user override');
    }
  }

  const savedId = await upsertUserActionPolicyOverride(c.get('db'), {
    id,
    userId: user.id,
    service,
    actionId,
    riskLevel,
    mode,
    lifetime: 'persistent' satisfies ActionPolicyLifetime,
    source: 'settings',
  });

  return c.json({ ok: true, id: savedId });
});

// DELETE /api/action-policy-overrides/:id
actionPolicyOverridesRouter.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');
  const existing = await getUserActionPolicyOverride(c.get('db'), id);

  if (!existing || existing.userId !== user.id) {
    throw new NotFoundError('Action policy override', id);
  }

  await deleteUserActionPolicyOverride(c.get('db'), id, user.id);
  return c.json({ ok: true });
});

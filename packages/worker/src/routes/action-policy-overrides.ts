import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { NotFoundError, ValidationError } from '@valet/shared';
import {
  deleteUserActionPolicyOverride,
  getUserActionPolicyOverride,
  listUserActionPolicyOverrides,
  resolveOrgPolicyMatch,
  upsertUserActionPolicyOverride,
} from '../lib/db.js';
import type { ActionPolicyLifetime } from '../lib/db/actions.js';

export const actionPolicyOverridesRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

type OverrideMode = 'allow' | 'require_approval' | 'deny';

const VALID_MODES = new Set<OverrideMode>(['allow', 'require_approval', 'deny']);
const VALID_RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);

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

  if (riskLevel && !VALID_RISK_LEVELS.has(riskLevel)) {
    throw new ValidationError(`Invalid risk level: ${riskLevel}. Must be one of: ${Array.from(VALID_RISK_LEVELS).join(', ')}`);
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

  if (mode === 'allow') {
    const explicitOrg = service && actionId
      ? await resolveOrgPolicyMatch(c.get('db'), service, actionId, '__unknown__')
      : service
        ? await resolveOrgPolicyMatch(c.get('db'), service, '__unknown__', '__unknown__')
        : riskLevel
          ? await resolveOrgPolicyMatch(c.get('db'), '__unknown__', '__unknown__', riskLevel)
          : null;
    if (explicitOrg?.mode === 'deny') {
      throw new ValidationError('This target is denied by organization policy and cannot be allowed by a user override');
    }
  }

  await upsertUserActionPolicyOverride(c.get('db'), {
    id,
    userId: user.id,
    service,
    actionId,
    riskLevel,
    mode,
    lifetime: 'persistent' satisfies ActionPolicyLifetime,
    source: 'settings',
  });

  return c.json({ ok: true, id });
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

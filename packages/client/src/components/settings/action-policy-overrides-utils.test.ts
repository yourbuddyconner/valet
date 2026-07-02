import { describe, expect, it } from 'vitest';
import {
  canEditActionPolicyOverride,
  getActionPolicyOverrideLifetimeLabel,
  splitActionPolicyOverrides,
} from './action-policy-overrides-utils';
import type { ActionPolicyOverride } from '@valet/shared';

function override(data: Partial<ActionPolicyOverride> & Pick<ActionPolicyOverride, 'id' | 'lifetime'>): ActionPolicyOverride {
  return {
    userId: 'user-1',
    service: null,
    actionId: null,
    riskLevel: null,
    mode: 'allow',
    appliesIn: 'any',
    paramMatchers: [],
    sessionId: null,
    expiresAt: null,
    source: 'settings',
    sourceInvocationId: null,
    createdAt: '2026-05-19T00:00:00Z',
    updatedAt: '2026-05-19T00:00:00Z',
    ...data,
  };
}

describe('action policy override settings helpers', () => {
  it('allows editing only persistent overrides', () => {
    expect(canEditActionPolicyOverride(override({ id: 'persistent', lifetime: 'persistent' }))).toBe(true);
    expect(canEditActionPolicyOverride(override({ id: 'session', lifetime: 'session' }))).toBe(false);
    expect(canEditActionPolicyOverride(override({ id: 'timed', lifetime: 'timed' }))).toBe(false);
  });

  it('labels override lifetimes for settings display', () => {
    expect(getActionPolicyOverrideLifetimeLabel(override({ id: 'persistent', lifetime: 'persistent', source: 'settings' }))).toBe('Persistent');
    expect(getActionPolicyOverrideLifetimeLabel(override({ id: 'always', lifetime: 'persistent', source: 'approval_prompt' }))).toBe('Always');
    expect(getActionPolicyOverrideLifetimeLabel(override({ id: 'session', lifetime: 'session' }))).toBe('Session');
    expect(getActionPolicyOverrideLifetimeLabel(override({ id: 'timed', lifetime: 'timed' }))).toBe('Timed');
  });

  it('splits persistent settings from temporary overrides', () => {
    const settings = override({ id: 'settings', lifetime: 'persistent', source: 'settings' });
    const always = override({ id: 'always', lifetime: 'persistent', source: 'approval_prompt' });
    const session = override({ id: 'session', lifetime: 'session', source: 'approval_prompt' });
    const timed = override({ id: 'timed', lifetime: 'timed', source: 'approval_prompt' });

    expect(splitActionPolicyOverrides([session, settings, timed, always])).toEqual({
      persistent: [settings, always],
      temporary: [session, timed],
    });
  });
});

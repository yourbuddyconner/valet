import type { ActionPolicyOverride } from '@valet/shared';

export function canEditActionPolicyOverride(override: ActionPolicyOverride): boolean {
  return override.lifetime === 'persistent';
}

export function getActionPolicyOverrideLifetimeLabel(override: ActionPolicyOverride): string {
  if (override.lifetime === 'persistent') {
    return override.source === 'approval_prompt' ? 'Always' : 'Persistent';
  }
  if (override.lifetime === 'session') return 'Session';
  return 'Timed';
}

export function splitActionPolicyOverrides(overrides: ActionPolicyOverride[]): {
  persistent: ActionPolicyOverride[];
  temporary: ActionPolicyOverride[];
} {
  return {
    persistent: overrides.filter((override) => override.lifetime === 'persistent'),
    temporary: overrides.filter((override) => override.lifetime !== 'persistent'),
  };
}

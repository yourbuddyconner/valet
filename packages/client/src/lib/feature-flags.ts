/**
 * Tiny client-side feature flag system. Defaults from a baseline map; can be
 * overridden per-user via localStorage (`flag:<name> = on|off`) for dogfood.
 *
 * Replace with a real flag provider when one is available.
 */

export const FLAG_NAMES = [
  'workflow_ui_execution_v2',
  'workflow_ui_chat_cards',
] as const;

export type FlagName = (typeof FLAG_NAMES)[number] | string;

const DEFAULTS: Record<string, boolean> = {
  workflow_ui_execution_v2: false,
  workflow_ui_chat_cards: false,
};

export function isFlagEnabled(name: FlagName): boolean {
  if (typeof localStorage !== 'undefined') {
    const override = localStorage.getItem(`flag:${name}`);
    if (override === 'on') return true;
    if (override === 'off') return false;
  }
  return DEFAULTS[name] ?? false;
}

/**
 * Hook-shape wrapper for component usage. No subscription — components that
 * need live toggling can call setFlag() and force a remount themselves.
 */
export function useFeatureFlag(name: FlagName): boolean {
  return isFlagEnabled(name);
}

export function setFlag(name: FlagName, value: boolean | null): void {
  if (typeof localStorage === 'undefined') return;
  if (value === null) {
    localStorage.removeItem(`flag:${name}`);
  } else {
    localStorage.setItem(`flag:${name}`, value ? 'on' : 'off');
  }
}

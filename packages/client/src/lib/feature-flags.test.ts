import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { isFlagEnabled, setFlag, FLAG_NAMES } from './feature-flags';

// vitest 'node' environment has no localStorage — install a minimal in-memory shim.
beforeAll(() => {
  if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map<string, string>();
    (globalThis as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size; },
    };
  }
});

describe('isFlagEnabled', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns false by default for unknown flags', () => {
    expect(isFlagEnabled('does_not_exist')).toBe(false);
  });

  it('returns true when localStorage override is "on"', () => {
    localStorage.setItem('flag:workflow_ui_execution_v2', 'on');
    expect(isFlagEnabled('workflow_ui_execution_v2')).toBe(true);
  });

  it('returns false when localStorage override is "off"', () => {
    localStorage.setItem('flag:workflow_ui_execution_v2', 'off');
    expect(isFlagEnabled('workflow_ui_execution_v2')).toBe(false);
  });

  it('setFlag(name, null) removes the override', () => {
    setFlag('workflow_ui_execution_v2', true);
    expect(isFlagEnabled('workflow_ui_execution_v2')).toBe(true);
    setFlag('workflow_ui_execution_v2', null);
    expect(isFlagEnabled('workflow_ui_execution_v2')).toBe(false);
  });

  it('exposes the canonical flag list', () => {
    expect(FLAG_NAMES).toContain('workflow_ui_execution_v2');
    expect(FLAG_NAMES).toContain('workflow_ui_chat_cards');
  });
});

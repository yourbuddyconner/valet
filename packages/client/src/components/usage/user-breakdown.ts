/**
 * Pure helpers for the per-user usage breakdown drill-down.
 * Kept separate from the component so the grouping/label logic is unit-testable.
 */

export interface UserModelRow {
  userId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
  callCount: number;
}

/**
 * Group per-user-per-model rows by userId, preserving input order.
 * The API returns rows sorted by token volume desc, so each user's models stay
 * in that order — biggest model first.
 */
export function groupModelsByUser(rows: UserModelRow[]): Map<string, UserModelRow[]> {
  const map = new Map<string, UserModelRow[]>();
  for (const row of rows) {
    const list = map.get(row.userId);
    if (list) list.push(row);
    else map.set(row.userId, [row]);
  }
  return map;
}

/**
 * Display label for a model id: strip the provider prefix (`anthropic/claude-x`
 * → `claude-x`) and fall back to "unknown" for empty/missing ids so the
 * drill-down never renders a blank or literal "null" row.
 */
export function formatModelLabel(model: string | null | undefined): string {
  const id = (model ?? '').trim();
  if (!id) return 'unknown';
  const slash = id.indexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id;
}

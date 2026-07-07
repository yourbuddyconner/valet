/**
 * Small shared helpers for executors that render templates into string
 * arguments. Single source of truth so multiple executors don't drift
 * (set/stop/llm/orchestrator/session each used to define their own
 * coerceString — at least one was missing the object-stringify branch
 * and silently produced `[object Object]`).
 */

/**
 * Coerce a rendered template value to the string the executor passes to
 * the integration / DO / LLM. Objects and arrays become JSON; primitives
 * become their string form; null/undefined become an empty string.
 *
 * NB: this is for string-typed sinks (prompt, summary, threadId, etc.).
 * For structured-value preservation use `renderTemplate` directly.
 */
export function coerceTemplateString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

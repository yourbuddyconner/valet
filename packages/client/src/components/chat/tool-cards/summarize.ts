/**
 * Shared header-summary derivation for tool cards.
 *
 * Both the lightweight `SummaryToolCard` (rendered while the
 * specialised card chunk lazy-loads) and the `GenericCard` (rendered
 * once expanded) need to produce the same one-line summary so the
 * collapsed → expanded transition doesn't add or remove information.
 *
 * The summary always tries to combine an `argHint` ("what was asked
 * for") with a `resultHint` ("what came back"), joined with `·`. Either
 * half can stand alone if the other isn't available.
 */
import { decode as decodeToon } from '@toon-format/toon';
import type { ToolCallData } from './types';

const ARG_PRIORITY = [
  // Search-style args first — for list/search tools we want the user
  // to see *what they searched for* above the fold.
  'query', 'q', 'search', 'pattern',
  // Action targets / payloads.
  'description', 'command', 'message', 'url', 'name', 'title',
  // Filesystem / path-ish.
  'file_path', 'filePath', 'path',
  // Scoping args common in API-shaped tools.
  'service', 'integration', 'provider', 'category', 'kind',
  'workflowId', 'workflow_id', 'executionId', 'execution_id',
  'id', 'slug',
  // Dispatch wrappers.
  'tool_id',
];

const RESULT_ARRAY_KEYS = [
  'results', 'items', 'matches', 'workflows', 'executions',
  'tools', 'triggers', 'rows', 'records', 'data',
];

const RESULT_NAME_KEYS = ['name', 'title', 'status', 'message', 'id'];

export function getToolSummary(tool: ToolCallData): string | null {
  const argsObj = asRecord(tool.args);

  // On failure, override the arg hint with the actual error message —
  // the user's immediate need is to see *why it broke*, not what they
  // asked for. The arg hint is still visible in the expanded args
  // panel, so nothing is hidden, just re-prioritised above the fold.
  if (tool.status === 'error') {
    const errMsg = extractErrorMessage(tool.result);
    const argHint = extractArgHint(tool, argsObj);
    if (errMsg && argHint) return `${argHint} → ${errMsg}`;
    if (errMsg) return errMsg;
    // fall through to normal summary if we couldn't isolate a message
  }

  const argHint = extractArgHint(tool, argsObj);
  const resultHint = extractResultHint(tool.result);
  if (argHint && resultHint) return `${argHint} · ${resultHint}`;
  return argHint ?? resultHint;
}

function extractErrorMessage(rawResult: unknown): string | null {
  if (rawResult == null) return null;
  if (typeof rawResult === 'string') {
    return clipError(stripErrorPrefix(rawResult));
  }
  if (typeof rawResult === 'object') {
    const obj = rawResult as Record<string, unknown>;
    for (const key of ['error', 'message', 'detail', 'reason']) {
      const val = obj[key];
      if (typeof val === 'string' && val.length > 0) {
        return clipError(stripErrorPrefix(val));
      }
      // Some shapes wrap: { error: { message: "..." } }
      if (val && typeof val === 'object') {
        const inner = (val as Record<string, unknown>).message;
        if (typeof inner === 'string' && inner.length > 0) {
          return clipError(stripErrorPrefix(inner));
        }
      }
    }
  }
  return null;
}

function stripErrorPrefix(s: string): string {
  // Tool errors often arrive as "Error: foo" or "ToolError: foo" —
  // strip the redundant prefix so the visible part is the *cause*.
  return s.replace(/^([A-Z][A-Za-z]*Error|Error):\s*/, '').trim();
}

function clipError(s: string): string {
  // Errors can include long stack traces; we only want the first line
  // (the actual message) above the fold.
  const firstLine = s.split('\n', 1)[0] ?? '';
  return firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractArgHint(tool: ToolCallData, argsObj: Record<string, unknown> | null): string | null {
  if (tool.toolName === 'call_tool' && argsObj?.tool_id) {
    return String(argsObj.tool_id);
  }
  if (!argsObj) return null;

  // 1. Try the priority list — these are the keys users overwhelmingly
  //    care about for the collapsed summary.
  for (const key of ARG_PRIORITY) {
    const hint = formatArgValue(argsObj[key]);
    if (hint) return hint;
  }

  // 2. Fall back to the first short scalar arg. Tools with a single
  //    obvious parameter (a UUID, a flag, a key) shouldn't get a blank
  //    header just because their key name isn't in the priority list.
  for (const [key, val] of Object.entries(argsObj)) {
    const hint = formatArgValue(val);
    if (hint) return `${key}: ${hint}`;
  }

  return null;
}

function formatArgValue(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) {
    return value.length > 80 ? value.slice(0, 80) + '…' : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

/**
 * Public wrapper around extractResultHint for shell-side auto-enrich.
 * Skipped on `error` and `running`/`pending` because:
 *   - on error, the summary will already carry the failure message and
 *     a "12 results" tail would be misleading;
 *   - while running, the result isn't final.
 */
export function getResultTail(rawResult: unknown, status: ToolCallData['status']): string | null {
  if (status === 'error' || status === 'pending' || status === 'running') return null;
  return extractResultHint(rawResult);
}

function extractResultHint(rawResult: unknown): string | null {
  const parsed = tryParseStructured(rawResult);

  // Even if we couldn't decode, a TOON array header `[N]:` still tells
  // us the row count cheaply.
  if (parsed == null) {
    if (typeof rawResult === 'string') {
      const m = /^\s*\[(\d+)\]/.exec(rawResult);
      if (m) return `${m[1]} result${m[1] === '1' ? '' : 's'}`;
    }
    return null;
  }

  if (Array.isArray(parsed)) {
    return `${parsed.length} result${parsed.length === 1 ? '' : 's'}`;
  }
  if (typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    for (const arrKey of RESULT_ARRAY_KEYS) {
      const arr = obj[arrKey];
      if (Array.isArray(arr)) return `${arr.length} ${arrKey}`;
    }
    for (const key of RESULT_NAME_KEYS) {
      const val = obj[key];
      if (typeof val === 'string' && val.length > 0) {
        return val.length > 60 ? val.slice(0, 60) + '…' : val;
      }
    }
  }
  return null;
}

function tryParseStructured(value: unknown): unknown | null {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    try {
      return decodeToon(value);
    } catch {
      return null;
    }
  }
}

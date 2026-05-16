/**
 * Template interpolation for workflow step fields.
 *
 * Resolves `{{path.to.value}}` tokens against trigger variables and prior step outputs
 * before each step executes. Missing paths render as empty strings and are reported so
 * authors can spot silent misspellings without the workflow hard-failing.
 *
 * Supported root namespaces: `variables`, `outputs`. Other roots are treated as missing.
 */

export interface InterpolationContext {
  variables: Record<string, unknown>;
  outputs: Record<string, unknown>;
}

export interface InterpolationResult {
  text: string;
  missingPaths: string[];
}

const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function resolveInterpolation(
  template: string,
  ctx: InterpolationContext,
): InterpolationResult {
  if (typeof template !== "string" || template.length === 0) {
    return { text: template ?? "", missingPaths: [] };
  }

  const missingPaths: string[] = [];
  const text = template.replace(TOKEN_RE, (_match, rawPath: string) => {
    const path = rawPath.trim();
    const [root, ...rest] = path.split(".");
    if (root !== "variables" && root !== "outputs") {
      missingPaths.push(path);
      return "";
    }
    const source = root === "variables" ? ctx.variables : ctx.outputs;
    const value = walkPath(source, rest);
    if (value === undefined) {
      missingPaths.push(path);
      return "";
    }
    return renderValue(value);
  });

  return { text, missingPaths };
}

export function resolveStepFields<S extends Record<string, unknown>>(
  step: S,
  ctx: InterpolationContext,
): { step: S; missingPaths: string[] } {
  const missingPaths: string[] = [];
  const resolved = { ...(step as Record<string, unknown>) };

  for (const key of STEP_STRING_FIELDS) {
    const value = resolved[key];
    if (typeof value === "string") {
      const r = resolveInterpolation(value, ctx);
      resolved[key] = r.text;
      missingPaths.push(...r.missingPaths);
    }
  }

  const args = resolved.arguments;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const resolvedArgs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      if (typeof v === "string") {
        const r = resolveInterpolation(v, ctx);
        resolvedArgs[k] = r.text;
        missingPaths.push(...r.missingPaths);
      } else {
        resolvedArgs[k] = v;
      }
    }
    resolved.arguments = resolvedArgs;
  }

  return { step: resolved as S, missingPaths };
}

const STEP_STRING_FIELDS = [
  "command",
  "prompt",
  "content",
  "message",
  "condition",
  "goal",
  "context",
] as const;

function walkPath(source: unknown, path: string[]): unknown {
  let cursor: unknown = source;
  for (const segment of path) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function renderValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

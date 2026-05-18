/**
 * Template interpolation for workflow step fields.
 *
 * Resolves `{{path.to.value}}` tokens against trigger variables and prior step outputs
 * before each step executes. Missing paths render as empty strings and are reported so
 * authors can spot silent misspellings without the workflow hard-failing.
 *
 * Supported root namespaces: `variables`, `outputs`, and `loop` (sourced from
 * `ctx.variables.loop` when a loop step is active). Other roots are treated as missing.
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
    if (root !== "variables" && root !== "outputs" && root !== "loop") {
      missingPaths.push(path);
      return "";
    }
    // `loop` is a convenience alias for `variables.loop` — populated by the
    // workflow engine each iteration so authors can write {{loop.item}}.
    const source =
      root === "variables"
        ? ctx.variables
        : root === "outputs"
          ? ctx.outputs
          : ctx.variables.loop && typeof ctx.variables.loop === "object"
            ? (ctx.variables.loop as Record<string, unknown>)
            : {};
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

  // Bash commands skip standard string interpolation. The workflow engine
  // calls `resolveBashCommand` separately, which routes `{{path}}` values
  // through env vars instead of splicing them into the shell string (prevents
  // shell-metacharacter injection from untrusted webhook payloads). See
  // `executeBashToolStep` for the security model.
  const isBashStep = resolved.type === "bash"
    || (resolved.type === "tool" && resolved.tool === "bash");

  for (const key of STEP_STRING_FIELDS) {
    if (isBashStep && key === "command") continue;
    const value = resolved[key];
    if (typeof value === "string") {
      const r = resolveInterpolation(value, ctx);
      resolved[key] = r.text;
      missingPaths.push(...r.missingPaths);
    }
  }

  const args = resolved.arguments;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    // Tool args frequently contain nested objects (e.g. `{ url: { live: "{{x}}" } }`).
    // Walk the whole tree so any string at any depth gets interpolated.
    // For bash tool steps, skip the `command` arg — same reason as above.
    const argsRecord = args as Record<string, unknown>;
    if (isBashStep && "command" in argsRecord) {
      const { command, ...rest } = argsRecord;
      const resolvedRest = resolveValue(rest, ctx, missingPaths) as Record<string, unknown>;
      resolved.arguments = { ...resolvedRest, command };
    } else {
      resolved.arguments = resolveValue(args, ctx, missingPaths);
    }
  }

  return { step: resolved as S, missingPaths };
}

/**
 * Bash-safe interpolation. Returns a rewritten command where every `{{path}}`
 * token is replaced with a shell variable reference (`"$VALET_TPL_N"`), and a
 * map of those env var names to their resolved string values.
 *
 * SECURITY: This is the ONLY safe way to inline workflow values into a bash
 * step's `command` field. Values flow through the OS env table, not the shell
 * parser, so untrusted payload content cannot inject shell metacharacters.
 * The replacement uses `"$VAR"` (double-quoted) so each expansion is a single
 * argument even if the value contains whitespace.
 */
export interface BashInterpolationResult {
  command: string;
  env: Record<string, string>;
  missingPaths: string[];
}

export function resolveBashCommand(
  template: string,
  ctx: InterpolationContext,
): BashInterpolationResult {
  if (typeof template !== "string" || template.length === 0) {
    return { command: template ?? "", env: {}, missingPaths: [] };
  }

  const missingPaths: string[] = [];
  const env: Record<string, string> = {};
  let counter = 0;

  const command = template.replace(TOKEN_RE, (_match, rawPath: string) => {
    const path = rawPath.trim();
    const [root, ...rest] = path.split(".");
    let value: unknown;
    if (root === "variables") {
      value = walkPath(ctx.variables, rest);
    } else if (root === "outputs") {
      value = walkPath(ctx.outputs, rest);
    } else if (root === "loop") {
      const loop = ctx.variables.loop && typeof ctx.variables.loop === "object"
        ? (ctx.variables.loop as Record<string, unknown>)
        : {};
      value = walkPath(loop, rest);
    } else {
      missingPaths.push(path);
      const varName = `VALET_TPL_${counter++}`;
      env[varName] = "";
      return `"$${varName}"`;
    }

    if (value === undefined) {
      missingPaths.push(path);
      const varName = `VALET_TPL_${counter++}`;
      env[varName] = "";
      return `"$${varName}"`;
    }

    const varName = `VALET_TPL_${counter++}`;
    env[varName] = renderValue(value);
    return `"$${varName}"`;
  });

  return { command, env, missingPaths };
}

function resolveValue(
  value: unknown,
  ctx: InterpolationContext,
  missingPaths: string[],
): unknown {
  if (typeof value === "string") {
    const r = resolveInterpolation(value, ctx);
    missingPaths.push(...r.missingPaths);
    return r.text;
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveValue(v, ctx, missingPaths));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveValue(v, ctx, missingPaths);
    }
    return out;
  }
  return value;
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

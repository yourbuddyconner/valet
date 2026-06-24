/**
 * Convert a Zod schema to JSON Schema for the workflow editor's tool node.
 *
 * Why this exists separately from `serializeZodSchema` (in session-tools.ts):
 * that one emits a flat `{ key: { type, required, description } }` map for
 * the agent's tool-listing protocol. The workflow editor speaks real JSON
 * Schema — `{ type: 'object', properties: {…}, required: […] }` — so the
 * tool node's inspector can render input parameters with the same SchemaTree
 * it uses for GitHub's hand-authored output schemas.
 *
 * Coverage: the Zod constructs that appear across the integration plugins
 * today — object, string, number, boolean, enum, literal, array, optional,
 * default, nullable, union, record. Anything we don't recognize falls
 * through to `{}` so a partial conversion is always better than a thrown
 * error in the catalog endpoint.
 */

import type { z } from 'zod';

interface ZodLike {
  _def?: {
    typeName?: string;
    description?: string;
    shape?: () => Record<string, ZodLike>;
    innerType?: ZodLike;
    defaultValue?: unknown;
    type?: ZodLike;
    values?: readonly string[];
    value?: unknown;
    options?: ZodLike[] | readonly string[];
    valueType?: ZodLike;
    checks?: Array<{ kind: string; value?: unknown; regex?: RegExp }>;
  };
  description?: string;
}

export function zodToJsonSchema(schema: z.ZodType | undefined): Record<string, unknown> {
  if (!schema) return {};
  return convert(schema as unknown as ZodLike);
}

function convert(node: ZodLike): Record<string, unknown> {
  const description = node._def?.description ?? node.description;
  const base = description ? { description } : {};
  const tn = node._def?.typeName;

  switch (tn) {
    case 'ZodObject': {
      const shape = node._def?.shape?.() ?? {};
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const { schema: inner, required: req } = unwrap(value);
        properties[key] = convert(inner);
        if (req) required.push(key);
      }
      return {
        ...base,
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      };
    }

    case 'ZodString': {
      return { ...base, type: 'string' };
    }

    case 'ZodNumber': {
      // ZodNumber.int() check → JSON Schema integer
      const isInt = node._def?.checks?.some((c) => c.kind === 'int');
      return { ...base, type: isInt ? 'integer' : 'number' };
    }

    case 'ZodBoolean':
      return { ...base, type: 'boolean' };

    case 'ZodEnum': {
      const values = (node._def?.values ?? []) as readonly string[];
      return { ...base, type: 'string', enum: [...values] };
    }

    case 'ZodNativeEnum': {
      const values = Object.values((node._def as { values?: Record<string, unknown> })?.values ?? {});
      return { ...base, type: 'string', enum: values };
    }

    case 'ZodLiteral': {
      const value = node._def?.value;
      const type = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
      return { ...base, type, enum: [value] };
    }

    case 'ZodArray': {
      const itemSchema = node._def?.type;
      return {
        ...base,
        type: 'array',
        ...(itemSchema ? { items: convert(itemSchema) } : {}),
      };
    }

    case 'ZodRecord': {
      const value = node._def?.valueType;
      return {
        ...base,
        type: 'object',
        ...(value ? { additionalProperties: convert(value) } : { additionalProperties: true }),
      };
    }

    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options = (node._def?.options as ZodLike[] | undefined) ?? [];
      const converted = options.map((o) => convert(o));
      return { ...base, anyOf: converted };
    }

    case 'ZodOptional':
    case 'ZodDefault':
    case 'ZodNullable': {
      const inner = node._def?.innerType;
      return inner ? convert(inner) : base;
    }

    case 'ZodAny':
    case 'ZodUnknown':
      return { ...base };

    default:
      return { ...base };
  }
}

// Unwrap optional/default/nullable wrappers to find the inner schema and
// whether the original was required.
function unwrap(node: ZodLike): { schema: ZodLike; required: boolean } {
  let current = node;
  let required = true;
  while (current?._def) {
    const tn = current._def.typeName;
    if (tn === 'ZodOptional' || tn === 'ZodDefault') {
      required = false;
      current = current._def.innerType!;
    } else if (tn === 'ZodNullable') {
      current = current._def.innerType!;
    } else {
      break;
    }
  }
  return { schema: current, required };
}

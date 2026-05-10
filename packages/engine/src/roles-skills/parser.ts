/**
 * Minimal markdown + YAML-frontmatter parser for role and skill artifacts.
 *
 * The frontmatter we care about is shallow `key: value` pairs. We do NOT
 * support nested objects, multi-line strings, or YAML anchors — if a
 * future role/skill needs them, swap in `gray-matter` and tighten this
 * module's API.
 */

export interface ParsedArtifact {
  frontmatter: Record<string, string | boolean | number>;
  body: string;
}

const FRONTMATTER_OPEN = /^---\s*\n/;
const FRONTMATTER_CLOSE = /\n---\s*(?:\n|$)/;

export function parseMarkdownArtifact(content: string): ParsedArtifact {
  const open = content.match(FRONTMATTER_OPEN);
  if (!open || open.index !== 0) {
    return { frontmatter: {}, body: content };
  }
  const after = content.slice(open[0].length);
  const close = after.match(FRONTMATTER_CLOSE);
  if (!close || close.index === undefined) {
    return { frontmatter: {}, body: content };
  }
  const fmText = after.slice(0, close.index);
  const body = after.slice(close.index + close[0].length);
  return { frontmatter: parseFrontmatter(fmText), body };
}

function parseFrontmatter(text: string): Record<string, string | boolean | number> {
  const out: Record<string, string | boolean | number> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const valueRaw = line.slice(colon + 1).trim();
    out[key] = parseValue(valueRaw);
  }
  return out;
}

function parseValue(raw: string): string | boolean | number {
  if (raw === "") return "";
  // Strip matching surrounding quotes.
  const stripped =
    (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1)
      : raw;
  if (stripped === raw) {
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
    if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
  }
  return stripped;
}

/**
 * Replace `{{name}}` placeholders with the corresponding value from `args`.
 * Whitespace inside the braces is allowed (`{{ name }}`). Unknown names
 * are left as-is rather than rendered as "undefined" so authoring errors
 * are visible to the LLM rather than silently swallowed.
 */
export function renderTemplate(body: string, args: Record<string, unknown> = {}): string {
  return body.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(args, name)) {
      const v = args[name];
      return v === undefined || v === null ? "" : String(v);
    }
    return match;
  });
}

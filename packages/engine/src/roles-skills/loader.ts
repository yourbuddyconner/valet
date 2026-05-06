import type { TSchema } from "typebox";
import type { RoleSpec, SkillSource } from "../types.js";
import { parseMarkdownArtifact } from "./parser.js";

/**
 * Build a RoleSpec from a markdown blob. Frontmatter keys honored:
 *   name (required)
 *   description (optional)
 *   model (optional — string id, applied when this role is selected for a prompt)
 */
export function loadRoleFromMarkdown(
  content: string,
  source: RoleSpec["source"] = "session",
  fallbackName?: string,
): RoleSpec {
  const parsed = parseMarkdownArtifact(content);
  const name = String(parsed.frontmatter.name ?? fallbackName ?? "");
  if (!name) {
    throw new Error(
      "loadRoleFromMarkdown: frontmatter.name is required (or pass fallbackName).",
    );
  }
  const description = parsed.frontmatter.description;
  const model = parsed.frontmatter.model;
  return {
    name,
    description: typeof description === "string" ? description : undefined,
    model: typeof model === "string" ? model : undefined,
    content: parsed.body.trimStart(),
    source,
  };
}

/**
 * Build a SkillSource from a markdown blob. Frontmatter:
 *   name (required)
 *   description (optional)
 * argsSchema is supplied separately by the caller — markdown frontmatter
 * is the wrong place for it.
 */
export function loadSkillFromMarkdown(
  content: string,
  source: SkillSource["source"] = "plugin",
  fallbackName?: string,
  argsSchema?: TSchema,
): SkillSource {
  const parsed = parseMarkdownArtifact(content);
  const name = String(parsed.frontmatter.name ?? fallbackName ?? "");
  if (!name) {
    throw new Error(
      "loadSkillFromMarkdown: frontmatter.name is required (or pass fallbackName).",
    );
  }
  const description = parsed.frontmatter.description;
  return {
    name,
    description: typeof description === "string" ? description : undefined,
    argsSchema,
    content: parsed.body.trimStart(),
    source,
  };
}

import { automationProposalRenderer } from "./automation-proposal";
/**
 * Tool-renderer registry.
 *
 * Each renderer claims one or more tool names and contributes a custom Body
 * for that tool's args/result. The fallback renderer matches everything, so
 * unknown plugin tools always render reasonably.
 *
 * Adding a renderer for a plugin tool: build a `ToolRenderer` (see
 * `./types.ts`), then add it to the `RENDERERS` array below — order matters,
 * first match wins. The fallback MUST stay last.
 */
import { bashRenderer } from "./bash";
import { browserRenderer } from "./browser";
import { editRenderer } from "./edit";
import { fallbackRenderer } from "./fallback";
import { findReplaceRenderer } from "./find-replace";
import { memPatchRenderer } from "./mem-patch";
import { memReadRenderer } from "./mem-read";
import { memShareRenderer } from "./mem-share";
import { memWriteRenderer } from "./mem-write";
import { openaiMediaRenderer } from "./openai-media";
import { readRenderer } from "./read";
import { securityRenderers } from "./security";
import { skillRenderer } from "./skill";
import { threadReadRenderer } from "./thread-read";
import { workflowRenderer } from "./workflow";
import { writeRenderer } from "./write";
import { matches, type ToolRenderer } from "./types";

const RENDERERS: ToolRenderer[] = [
  bashRenderer,
  browserRenderer,
  readRenderer,
  writeRenderer,
  editRenderer,
  memPatchRenderer,
  memReadRenderer,
  memShareRenderer,
  memWriteRenderer,
  skillRenderer,
  threadReadRenderer,
  automationProposalRenderer,
  workflowRenderer,
  findReplaceRenderer,
  openaiMediaRenderer,
  // The `sec_*` engagement tools (specific cards first, then the family
  // catch-all) — before the fallback, per the registry rule.
  ...securityRenderers,
  // … add plugin-specific renderers here as the ecosystem grows.
  fallbackRenderer,
];

export function pickRenderer(toolName: string, args?: unknown): ToolRenderer {
  for (const r of RENDERERS) {
    if (matches(r, toolName, args)) return r;
  }
  return fallbackRenderer;
}

export { ToolShell, ToolBody, TruncatedText, PathLabel } from "./tool-shell";
export type { ToolRenderer, ToolCategory, ToolStatus, ToolRendererProps } from "./types";

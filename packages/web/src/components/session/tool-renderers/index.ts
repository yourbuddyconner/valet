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
import { editRenderer } from "./edit";
import { fallbackRenderer } from "./fallback";
import { readRenderer } from "./read";
import { threadReadRenderer } from "./thread-read";
import { writeRenderer } from "./write";
import { matches, type ToolRenderer } from "./types";

const RENDERERS: ToolRenderer[] = [
  bashRenderer,
  readRenderer,
  writeRenderer,
  editRenderer,
  threadReadRenderer,
  // … add plugin-specific renderers here as the ecosystem grows.
  fallbackRenderer,
];

export function pickRenderer(toolName: string): ToolRenderer {
  for (const r of RENDERERS) {
    if (matches(r, toolName)) return r;
  }
  return fallbackRenderer;
}

export { ToolShell, ToolBody, TruncatedText, PathLabel } from "./tool-shell";
export type { ToolRenderer, ToolCategory, ToolStatus, ToolRendererProps } from "./types";

import { ToolCardShell, ToolCardSection } from './tool-card-shell';
import { WrenchIcon } from './icons';
import type { ToolCallData } from './types';
import { getToolSummary } from './summarize';
import { ToolPayload, tryParseJson } from '@/components/payload/tool-payload';

/**
 * When the tool is `call_tool`, the args reaching us look like:
 *   { tool_id: "...", summary: "...", params: { ... } }
 * The first two are already represented in the card header. Unwrap to
 * the `params` payload so the args panel shows the dispatched tool's
 * actual input. If `params` is missing (rare), fall back to the raw
 * args object.
 */
function unwrapCallToolArgs(tool: ToolCallData): unknown {
  if (tool.toolName !== 'call_tool') return tool.args;
  if (!tool.args || typeof tool.args !== 'object') return tool.args;
  const obj = tool.args as Record<string, unknown>;
  const params = obj.params;
  if (params === undefined) return tool.args;
  // params can arrive as a JSON-encoded string (server-side wrapping);
  // ToolPayload's normalisePayload will deal with that.
  return params;
}

export function GenericCard({ tool }: { tool: ToolCallData }) {
  const hasArgs = tool.args != null && (typeof tool.args !== 'object' || Object.keys(tool.args as object).length > 0);
  const hasResult = tool.result != null && tool.result !== '';
  const summary = getToolSummary(tool);
  const displayArgs = unwrapCallToolArgs(tool);

  return (
    <ToolCardShell
      icon={<WrenchIcon className="h-3.5 w-3.5" />}
      label={tool.toolName}
      status={tool.status}
      result={tool.result}
      tool={tool}
      summary={summary ? (
        <span className="text-neutral-500 dark:text-neutral-400">{summary}</span>
      ) : undefined}
    >
      {(hasArgs || hasResult) && (
        <>
          {hasArgs && (
            <ToolCardSection label="arguments">
              <ToolPayload value={displayArgs} />
            </ToolCardSection>
          )}
          {hasResult && (
            <ToolCardSection label="result" className="border-t border-neutral-100 dark:border-neutral-800">
              <ToolPayload value={tryParseJson(tool.result) ?? tool.result} />
            </ToolCardSection>
          )}
        </>
      )}
    </ToolCardShell>
  );
}

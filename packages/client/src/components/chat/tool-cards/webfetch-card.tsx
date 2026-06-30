import { ToolCardShell, ToolCardSection, ToolCodeBlock } from './tool-card-shell';
import { GlobeIcon } from './icons';
import type { ToolCallData, WebFetchArgs } from './types';

export function WebFetchCard({ tool }: { tool: ToolCallData }) {
  const args = (tool.args ?? {}) as WebFetchArgs;
  const url = args.url ?? '';
  const prompt = args.prompt;

  const resultStr = tool.result != null
    ? (typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result, null, 2))
    : null;

  // Extract hostname for display
  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = url;
  }

  return (
    <ToolCardShell
      icon={<GlobeIcon className="h-3.5 w-3.5" />}
      label="webfetch"
      status={tool.status}
      tool={tool}
      summary={
        <span className="flex items-center gap-1.5">
          <span className="font-semibold text-neutral-600 dark:text-neutral-300">{hostname}</span>
          {prompt && (
            <span className="text-neutral-400 dark:text-neutral-500">
              {prompt.length > 60 ? prompt.slice(0, 60) + '...' : prompt}
            </span>
          )}
        </span>
      }
    >
      {(url || resultStr) && (
        <>
          {url && (
            <ToolCardSection label="url">
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all font-mono text-[11px] text-accent hover:underline"
              >
                {url}
              </a>
              {prompt && (
                <p className="mt-1 font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
                  {prompt}
                </p>
              )}
            </ToolCardSection>
          )}
          {resultStr && (
            <ToolCardSection label="result" className="border-t border-neutral-100 dark:border-neutral-800">
              <ToolCodeBlock maxHeight="240px">
                {resultStr.length > 3000 ? resultStr.slice(0, 3000) + '\n... (truncated)' : resultStr}
              </ToolCodeBlock>
            </ToolCardSection>
          )}
        </>
      )}
    </ToolCardShell>
  );
}

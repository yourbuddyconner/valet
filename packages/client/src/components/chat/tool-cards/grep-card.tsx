import { ToolCardShell, ToolCardSection } from './tool-card-shell';
import { GrepIcon } from './icons';
import type { ToolCallData, GrepArgs } from './types';

export function GrepCard({ tool }: { tool: ToolCallData }) {
  const args = (tool.args ?? {}) as GrepArgs;
  const pattern = args.pattern ?? '';
  const path = args.path;
  const glob = args.glob ?? args.include;

  const resultStr = typeof tool.result === 'string' ? tool.result : null;
  const lines = resultStr ? resultStr.split('\n').filter(Boolean) : [];

  return (
    <ToolCardShell
      icon={<GrepIcon className="h-3.5 w-3.5" />}
      label="grep"
      status={tool.status}
      tool={tool}
      summary={
        <span className="flex items-center gap-1.5">
          <code className="font-semibold text-neutral-600 dark:text-neutral-300">/{pattern}/</code>
          {glob && (
            <span className="text-neutral-400 dark:text-neutral-500">{glob}</span>
          )}
          {path && (
            <span className="text-neutral-400 dark:text-neutral-500">
              in {path}
            </span>
          )}
          {lines.length > 0 && (
            <span className="text-neutral-400 dark:text-neutral-500">
              {lines.length} {lines.length === 1 ? 'result' : 'results'}
            </span>
          )}
        </span>
      }
    >
      {lines.length > 0 && (
        <ToolCardSection>
          <div className="overflow-auto rounded bg-neutral-50 dark:bg-neutral-900/50" style={{ maxHeight: '260px' }}>
            <div className="font-mono text-[11px] leading-[1.6]">
              {lines.map((line, i) => {
                // Try to parse grep output: "file:line:content" or "file:content"
                const parsed = parseGrepLine(line);
                return (
                  <div
                    key={i}
                    className="flex border-b border-neutral-100 last:border-0 dark:border-neutral-800/60"
                  >
                    {parsed.file && (
                      <span className="shrink-0 border-r border-neutral-200 px-2 py-0.5 text-neutral-400 dark:border-neutral-700/60 dark:text-neutral-500">
                        {parsed.file}
                      </span>
                    )}
                    {parsed.lineNum && (
                      <span className="shrink-0 select-none border-r border-neutral-200 px-1.5 py-0.5 text-right tabular-nums text-neutral-300 dark:border-neutral-700/60 dark:text-neutral-600">
                        {parsed.lineNum}
                      </span>
                    )}
                    <span className="flex-1 px-2 py-0.5 whitespace-pre text-neutral-600 dark:text-neutral-400">
                      {parsed.content}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </ToolCardSection>
      )}
    </ToolCardShell>
  );
}

function parseGrepLine(line: string): { file?: string; lineNum?: string; content: string } {
  // file:linenum:content
  const m = line.match(/^(.+?):(\d+):(.*)$/);
  if (m) return { file: m[1], lineNum: m[2], content: m[3] };

  // file:content (no line number)
  const m2 = line.match(/^(.+?):(.*)$/);
  if (m2 && !m2[1].includes(' ')) return { file: m2[1], content: m2[2] };

  return { content: line };
}

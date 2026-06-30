import { ToolCardShell, ToolCardSection } from './tool-card-shell';
import { TerminalIcon } from './icons';
import type { ToolCallData, BashArgs } from './types';

export function BashCard({ tool }: { tool: ToolCallData }) {
  const args = (tool.args ?? {}) as BashArgs;
  const command = args.command ?? '';
  const description = args.description;

  const resultStr = typeof tool.result === 'string' ? tool.result : null;
  const exitCode = extractExitCode(resultStr);
  const output = resultStr;

  return (
    <ToolCardShell
      icon={<TerminalIcon className="h-3.5 w-3.5" />}
      label="bash"
      status={tool.status}
      tool={tool}
      summary={
        description ? (
          <span className="text-neutral-500 dark:text-neutral-400">{description}</span>
        ) : command ? (
          <code className="text-neutral-500 dark:text-neutral-400">
            {command.length > 80 ? command.slice(0, 80) + '...' : command}
          </code>
        ) : undefined
      }
    >
      <ToolCardSection>
        {/* Command prompt */}
        <div className="overflow-auto rounded bg-neutral-900 dark:bg-neutral-950" style={{ maxHeight: '320px' }}>
          {/* Command line */}
          <div className="flex items-start gap-0 border-b border-neutral-800 px-3 py-2">
            <span className="shrink-0 select-none font-mono text-[11px] text-emerald-500">$</span>
            <pre className="ml-2 flex-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-[1.6] text-neutral-200">
              {command}
            </pre>
          </div>
          {/* Output */}
          {output && (
            <pre className="px-3 py-2 font-mono text-[11px] leading-[1.6] text-neutral-400">
              {output.length > 3000 ? output.slice(0, 3000) + '\n... (truncated)' : output}
            </pre>
          )}
        </div>
        {/* Exit code */}
        {exitCode !== null && exitCode !== 0 && (
          <p className="mt-1.5 font-mono text-[10px] text-red-400">
            exit {exitCode}
          </p>
        )}
      </ToolCardSection>
    </ToolCardShell>
  );
}

function extractExitCode(result: string | null): number | null {
  if (!result) return null;
  const match = result.match(/exit code[:\s]*(\d+)/i) || result.match(/^(\d+)$/m);
  return match ? parseInt(match[1], 10) : null;
}

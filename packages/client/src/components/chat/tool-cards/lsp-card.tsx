import { ToolCardShell, ToolCardSection, ToolCodeBlock } from './tool-card-shell';
import { LspIcon } from './icons';
import type { ToolCallData, LspArgs } from './types';
import { formatToolPath } from './path-display';

const OP_LABELS: Record<string, string> = {
  goToDefinition: 'Go to Definition',
  findReferences: 'Find References',
  hover: 'Hover',
  documentSymbol: 'Document Symbols',
  workspaceSymbol: 'Workspace Symbols',
  goToImplementation: 'Go to Implementation',
  prepareCallHierarchy: 'Call Hierarchy',
  incomingCalls: 'Incoming Calls',
  outgoingCalls: 'Outgoing Calls',
};

export function LspCard({ tool }: { tool: ToolCallData }) {
  const args = (tool.args ?? {}) as LspArgs;
  const operation = args.operation ?? '';
  const filePath = args.file_path ?? args.filePath ?? '';
  const { fileName, dirPath } = formatToolPath(filePath);
  const line = args.line;
  const character = args.character;
  const symbol = args.symbol ?? args.query;

  const resultStr = tool.result != null
    ? (typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result, null, 2))
    : null;

  const opLabel = OP_LABELS[operation] ?? operation;

  return (
    <ToolCardShell
      icon={<LspIcon className="h-3.5 w-3.5" />}
      label="lsp"
      status={tool.status}
      tool={tool}
      summary={
        <span className="flex items-center gap-1.5">
          {opLabel && (
            <span className="rounded bg-violet-100 px-1 py-px text-[9px] font-medium text-violet-700 dark:bg-violet-900/30 dark:text-violet-400">
              {opLabel}
            </span>
          )}
          {dirPath && (
            <span className="text-neutral-500 dark:text-neutral-400">{dirPath}</span>
          )}
          {fileName && (
            <span className="font-semibold text-neutral-600 dark:text-neutral-300">{fileName}</span>
          )}
          {line != null && (
            <span className="text-neutral-400 dark:text-neutral-500">
              :{line}{character != null ? `:${character}` : ''}
            </span>
          )}
          {symbol && (
            <code className="text-neutral-500 dark:text-neutral-400">{symbol}</code>
          )}
        </span>
      }
    >
      {resultStr && (
        <ToolCardSection label="result">
          <ToolCodeBlock maxHeight="280px">
            {resultStr.length > 3000 ? resultStr.slice(0, 3000) + '\n... (truncated)' : resultStr}
          </ToolCodeBlock>
        </ToolCardSection>
      )}
    </ToolCardShell>
  );
}

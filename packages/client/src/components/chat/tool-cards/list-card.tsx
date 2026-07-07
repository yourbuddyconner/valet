import { ToolCardShell, ToolCardSection } from './tool-card-shell';
import { FolderIcon, FileIcon } from './icons';
import type { ToolCallData, ListArgs } from './types';

export function ListCard({ tool }: { tool: ToolCallData }) {
  const args = (tool.args ?? {}) as ListArgs;
  const path = args.path ?? '.';

  const resultStr = typeof tool.result === 'string' ? tool.result : null;
  const entries = resultStr
    ? resultStr.split('\n').filter(Boolean)
    : [];

  return (
    <ToolCardShell
      icon={<FolderIcon className="h-3.5 w-3.5" />}
      label="ls"
      status={tool.status}
      tool={tool}
      summary={
        <span className="flex items-center gap-1.5">
          <span className="text-neutral-500 dark:text-neutral-400">{path}</span>
          {entries.length > 0 && (
            <span className="text-neutral-400 dark:text-neutral-500">
              {entries.length} entries
            </span>
          )}
        </span>
      }
    >
      {entries.length > 0 && (
        <ToolCardSection>
          <div className="overflow-auto" style={{ maxHeight: '240px' }}>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0 sm:grid-cols-3">
              {entries.map((entry, i) => {
                const isDir = entry.endsWith('/');
                const name = isDir ? entry.slice(0, -1) : entry;
                return (
                  <div
                    key={i}
                    className="flex items-center gap-1.5 rounded px-1 py-0.5 font-mono text-[11px]"
                  >
                    {isDir ? (
                      <FolderIcon className="h-3 w-3 shrink-0 text-amber-500/70 dark:text-amber-400/60" />
                    ) : (
                      <FileIcon className="h-3 w-3 shrink-0 text-neutral-400 dark:text-neutral-500" />
                    )}
                    <span className={isDir ? 'font-medium text-amber-700 dark:text-amber-300' : 'text-neutral-600 dark:text-neutral-400'}>
                      {name}
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

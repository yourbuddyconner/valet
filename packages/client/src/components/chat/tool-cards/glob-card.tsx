import { ToolCardShell, ToolCardSection } from './tool-card-shell';
import { SearchIcon, FileIcon, FolderIcon } from './icons';
import type { ToolCallData, GlobArgs } from './types';

export function GlobCard({ tool }: { tool: ToolCallData }) {
  const args = (tool.args ?? {}) as GlobArgs;
  const pattern = args.pattern ?? '';
  const basePath = args.path;

  const resultStr = typeof tool.result === 'string' ? tool.result : null;
  const paths = resultStr
    ? resultStr.split('\n').filter(Boolean)
    : [];

  return (
    <ToolCardShell
      icon={<SearchIcon className="h-3.5 w-3.5" />}
      label="glob"
      status={tool.status}
      tool={tool}
      summary={
        <span className="flex items-center gap-1.5">
          <code className="font-semibold text-neutral-600 dark:text-neutral-300">{pattern}</code>
          {basePath && (
            <span className="text-neutral-400 dark:text-neutral-500">
              in {basePath}
            </span>
          )}
          {paths.length > 0 && (
            <span className="text-neutral-400 dark:text-neutral-500">
              {paths.length} {paths.length === 1 ? 'match' : 'matches'}
            </span>
          )}
        </span>
      }
    >
      {paths.length > 0 && (
        <ToolCardSection>
          <div className="overflow-auto" style={{ maxHeight: '240px' }}>
            <div className="space-y-0">
              {paths.map((p, i) => {
                const isDir = p.endsWith('/');
                const name = p.split('/').filter(Boolean).pop() ?? p;
                const dir = p.slice(0, p.length - name.length - (isDir ? 1 : 0));
                return (
                  <div
                    key={i}
                    className="flex items-center gap-1.5 rounded px-1 py-0.5 font-mono text-[11px] hover:bg-neutral-50 dark:hover:bg-white/[0.02]"
                  >
                    {isDir ? (
                      <FolderIcon className="h-3 w-3 shrink-0 text-amber-500/70 dark:text-amber-400/60" />
                    ) : (
                      <FileIcon className="h-3 w-3 shrink-0 text-neutral-400 dark:text-neutral-500" />
                    )}
                    <span className="text-neutral-400 dark:text-neutral-600">{dir}</span>
                    <span className="text-neutral-700 dark:text-neutral-300">{name}{isDir ? '/' : ''}</span>
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

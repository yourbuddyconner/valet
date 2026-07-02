import { MultiFileDiff } from '@pierre/diffs/react';
import { ToolCardShell, ToolCardSection } from './tool-card-shell';
import { FileEditIcon } from './icons';
import type { ToolCallData, EditArgs } from './types';
import { formatToolPath } from './path-display';
import { usePierreTheme } from '@/hooks/use-pierre-theme';
import { PierreWrapper, PIERRE_INLINE_CSS } from '@/components/pierre/pierre-wrapper';

function parseArgs(raw: unknown): EditArgs {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as EditArgs;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as EditArgs; } catch { return {}; }
  }
  return {};
}

export function EditCard({ tool }: { tool: ToolCallData }) {
  const args = parseArgs(tool.args);
  const filePath = args.file_path ?? args.filePath ?? '';
  const { fileName, dirPath } = formatToolPath(filePath);

  const oldStr = args.old_string ?? args.oldString ?? '';
  const newStr = args.new_string ?? args.newString ?? '';
  const replaceAll = args.replace_all ?? args.replaceAll;

  const resultStr = typeof tool.result === 'string' ? tool.result : null;
  const theme = usePierreTheme();

  return (
    <ToolCardShell
      icon={<FileEditIcon className="h-3.5 w-3.5" />}
      label="edit"
      status={tool.status}
      tool={tool}
      defaultExpanded
      summary={
        <span className="flex items-center gap-1.5">
          <span className="text-neutral-500 dark:text-neutral-400">{dirPath}</span>
          <span className="font-semibold text-neutral-700 dark:text-neutral-200">{fileName}</span>
          {replaceAll && (
            <span className="rounded bg-amber-100 px-1 py-px text-[9px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
              all
            </span>
          )}
        </span>
      }
    >
      {(oldStr || newStr) ? (
        <ToolCardSection>
          <PierreWrapper maxHeight="320px" debugLabel="EditCard">
            <MultiFileDiff
              oldFile={{ name: filePath || 'file.txt', contents: oldStr }}
              newFile={{ name: filePath || 'file.txt', contents: newStr }}
              options={{ theme, diffStyle: 'unified', overflow: 'scroll', disableFileHeader: true, unsafeCSS: PIERRE_INLINE_CSS }}
            />
          </PierreWrapper>
          {resultStr && (
            <p className="mt-1.5 font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
              {resultStr}
            </p>
          )}
        </ToolCardSection>
      ) : (tool.args != null || resultStr) ? (
        <ToolCardSection>
          {tool.args != null && (
            <pre className="overflow-auto font-mono text-[11px] leading-[1.6] text-neutral-500 dark:text-neutral-400" style={{ maxHeight: '200px' }}>
              {typeof tool.args === 'string' ? tool.args : JSON.stringify(tool.args, null, 2)}
            </pre>
          )}
          {resultStr && (
            <p className="mt-1.5 border-t border-neutral-100 pt-1.5 font-mono text-[10px] text-neutral-400 dark:border-neutral-800 dark:text-neutral-500">
              {resultStr}
            </p>
          )}
        </ToolCardSection>
      ) : null}
    </ToolCardShell>
  );
}

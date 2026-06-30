import { File } from '@pierre/diffs/react';
import { ToolCardShell, ToolCardSection } from './tool-card-shell';
import { FilePlusIcon } from './icons';
import type { ToolCallData, WriteArgs } from './types';
import { formatToolPath } from './path-display';
import { usePierreTheme } from '@/hooks/use-pierre-theme';
import { PierreWrapper, PIERRE_INLINE_CSS } from '@/components/pierre/pierre-wrapper';

export function WriteCard({ tool }: { tool: ToolCallData }) {
  const args = (tool.args ?? {}) as WriteArgs;
  const filePath = args.file_path ?? args.filePath ?? '';
  const { fileName, dirPath } = formatToolPath(filePath);
  const content = args.content ?? '';
  const lineCount = content ? content.split('\n').length : 0;
  const theme = usePierreTheme();

  const displayContent = content.length > 2000
    ? content.slice(0, 2000) + '\n... (truncated)'
    : content;

  return (
    <ToolCardShell
      icon={<FilePlusIcon className="h-3.5 w-3.5" />}
      label="write"
      status={tool.status}
      tool={tool}
      summary={
        <span className="flex items-center gap-1.5">
          <span className="text-neutral-500 dark:text-neutral-400">{dirPath}</span>
          <span className="font-semibold text-neutral-700 dark:text-neutral-200">{fileName}</span>
          {lineCount > 0 && (
            <span className="text-neutral-400 dark:text-neutral-500">
              {lineCount} lines
            </span>
          )}
        </span>
      }
    >
      {content && (
        <ToolCardSection>
          <PierreWrapper maxHeight="280px" debugLabel="WriteCard">
            <File
              file={{ name: filePath || 'file.txt', contents: displayContent }}
              options={{ theme, overflow: 'scroll', disableFileHeader: true, unsafeCSS: PIERRE_INLINE_CSS }}
            />
          </PierreWrapper>
        </ToolCardSection>
      )}
    </ToolCardShell>
  );
}

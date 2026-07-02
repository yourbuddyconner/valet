import { File } from '@pierre/diffs/react';
import { ToolCardShell, ToolCardSection } from './tool-card-shell';
import { FileIcon } from './icons';
import type { ToolCallData, ReadArgs } from './types';
import { formatToolPath } from './path-display';
import { usePierreTheme } from '@/hooks/use-pierre-theme';
import { PierreWrapper, PIERRE_INLINE_CSS, stripLineNumbers } from '@/components/pierre/pierre-wrapper';

export function ReadCard({ tool }: { tool: ToolCallData }) {
  const args = (tool.args ?? {}) as ReadArgs;
  const filePath = args.file_path ?? args.filePath ?? '';
  const { fileName, dirPath } = formatToolPath(filePath);
  const theme = usePierreTheme();

  const resultStr = typeof tool.result === 'string' ? tool.result : null;
  const lineCount = resultStr ? resultStr.split('\n').length : 0;

  // Extract line range info
  const rangeInfo = args.offset || args.limit
    ? `L${args.offset ?? 1}${args.limit ? `–${(args.offset ?? 1) + args.limit}` : ''}`
    : lineCount > 0
      ? `${lineCount} lines`
      : '';

  return (
    <ToolCardShell
      icon={<FileIcon className="h-3.5 w-3.5" />}
      label="read"
      status={tool.status}
      tool={tool}
      summary={
        <span className="flex items-center gap-1.5">
          <span className="text-neutral-500 dark:text-neutral-400">{dirPath}</span>
          <span className="font-semibold text-neutral-700 dark:text-neutral-200">{fileName}</span>
          {rangeInfo && (
            <span className="text-neutral-400 dark:text-neutral-500">
              {rangeInfo}
            </span>
          )}
        </span>
      }
    >
      {resultStr && (
        <ToolCardSection>
          <PierreWrapper maxHeight="280px" debugLabel="ReadCard">
            <File
              file={{ name: filePath || 'file.txt', contents: stripLineNumbers(resultStr) }}
              options={{ theme, overflow: 'scroll', disableFileHeader: true, unsafeCSS: PIERRE_INLINE_CSS }}
            />
          </PierreWrapper>
        </ToolCardSection>
      )}
    </ToolCardShell>
  );
}

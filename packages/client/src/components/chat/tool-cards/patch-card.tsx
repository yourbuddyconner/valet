import { PatchDiff } from '@pierre/diffs/react';
import { ToolCardShell, ToolCardSection } from './tool-card-shell';
import { PatchIcon } from './icons';
import type { ToolCallData, PatchArgs } from './types';
import { formatToolPath } from './path-display';
import { usePierreTheme } from '@/hooks/use-pierre-theme';
import { PierreWrapper, PIERRE_INLINE_CSS } from '@/components/pierre/pierre-wrapper';

/**
 * Extract the first file path from an OpenCode patch text.
 * Matches lines like "*** Add File: foo.ts", "*** Update File: bar.ts", "*** Delete File: baz.ts"
 */
function extractFilePathFromPatch(patchText: string): string {
  const match = patchText.match(/\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+)/);
  return match?.[1]?.trim() ?? '';
}

/**
 * Convert OpenCode's `*** Begin Patch` format to standard unified diff that Pierre can parse.
 *
 * OpenCode uses context-based `@@` markers (e.g. `@@ def greet():`) to locate changes,
 * NOT standard unified diff headers (`@@ -1,3 +1,4 @@`). We parse each chunk and
 * generate proper hunk headers with line counts so Pierre's parser can handle them.
 */
function opencodePatchToUnifiedDiff(patch: string): string {
  // If it already looks like a unified/git diff, pass through
  if (!patch.includes('*** ')) return patch;
  if (/^diff --git /m.test(patch)) return patch;
  if (/^--- .+\n\+\+\+ /m.test(patch)) return patch;

  const lines = patch.split('\n');
  const output: string[] = [];
  let i = 0;

  // Skip *** Begin Patch
  if (lines[i]?.trim() === '*** Begin Patch') i++;

  // Track cumulative line position for generating hunk offsets
  let linePos = 1;

  while (i < lines.length) {
    const line = lines[i];
    if (line?.trim() === '*** End Patch') { i++; continue; }

    const addMatch = line?.match(/^\*\*\*\s+Add\s+File:\s*(.+)/);
    const updateMatch = line?.match(/^\*\*\*\s+Update\s+File:\s*(.+)/);
    const deleteMatch = line?.match(/^\*\*\*\s+Delete\s+File:\s*(.+)/);

    if (addMatch) {
      const fileName = addMatch[1].trim();
      i++;
      // Collect all + lines until next *** or end
      const addedLines: string[] = [];
      while (i < lines.length && !lines[i].startsWith('*** ')) {
        addedLines.push(lines[i]);
        i++;
      }
      const count = addedLines.length;
      output.push(`--- /dev/null`);
      output.push(`+++ b/${fileName}`);
      output.push(`@@ -0,0 +1,${count} @@`);
      output.push(...addedLines);

    } else if (updateMatch) {
      const fileName = updateMatch[1].trim();
      i++;
      // Skip optional *** Move to: line
      if (i < lines.length && lines[i].startsWith('*** Move to:')) i++;

      output.push(`--- a/${fileName}`);
      output.push(`+++ b/${fileName}`);
      linePos = 1;

      // Parse chunks: each starts with @@ (context marker), followed by +/-/space lines
      while (i < lines.length && !lines[i].startsWith('*** ')) {
        if (lines[i].startsWith('@@')) {
          // This is a context marker line like "@@ def greet():"
          const contextText = lines[i].substring(2).trim();
          i++;

          // Collect the diff lines for this chunk
          const chunkLines: string[] = [];
          while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('*** ')) {
            chunkLines.push(lines[i]);
            i++;
          }

          // Count old/new lines for the hunk header
          let oldCount = 0;
          let newCount = 0;
          for (const cl of chunkLines) {
            if (cl.startsWith('+')) newCount++;
            else if (cl.startsWith('-')) oldCount++;
            else if (cl.startsWith(' ')) { oldCount++; newCount++; }
          }

          // Generate proper unified diff hunk header
          const ctxSuffix = contextText ? ` ${contextText}` : '';
          output.push(`@@ -${linePos},${oldCount} +${linePos},${newCount} @@${ctxSuffix}`);
          output.push(...chunkLines);
          linePos += oldCount;
        } else {
          // Stray line outside a @@ chunk — skip
          i++;
        }
      }

    } else if (deleteMatch) {
      const fileName = deleteMatch[1].trim();
      i++;
      output.push(`--- a/${fileName}`);
      output.push(`+++ /dev/null`);
      output.push(`@@ -1,1 +0,0 @@`);
      output.push(`-${fileName}`);
    } else {
      i++;
    }
  }

  return output.join('\n');
}

export function PatchCard({ tool }: { tool: ToolCallData }) {
  const args = (tool.args ?? {}) as PatchArgs;
  const rawPatch = args.patch ?? args.diff ?? args.content ?? args.patchText ?? '';
  const filePath = args.file_path ?? args.filePath ?? extractFilePathFromPatch(rawPatch);
  const { fileName, dirPath } = formatToolPath(filePath);

  // Convert OpenCode patch format to unified diff for Pierre
  const patchContent = opencodePatchToUnifiedDiff(rawPatch);

  const resultStr = typeof tool.result === 'string' ? tool.result : null;
  const theme = usePierreTheme();

  // Count additions/removals from raw patch content
  const lines = rawPatch.split('\n');
  let additions = 0;
  let removals = 0;
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    if (line.startsWith('-') && !line.startsWith('---')) removals++;
  }

  return (
    <ToolCardShell
      icon={<PatchIcon className="h-3.5 w-3.5" />}
      label="patch"
      status={tool.status}
      tool={tool}
      defaultExpanded
      summary={
        <span className="flex items-center gap-1.5">
          {filePath && (
            <>
              <span className="text-neutral-500 dark:text-neutral-400">{dirPath}</span>
              <span className="font-semibold text-neutral-700 dark:text-neutral-200">{fileName}</span>
            </>
          )}
          {(additions > 0 || removals > 0) && (
            <span className="text-neutral-400 dark:text-neutral-500">
              {additions > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>}
              {additions > 0 && removals > 0 && ' '}
              {removals > 0 && <span className="text-red-500 dark:text-red-400">-{removals}</span>}
            </span>
          )}
        </span>
      }
    >
      {patchContent && (
        <ToolCardSection>
          <PierreWrapper maxHeight="360px">
            <PatchDiff
              patch={patchContent}
              options={{ theme, diffStyle: 'unified', overflow: 'scroll', disableFileHeader: true, unsafeCSS: PIERRE_INLINE_CSS }}
            />
          </PierreWrapper>
          {resultStr && (
            <p className="mt-1.5 font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
              {resultStr}
            </p>
          )}
        </ToolCardSection>
      )}
    </ToolCardShell>
  );
}

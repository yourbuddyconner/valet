import { ToolCardShell, ToolCardSection } from './tool-card-shell';
import { ForkIcon } from './icons';
import { MarkdownContent } from '../markdown';
import type { ToolCallData } from './types';

interface TaskArgs {
  description?: string;
  prompt?: string;
  subagent_type?: string;
  task_id?: string;
}

/** Extract the content between <task_result>...</task_result> tags and the task_id */
function parseTaskResult(result: unknown): { taskId: string | null; content: string | null } {
  if (typeof result !== 'string') return { taskId: null, content: null };

  // Extract task_id
  const idMatch = result.match(/task_id:\s*(\S+)/);
  const taskId = idMatch?.[1] ?? null;

  // Extract content between <task_result> tags
  const tagMatch = result.match(/<task_result>\s*([\s\S]*?)\s*<\/task_result>/);
  if (tagMatch) {
    return { taskId, content: tagMatch[1] };
  }

  // If no tags found, return everything after the task_id line as content
  const lines = result.split('\n');
  const contentLines = lines.filter((l) => !l.startsWith('task_id:') && l.trim() !== '');
  return { taskId, content: contentLines.length > 0 ? contentLines.join('\n') : null };
}

export function TaskCard({ tool }: { tool: ToolCallData }) {
  const args = (tool.args ?? {}) as TaskArgs;
  const description = args.description ?? 'Subagent task';
  const { taskId, content } = parseTaskResult(tool.result);

  const summary = (
    <span className="text-neutral-500 dark:text-neutral-400">
      {description}
    </span>
  );

  return (
    <ToolCardShell
      icon={<ForkIcon className="h-3.5 w-3.5" />}
      label="task"
      status={tool.status}
      tool={tool}
      summary={summary}
    >
      {/* Prompt (collapsed) */}
      {args.prompt && (
        <ToolCardSection label="prompt" className="border-b border-neutral-100 dark:border-neutral-800">
          <p className="font-mono text-[11px] leading-[1.6] text-neutral-600 dark:text-neutral-400">
            {args.prompt.length > 300 ? args.prompt.slice(0, 300) + '...' : args.prompt}
          </p>
        </ToolCardSection>
      )}

      {/* Agent type + task_id metadata */}
      {(args.subagent_type || taskId) && (
        <ToolCardSection className="border-b border-neutral-100 dark:border-neutral-800">
          <div className="space-y-0.5 font-mono text-[11px]">
            {args.subagent_type && (
              <div className="flex gap-3">
                <span className="w-16 shrink-0 text-neutral-400 dark:text-neutral-500">agent</span>
                <span className="text-neutral-600 dark:text-neutral-300">{args.subagent_type}</span>
              </div>
            )}
            {taskId && (
              <div className="flex gap-3">
                <span className="w-16 shrink-0 text-neutral-400 dark:text-neutral-500">task_id</span>
                <span className="text-neutral-500 dark:text-neutral-400">{taskId.length > 24 ? taskId.slice(0, 24) + '...' : taskId}</span>
              </div>
            )}
          </div>
        </ToolCardSection>
      )}

      {/* Result rendered as markdown */}
      {content && (
        <ToolCardSection label="result">
          <div className="prose-tool-result max-h-[400px] overflow-auto text-[12px] leading-[1.6]">
            <MarkdownContent content={content} />
          </div>
        </ToolCardSection>
      )}
    </ToolCardShell>
  );
}

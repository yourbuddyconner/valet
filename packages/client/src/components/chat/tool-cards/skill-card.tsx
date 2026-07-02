import { ToolCardShell, ToolCardSection, ToolCodeBlock } from './tool-card-shell';
import { SkillIcon } from './icons';
import type { ToolCallData, SkillArgs } from './types';

export function SkillCard({ tool }: { tool: ToolCallData }) {
  const args = (tool.args ?? {}) as SkillArgs;
  const name = args.name ?? args.path ?? '';

  const resultStr = tool.result != null
    ? (typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result, null, 2))
    : null;

  return (
    <ToolCardShell
      icon={<SkillIcon className="h-3.5 w-3.5" />}
      label="skill"
      status={tool.status}
      tool={tool}
      summary={
        name ? (
          <span className="font-semibold text-neutral-600 dark:text-neutral-300">{name}</span>
        ) : undefined
      }
    >
      {resultStr && (
        <ToolCardSection label="content">
          <ToolCodeBlock maxHeight="240px">
            {resultStr.length > 3000 ? resultStr.slice(0, 3000) + '\n... (truncated)' : resultStr}
          </ToolCodeBlock>
        </ToolCardSection>
      )}
    </ToolCardShell>
  );
}

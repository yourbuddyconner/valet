import { ToolCardShell, ToolCardExpansionIntentContext } from './tool-card-shell';
import { WrenchIcon } from './icons';
import type { ToolCallData } from './types';
import { getToolCardMeta } from './meta';

interface SummaryToolCardProps {
  tool: ToolCallData;
  onExpand?: () => void;
  loading?: boolean;
}

export function SummaryToolCard({ tool, onExpand, loading = false }: SummaryToolCardProps) {
  const meta = getToolCardMeta(tool);

  return (
    <ToolCardExpansionIntentContext.Provider value={null}>
      <ToolCardShell
        icon={<WrenchIcon />}
        label={meta.label}
        status={tool.status}
        summary={loading ? 'Loading details...' : meta.summary}
        expandable={Boolean(onExpand)}
        onToggle={onExpand}
      />
    </ToolCardExpansionIntentContext.Provider>
  );
}

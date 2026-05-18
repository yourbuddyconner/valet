import {
  Terminal,
  Wrench,
  Sparkles,
  Send,
  GitBranch,
  Network,
  Repeat,
  ShieldCheck,
  Circle,
  type LucideIcon,
} from 'lucide-react';
import type { WorkflowStep } from '@/api/workflows';

const ICON_BY_TYPE: Record<WorkflowStep['type'], LucideIcon> = {
  bash: Terminal,
  tool: Wrench,
  agent_prompt: Sparkles,
  notify: Send,
  conditional: GitBranch,
  parallel: Network,
  loop: Repeat,
  approval: ShieldCheck,
};

export function stepTypeIcon(type: WorkflowStep['type']): LucideIcon {
  return ICON_BY_TYPE[type] ?? Circle;
}

export function StepTypeIcon({
  type,
  className,
}: {
  type: WorkflowStep['type'];
  className?: string;
}) {
  const Icon = stepTypeIcon(type);
  return <Icon className={className} strokeWidth={1.5} aria-hidden="true" />;
}

import {
  Sparkles,    // agent_prompt
  Terminal,    // bash
  Bell,        // notify
  CheckSquare, // approval
  GitBranch,   // conditional
  RotateCw,    // loop
  Split,       // parallel
  Wrench,      // tool
  FileQuestion, // fallback
} from 'lucide-react';

export const STEP_ICONS = {
  agent_prompt: Sparkles,
  bash: Terminal,
  notify: Bell,
  approval: CheckSquare,
  conditional: GitBranch,
  loop: RotateCw,
  parallel: Split,
  tool: Wrench,
  fallback: FileQuestion,
} as const;

export type StepKindWithIcon = keyof typeof STEP_ICONS;

export function StepIcon({ kind }: { kind: string }) {
  const Icon = (STEP_ICONS as Record<string, typeof Sparkles>)[kind] ?? STEP_ICONS.fallback;
  return <Icon className="h-3.5 w-3.5" aria-hidden="true" />;
}

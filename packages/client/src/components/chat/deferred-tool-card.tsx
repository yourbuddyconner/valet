import { lazy, Suspense } from 'react';
import { SummaryToolCard } from './tool-cards/summary-card';
import type { ToolCallData } from './tool-cards/types';

const ToolCard = lazy(async () => {
  const mod = await import('./tool-cards');
  return { default: mod.ToolCard };
});

export function DeferredToolCard({ tool }: { tool: ToolCallData }) {
  // Tool cards engage immediately — the user shouldn't have to click a
  // collapsed summary just to see args/result. The Suspense fallback
  // still shows the SummaryToolCard while the specialized chunk loads,
  // so collapsed-state visuals remain consistent.
  return (
    <Suspense fallback={<SummaryToolCard tool={tool} loading />}>
      <ToolCard tool={tool} initiallyEngaged />
    </Suspense>
  );
}

import { lazy, Suspense, useState } from 'react';
import { SummaryToolCard } from './tool-cards/summary-card';
import type { ToolCallData } from './tool-cards/types';

const ToolCard = lazy(async () => {
  const mod = await import('./tool-cards');
  return { default: mod.ToolCard };
});

export function DeferredToolCard({ tool }: { tool: ToolCallData }) {
  const [engaged, setEngaged] = useState(false);

  if (!engaged) {
    return <SummaryToolCard tool={tool} onExpand={() => setEngaged(true)} />;
  }

  return (
    <Suspense fallback={<SummaryToolCard tool={tool} loading />}>
      <ToolCard tool={tool} initiallyEngaged />
    </Suspense>
  );
}

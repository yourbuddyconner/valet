import { lazy, Suspense, useState } from 'react';
import { SummaryToolCard } from './tool-cards/summary-card';
import type { ToolCallData } from './tool-cards/types';

const ToolCard = lazy(async () => {
  const mod = await import('./tool-cards');
  return { default: mod.ToolCard };
});

export function DeferredToolCard({ tool }: { tool: ToolCallData }) {
  // Collapsed by default — the summary header (tool name + a one-line
  // summary like `tool_id` or first arg) is enough at rest, and the
  // specialized card chunk only loads when the user actually clicks to
  // expand. This avoids parsing/hydrating heavy result payloads (e.g.
  // a full workflow definition) for every card on screen.
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

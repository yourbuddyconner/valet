import { lazy, Suspense, useContext, useState } from 'react';
import { SummaryToolCard } from './tool-cards/summary-card';
import { ToolCardExpandAllContext } from './tool-cards/tool-card-shell';
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
  // The chat-level "expand all" toggle skips the gate and engages every
  // card so the user can see everything in one go.
  const [engaged, setEngaged] = useState(false);
  const expandAll = useContext(ToolCardExpandAllContext);

  if (!engaged && !expandAll) {
    return <SummaryToolCard tool={tool} onExpand={() => setEngaged(true)} />;
  }

  return (
    <Suspense fallback={<SummaryToolCard tool={tool} loading />}>
      <ToolCard tool={tool} initiallyEngaged />
    </Suspense>
  );
}

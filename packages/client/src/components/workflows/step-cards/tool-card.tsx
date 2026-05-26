import { DeferredToolCard } from '@/components/chat/deferred-tool-card';
import type { ToolCallData, ToolCallStatus } from '@/components/chat/tool-cards/types';
import type { WorkflowStepCardProps } from './index';

interface WorkflowToolInput {
  tool?: string;
  arguments?: unknown;
}

/**
 * A workflow `tool` step is functionally a tool call. Delegate to the same
 * `DeferredToolCard` the assistant chat uses so users see one canonical
 * rendering per tool (read/write/grep/edit/bash/etc.).
 */
export function ToolCard({ step }: WorkflowStepCardProps) {
  const input = step.input as WorkflowToolInput | null;
  const toolName = typeof input?.tool === 'string' ? input.tool : 'unknown';

  const toolCallData: ToolCallData = {
    toolName,
    status: mapStatus(step.status),
    args: input?.arguments ?? {},
    result: step.output ?? null,
  };

  return <DeferredToolCard tool={toolCallData} />;
}

function mapStatus(status: string): ToolCallStatus {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'error';
  if (status === 'running') return 'running';
  return 'pending';
}

import type { Category, ThreadRow } from './types.js';

// Mechanical thread categorization. Matches the rules in the design spec.
export function categorizeThread(thread: ThreadRow): Category {
  if (thread.originTriggerId !== null) return 'automation-trigger';
  if (thread.isOrchestrator && thread.originChannelType !== null) return 'orchestrator-chat';
  if (thread.isOrchestrator) return 'orchestrator-internal';
  return 'ad-hoc';
}

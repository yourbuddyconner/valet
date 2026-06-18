import type { Category, ThreadRow } from './types.js';

// Mechanical thread categorization.
//
// `session_threads.origin_channel_type` turns out to be unreliably populated
// in real data — most channel-facing orchestrator threads have it as null.
// We use `hasUserMessage` as the actual chat-vs-background signal:
// channel-bound conversations always start with an inbound user message;
// orchestrator self-work (memory compaction, scheduled checks) doesn't.
export function categorizeThread(thread: ThreadRow): Category {
  if (thread.originTriggerId !== null) return 'automation-trigger';
  if (thread.isOrchestrator && thread.hasUserMessage) return 'orchestrator-chat';
  if (thread.isOrchestrator) return 'orchestrator-internal';
  return 'ad-hoc';
}

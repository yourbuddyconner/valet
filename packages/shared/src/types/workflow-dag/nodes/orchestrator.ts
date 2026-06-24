import type { NodeDocs } from '../docs.js';

export interface OrchestratorNode {
  id: string;
  type: 'orchestrator';
  prompt: string;
  forceNewThread?: boolean;
  resultMode?: 'last_message' | 'transcript';
  wait?: {
    mode: 'none' | 'until_idle';
    timeout?: string;
  };
}

export function createDefaultOrchestratorNode(id: string): OrchestratorNode {
  return { id, type: 'orchestrator', prompt: '' };
}

export const orchestratorNodeDocs: NodeDocs = {
  label: 'Orchestrator',
  description: 'Ask the user orchestrator to do work',
  longDescription: `Sends a prompt to the user's orchestrator (the long-lived "Jarvis"
session) and optionally waits for it to respond. Use this when you want
the workflow to delegate to the user's primary agent — for example,
"draft a Slack reply to this thread" or "decide which repo this change
belongs to" — rather than running a fresh LLM call without context.

The orchestrator runs in its own session and keeps long-term memory, so
prompts can reference prior conversations and the orchestrator's existing
context. The output depends on \`resultMode\`: \`last_message\` returns just
the orchestrator's final reply; \`transcript\` returns the full message
history for the dispatch.`,
  fields: {
    prompt: {
      help: 'What to ask the orchestrator. Supports template expressions for upstream node outputs.',
    },
    forceNewThread: {
      help: 'When true, the prompt starts a new orchestrator thread instead of continuing whatever thread the workflow last used.',
    },
    resultMode: {
      help: 'last_message returns just the final orchestrator reply. transcript returns every message in the dispatch — useful for capturing reasoning chains.',
    },
    wait: {
      help: 'until_idle blocks until the orchestrator finishes thinking; none fires the prompt and returns immediately (the orchestrator may still be working). Most workflows want until_idle.',
    },
  },
  gotchas: [
    'Requires the user orchestrator session to be reachable. If the orchestrator is hibernated, dispatching wakes it.',
  ],
};

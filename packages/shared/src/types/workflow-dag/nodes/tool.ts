import type { NodeDocs } from '../docs.js';

export interface ToolNode {
  id: string;
  type: 'tool';
  service: string;
  action: string;
  params: Record<string, unknown>;
  summary?: string;
  onPolicyDeny?: 'fail' | 'skip';
  retries?: number;
}

export function createDefaultToolNode(id: string): ToolNode {
  return { id, type: 'tool', service: '', action: '', params: {} };
}

export const toolNodeDocs: NodeDocs<ToolNode> = {
  label: 'Tool',
  description: 'Call an integration action',
  longDescription: `Invokes one action on one integrated service — sending a Slack message,
creating a Linear issue, posting a GitHub comment, etc. The params object
is template-evaluated against the workflow state before the call, so
upstream node outputs and trigger data can flow into the action.

Every tool call writes an \`action_invocations\` row for the audit log.
Actions can be gated by user or org policies; when a call is held for
approval, the node parks the run until the user resolves it from the web
UI (or the configured \`onPolicyDeny\` behavior kicks in).`,
  fields: {
    service: {
      help: 'Integration provider (slack, github, gmail, linear, etc.). Must be an integration the workflow owner has connected.',
    },
    action: {
      help: 'Specific action on the service. The action catalog suggests valid combinations.',
    },
    params: {
      help: 'Action input. Values support templates like ${nodes.previous.output.<field>} and ${trigger.data.<field>}.',
    },
    summary: {
      help: 'One-line description of what this specific call does ("Notify on-call about deploy"). Shown in approval prompts and the execution trace. Defaults to "<service>.<action>" — set this when "slack.send_message" isn\'t self-explanatory.',
    },
    onPolicyDeny: {
      help: 'What happens when the user (or policy) denies the action. fail aborts the workflow; skip marks the node skipped and continues.',
    },
    retries: {
      help: 'How many times to retry transient failures. 0 disables retries; default is 3 retries with backoff.',
    },
  },
  gotchas: [
    'Action invocations are durable — a retry of the workflow step reuses the original invocation row instead of re-calling the service.',
  ],
};

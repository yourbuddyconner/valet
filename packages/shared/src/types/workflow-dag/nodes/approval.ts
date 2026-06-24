import type { NodeDocs } from '../docs.js';

export interface ApprovalNode {
  id: string;
  type: 'approval';
  prompt: string;
  summary?: string;
  details?: unknown;
  timeout?: string;
  onDeny?: 'fail' | 'skip';
}

export function createDefaultApprovalNode(id: string): ApprovalNode {
  return { id, type: 'approval', prompt: '' };
}

export const approvalNodeDocs: NodeDocs = {
  label: 'Approval',
  description: 'Pause for human approval',
  longDescription: `Parks the workflow until a human approves or denies. Writes a row to
\`workflow_approvals\` and surfaces a pending-approval card in the web UI
(plus the per-execution inspector). The workflow resumes when an
authorized user resolves it.

Use this for human-in-the-loop gates: confirming an outbound action,
reviewing a generated plan before a tool node executes it, or letting an
operator decide between alternative branches. Anything posted to
\`details\` is rendered as-is in the approval prompt — strings, JSON, or a
preview of an upstream node's output all work.`,
  fields: {
    prompt: {
      help: 'Question shown to the approver. Should describe the decision they\'re being asked to make.',
    },
    summary: {
      help: 'Optional one-line summary shown in the approvals list. Defaults to the prompt truncated.',
    },
    details: {
      help: 'Optional payload (string, JSON, or anything serializable) rendered alongside the prompt. Use this to surface upstream context like ${nodes.draft.output}.',
    },
    timeout: {
      help: 'Optional ISO 8601 duration after which the approval expires. Without a timeout, the workflow can park here indefinitely.',
    },
    onDeny: {
      help: 'What happens if the approval is denied or expires. fail aborts the workflow; skip marks the node skipped and continues to any false-branch successor.',
    },
  },
};

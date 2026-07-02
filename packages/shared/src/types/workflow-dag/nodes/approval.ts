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

export const approvalNodeDocs: NodeDocs<ApprovalNode> = {
  label: 'Approval',
  description: 'Pause for human approval',
  longDescription: `Parks the workflow until a human approves or denies. Writes a row to
\`workflow_approvals\` and surfaces a pending-approval card in the web UI
(plus the per-execution inspector). The workflow resumes when an
authorized user resolves it.

### Summary vs prompt vs details

Three text fields that look similar but show up in different places:

- **\`summary\`** — one-line title. This is what the approver sees in the
  **approvals list** before clicking in. Keep it short and scannable
  ("Approve PR #1234 merge?", "Send Slack reminder to @on-call?"). If
  omitted, defaults to the prompt truncated.
- **\`prompt\`** — the **question** the approver is being asked. Shown
  prominently on the approval detail page. Phrase it as a decision
  ("Should we proceed with deleting these 3 stale branches?"), not a
  description.
- **\`details\`** — **supporting context** rendered below the prompt.
  Anything serializable: a string, a JSON object, or a template expression
  pulling in an upstream node's output. Use this to show the approver
  *what* they're approving (the diff, the plan, the draft message).

Mental model: \`summary\` is the email subject line, \`prompt\` is the
question, \`details\` is the attached document.

### When to reach for approval

Human-in-the-loop gates — confirming an outbound action, reviewing a
generated plan before a tool node executes it, or letting an operator
decide between alternative branches.`,
  fields: {
    summary: {
      help: 'One-line title shown in the approvals list ("Approve PR #1234 merge?"). Keep it scannable. Defaults to the prompt truncated.',
    },
    prompt: {
      help: 'The decision question. Phrase it as something the approver answers yes/no to ("Should we proceed with deleting these branches?").',
    },
    details: {
      help: 'Supporting context shown below the prompt — the diff, the plan, the draft message. Use template expressions like ${nodes.draft.output} to surface upstream content.',
    },
    timeout: {
      help: 'Optional ISO 8601 duration after which the approval expires (e.g. PT1H, P1D). Without a timeout, the workflow can park here indefinitely.',
    },
    onDeny: {
      help: 'What happens if the approval is denied or expires. fail aborts the workflow; skip marks the node skipped and continues to any false-branch successor.',
    },
  },
};

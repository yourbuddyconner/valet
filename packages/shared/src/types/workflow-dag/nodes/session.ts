import type { NodeDocs } from '../docs.js';

// Session node — discriminated on `mode`.
export type SessionNode = StartSessionNode | PromptSessionNode;

export interface StartSessionNode {
  id: string;
  type: 'session';
  mode: 'start';
  prompt: string;
  workspace: string;
  title?: string;
  personaId?: string;
  model?: string;
  repo?: {
    url?: string;
    branch?: string;
    ref?: string;
    sourceRepoFullName?: string;
  };
  wait?: {
    mode: 'none' | 'until_idle';
    timeout?: string;
  };
}

export interface PromptSessionNode {
  id: string;
  type: 'session';
  mode: 'prompt';
  sessionId: string;
  prompt: string;
  threadId?: string;
  forceNewThread?: boolean;
  wait?: {
    mode: 'none' | 'until_idle';
    timeout?: string;
  };
}

export function createDefaultSessionNode(id: string): SessionNode {
  return { id, type: 'session', mode: 'start', prompt: '', workspace: '' };
}

export const sessionNodeDocs: NodeDocs<SessionNode> = {
  label: 'Session',
  description: 'Start or prompt a coding session',
  longDescription: `Spawns a fresh agent session (mode \`start\`) or sends a prompt to an
existing one (mode \`prompt\`). Sessions run in isolated Modal sandboxes
with a full dev environment — VS Code, browser, terminal, and OpenCode
with the full tool catalog — so this is how a workflow does "real work"
that needs filesystem, network, or long-running tasks.

In start mode, the workflow allocates a workspace and prompt and the
resulting session is tracked in \`workflow_spawned_sessions\` for cleanup.
In prompt mode, the workflow attaches to an existing session by ID and
sends a new prompt to it (optionally on a fresh thread).

The \`wait\` mode decides whether the workflow blocks for the session's
reply or returns immediately. \`until_idle\` is the usual choice; \`none\`
fires the prompt and moves on without seeing the response.`,
  fields: {
    mode: {
      help: 'start = create a new session for this workflow run. prompt = send a prompt to a session that already exists.',
    },
    prompt: {
      help: 'What to send the session. In start mode this is the opening message; in prompt mode it\'s sent on the chosen thread. Supports template expressions for upstream node outputs.',
    },
    workspace: {
      help: 'Workspace name (start mode only). A new sandbox is provisioned for this workspace.',
    },
    repo: {
      help: 'Optional repo to clone into the workspace at session start. Set url for an HTTPS clone, sourceRepoFullName for a GitHub installation-scoped clone.',
    },
    sessionId: {
      help: 'ID of an existing session to prompt (prompt mode only). Typically a previous session node\'s output.',
    },
    threadId: {
      help: 'Optional thread to continue. If unset, the prompt goes to the session\'s last active thread.',
    },
    forceNewThread: {
      help: 'When true, opens a fresh thread for the prompt regardless of which thread the session was last on.',
    },
    wait: {
      help: 'until_idle blocks until the session finishes responding. none returns immediately, leaving the session working in the background.',
    },
  },
  gotchas: [
    'Sessions spawned by a workflow are retained for 30 days by default and cleaned up if the workflow is cancelled.',
    'Hibernated sessions wake automatically when prompted; expect a short startup delay on the first prompt of an idle session.',
  ],
};

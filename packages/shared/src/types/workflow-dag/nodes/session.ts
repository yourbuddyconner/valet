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
  repairModel?: string;
  outputSchema?: Record<string, unknown>;
  resultMode?: 'last_message' | 'transcript';
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
  repairModel?: string;
  outputSchema?: Record<string, unknown>;
  resultMode?: 'last_message' | 'transcript';
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

### Start vs prompt mode

- **start** — provision a brand-new sandbox for this run. Use when the
  workflow owns the session lifecycle (it starts the work, the session
  finishes it, the session is then cleaned up).
- **prompt** — attach to a session that already exists (by ID, usually
  pulled from an upstream node's output). Use when iterating on a
  long-lived workspace or when one workflow hands work to another.

### What \`workspace\` and \`title\` mean (start mode)

- **\`workspace\`** is a short slug identifying the sandbox's working
  directory (e.g. \`auth-refactor\`, \`q3-migration\`). It becomes the project
  name inside the sandbox and is shown in the sessions list. Pick something
  short and stable; the same workspace name across runs is fine.
- **\`title\`** is a human-readable label shown in the UI ("Backfill stale
  user rows"). Defaults to the workspace if unset. Use this for run-specific
  context that wouldn't fit in the workspace slug.

### Wait mode

Decides whether the workflow blocks for the session's reply or returns
immediately. \`until_idle\` is the usual choice — the workflow pauses until
the agent stops working. \`none\` fires the prompt and moves on, leaving the
session running in the background.

When \`until_idle\` is used, the node output includes \`response\` with the
final assistant message text, \`lastMessage\` with message metadata, and
\`output\` when that response is valid JSON. If \`outputSchema\` is set, the
final response is parsed and validated against that schema; invalid JSON is
repaired with \`repairModel\` (or the configured default model) before the
validated object is written to \`output\`. Set \`resultMode: "transcript"\` to
also include the ordered session transcript.`,
  fields: {
    mode: {
      help: 'start = create a new session for this workflow run. prompt = send a prompt to a session that already exists (by ID).',
    },
    prompt: {
      help: 'What to send the session. In start mode this is the opening message; in prompt mode it\'s sent on the chosen thread. Supports template expressions for upstream node outputs.',
    },
    workspace: {
      help: 'Short slug for the sandbox working directory (e.g. "auth-refactor"). Becomes the project name inside the sandbox. Same name across runs is fine.',
    },
    title: {
      help: 'Optional human-readable label shown in the sessions list. Defaults to the workspace. Use this for run-specific context that doesn\'t fit in the workspace slug.',
    },
    personaId: {
      help: 'Which agent persona to attach to the session. Personas bundle a system prompt, default model, and tool set. Pick "Default persona" to use the org default.',
    },
    repo: {
      help: 'Optional repo to clone into the workspace at session start. Provide either a Git URL (http/https/ssh) or a GitHub repo full name like owner/repo to use the installation-scoped clone.',
    },
    sessionId: {
      help: 'ID of an existing session to prompt (prompt mode only). Typically a previous session node\'s output, e.g. ${nodes.session-start.output.sessionId}.',
    },
    threadId: {
      help: 'Optional thread to continue. If unset, the prompt goes to the session\'s last active thread.',
    },
    forceNewThread: {
      help: 'When true, opens a fresh thread for the prompt regardless of which thread the session was last on.',
    },
    resultMode: {
      help: 'last_message returns the final assistant reply. transcript also returns the ordered session transcript after waiting until idle.',
    },
    outputSchema: {
      help: 'Optional JSON Schema for the final assistant reply. When set, the response is parsed, validated, repaired if needed, and stored as output.',
    },
    repairModel: {
      help: 'Optional model used to repair malformed or schema-invalid JSON. Defaults to the session model in start mode, then user/org model preferences.',
    },
    wait: {
      help: 'until_idle blocks until the session finishes responding. none returns immediately, leaving the session working in the background.',
    },
  },
  gotchas: [
    'Sessions spawned by a workflow are workflow-owned and are terminated when the workflow completes, fails, or is cancelled.',
    'Hibernated sessions wake automatically when prompted; expect a short startup delay on the first prompt of an idle session.',
    'In start mode, repo.url must be a valid Git URL (https://, http://, ssh://, or git@host:path). sourceRepoFullName must be a GitHub "owner/repo" slug. The runtime rejects malformed values at run time, not at save time.',
  ],
};

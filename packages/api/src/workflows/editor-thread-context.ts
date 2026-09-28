/** Conversation context is a hint, not a grant. Workflow tools enforce access. */
export function workflowEditorThreadContext(thread: { key: string }): string | undefined {
  const match = /^workflow:(wf_[A-Za-z0-9_-]+)$/.exec(thread.key);
  if (!match) return undefined;
  return `This conversation is the visual editor for workflow ${match[1]}. Read that workflow before answering questions or making changes. Apply requested changes with the workflow tools. The workflow tools enforce the current owner's permissions.`;
}

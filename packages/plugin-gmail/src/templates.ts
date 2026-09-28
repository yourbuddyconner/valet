/**
 * Gmail workflow templates.
 *
 * The sweeper moves low-priority UNREAD mail out of the inbox and onto one
 * existing label, so the rest of the inbox can be read in one pass later.
 * It never creates a label, because Gmail label creation is not an action
 * this plugin exposes: the destination must already exist, and the
 * classifier picks it from the account's own label list.
 *
 * Every action it calls resolves to `allow` under the default policy
 * (`list_labels` low, `triage_inbox` and `modify_labels` medium), so a
 * scheduled run never parks on an approval gate. `send_email` and
 * `trash_message` are high risk and deliberately absent — an unattended run
 * that hits a gate waits for a click forever.
 */
import type { WorkflowTemplate } from '@valet/engine';
import type { WorkflowDefinition } from '@valet/workflow';

const inboxSweeper: WorkflowDefinition = {
  version: 'dag/v1',
  nodes: [
    { id: 'start', type: 'trigger' },
    {
      id: 'labels',
      type: 'tool',
      service: 'gmail',
      action: 'list_labels',
      summary: 'Read the labels that already exist on the account',
      params: {},
    },
    {
      id: 'triage',
      type: 'tool',
      service: 'gmail',
      action: 'triage_inbox',
      summary: 'Read the newest unread mail, with its triage signals',
      // 50 is `triage_inbox`'s own ceiling, and it matches the foreach
      // maxItems below — so the loop can never truncate a batch in silence.
      params: { maxResults: 50, bodyExcerptLength: 300 },
    },
    {
      id: 'classify',
      type: 'llm',
      model: 'claude-haiku-4-5',
      system:
        'You sort unread mail. Low priority means bulk mail, newsletters, and automated notices that ' +
        'need no reply. Anything addressed to the reader by a person is NOT low priority. ' +
        'Anything that asks a question or requests an action is NOT low priority.',
      prompt: [
        'The labels on this account:',
        '{{ nodes.labels.result.labels }}',
        '',
        'The unread mail:',
        '{{ nodes.triage.result.messages }}',
        '',
        'Pick the one existing label that best holds low-priority mail. Use its id, not its name.',
        'Then list the ids of the messages that belong there.',
        '',
        'Return JSON in a ```json block: { "labelId": ..., "lowPriorityIds": [...] }.',
        'If no existing label suits low-priority mail, return an empty labelId AND an empty lowPriorityIds.',
      ].join('\n'),
      outputSchema: {
        type: 'object',
        properties: {
          labelId: { type: 'string' },
          lowPriorityIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['labelId', 'lowPriorityIds'],
      },
    },
    {
      // Both halves must hold. An empty labelId with a full id list would
      // label every message with "", which fails once per message; an empty
      // id list with a good label has nothing to move.
      id: 'have_work',
      type: 'if',
      combinator: 'and',
      conditions: [
        { left: 'nodes.classify.result.output.labelId', dataType: 'string', operation: 'isNotEmpty' },
        {
          left: 'nodes.classify.result.output.lowPriorityIds',
          dataType: 'array',
          operation: 'lengthGreaterThan',
          right: 0,
        },
      ],
    },
    {
      id: 'sweep',
      type: 'foreach',
      items: '{{ nodes.classify.result.output.lowPriorityIds }}',
      maxItems: 50,
      concurrency: 3,
      // Independent messages: one Gmail error must not skip the rest.
      onItemError: 'collect',
      body: {
        id: 'move_message',
        type: 'tool',
        service: 'gmail',
        action: 'modify_labels',
        summary: 'Label the message and take it out of the inbox',
        params: {
          messageId: '{{ item }}',
          addLabelIds: ['{{ nodes.classify.result.output.labelId }}'],
          removeLabelIds: ['INBOX'],
        },
      },
    },
    {
      id: 'report',
      type: 'thread',
      wait: { mode: 'until_idle' },
      prompt: [
        'I swept low-priority unread mail out of my inbox. Report the counts to me in one short paragraph.',
        'If any message failed, or if the batch was truncated, say so first.',
        '',
        'Moved: {{ nodes.sweep.result.completedCount }}',
        'Failed: {{ nodes.sweep.result.failedCount }}',
        'Selected: {{ nodes.sweep.result.inputCount }}',
        'Truncated: {{ nodes.sweep.result.truncatedCount }}',
        '',
        'Per-message outcomes:',
        '{{ nodes.sweep.result.items }}',
      ].join('\n'),
    },
  ],
  edges: [
    { from: 'start', to: 'labels' },
    { from: 'start', to: 'triage' },
    { from: 'labels', to: 'classify' },
    { from: 'triage', to: 'classify' },
    { from: 'classify', to: 'have_work' },
    { from: 'have_work', to: 'sweep', fromOutput: 'true' },
    { from: 'sweep', to: 'report' },
  ],
};

export const gmailTemplates: WorkflowTemplate[] = [
  {
    id: 'gmail.inbox-sweeper',
    name: 'Inbox sweeper',
    description:
      'Label low-priority unread mail and move it out of the inbox. Keep mail from people in the inbox.',
    category: 'inbox',
    apps: ['gmail', 'claude'],
    steps: [
      'Read the labels that already exist on the account.',
      'Read up to 50 unread messages, with their triage signals.',
      'Choose the label that holds low-priority mail, and the messages that belong there.',
      'Move each of those messages to that label and out of the inbox.',
      'Report what moved, what failed, and what was left over.',
    ],
    caveats: [
      'The destination label must already exist. Create it in Gmail first — this workflow cannot.',
      'It reads unread mail only, up to 50 messages per run.',
      'It never deletes mail and never sends mail.',
    ],
    definition: inboxSweeper,
    schedule: {
      name: 'Inbox sweeper',
      cron: '0 12 * * 1-5',
      timezone: 'UTC',
      description: 'Weekdays at 12:00 UTC',
    },
  },
];

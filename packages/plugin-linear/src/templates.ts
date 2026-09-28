/**
 * Linear workflow templates.
 *
 * Linear reaches Valet over MCP, which has two consequences these
 * definitions are built around.
 *
 * First, the action list resolves at run time. `list_issues` is the tool the
 * official Linear MCP server exposes for this (verified against a live
 * `tools/list`; it reads `assignee: "me"` as the authenticated user). Because
 * names resolve upstream, a future rename would still pass save-time
 * validation and fail on the first run, not on install — so the card names
 * that risk.
 *
 * Second, an MCP action returns its text content as the node result — a
 * STRING, not a parsed object. So the triage step reads the whole result
 * (`nodes.my_issues.result`) and never a field under it: `result.issues`
 * would render as null.
 *
 * The template is read-only on purpose. MCP actions default to medium risk,
 * which resolves to `allow`, so a template that applied its own suggestions
 * would rewrite the issue tracker unattended and with no gate. Suggestions
 * are output here; the person applies them.
 */
import type { WorkflowTemplate } from '@valet/engine';
import type { WorkflowDefinition } from '@valet/workflow';

const weeklyIssueTriage: WorkflowDefinition = {
  version: 'dag/v1',
  nodes: [
    { id: 'start', type: 'trigger' },
    {
      id: 'my_issues',
      type: 'tool',
      service: 'linear',
      action: 'list_issues',
      summary: 'Read the issues assigned to you',
      params: { assignee: 'me' },
    },
    {
      id: 'triage',
      type: 'llm',
      model: 'claude-sonnet-4-5',
      system:
        'You run a weekly triage over one person\'s issue list. Say what changed, what is at risk, and ' +
        'what should move. Every suggestion names one issue and one concrete change. ' +
        'Suggest nothing you cannot support from the data you were given.',
      prompt: [
        'The time now is {{ trigger.timestamp }}. Judge staleness against it.',
        '',
        'Issues assigned to you:',
        '{{ nodes.my_issues.result }}',
        '',
        'Write a short summary of the week, then list the changes worth making.',
        'Return JSON in a ```json block:',
        '{ "summary": ..., "suggestions": [ { "issue": ..., "change": ..., "why": ... } ] }',
        'Return an empty suggestions array when nothing needs to change.',
      ].join('\n'),
      outputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          suggestions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                issue: { type: 'string' },
                change: { type: 'string' },
                why: { type: 'string' },
              },
              required: ['issue', 'change', 'why'],
            },
          },
        },
        required: ['summary', 'suggestions'],
      },
    },
    {
      id: 'deliver',
      type: 'thread',
      wait: { mode: 'until_idle' },
      prompt: [
        'This is my weekly issue triage. Give me the summary, then the suggested changes as a list.',
        'Do not change any issue. Ask me which suggestions to apply.',
        '',
        'Summary:',
        '{{ nodes.triage.result.output.summary }}',
        '',
        'Suggested changes:',
        '{{ nodes.triage.result.output.suggestions }}',
      ].join('\n'),
    },
  ],
  edges: [
    { from: 'start', to: 'my_issues' },
    { from: 'my_issues', to: 'triage' },
    { from: 'triage', to: 'deliver' },
  ],
};

export const linearTemplates: WorkflowTemplate[] = [
  {
    id: 'linear.weekly-issue-triage',
    name: 'Weekly issue triage',
    description:
      'Get a summary of assigned Linear issues and suggested changes in your orchestrator. Leaves Linear unchanged.',
    category: 'triage',
    apps: ['linear', 'claude'],
    steps: [
      'Read the Linear issues assigned to you.',
      'Summarize the week and pick out what is stale or at risk.',
      'List the changes worth making, one issue at a time.',
      'Send the summary and the suggestions to your orchestrator.',
    ],
    caveats: [
      'Linear tools resolve when the run starts, so a renamed Linear tool fails on the first run, not at install.',
      'The run never writes to Linear. Apply the suggestions yourself.',
    ],
    definition: weeklyIssueTriage,
    schedule: {
      name: 'Weekly issue triage',
      cron: '0 14 * * 1',
      timezone: 'UTC',
      description: 'Mondays at 14:00 UTC',
    },
  },
];

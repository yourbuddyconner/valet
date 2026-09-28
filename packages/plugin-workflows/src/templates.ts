/**
 * Cross-service workflow templates.
 *
 * A template belongs to the plugin that owns the actions it calls. These
 * four have no single owner: three read several services at once, and the
 * memory sweep needs no integration of its own — it runs through the
 * orchestrator, which reads whatever the person has connected. They live
 * with the workflow surface itself.
 *
 * Three contract rules shape every definition here.
 *
 * 1. A scheduled run gets NO `dataSchema` defaults — the schedule puts its
 *    own payload in `trigger.data`, so a template that reads
 *    `trigger.data.<field>` on a cron run reads null. Every scheduled
 *    template below therefore carries its parameters as literals, and only
 *    the manual batch template declares inputs.
 * 2. `trigger.timestamp` IS available on every run path, so a scheduled run
 *    can still know the date.
 * 3. An MCP action (Linear) returns its text content as the node result, a
 *    string. Read the whole `nodes.<id>.result`, never a field under it.
 *
 * Slack here is read-only. This plugin set has no action that posts to a
 * Slack channel, so a digest is delivered through the orchestrator, which
 * is the durable inbox the person already reads.
 */
import type { WorkflowTemplate } from "@valet/engine";
import type { WorkflowDefinition } from "@valet/workflow";

const nightlyMemorySweep: WorkflowDefinition = {
  version: "dag/v1",
  nodes: [
    { id: "start", type: "trigger" },
    {
      // The memory tools are built onto the orchestrator session and exist
      // nowhere else — there is no memory action, so no `tool` node can
      // reach memory. An orchestrator node is not a workaround here, it is
      // the only way to express this.
      id: "sweep",
      type: "thread",
      wait: { mode: "until_idle" },
      prompt: [
        "Run your nightly memory self-improvement pass. The time now is {{ trigger.timestamp }}.",
        "You are the librarian of your own long-term memory. Keep it accurate, current,",
        "deduplicated, and findable — the right answer must surface fast on the next search,",
        "and nothing may mislead.",
        "",
        "## Before anything else",
        "1. Load the `memory` skill with the skill tool. It holds the playbook for every step below.",
        "2. Read notes/memory-audit-log.md — recent audit history and open flags. If it does not",
        "   exist yet, you will create it at the end of this run.",
        "",
        "## Scope and rotation",
        "Memory is typed: preferences/, projects/, workflows/, people/, notes/, and artifacts/",
        "each hold one kind of file, and every durable fact belongs in exactly one typed home.",
        "Work over every directory except journal/. The journal is append-only: read it as a",
        "source of truth, never edit old entries. Do not audit everything in one night. Prefer",
        "files changed recently, files never audited, and files whose subject appears in recent",
        "journal entries. Cap yourself to a modest slice per run and rotate across nights.",
        "Stable files already audited do not need re-examining.",
        "",
        "## Sources of truth",
        "Act autonomously on your own journal history and on connected integrations — they are",
        "the person's authoritative systems, and reading them to verify a fact is in bounds.",
        "Do not canonize facts from the open web. If only web research can resolve a fact, flag it.",
        "",
        "## Priorities, in order",
        "1. People sweep. Pick a few people/ hubs: recently mentioned, never audited, or holding",
        "   time-sensitive claims (role, team, current project, contact info). Verify each claim",
        "   against the journal and connected integrations. Correct a contradicted claim in place",
        "   and cite the source. Add facts recent journal traffic surfaced that the hub lacks.",
        "   Keep hubs terse: links over prose. Flag what you cannot verify.",
        "2. Save-worthy scan. If a connected integration carries the person's day-to-day traffic",
        "   (chat channels, email), read what arrived since the last run. Keep the scan cursor in",
        "   state/nightly-scan-cursor.md; with no cursor, cover the last 24 hours. Canonize what",
        "   should exist in memory but does not: decisions the person announced, preferences the",
        "   person stated in their own words (origin: user-stated), people facts, workflow",
        "   patterns that repeat, and corrections to existing memory. Do not canonize open",
        "   brainstorming that landed in no decision. Advance the cursor only after the writes",
        "   succeed. With no such integration, skip this step.",
        "3. Consolidate and dedup. mem_search by topic AND by resource — two files with the same",
        "   resource are the classic duplicate. Merge into the file with more inbound links,",
        "   patch every referencer, then mem_rm the other.",
        "4. Metadata enrichment. Fill thin metadata with a metadata-only mem_write (omit content):",
        "   type (reclassify after a cross-directory move — mem_move does not), tags (reuse the",
        "   existing vocabulary), description (what the file answers, not its title restated),",
        "   resource for files about one external thing, origin: user-stated where the person",
        "   said it directly, and expires on time-bound content.",
        "5. Grow the knowledge graph. Memory is a linked graph, not a pile of files — links are",
        "   how the next search finds context. Keep one concept per file, hub-and-spoke over",
        "   mega-files. Add a Related section to each file you touch that links its cluster,",
        "   with a word on why each link matters. Link every person mention to its people/ hub",
        "   and every project fact to its projects/ file. Run mem_links on files you touch: for",
        "   a phantom target, create the stub or fix the link; for a valuable file with no",
        "   inbound links, link it from a hub.",
        "6. Journal distillation. Promote durable facts from journal entries older than two weeks",
        "   into the right typed file — update existing files over creating new ones — and link",
        "   back to the source journal date for provenance.",
        "7. Corrections. Update what a newer entry supersedes. Reconcile files that disagree",
        "   toward the stronger evidence. Correct what an authoritative source proves wrong, and",
        "   cite the source. Fill gaps you can fill without guessing. Prune what no longer exists,",
        "   confirmed against an integration where possible. When correctness depends on the",
        "   person's intent, do not touch the file — flag it.",
        "",
        "## Context-budget awareness",
        "Pinned files and recent journals load at every wake inside a fixed budget. Keep pins few",
        "and short. When a pinned file grows, split it: a pinned kernel plus a linked spoke.",
        "",
        "## Hard rules",
        "- Before a high-blast-radius action, stop and flag instead. That means: deleting or",
        "  rewriting anything under preferences/ or any pinned file, a bulk prune, a structural",
        "  reorganization, or any change you are unsure about.",
        "- Reorganize with mem_move, never write + rm. After a cross-directory move, reclassify",
        "  the type with a metadata-only mem_write.",
        "- Never invent a value. If you cannot verify a fact, flag it instead of writing it.",
        "- Cite the source for every correction and gap-fill: a journal date, an integration",
        "  query, a document link.",
        "- Prefer mem_patch over a full-file mem_write.",
        "- Before a prune or merge, check inbound links with mem_links.",
        "- Before creating a file about an external resource, mem_search that resource. If a",
        "  file already covers it, merge there. Do not fork.",
        "",
        "## Close out",
        "Append one dated entry to notes/memory-audit-log.md: files touched, one line per change,",
        "a section per priority worked, and any new flags. Before flagging, check the log — if",
        "the same unresolved item was flagged on a prior run, do not re-flag it.",
        "Then report briefly: corrections as before → after with the source, what you",
        "consolidated or pruned, and a short 'needs your call' list of new flags. On a clean",
        "run, one line is enough — the audit log is the record.",
      ].join("\n"),
    },
  ],
  edges: [{ from: "start", to: "sweep" }],
};

const dailyTriageDigest: WorkflowDefinition = {
  version: "dag/v1",
  nodes: [
    { id: "start", type: "trigger" },
    {
      id: "review_queue",
      type: "tool",
      service: "github",
      action: "search_issues",
      credential: "user",
      summary: "Pull requests that asked for your review",
      params: { q: "is:open is:pr review-requested:@me archived:false", limit: 25 },
    },
    {
      id: "linear_issues",
      type: "tool",
      service: "linear",
      action: "list_issues",
      // Linear's MCP `list_issues` reads the assignee filter as "me" for the
      // authenticated user (the tool's own description: "For my issues, use
      // 'me' as the assignee.").
      params: { assignee: "me" },
      summary: "Issues assigned to you",
    },
    {
      id: "slack_channels",
      type: "tool",
      service: "slack",
      action: "list_channels",
      summary: "Channels the workspace connection has joined",
      params: { scope: "joined" },
    },
    {
      id: "slack_history",
      type: "foreach",
      items: "{{ nodes.slack_channels.result.channels }}",
      // Explicit, so a workspace with more channels than this is reported
      // as truncated by the digest instead of quietly cut short.
      maxItems: 12,
      concurrency: 3,
      onItemError: "collect",
      body: {
        id: "read_channel",
        type: "tool",
        service: "slack",
        action: "read_history",
        summary: "Recent messages in one channel",
        params: { channel: "{{ item.id }}", limit: 40 },
      },
    },
    {
      id: "digest",
      type: "llm",
      model: "claude-sonnet-4-5",
      system:
        "You write one morning triage digest across three sources. Lead with what blocks another person. " +
        "Then what blocks the reader. Then what only needs to be read. Give each item its link or its " +
        "channel. Merge items that describe the same piece of work. Never invent an item.",
      prompt: [
        "The time now is {{ trigger.timestamp }}. Treat anything older than one day as background.",
        "",
        "## GitHub — reviews waiting on you",
        "{{ nodes.review_queue.result.items }}",
        "",
        "## Linear — issues assigned to you",
        "{{ nodes.linear_issues.result }}",
        "",
        "## Slack — recent channel activity",
        "Channels read: {{ nodes.slack_history.result.completedCount }} of {{ nodes.slack_history.result.inputCount }}.",
        "Channels not read because the limit was reached: {{ nodes.slack_history.result.truncatedCount }}.",
        "{{ nodes.slack_history.result.items }}",
        "",
        "Write the digest in markdown, under 500 words. Name any source that returned an error,",
        "and say plainly when a source had nothing.",
      ].join("\n"),
    },
    {
      id: "deliver",
      type: "thread",
      wait: { mode: "until_idle" },
      prompt: [
        "This is my morning triage digest. Post it back to me as it is written.",
        "Do not act on any item unless I ask you to.",
        "",
        "{{ nodes.digest.result.text }}",
      ].join("\n"),
    },
  ],
  edges: [
    { from: "start", to: "review_queue" },
    { from: "start", to: "linear_issues" },
    { from: "start", to: "slack_channels" },
    { from: "slack_channels", to: "slack_history" },
    { from: "review_queue", to: "digest" },
    { from: "linear_issues", to: "digest" },
    { from: "slack_history", to: "digest" },
    { from: "digest", to: "deliver" },
  ],
};

const meetingPrep: WorkflowDefinition = {
  version: "dag/v1",
  nodes: [
    { id: "start", type: "trigger" },
    {
      id: "my_pull_requests",
      type: "tool",
      service: "github",
      action: "search_issues",
      credential: "user",
      summary: "Your recent pull requests",
      params: { q: "is:pr author:@me archived:false", sort: "updated", order: "desc", limit: 25 },
    },
    {
      id: "linear_issues",
      type: "tool",
      service: "linear",
      action: "list_issues",
      // Linear's MCP `list_issues` reads the assignee filter as "me" for the
      // authenticated user (the tool's own description: "For my issues, use
      // 'me' as the assignee.").
      params: { assignee: "me" },
      summary: "Issues assigned to you",
    },
    {
      id: "slack_channels",
      type: "tool",
      service: "slack",
      action: "list_channels",
      summary: "Channels the workspace connection has joined",
      params: { scope: "joined" },
    },
    {
      id: "slack_discussions",
      type: "foreach",
      items: "{{ nodes.slack_channels.result.channels }}",
      maxItems: 12,
      concurrency: 3,
      onItemError: "collect",
      body: {
        // `threads_only` keeps the messages that drew replies. A staff
        // meeting cares about discussions, not about one-line notices.
        id: "read_discussions",
        type: "tool",
        service: "slack",
        action: "read_history",
        summary: "Threaded discussions in one channel",
        params: { channel: "{{ item.id }}", limit: 100, threads_only: true },
      },
    },
    {
      id: "brief",
      type: "llm",
      model: "claude-sonnet-4-5",
      system:
        "You prepare one person for a staff meeting. Select only what is worth saying out loud: a " +
        "decision someone must make, a blocker another team owns, a risk to a date, and work that " +
        "finished and should be told. Leave out routine progress. Each line must be sayable in ten seconds.",
      prompt: [
        "The time now is {{ trigger.timestamp }}. Cover the last seven days.",
        "",
        "## GitHub — your recent pull requests",
        "{{ nodes.my_pull_requests.result.items }}",
        "",
        "## Linear — issues assigned to you",
        "{{ nodes.linear_issues.result }}",
        "",
        "## Slack — threaded discussions",
        "Channels read: {{ nodes.slack_discussions.result.completedCount }} of {{ nodes.slack_discussions.result.inputCount }}.",
        "Channels not read because the limit was reached: {{ nodes.slack_discussions.result.truncatedCount }}.",
        "{{ nodes.slack_discussions.result.items }}",
        "",
        "Write four short sections: Decisions needed, Blockers, Risks to a date, Worth telling.",
        "Write nothing under a heading that has nothing. Say so in one line instead.",
      ].join("\n"),
    },
    {
      id: "deliver",
      type: "thread",
      wait: { mode: "until_idle" },
      prompt: [
        "This is my meeting prep for the week. Post it back to me as it is written,",
        "then hold it so I can ask you about any line.",
        "",
        "{{ nodes.brief.result.text }}",
      ].join("\n"),
    },
  ],
  edges: [
    { from: "start", to: "my_pull_requests" },
    { from: "start", to: "linear_issues" },
    { from: "start", to: "slack_channels" },
    { from: "slack_channels", to: "slack_discussions" },
    { from: "my_pull_requests", to: "brief" },
    { from: "linear_issues", to: "brief" },
    { from: "slack_discussions", to: "brief" },
    { from: "brief", to: "deliver" },
  ],
};

const batchOverRows: WorkflowDefinition = {
  version: "dag/v1",
  nodes: [
    {
      id: "start",
      type: "trigger",
      dataSchema: {
        rows: {
          type: "array",
          required: true,
          label: "Rows",
          placeholder: '[{"account": "Acme", "arr": 120000, "industry": "logistics"}]',
          description: "The list to work through. One entry per row. Up to 100 rows per run.",
        },
        instruction: {
          type: "string",
          required: true,
          label: "What to do with each row",
          placeholder: "Assign an account tier: enterprise, mid-market, or self-serve.",
          description: "One instruction, applied to every row on its own.",
        },
      },
    },
    {
      id: "batch",
      type: "foreach",
      items: "{{ trigger.data.rows }}",
      // The cap is declared, not inherited, and the rollup below reports
      // `truncatedCount` — so a list longer than the cap is visible.
      maxItems: 100,
      concurrency: 3,
      onItemError: "collect",
      body: {
        id: "judge_row",
        type: "llm",
        model: "claude-haiku-4-5",
        system:
          "You apply one instruction to one row. Judge only the row in front of you. " +
          "Give a short reason that cites a value from the row.",
        prompt: [
          "Instruction: {{ trigger.data.instruction }}",
          "",
          "Row {{ index }}:",
          "{{ item }}",
          "",
          'Return JSON in a ```json block: { "label": ..., "rationale": ... }.',
        ].join("\n"),
        outputSchema: {
          type: "object",
          properties: {
            label: { type: "string" },
            rationale: { type: "string" },
          },
          required: ["label", "rationale"],
        },
      },
    },
    {
      id: "rollup",
      type: "llm",
      model: "claude-sonnet-4-5",
      system:
        "You summarize a batch. Report the counts first, then the distribution of labels, then any row " +
        "that failed. Quote the failure text as it was given to you.",
      prompt: [
        "Instruction that was applied: {{ trigger.data.instruction }}",
        "",
        "Rows given: {{ nodes.batch.result.inputCount }}",
        "Rows processed: {{ nodes.batch.result.completedCount }}",
        "Rows failed: {{ nodes.batch.result.failedCount }}",
        "Rows dropped because the 100-row cap was reached: {{ nodes.batch.result.truncatedCount }}",
        "",
        "Per-row results:",
        "{{ nodes.batch.result.items }}",
        "",
        "Write the summary in markdown. If any row was dropped by the cap, say so in the first line.",
      ].join("\n"),
    },
  ],
  edges: [
    { from: "start", to: "batch" },
    { from: "batch", to: "rollup" },
  ],
};

export const workflowTemplates: WorkflowTemplate[] = [
  {
    id: "workflows.nightly-memory-sweep",
    name: "Nightly memory sweep",
    description:
      "Verify and tidy a rotating slice of memory, merge duplicates, and distill old journals. Log changes and report anything that needs your review.",
    category: "maintenance",
    apps: ["claude"],
    steps: [
      "Read the audit log, then pick a slice: recent changes, never-audited files, people hubs.",
      "Verify time-sensitive claims against the journal and connected integrations.",
      "Canonize save-worthy material from recent integration traffic.",
      "Merge duplicates, fill thin metadata, and grow the link graph: cross-link clusters, repair phantoms, connect orphans.",
      "Distill durable facts out of journal entries older than two weeks.",
      "Append to the audit log, then report changes and anything that needs your call.",
    ],
    caveats: [
      "The sweep edits your memory. Read the first few reports before you leave it unattended.",
      "It corrects only what it can verify, and it cites the source. Everything else it flags to you.",
      "It never deletes preferences or pinned files on its own — those are flagged, not touched.",
      "With no integration connected, it verifies against the journal alone and skips the traffic scan.",
    ],
    definition: nightlyMemorySweep,
    schedule: {
      name: "Nightly memory sweep",
      cron: "0 6 * * *",
      timezone: "UTC",
      description: "Every day at 06:00 UTC",
    },
  },
  {
    id: "workflows.daily-triage-digest",
    name: "Daily triage digest",
    description:
      "Get one ranked digest of GitHub reviews, Linear issues, and Slack activity in your orchestrator.",
    category: "digest",
    apps: ["github", "linear", "slack", "claude"],
    steps: [
      "Search GitHub for pull requests that requested your review.",
      "Read the Linear issues assigned to you.",
      "List the Slack channels the connection has joined, then read recent messages in each.",
      "Write one ranked digest across all three.",
      "Send the digest to your orchestrator.",
    ],
    caveats: [
      "Reads up to 12 Slack channels per run. The digest reports how many were left out.",
      "Connect Linear for the workflow workspace. Slack can use the organization connection; team runs use configured team credentials and permitted organization fallbacks.",
      "Linear tools resolve when the run starts, so a renamed Linear tool fails on the first run, not at install.",
      "Uses a GitHub user credential, not the installed App: your account for personal runs, or the configured team credential for team runs.",
    ],
    definition: dailyTriageDigest,
    schedule: {
      name: "Daily triage digest",
      cron: "0 13 * * 1-5",
      timezone: "UTC",
      description: "Weekdays at 13:00 UTC",
    },
  },
  {
    id: "workflows.meeting-prep",
    name: "Weekly meeting prep",
    description:
      "Get a meeting brief with decisions, blockers, risks, and completed work from GitHub, Linear, and Slack.",
    category: "digest",
    apps: ["github", "linear", "slack", "claude"],
    steps: [
      "Read your recent pull requests.",
      "Read the Linear issues assigned to you.",
      "Read the Slack discussions that drew replies, channel by channel.",
      "Select only what is worth saying out loud.",
      "Send four short sections to your orchestrator.",
    ],
    caveats: [
      "Reads up to 12 Slack channels per run. The brief reports how many were left out.",
      "Connect Linear for the workflow workspace. Slack can use the organization connection; team runs use configured team credentials and permitted organization fallbacks.",
      "Linear tools resolve when the run starts, so a renamed Linear tool fails on the first run, not at install.",
      "Uses a GitHub user credential, not the installed App: your account for personal runs, or the configured team credential for team runs.",
    ],
    definition: meetingPrep,
    schedule: {
      name: "Weekly meeting prep",
      cron: "0 15 * * 1",
      timezone: "UTC",
      description: "Mondays at 15:00 UTC",
    },
  },
  {
    id: "workflows.batch-over-rows",
    name: "Run one instruction over a batch",
    description:
      "Apply one instruction to each row, then summarize the results. Runs on demand for up to 100 rows.",
    category: "batch",
    apps: ["claude"],
    steps: [
      "Paste the rows and write the instruction.",
      "Apply the instruction to each row on its own, three at a time.",
      "Collect a label and a reason for every row.",
      "Summarize the counts, the label distribution, and any failure.",
    ],
    caveats: [
      "Runs on demand only. It has no schedule, because a scheduled run cannot read the rows you type here.",
      "It processes the first 100 rows. The summary names how many were dropped.",
      "It produces judgments. It writes to no other system.",
    ],
    definition: batchOverRows,
  },
];

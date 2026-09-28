/**
 * The seeded workflow catalog — templates the host itself ships.
 *
 * A plugin owns the templates that call its actions, so a host that does
 * not load the plugin never offers a workflow it cannot run
 * (`plugin-workflows/src/templates.ts` holds those). The templates here
 * belong to no plugin: they call no integration action at all. They use
 * only `trigger`, `llm`, `if`, `orchestrator` and `stop` nodes, so they
 * validate and install on every deployment, whatever set of plugins is
 * loaded and whatever the person has connected.
 *
 * That is the point of the file. A new account has nothing connected, and a
 * gallery whose every card says "connect GitHub first" teaches nothing. A
 * person can install any of these on the first day, run it, and read the
 * definition to learn how a workflow addresses its own data.
 *
 * ── The addressing contract these definitions demonstrate ──
 *
 * Each of the four rules below has one correct form and one form that looks
 * correct and renders empty. A wrong path is not a validation error at the
 * fourth segment, so a run finishes "successfully" with a blank prompt.
 * Copy these forms.
 *
 *   1. A trigger input is at `{{ trigger.data.<field> }}`. The payload is
 *      `{ type, triggerId, timestamp, data, metadata }`, so
 *      `{{ trigger.<field> }}` renders null.
 *   2. An llm node with no `outputSchema` exposes its text at
 *      `{{ nodes.<id>.result.text }}`. With an `outputSchema` it also
 *      exposes `{{ nodes.<id>.result.output.<field> }}`, and only the
 *      fields that schema declares.
 *   3. An orchestrator or session node exposes `{{ nodes.<id>.result
 *      .response }}`. It has no `.text`, and an llm node has no
 *      `.response`. The two are opposites and easy to swap.
 *   4. Every node result is read under `result`. `output` is a legacy alias
 *      for the same value; new definitions use `result`.
 *
 * ── Why every template here is manual ──
 *
 * A scheduled run puts `{ scheduleName, cron, input }` in `trigger.data`
 * and applies NO `dataSchema` defaults (`scheduler.ts`). A schedule
 * therefore cannot deliver the per-run text these templates work on. Adding
 * a cron would make each one read null every night, forever, and nothing
 * would report it. They collect their inputs in the run form instead.
 *
 * ── Why the notifications go through the orchestrator ──
 *
 * No `tool` node here means no service to connect, but it also means no
 * direct way to post a message. The orchestrator is the durable inbox the
 * person already reads, and it delivers through whatever channel that
 * person has connected. When it has none, it reports back in the session
 * rather than failing the run.
 */
import type { WorkflowTemplate } from "@valet/engine";
import type { WorkflowDefinition } from "@valet/workflow";

/** Reasoning steps use the mid-tier model; matching and classification use
 * the small one. Both ids are in the model catalog the validator checks,
 * so a rename upstream fails at list time rather than on a run. */
const REASONING_MODEL = "claude-sonnet-4-5";
const CLASSIFY_MODEL = "claude-haiku-4-5";

// ─── Draft, critique, revise ─────────────────────────────────────────────

/**
 * Write a draft, judge it against the brief, and revise it only when the
 * judgment says to.
 *
 * The critique step carries an `outputSchema` for one reason: the `if` node
 * needs a field it can compare. A critique written as prose would force a
 * second model call to decide what the first one meant.
 */
const draftAndRevise: WorkflowDefinition = {
  version: "dag/v1",
  nodes: [
    {
      id: "start",
      type: "trigger",
      dataSchema: {
        brief: {
          type: "string",
          required: true,
          label: "Brief",
          placeholder: "Announce that scheduled exports now run hourly instead of daily.",
        },
        audience: {
          type: "string",
          required: true,
          label: "Audience",
          placeholder: "Existing customers on the paid plan",
        },
        constraints: {
          type: "string",
          label: "Constraints",
          placeholder: "Under 150 words. No pricing claims.",
          description: "Optional. Length, tone, and anything the text must not say.",
        },
      },
    },
    {
      id: "draft",
      type: "llm",
      model: REASONING_MODEL,
      system:
        "You write a first draft from a brief. Write for the named audience. Follow every constraint. " +
        "State only what the brief supports, and never add a fact the brief does not give you.",
      prompt: [
        "Brief: {{ trigger.data.brief }}",
        "Audience: {{ trigger.data.audience }}",
        "Constraints: {{ trigger.data.constraints }}",
        "",
        "Write the draft. Return the text only, with no preamble.",
      ].join("\n"),
    },
    {
      id: "critique",
      type: "llm",
      model: REASONING_MODEL,
      system:
        "You judge a draft against its brief. Report only defects a reader would notice: a claim the brief " +
        "does not support, a broken constraint, or the wrong audience. Ignore style you merely dislike. " +
        "A draft with no such defect ships.",
      prompt: [
        "Brief: {{ trigger.data.brief }}",
        "Audience: {{ trigger.data.audience }}",
        "Constraints: {{ trigger.data.constraints }}",
        "",
        "Draft:",
        "{{ nodes.draft.result.text }}",
        "",
        'Return JSON in a ```json block: { "verdict": "ship" | "revise", "issues": [...], "reason": ... }.',
        'Use "revise" only when you listed at least one issue.',
      ].join("\n"),
      outputSchema: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["ship", "revise"] },
          issues: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
        required: ["verdict", "issues", "reason"],
      },
    },
    {
      id: "needs_revision",
      type: "if",
      conditions: [
        { left: "nodes.critique.result.output.verdict", dataType: "string", operation: "equals", right: "revise" },
      ],
    },
    {
      id: "revise",
      type: "llm",
      model: REASONING_MODEL,
      system:
        "You correct a draft. Fix every issue you are given and change nothing else. Keep the parts the " +
        "critique did not name.",
      prompt: [
        "Brief: {{ trigger.data.brief }}",
        "Audience: {{ trigger.data.audience }}",
        "Constraints: {{ trigger.data.constraints }}",
        "",
        "Draft:",
        "{{ nodes.draft.result.text }}",
        "",
        "Issues to fix:",
        "{{ nodes.critique.result.output.issues }}",
        "",
        "Return the corrected text only, with no preamble and no list of what you changed.",
      ].join("\n"),
    },
    {
      id: "revised",
      type: "stop",
      outcome: "success",
      output: {
        text: "{{ nodes.revise.result.text }}",
        revised: true,
        issues: "{{ nodes.critique.result.output.issues }}",
      },
    },
    {
      id: "shipped",
      type: "stop",
      outcome: "success",
      output: {
        text: "{{ nodes.draft.result.text }}",
        revised: false,
        reason: "{{ nodes.critique.result.output.reason }}",
      },
    },
  ],
  edges: [
    { from: "start", to: "draft" },
    { from: "draft", to: "critique" },
    { from: "critique", to: "needs_revision" },
    { from: "needs_revision", to: "revise", fromOutput: "true" },
    { from: "needs_revision", to: "shipped", fromOutput: "false" },
    { from: "revise", to: "revised" },
  ],
};

// ─── Spec to ordered tasks ───────────────────────────────────────────────

/**
 * Turn a written spec into an ordered task list, then hand it to the
 * orchestrator.
 *
 * The orchestrator step reads the plan and holds it. It creates nothing.
 * A workflow that files tickets from a model's first pass over a spec
 * produces a backlog nobody trusts, so the person approves the list in
 * conversation and then asks for the tickets.
 */
const specToTasks: WorkflowDefinition = {
  version: "dag/v1",
  nodes: [
    {
      id: "start",
      type: "trigger",
      dataSchema: {
        spec: {
          type: "string",
          required: true,
          label: "Spec",
          placeholder: "Paste the spec, the design doc, or a description of the change.",
        },
        teamContext: {
          type: "string",
          label: "Team context",
          placeholder: "Two engineers. The export service is already deployed.",
          description: "Optional. What the team already has, so the plan does not repeat finished work.",
        },
      },
    },
    {
      id: "plan",
      type: "llm",
      model: REASONING_MODEL,
      system:
        "You break a spec into tasks a team can pick up. Each task is one piece of work with a clear end. " +
        "Order the list so a task never comes before the task it depends on. Name a dependency by the title " +
        "of the task it needs. When the spec leaves something undecided, put it in openQuestions rather than " +
        "guessing it inside a task.",
      prompt: [
        "Spec:",
        "{{ trigger.data.spec }}",
        "",
        "Team context: {{ trigger.data.teamContext }}",
        "",
        "Return JSON in a ```json block:",
        '{ "tasks": [{ "title": ..., "why": ..., "dependsOn": [...], "size": "S" | "M" | "L" }],',
        '  "risks": [...], "openQuestions": [...] }.',
      ].join("\n"),
      outputSchema: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                why: { type: "string" },
                dependsOn: { type: "array", items: { type: "string" } },
                size: { type: "string", enum: ["S", "M", "L"] },
              },
              required: ["title", "why", "dependsOn", "size"],
            },
          },
          risks: { type: "array", items: { type: "string" } },
          openQuestions: { type: "array", items: { type: "string" } },
        },
        required: ["tasks", "risks", "openQuestions"],
      },
    },
    {
      id: "handoff",
      type: "thread",
      wait: { mode: "until_idle" },
      prompt: [
        "This is a task breakdown of a spec. Post it back to me as a numbered list, in the order given,",
        "with the size and the dependencies on each line. Then list the risks and the open questions.",
        "",
        "Create nothing yet. Wait until I tell you which tasks to file.",
        "",
        "Tasks:",
        "{{ nodes.plan.result.output.tasks }}",
        "",
        "Risks:",
        "{{ nodes.plan.result.output.risks }}",
        "",
        "Open questions:",
        "{{ nodes.plan.result.output.openQuestions }}",
      ].join("\n"),
    },
    {
      id: "done",
      type: "stop",
      outcome: "success",
      output: {
        tasks: "{{ nodes.plan.result.output.tasks }}",
        risks: "{{ nodes.plan.result.output.risks }}",
        openQuestions: "{{ nodes.plan.result.output.openQuestions }}",
      },
    },
  ],
  edges: [
    { from: "start", to: "plan" },
    { from: "plan", to: "handoff" },
    { from: "handoff", to: "done" },
  ],
};

// ─── The catalog ─────────────────────────────────────────────────────────

/**
 * Ids are namespaced `catalog.` so a plugin can never claim one by
 * accident. `listCatalogTemplates` throws on a collision anyway, which
 * turns the accident into a build-time failure rather than a template the
 * install route can no longer reach.
 */
export const builtinWorkflowTemplates: WorkflowTemplate[] = [
  {
    id: "catalog.draft-and-revise",
    name: "Draft, critique, revise",
    description:
      "Write a draft from a brief, judge it against that brief, and revise it only when the judgment finds " +
      "a defect a reader would notice.",
    category: "writing",
    apps: ["claude"],
    steps: [
      "Give it the brief, the audience, and any constraints.",
      "Write a first draft.",
      "Judge the draft against the brief and list the defects.",
      "Revise when there are defects, and ship the first draft when there are none.",
    ],
    caveats: [
      "The critique and the draft come from the same model, so it does not replace a human read of anything that matters.",
      "It returns text. It publishes nothing.",
    ],
    definition: draftAndRevise,
  },
  {
    id: "catalog.spec-to-tasks",
    name: "Break a spec into ordered tasks",
    description:
      "Turn a spec into a dependency-ordered task list with sizes, risks, and the questions the spec leaves " +
      "open, then hand it to your orchestrator to review with you.",
    category: "planning",
    apps: ["claude"],
    steps: [
      "Paste the spec, and the team context if it helps.",
      "Break it into tasks, each with a reason, a size, and its dependencies.",
      "Collect the risks and the questions the spec leaves open.",
      "Hand the list to your orchestrator, which posts it and waits.",
    ],
    caveats: [
      "It files nothing. The orchestrator holds the list until you say which tasks to create.",
      "Sizes are an estimate from the spec text alone.",
    ],
    definition: specToTasks,
  },
];

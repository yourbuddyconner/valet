/**
 * "New workflow" dialog: name the workflow, choose the shape it starts
 * from, and land in the editor on it.
 *
 * Before the presets, "New workflow" always produced a bare trigger → stop
 * graph. That graph runs, but it teaches nothing: the person then has to
 * discover the node types, the edge rules, and — the expensive part — how a
 * node reads the value another node produced. A wrong template path is not
 * a validation error, so the run finishes "successfully" with an empty
 * prompt in the middle of it.
 *
 * So each preset below is a WORKED EXAMPLE of the addressing contract, not
 * a stub. The four rules, and the near-miss each one has:
 *
 *   1. A trigger input is at `{{ trigger.data.<field> }}`. The trigger
 *      payload is `{ type, triggerId, timestamp, data, metadata }`, so
 *      `{{ trigger.<field> }}` renders null.
 *   2. An llm node with no `outputSchema` exposes its text at
 *      `{{ nodes.<id>.result.text }}`. It has no `.response`.
 *   3. An orchestrator or session node exposes `{{ nodes.<id>.result
 *      .response }}`. It has no `.text`.
 *   4. A tool node's result IS the action's own payload, so
 *      `github.search_issues` is read at `{{ nodes.<id>.result.items }}`
 *      and `{{ nodes.<id>.result.total_count }}`.
 *
 * Whatever a preset ships, a person copies. `new-workflow-dialog.test.tsx`
 * therefore holds every preset to the validator and to those four rules.
 *
 * Mirrors `~/components/new-session-dialog.tsx` — same controlled `open`/
 * `onOpenChange` + `Dialog`/`DialogContent`/`DialogFooter` composition, same
 * "stays open with the mutation's error on failure" pattern.
 */
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useCreateWorkflow } from "~/api/workflows";
import { Button, Dialog, DialogContent, DialogFooter, Input, Label } from "~/components/primitives";
import { ModelCombobox } from "~/components/settings/model-combobox";
import { RadioCard } from "~/components/settings/radio-card";
import {
  autoLayout,
  createDefaultWorkflowDefinition,
  type WorkflowDefinition,
  type WorkflowNode,
} from "~/components/workflows/editor-model";
import { errorText } from "~/lib/error-text";
import { useWorkspaceScope } from "~/lib/workspace-scope";

const DEFAULT_NAME = "Untitled workflow";

/** Presets save tier tokens. The org controls which catalog model each tier resolves to. */
const WRITE_MODEL = "m";
const CLASSIFY_MODEL = "xs";

export interface WorkflowPreset {
  id: string;
  name: string;
  /** One line on the card. It says what the graph is, not what it is for. */
  description: string;
  /** The workflow name this preset suggests, until the person types one. */
  suggestedName: string;
  /** A catalog-backed size tier selected for this preset's intended task. */
  recommendedModel: string;
  build: () => WorkflowDefinition;
}

/**
 * Give every node a saved position.
 *
 * A definition with no `ui` still renders — the canvas falls back to
 * `autoLayout` for a node with no entry. Writing the positions in makes
 * them the person's own from the first save, so a later edit does not
 * silently re-flow the graph they arranged.
 */
function laidOut(definition: WorkflowDefinition): WorkflowDefinition {
  const positions = autoLayout(definition);
  const nodes: Record<string, { position: { x: number; y: number } }> = {};
  for (const [id, position] of Object.entries(positions)) nodes[id] = { position };
  return { ...definition, ui: { nodes } };
}

/** Apply the visible creation choice to every model-capable starter node. */
export function withWorkflowModel(definition: WorkflowDefinition, model: string): WorkflowDefinition {
  const next = structuredClone(definition);
  next.ui = { ...next.ui, nodes: next.ui?.nodes ?? {}, defaultModel: model };
  const apply = (node: WorkflowNode): void => {
    if (node.type === "llm" || node.type === "session") node.model = model;
    if (node.type === "foreach") apply(node.body);
  };
  for (const node of next.nodes) apply(node);
  return next;
}

/** Trigger → one llm step → stop. The shortest graph that reads an input
 * and returns a result. */
function buildSimple(): WorkflowDefinition {
  return laidOut({
    version: "dag/v1",
    nodes: [
      {
        id: "start",
        type: "trigger",
        dataSchema: {
          request: {
            type: "string",
            required: true,
            label: "Request",
            placeholder: "Summarize this week's release notes for the support team.",
          },
        },
      },
      {
        id: "respond",
        type: "llm",
        model: WRITE_MODEL,
        system: "You answer the request you are given. Answer only what was asked.",
        prompt: "{{ trigger.data.request }}",
      },
      {
        id: "done",
        type: "stop",
        outcome: "success",
        // An llm node with no outputSchema exposes `result.text`, and
        // nothing else that carries the answer.
        output: { answer: "{{ nodes.respond.result.text }}" },
      },
    ],
    edges: [
      { from: "start", to: "respond" },
      { from: "respond", to: "done" },
    ],
  });
}

/**
 * Trigger → three branches → aggregate → stop.
 *
 * The branches are separate nodes rather than a `foreach`, because a
 * starter graph should show the fan-out plainly on the canvas. A `foreach`
 * hides the width behind one node, and it truncates at `maxItems` in
 * silence, which is the wrong first lesson.
 */
function buildParallel(): WorkflowDefinition {
  const angle = (id: string, lens: string, instruction: string): WorkflowNode => ({
    id,
    type: "llm",
    model: WRITE_MODEL,
    system: `You examine one subject through a single lens: ${lens}. Ignore every other angle.`,
    prompt: [`Subject: {{ trigger.data.subject }}`, "", instruction].join("\n"),
  });

  return laidOut({
    version: "dag/v1",
    nodes: [
      {
        id: "start",
        type: "trigger",
        dataSchema: {
          subject: {
            type: "string",
            required: true,
            label: "Subject",
            placeholder: "Move scheduled exports from daily to hourly.",
          },
        },
      },
      angle("risks", "what could go wrong", "List the risks. Give each one a likely cause."),
      angle("options", "the ways to do it", "List the options. Give each one its main trade-off."),
      angle("evidence", "what we would need to know", "List what we must measure or confirm first."),
      {
        id: "summary",
        type: "llm",
        model: WRITE_MODEL,
        system:
          "You merge three separate analyses into one brief. Keep every point that appears in only one of " +
          "them. Say plainly where two of them disagree. Add nothing they did not say.",
        prompt: [
          "Subject: {{ trigger.data.subject }}",
          "",
          "## Risks",
          "{{ nodes.risks.result.text }}",
          "",
          "## Options",
          "{{ nodes.options.result.text }}",
          "",
          "## What we need to know",
          "{{ nodes.evidence.result.text }}",
          "",
          "Write the brief in markdown, under 400 words.",
        ].join("\n"),
      },
      {
        id: "done",
        type: "stop",
        outcome: "success",
        output: { brief: "{{ nodes.summary.result.text }}" },
      },
    ],
    // The three angle nodes leave the trigger together, so the run executes
    // them in one wave rather than one after another.
    edges: [
      { from: "start", to: "risks" },
      { from: "start", to: "options" },
      { from: "start", to: "evidence" },
      { from: "risks", to: "summary" },
      { from: "options", to: "summary" },
      { from: "evidence", to: "summary" },
      { from: "summary", to: "done" },
    ],
  });
}

/**
 * Trigger → tool call → conditional → stop.
 *
 * GitHub search is the example because it reads and never writes, so
 * running the preset unchanged cannot damage anything. The empty result is
 * a real branch, not an afterthought: a report written over zero rows is
 * the most common way one of these workflows lies to its reader.
 */
function buildApiAutomation(): WorkflowDefinition {
  return laidOut({
    version: "dag/v1",
    nodes: [
      {
        id: "start",
        type: "trigger",
        dataSchema: {
          query: {
            type: "string",
            required: true,
            label: "GitHub search query",
            placeholder: "is:open is:pr review-requested:@me archived:false",
            description: "The same query syntax the GitHub search box takes.",
          },
        },
      },
      {
        id: "search",
        type: "tool",
        service: "github",
        action: "search_issues",
        // Act as the workflow's owner. The installed application has no
        // view of "assigned to me", so `app` would return a different set.
        credential: "user",
        summary: "Issues and pull requests that match the query",
        params: { q: "{{ trigger.data.query }}", limit: 20 },
      },
      {
        id: "any_matches",
        type: "if",
        // A tool node's result IS the action's payload, so the count is at
        // `result.total_count` — the field name github.search_issues
        // returns, not a name of ours.
        conditions: [
          { left: "nodes.search.result.total_count", dataType: "number", operation: "greaterThan", right: 0 },
        ],
      },
      {
        id: "report",
        type: "llm",
        model: CLASSIFY_MODEL,
        system:
          "You turn a list of GitHub items into a short ranked report. Put what blocks another person " +
          "first. Give every item its title and its url. Never invent an item.",
        prompt: [
          "Query: {{ trigger.data.query }}",
          "Matches: {{ nodes.search.result.total_count }}",
          "",
          "{{ nodes.search.result.items }}",
          "",
          "Write the report in markdown, under 300 words.",
        ].join("\n"),
      },
      {
        id: "done",
        type: "stop",
        outcome: "success",
        output: {
          matches: "{{ nodes.search.result.total_count }}",
          report: "{{ nodes.report.result.text }}",
        },
      },
      {
        id: "nothing_found",
        type: "stop",
        // Success, not failure: an empty search is an answer. A failure
        // outcome here would raise an alert every time nothing needed
        // doing.
        outcome: "success",
        message: "Nothing matched the query {{ trigger.data.query }}.",
        output: { matches: 0 },
      },
    ],
    edges: [
      { from: "start", to: "search" },
      { from: "search", to: "any_matches" },
      { from: "any_matches", to: "report", fromOutput: "true" },
      { from: "any_matches", to: "nothing_found", fromOutput: "false" },
      { from: "report", to: "done" },
    ],
  });
}

export const WORKFLOW_PRESETS: WorkflowPreset[] = [
  {
    id: "blank",
    name: "Blank",
    description: "A trigger and a stop. Build the rest yourself.",
    suggestedName: DEFAULT_NAME,
    recommendedModel: "s",
    build: createDefaultWorkflowDefinition,
  },
  {
    id: "simple",
    name: "Simple",
    description: "One step: take a request, answer it, return the answer.",
    suggestedName: "Answer a request",
    recommendedModel: WRITE_MODEL,
    build: buildSimple,
  },
  {
    id: "parallel",
    name: "Parallel with summary",
    description: "Examine one subject three ways at once, then merge the three into one brief.",
    suggestedName: "Three-angle brief",
    recommendedModel: WRITE_MODEL,
    build: buildParallel,
  },
  {
    id: "api-automation",
    name: "API automation",
    description: "Search GitHub, then report on the matches or say plainly that there were none.",
    suggestedName: "GitHub search report",
    recommendedModel: CLASSIFY_MODEL,
    build: buildApiAutomation,
  },
];

export function NewWorkflowDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const scope = useWorkspaceScope();
  return <WorkflowCreationForm key={scope.teamId === undefined ? "personal" : `team:${scope.teamId}`}
    open={open} onOpenChange={onOpenChange} teamId={scope.teamId} />;
}

function WorkflowCreationForm({ open, onOpenChange, teamId }: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  teamId: string | undefined;
}) {
  const navigate = useNavigate();
  const create = useCreateWorkflow();
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    return () => { generation.current += 1; };
  }, [open]);
  const [presetId, setPresetId] = useState(WORKFLOW_PRESETS[0]!.id);
  const [name, setName] = useState(DEFAULT_NAME);
  // Choosing a preset renames an UNTOUCHED field, and never a typed one —
  // silently replacing a name somebody wrote is worse than a dull default.
  const [nameTouched, setNameTouched] = useState(false);
  const [model, setModel] = useState(WORKFLOW_PRESETS[0]!.recommendedModel);
  // A preset can update its recommendation only until the person overrides it.
  const [modelTouched, setModelTouched] = useState(false);
  // The active workspace owns it. An Owner select here duplicated the nav's
  // workspace switcher and could contradict it.
  const preset = WORKFLOW_PRESETS.find((p) => p.id === presetId) ?? WORKFLOW_PRESETS[0]!;

  function selectPreset(next: WorkflowPreset): void {
    setPresetId(next.id);
    if (!nameTouched) setName(next.suggestedName);
    if (!modelTouched) setModel(next.recommendedModel);
  }

  function reset(): void {
    setPresetId(WORKFLOW_PRESETS[0]!.id);
    setName(DEFAULT_NAME);
    setNameTouched(false);
    setModel(WORKFLOW_PRESETS[0]!.recommendedModel);
    setModelTouched(false);
  }

  async function submit() {
    const trimmed = name.trim();
    if (!open || create.isPending || !trimmed) return;
    const requestGeneration = generation.current;
    try {
      const created = await create.mutateAsync({
        name: trimmed,
        definition: withWorkflowModel(preset.build(), model),
        ...(teamId === undefined ? {} : { teamId }),
      });
      // A workspace change unmounts this form. Its late response must not
      // close the new form or navigate away from the new workspace.
      if (generation.current !== requestGeneration) return;
      onOpenChange(false);
      reset();
      void navigate({ to: "/workflows/$workflowId", params: { workflowId: created.id } });
    } catch {
      // useMutation surfaces the error in `create.error`; the dialog stays open.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] max-w-lg overflow-y-auto"
        title="New workflow"
        description="Choose a starting shape. Every one of them runs as it is, and you can rebuild it in the editor."
      >
        <div className="grid gap-1">
          <Label htmlFor="workflow-name">Name</Label>
          <Input
            id="workflow-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
            placeholder={DEFAULT_NAME}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
        </div>

        <div className="grid gap-1">
          <Label id="workflow-preset-label">Start from</Label>
          <div role="radiogroup" aria-labelledby="workflow-preset-label" className="grid gap-2">
            {WORKFLOW_PRESETS.map((option) => (
              <RadioCard
                key={option.id}
                title={option.name}
                description={option.description}
                selected={option.id === preset.id}
                onSelect={() => selectPreset(option)}
              />
            ))}
          </div>
        </div>

        <div className="grid gap-1">
          <Label>Model</Label>
          <ModelCombobox
            value={model}
            onSelect={(value) => {
              setModel(value);
              setModelTouched(true);
            }}
            onClear={() => {
              setModel(preset.recommendedModel);
              setModelTouched(false);
            }}
            emptyLabel="Use recommendation"
            disabled={create.isPending}
          />
          <p className="text-xs text-muted">
            {modelTouched ? "Your override applies to starter LLM and session nodes." : "Recommended for this starting shape."}
          </p>
        </div>

        {create.error && (
          <div className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-xs text-danger-600">
            {errorText(create.error)}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={create.isPending || !name.trim()}>
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import type { ForeachBodyNode, ForeachNode } from "@valet/workflow";
import { LabeledInput, NumberField, SelectField } from "../fields";
import { LlmForm } from "./llm-form";
import { ThreadForm } from "./thread-form";
import { SessionForm } from "./session-form";
import { SetForm } from "./set-form";
import { ToolForm } from "./tool-form";
import { WorkflowCallForm } from "./workflow-call-form";

const FOREACH_BODY_TYPES: ForeachBodyNode["type"][] = [
  "llm",
  "tool",
  "set",
  "thread",
  "session",
  "workflow",
];

export function ForeachForm({
  node,
  onChange,
}: {
  node: ForeachNode;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <LabeledInput
        label="Items (template expression, must resolve to an array)"
        value={node.items}
        onChange={(value) => onChange({ items: value })}
      />
      <LabeledInput
        label="Item alias (default: item)"
        value={node.itemAlias ?? ""}
        onChange={(value) => onChange({ itemAlias: value || undefined })}
      />
      <LabeledInput
        label="Index alias (default: index)"
        value={node.indexAlias ?? ""}
        onChange={(value) => onChange({ indexAlias: value || undefined })}
      />
      <NumberField label="Max items" value={node.maxItems} onChange={(value) => onChange({ maxItems: value })} min={1} />
      <NumberField
        label="Concurrency"
        value={node.concurrency}
        onChange={(value) => onChange({ concurrency: value })}
        min={1}
        max={10}
      />
      <SelectField
        label="On item error"
        value={node.onItemError ?? "fail"}
        onChange={(value) => onChange({ onItemError: value })}
        options={[
          { value: "fail", label: "Fail the loop" },
          { value: "skip", label: "Skip the item" },
          { value: "collect", label: "Collect the error" },
        ]}
      />

      <div className="rounded border border-line p-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted">Body</span>
        <ForeachBodyForm body={node.body} onChange={(body) => onChange({ body })} />
      </div>
    </div>
  );
}

function defaultForeachBody(type: ForeachBodyNode["type"], id: string): ForeachBodyNode {
  switch (type) {
    case "llm":
      return { id, type: "llm", model: "", prompt: "" };
    case "tool":
      return { id, type: "tool", service: "", action: "", params: {} };
    case "set":
      return { id, type: "set", values: {} };
    case "thread":
      return { id, type: "thread", prompt: "" };
    case "session":
      return { id, type: "session", mode: "start", prompt: "" };
    case "workflow":
      return { id, type: "workflow", workflowId: "" };
  }
}

/**
 * Reuses the same per-type forms as the top-level dispatch (`registry.ts`'s
 * `NodeForm`) for the foreach body — a body-level field patch is merged
 * into the current body and the WHOLE resulting body object is sent up as
 * a single `{ body }` patch on the parent foreach node.
 */
function ForeachBodyForm({
  body,
  onChange,
}: {
  body: ForeachBodyNode;
  onChange: (body: ForeachBodyNode) => void;
}) {
  function changeBodyType(type: ForeachBodyNode["type"]) {
    if (type === body.type) return;
    onChange(defaultForeachBody(type, body.id));
  }

  function patchBody(patch: Record<string, unknown>) {
    onChange({ ...body, ...patch, id: body.id, type: body.type } as ForeachBodyNode);
  }

  return (
    <div className="mt-2 flex flex-col gap-3">
      <SelectField
        label="Body type"
        value={body.type}
        // Safe narrowing: `value` always comes from `FOREACH_BODY_TYPES`, the
        // exhaustive body-type list this select's `options` were built from.
        onChange={(value) => changeBodyType(value as ForeachBodyNode["type"])}
        options={FOREACH_BODY_TYPES.map((type) => ({ value: type, label: type }))}
      />
      <BodyNodeForm key={`${body.id}:${body.type}`} node={body} onChange={patchBody} />
    </div>
  );
}

/** `allowOnError={false}`: the per-item policy is the foreach's own `onItemError`. */
function BodyNodeForm({
  node,
  onChange,
}: {
  node: ForeachBodyNode;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  switch (node.type) {
    case "llm":
      return <LlmForm node={node} onChange={onChange} allowOnError={false} />;
    case "tool":
      return <ToolForm node={node} onChange={onChange} allowOnError={false} />;
    case "set":
      return <SetForm node={node} onChange={onChange} />;
    case "thread":
      return <ThreadForm node={node} onChange={onChange} />;
    case "session":
      return <SessionForm node={node} onChange={onChange} />;
    case "workflow":
      return <WorkflowCallForm node={node} onChange={onChange} allowOnError={false} />;
  }
}

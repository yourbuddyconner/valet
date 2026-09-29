import type { SessionNode } from "@valet/workflow";
import { JsonTextarea, LabeledInput, LabeledTextarea, SelectField } from "../fields";
import { Label } from "~/components/primitives";
import { ModelCombobox } from "~/components/settings/model-combobox";

export function SessionForm({
  node,
  onChange,
}: {
  node: SessionNode;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <LabeledTextarea label="Prompt" value={node.prompt} onChange={(value) => onChange({ prompt: value })} />
      <LabeledInput label="Title" value={node.title ?? ""} onChange={(value) => onChange({ title: value || undefined })} />
      <div className="grid gap-1">
        <Label>Model</Label>
        <ModelCombobox
          value={node.model ?? null}
          onSelect={(model) => onChange({ model })}
          onClear={() => onChange({ model: undefined })}
          emptyLabel="Use the runtime default"
          ariaLabel="Model"
        />
      </div>
      <JsonTextarea
        label="Output schema (JSON)"
        value={node.outputSchema}
        onChange={(value) => onChange({ outputSchema: value })}
      />
      <SelectField
        label="Wait mode"
        value={node.wait?.mode ?? "none"}
        onChange={(value) => onChange({ wait: { mode: value } })}
        options={[
          { value: "none", label: "None — don't wait" },
          { value: "until_idle", label: "Until idle" },
        ]}
      />
    </div>
  );
}

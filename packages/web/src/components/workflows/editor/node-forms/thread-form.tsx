import type { ThreadNode } from "@valet/workflow";
import { JsonTextarea, LabeledTextarea, SelectField } from "../fields";

export function ThreadForm({
  node,
  onChange,
}: {
  node: ThreadNode;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <LabeledTextarea label="Prompt" value={node.prompt} onChange={(value) => onChange({ prompt: value })} />
      <JsonTextarea
        label="Output schema (JSON)"
        value={node.outputSchema}
        onChange={(value) => onChange({ outputSchema: value })}
      />
      <SelectField
        label="Wait mode"
        value={node.wait?.mode ?? "until_idle"}
        onChange={(value) => onChange({ wait: { mode: value } })}
        options={[
          { value: "none", label: "None — don't wait" },
          { value: "until_idle", label: "Until idle" },
        ]}
      />
    </div>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useMe, usePatchMe, useOrg } from "~/api/settings";
import { FieldRow } from "~/components/settings/field-row";
import { ModelCombobox } from "~/components/settings/model-combobox";
import { ReasoningSelect } from "~/components/settings/reasoning-select";
import { Section } from "~/components/settings/section";

/** Personal defaults for new threads. */
export const Route = createFileRoute("/settings/threads")({
  component: ThreadDefaultsPage,
});

export function ThreadDefaultsPage() {
  const meQ = useMe();
  const patchMe = usePatchMe();
  const org = useOrg();
  const defaultSource = org.data?.features.organizations ? "Organization default" : "Valet default";

  return (
    <Section title="Thread defaults" description="Defaults for new conversations in your personal space.">
      <FieldRow
        label="Default model"
        hint={`Choose a model for new personal threads, or use the ${defaultSource.toLowerCase()}. Existing threads keep their settings.`}
      >
        <ModelCombobox
          value={meQ.data?.defaultModel ?? null}
          onSelect={(id) => patchMe.mutate({ defaultModel: id })}
          onClear={() => patchMe.mutate({ defaultModel: null })}
          emptyLabel={defaultSource}
        />
      </FieldRow>

      <FieldRow
        label="Default reasoning"
        hint={`Choose a reasoning level for new personal threads, or use the ${defaultSource.toLowerCase()}. Existing threads keep their settings.`}
      >
        <ReasoningSelect
          value={meQ.data?.defaultReasoning ?? null}
          onChange={(defaultReasoning) => patchMe.mutate({ defaultReasoning })}
          emptyLabel={defaultSource}
        />
      </FieldRow>

      <FieldRow
        label="New thread behavior"
        hint="Choose whether a new thread keeps the current model and thinking or uses your configured defaults."
      >
        <select
          aria-label="New thread behavior"
          value={meQ.data?.newThreadBehavior ?? "keep_current"}
          onChange={(event) => {
            const newThreadBehavior = event.target.value;
            if (newThreadBehavior === "keep_current" || newThreadBehavior === "use_defaults") {
              patchMe.mutate({ newThreadBehavior });
            }
          }}
          className="h-12 w-full rounded border border-[--border] bg-[--bg] px-2 text-base sm:h-9 sm:text-sm text-[--fg]"
        >
          <option value="keep_current">Keep current settings</option>
          <option value="use_defaults">Use configured defaults</option>
        </select>
      </FieldRow>
    </Section>
  );
}

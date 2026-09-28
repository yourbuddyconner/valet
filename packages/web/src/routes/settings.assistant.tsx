import { createFileRoute } from "@tanstack/react-router";
import { useMe, usePatchMe } from "~/api/settings";
import { FieldRow } from "~/components/settings/field-row";
import { ModelCombobox } from "~/components/settings/model-combobox";
import { ReasoningSelect } from "~/components/settings/reasoning-select";
import { Section } from "~/components/settings/section";

/**
 * `/settings/assistant` — You · Assistant. Name + personality (shared
 * `IdentityFields`, same component/mutation the dashboard's identity header
 * uses) plus the default-model typeahead (now tier-first, Task 15) over
 * `GET /api/models` + `PATCH /api/me`, and the default-reasoning select
 * over `GET /api/org/reasoning` + `PATCH /api/me`.
 */
export const Route = createFileRoute("/settings/assistant")({
  component: AssistantPage,
});

export function AssistantPage() {
  const meQ = useMe();
  const patchMe = usePatchMe();

  return (
    <Section title="Thread defaults" description="Defaults for new conversations in your personal space.">
      <FieldRow
        label="Default model"
        hint="New sessions you start use this model or size. Existing sessions keep theirs. Switch the model per thread in the chat header. Shared team assistants do not use it."
      >
        <ModelCombobox
          value={meQ.data?.defaultModel ?? null}
          onSelect={(id) => patchMe.mutate({ defaultModel: id })}
          onClear={() => patchMe.mutate({ defaultModel: null })}
          emptyLabel="Team or organization default"
        />
      </FieldRow>

      <FieldRow
        label="Default reasoning"
        hint="New sessions you start use this reasoning level. Existing sessions keep theirs."
      >
        <ReasoningSelect
          value={meQ.data?.defaultReasoning ?? null}
          onChange={(defaultReasoning) => patchMe.mutate({ defaultReasoning })}
          emptyLabel="Team or organization default"
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

import { useState } from "react";
import { Label, Spinner } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { useOrgReasoning, usePatchOrgReasoning } from "~/api/settings";
import { apiErrorMessage } from "~/api/policies";
import { levelsUpTo, REASONING_LABELS, REASONING_LEVELS } from "~/lib/reasoning";

const SELECT_CLASS = "mt-1 h-12 w-full rounded border border-[--border] bg-[--bg] px-2 text-base text-[--fg] sm:h-9 sm:text-sm";

/**
 * Organization · Models — default and max reasoning levels
 * (model-selector-overhaul, Task 13). `GET`/`PATCH /api/org/reasoning`
 * stores each field as an explicit level or unset (inherit / no cap). A
 * default above the chosen max is disabled in the picker rather than
 * silently clamped, per `levelsUpTo`.
 */
export function ReasoningSection() {
  const reasoningQ = useOrgReasoning();
  const patchReasoning = usePatchOrgReasoning();
  const [error, setError] = useState<string | null>(null);

  const data = reasoningQ.data;
  const defaultLevel = data?.default ?? "";
  const maxLevel = data?.max ?? "";
  const allowedDefaults = new Set(levelsUpTo(maxLevel || undefined));

  function setDefault(value: string) {
    setError(null);
    patchReasoning.mutate(
      { default: value || null },
      { onError: (err) => setError(apiErrorMessage(err)) },
    );
  }

  function setMax(value: string) {
    setError(null);
    patchReasoning.mutate(
      { max: value || null },
      { onError: (err) => setError(apiErrorMessage(err)) },
    );
  }

  return (
    <Section
      title="Reasoning"
      description="Set the default and maximum extended-thinking levels for runtimes in this organization."
    >
      {reasoningQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {reasoningQ.error && (
        <p className="py-4 text-sm text-danger-500">Failed to load reasoning settings.</p>
      )}

      {data && (
        <div className="space-y-4 py-4">
          <div className="grid max-w-md grid-cols-2 gap-4">
            <div>
              <Label htmlFor="reasoning-default">Default</Label>
              <select
                id="reasoning-default"
                value={defaultLevel}
                onChange={(e) => setDefault(e.target.value)}
                className={SELECT_CLASS}
              >
                <option value="">Inherit</option>
                {REASONING_LEVELS.map((level) => (
                  <option key={level} value={level} disabled={!allowedDefaults.has(level)}>
                    {REASONING_LABELS[level]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="reasoning-max">Max</Label>
              <select
                id="reasoning-max"
                value={maxLevel}
                onChange={(e) => setMax(e.target.value)}
                className={SELECT_CLASS}
              >
                <option value="">No cap</option>
                {REASONING_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {REASONING_LABELS[level]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {error && <p className="text-xs text-danger-500">{error}</p>}
        </div>
      )}
    </Section>
  );
}

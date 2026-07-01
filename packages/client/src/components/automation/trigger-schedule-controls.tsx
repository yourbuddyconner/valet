import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import {
  getSchedulePresetForCron,
  getSchedulePresetSummary,
  resolveSchedulePresetCron,
  SCHEDULE_PRESETS,
  type SchedulePresetId,
} from './trigger-schedule-model';

interface FriendlyScheduleFieldsProps {
  cron: string;
  timezone: string;
  onCronChange: (value: string) => void;
  onTimezoneChange: (value: string) => void;
}

export function FriendlyScheduleFields({
  cron,
  timezone,
  onCronChange,
  onTimezoneChange,
}: FriendlyScheduleFieldsProps) {
  const selectedPreset = getSchedulePresetForCron(cron);
  const isCustom = selectedPreset.id === 'custom';

  function handlePresetChange(value: string) {
    onCronChange(resolveSchedulePresetCron(value as SchedulePresetId, cron));
  }

  return (
    <div className="space-y-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-700 dark:bg-neutral-900/40">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Schedule
          </label>
          <select
            value={selectedPreset.id}
            onChange={(event) => handlePresetChange(event.target.value)}
            className="h-10 w-full rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:focus:ring-neutral-100"
          >
            {SCHEDULE_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
            {getSchedulePresetSummary(selectedPreset.id)}
          </p>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Timezone
          </label>
          <Input
            value={timezone}
            onChange={(event) => onTimezoneChange(event.target.value)}
            placeholder="America/Los_Angeles"
            className="h-10"
          />
          <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
            Runs in this timezone.
          </p>
        </div>
      </div>

      {isCustom ? (
        <div>
          <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Cron expression
          </label>
          <Input
            value={cron}
            onChange={(event) => onCronChange(event.target.value)}
            placeholder="0 9 * * 1-5"
          />
          <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
            Advanced cron syntax. Use five fields: minute, hour, day, month, weekday.
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
          <span>Stored as</span>
          <code className="rounded-md border border-neutral-200 bg-white px-2 py-1 font-mono text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
            {cron}
          </code>
        </div>
      )}
    </div>
  );
}

interface OrchestratorPromptEditorProps {
  value: string;
  onChange: (value: string) => void;
  hasError?: boolean;
}

export function OrchestratorPromptEditor({
  value,
  onChange,
  hasError = false,
}: OrchestratorPromptEditorProps) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Orchestrator prompt
        </label>
        <span className="text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
          {value.trim().length} chars
        </span>
      </div>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={12}
        placeholder="Describe exactly what your orchestrator should do when this schedule runs."
        className={cn(
          'min-h-[320px] w-full resize-y rounded-lg border border-neutral-200 bg-white px-4 py-3 text-sm leading-6 text-neutral-900 shadow-inner placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:ring-neutral-100',
          hasError && 'border-red-500 focus:ring-red-500 dark:border-red-500 dark:focus:ring-red-500',
        )}
      />
      <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
        This prompt is sent to the orchestrator each time the trigger fires.
      </p>
    </div>
  );
}

interface OrchestratorModelSelectorProps {
  value: string;
  onChange: (value: string) => void;
  availableModels: Array<{ provider: string; models: Array<{ id: string; name: string }> }>;
}

/**
 * Optional per-trigger model override for orchestrator schedules. Empty
 * string means "inherit the session's default model." The value is a raw
 * model id (e.g. "claude-sonnet-4-6") threaded through to the DO's
 * /prompt endpoint on each fire.
 */
export function OrchestratorModelSelector({
  value,
  onChange,
  availableModels,
}: OrchestratorModelSelectorProps) {
  // If the persisted value isn't in any provider group — either because
  // it was removed from the org's available models, or because the models
  // query hasn't resolved yet — render a synthetic option so the pinned
  // value stays visible instead of the select silently blanking out.
  const valueInList = value === '' || availableModels.some(
    (group) => group.models.some((model) => model.id === value),
  );

  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
        Model
      </label>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          'w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-neutral-900',
          'dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:focus:ring-neutral-100',
        )}
      >
        <option value="">Inherit user default</option>
        {!valueInList && (
          <option value={value}>Unknown model: {value}</option>
        )}
        {availableModels.map((group) => (
          <optgroup key={group.provider} label={group.provider}>
            {group.models.map((model) => (
              <option key={model.id} value={model.id}>{model.name}</option>
            ))}
          </optgroup>
        ))}
      </select>
      {!valueInList && (
        <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-400">
          The pinned model is not in your currently available list. Pick a new model or clear this to inherit the default.
        </p>
      )}
      {valueInList && (
        <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
          Optional. Each fire creates a new thread using this model instead of your default.
        </p>
      )}
    </div>
  );
}

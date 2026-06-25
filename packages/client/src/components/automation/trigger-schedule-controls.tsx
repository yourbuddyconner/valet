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

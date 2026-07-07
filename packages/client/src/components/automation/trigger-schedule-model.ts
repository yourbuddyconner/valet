export type SchedulePresetId =
  | 'weekdays_morning'
  | 'daily_morning'
  | 'twice_daily'
  | 'weekly_monday'
  | 'weekly_friday'
  | 'hourly'
  | 'custom';

export interface SchedulePreset {
  id: SchedulePresetId;
  label: string;
  description: string;
  cron: string | null;
}

export const SCHEDULE_PRESETS: SchedulePreset[] = [
  {
    id: 'weekdays_morning',
    label: 'Every weekday morning',
    description: 'Runs Monday through Friday at 9:00 AM.',
    cron: '0 9 * * 1-5',
  },
  {
    id: 'daily_morning',
    label: 'Every morning',
    description: 'Runs every day at 9:00 AM.',
    cron: '0 9 * * *',
  },
  {
    id: 'twice_daily',
    label: 'Twice a day',
    description: 'Runs every day at 9:00 AM and 6:00 PM.',
    cron: '0 9,18 * * *',
  },
  {
    id: 'weekly_monday',
    label: 'Once a week',
    description: 'Runs once a week on Monday at 9:00 AM.',
    cron: '0 9 * * 1',
  },
  {
    id: 'weekly_friday',
    label: 'Every Friday afternoon',
    description: 'Runs once a week on Friday at 4:00 PM.',
    cron: '0 16 * * 5',
  },
  {
    id: 'hourly',
    label: 'Every hour',
    description: 'Runs at the top of every hour.',
    cron: '0 * * * *',
  },
  {
    id: 'custom',
    label: 'Custom cron',
    description: 'Use an advanced cron expression.',
    cron: null,
  },
];

export function getSchedulePresetForCron(cron: string): SchedulePreset {
  const normalizedCron = cron.trim();
  return SCHEDULE_PRESETS.find((preset) => preset.cron === normalizedCron)
    ?? SCHEDULE_PRESETS[SCHEDULE_PRESETS.length - 1];
}

export function resolveSchedulePresetCron(
  presetId: SchedulePresetId,
  currentCron: string,
): string {
  const preset = SCHEDULE_PRESETS.find((item) => item.id === presetId);
  if (!preset || preset.id === 'custom') return currentCron;
  return preset.cron ?? currentCron;
}

export function getSchedulePresetSummary(presetId: SchedulePresetId): string {
  return SCHEDULE_PRESETS.find((preset) => preset.id === presetId)?.description
    ?? SCHEDULE_PRESETS[SCHEDULE_PRESETS.length - 1].description;
}

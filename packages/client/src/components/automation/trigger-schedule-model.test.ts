import { describe, expect, it } from 'vitest';
import {
  getSchedulePresetForCron,
  getSchedulePresetSummary,
  resolveSchedulePresetCron,
} from './trigger-schedule-model';

describe('trigger schedule model', () => {
  it('matches a friendly preset from an existing cron expression', () => {
    expect(getSchedulePresetForCron('0 9 * * 1-5')?.id).toBe('weekdays_morning');
  });

  it('treats unknown cron expressions as custom schedules', () => {
    expect(getSchedulePresetForCron('0 9,18 * * *')?.id).toBe('custom');
  });

  it('returns preset cron when selecting a friendly schedule', () => {
    expect(resolveSchedulePresetCron('weekly_monday', '0 9,18 * * *')).toBe('0 9 * * 1');
  });

  it('preserves the current cron when selecting custom', () => {
    expect(resolveSchedulePresetCron('custom', '0 9,18 * * *')).toBe('0 9,18 * * *');
  });

  it('summarizes preset schedules in plain language', () => {
    expect(getSchedulePresetSummary('weekly_monday')).toBe('Runs once a week on Monday at 9:00 AM.');
  });
});

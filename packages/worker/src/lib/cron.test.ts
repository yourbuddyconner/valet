import { describe, expect, it } from 'vitest';
import { matchesCronField, getZonedDateParts, cronMatchesNow, findMissedCronTicks } from './cron.js';

// ─── matchesCronField ──────────────────────────────────────────────────────────

describe('matchesCronField', () => {
  it('wildcard matches any value', () => {
    expect(matchesCronField('*', 0, 0, 59)).toBe(true);
    expect(matchesCronField('*', 31, 1, 31)).toBe(true);
  });

  it('exact value matches', () => {
    expect(matchesCronField('5', 5, 0, 59)).toBe(true);
    expect(matchesCronField('5', 6, 0, 59)).toBe(false);
  });

  it('rejects out-of-range exact values', () => {
    expect(matchesCronField('60', 60, 0, 59)).toBe(false);
    expect(matchesCronField('-1', -1, 0, 59)).toBe(false);
  });

  it('step from zero (*/N)', () => {
    expect(matchesCronField('*/15', 0, 0, 59)).toBe(true);
    expect(matchesCronField('*/15', 15, 0, 59)).toBe(true);
    expect(matchesCronField('*/15', 30, 0, 59)).toBe(true);
    expect(matchesCronField('*/15', 45, 0, 59)).toBe(true);
    expect(matchesCronField('*/15', 7, 0, 59)).toBe(false);
    expect(matchesCronField('*/15', 1, 0, 59)).toBe(false);
  });

  it('rejects */0 (zero step)', () => {
    expect(matchesCronField('*/0', 0, 0, 59)).toBe(false);
  });

  it('range (start-end)', () => {
    expect(matchesCronField('1-5', 1, 0, 7)).toBe(true);
    expect(matchesCronField('1-5', 3, 0, 7)).toBe(true);
    expect(matchesCronField('1-5', 5, 0, 7)).toBe(true);
    expect(matchesCronField('1-5', 0, 0, 7)).toBe(false);
    expect(matchesCronField('1-5', 6, 0, 7)).toBe(false);
  });

  it('range with step (start-end/step)', () => {
    expect(matchesCronField('0-30/10', 0, 0, 59)).toBe(true);
    expect(matchesCronField('0-30/10', 10, 0, 59)).toBe(true);
    expect(matchesCronField('0-30/10', 20, 0, 59)).toBe(true);
    expect(matchesCronField('0-30/10', 30, 0, 59)).toBe(true);
    expect(matchesCronField('0-30/10', 5, 0, 59)).toBe(false);
    expect(matchesCronField('0-30/10', 40, 0, 59)).toBe(false);
  });

  it('reversed range is rejected', () => {
    expect(matchesCronField('5-1', 3, 0, 7)).toBe(false);
  });

  it('comma-separated list', () => {
    expect(matchesCronField('1,3,5', 1, 0, 7)).toBe(true);
    expect(matchesCronField('1,3,5', 3, 0, 7)).toBe(true);
    expect(matchesCronField('1,3,5', 5, 0, 7)).toBe(true);
    expect(matchesCronField('1,3,5', 2, 0, 7)).toBe(false);
  });

  it('comma-separated with ranges', () => {
    expect(matchesCronField('1-3,5', 2, 0, 7)).toBe(true);
    expect(matchesCronField('1-3,5', 5, 0, 7)).toBe(true);
    expect(matchesCronField('1-3,5', 4, 0, 7)).toBe(false);
  });

  it('empty parts in comma list are skipped', () => {
    expect(matchesCronField(',,,5,,,', 5, 0, 59)).toBe(true);
    expect(matchesCronField(',,,', 0, 0, 59)).toBe(false);
  });

  it('sunday alias: 0 and 7 both match Sunday', () => {
    // dayOfWeek=0 (Sunday), field="0" → should match
    expect(matchesCronField('0', 0, 0, 7)).toBe(true);
    // dayOfWeek=0 (Sunday), field="7" with sundayAlias → should match (0 normalized to 7)
    expect(matchesCronField('7', 0, 0, 7, true)).toBe(true);
    // dayOfWeek=0 (Sunday), field="1-5" → weekday range, should not match
    expect(matchesCronField('1-5', 0, 0, 7)).toBe(false);
  });
});

// ─── getZonedDateParts ─────────────────────────────────────────────────────────

describe('getZonedDateParts', () => {
  it('returns correct UTC parts', () => {
    const date = new Date('2026-05-20T14:30:00Z');
    const parts = getZonedDateParts(date, 'UTC');
    expect(parts).toEqual({
      minute: 30,
      hour: 14,
      day: 20,
      month: 5,
      dayOfWeek: 3, // Wednesday
    });
  });

  it('converts to timezone correctly', () => {
    // 14:00 UTC = 7:00 AM PDT (America/Los_Angeles)
    const date = new Date('2026-05-20T14:00:00Z');
    const parts = getZonedDateParts(date, 'America/Los_Angeles');
    expect(parts).toEqual({
      minute: 0,
      hour: 7,
      day: 20,
      month: 5,
      dayOfWeek: 3,
    });
  });

  it('handles midnight correctly (hour=0, not 24)', () => {
    const midnight = new Date('2026-05-20T00:00:00Z');
    const parts = getZonedDateParts(midnight, 'UTC');
    expect(parts).not.toBeNull();
    expect(parts!.hour).toBe(0);
  });

  it('handles midnight in non-UTC timezone', () => {
    // Midnight in New York = 04:00 UTC (EDT)
    const date = new Date('2026-05-20T04:00:00Z');
    const parts = getZonedDateParts(date, 'America/New_York');
    expect(parts).not.toBeNull();
    expect(parts!.hour).toBe(0);
    expect(parts!.minute).toBe(0);
  });

  it('returns null for invalid timezone', () => {
    const date = new Date('2026-05-20T14:00:00Z');
    expect(getZonedDateParts(date, 'Invalid/Timezone')).toBeNull();
  });
});

// ─── cronMatchesNow ────────────────────────────────────────────────────────────

describe('cronMatchesNow', () => {
  it('every-minute cron matches any time', () => {
    expect(cronMatchesNow('* * * * *', new Date('2026-05-20T14:30:00Z'))).toBe(true);
  });

  it('specific time matches exactly', () => {
    // 9:00 AM ET on a weekday
    const date = new Date('2026-05-20T13:00:00Z'); // 9:00 AM EDT
    expect(cronMatchesNow('0 9 * * 1-5', date, 'America/New_York')).toBe(true);
  });

  it('specific time does not match wrong minute', () => {
    const date = new Date('2026-05-20T13:01:00Z'); // 9:01 AM EDT
    expect(cronMatchesNow('0 9 * * 1-5', date, 'America/New_York')).toBe(false);
  });

  it('does not match on weekends for 1-5 day-of-week', () => {
    // 2026-05-23 is a Saturday
    const saturday = new Date('2026-05-23T13:00:00Z');
    expect(cronMatchesNow('0 9 * * 1-5', saturday, 'America/New_York')).toBe(false);
  });

  it('matches Sunday with day-of-week 0', () => {
    // 2026-05-24 is a Sunday
    const sunday = new Date('2026-05-24T13:00:00Z');
    expect(cronMatchesNow('0 9 * * 0', sunday, 'America/New_York')).toBe(true);
  });

  it('matches Sunday with day-of-week 7 (alias)', () => {
    const sunday = new Date('2026-05-24T13:00:00Z');
    expect(cronMatchesNow('0 9 * * 7', sunday, 'America/New_York')).toBe(true);
  });

  it('midnight cron matches at midnight UTC', () => {
    const midnight = new Date('2026-05-20T00:00:00Z');
    expect(cronMatchesNow('0 0 * * *', midnight, 'UTC')).toBe(true);
  });

  it('midnight cron does not match at 1 AM', () => {
    const oneAm = new Date('2026-05-20T01:00:00Z');
    expect(cronMatchesNow('0 0 * * *', oneAm, 'UTC')).toBe(false);
  });

  it('*/15 matches at 0, 15, 30, 45', () => {
    expect(cronMatchesNow('*/15 * * * *', new Date('2026-05-20T14:00:00Z'))).toBe(true);
    expect(cronMatchesNow('*/15 * * * *', new Date('2026-05-20T14:15:00Z'))).toBe(true);
    expect(cronMatchesNow('*/15 * * * *', new Date('2026-05-20T14:30:00Z'))).toBe(true);
    expect(cronMatchesNow('*/15 * * * *', new Date('2026-05-20T14:45:00Z'))).toBe(true);
    expect(cronMatchesNow('*/15 * * * *', new Date('2026-05-20T14:07:00Z'))).toBe(false);
  });

  it('hourly range: */15 8-16 * * 1-5 in LA timezone', () => {
    // 15:00 UTC = 8:00 AM PDT, minute 0 matches */15 — should match
    expect(cronMatchesNow('*/15 8-16 * * 1-5', new Date('2026-05-20T15:00:00Z'), 'America/Los_Angeles')).toBe(true);
    // 15:15 UTC = 8:15 AM PDT — matches
    expect(cronMatchesNow('*/15 8-16 * * 1-5', new Date('2026-05-20T15:15:00Z'), 'America/Los_Angeles')).toBe(true);
    // 14:00 UTC = 7:00 AM PDT — outside 8-16 range
    expect(cronMatchesNow('*/15 8-16 * * 1-5', new Date('2026-05-20T14:00:00Z'), 'America/Los_Angeles')).toBe(false);
  });

  it('rejects malformed cron (wrong number of fields)', () => {
    expect(cronMatchesNow('* * *', new Date())).toBe(false);
    expect(cronMatchesNow('* * * * * *', new Date())).toBe(false);
  });

  it('comma-separated hours: 0 10,14,18 * * 1-5', () => {
    // 14:00 UTC = 10:00 AM EDT
    expect(cronMatchesNow('0 10,14,18 * * 1-5', new Date('2026-05-20T14:00:00Z'), 'America/New_York')).toBe(true);
    // 18:00 UTC = 2:00 PM EDT = 14:00 local
    expect(cronMatchesNow('0 10,14,18 * * 1-5', new Date('2026-05-20T18:00:00Z'), 'America/New_York')).toBe(true);
    // 15:00 UTC = 11:00 AM EDT — not in list
    expect(cronMatchesNow('0 10,14,18 * * 1-5', new Date('2026-05-20T15:00:00Z'), 'America/New_York')).toBe(false);
  });
});

// ─── findMissedCronTicks ───────────────────────────────────────────────────────

describe('findMissedCronTicks', () => {
  it('finds a single missed daily tick', () => {
    // Trigger: 0 9 * * 1-5 ET (9 AM ET = 13:00 UTC)
    // Last ran yesterday at 13:00 UTC, now is today at 13:01 UTC
    const after = new Date('2026-05-19T13:00:00Z');
    const before = new Date('2026-05-20T13:01:00Z');

    const missed = findMissedCronTicks('0 9 * * 1-5', 'America/New_York', after, before);
    expect(missed).toEqual(['2026-05-20T13:00']);
  });

  it('finds multiple missed */15 ticks', () => {
    // Last ran at 13:15, now is 14:03. Missed 13:30 and 13:45.
    // 14:00 is also in the window but would be excluded since cursor starts at 14:02.
    const after = new Date('2026-05-20T13:15:00Z');
    const before = new Date('2026-05-20T14:03:00Z');

    const missed = findMissedCronTicks('*/15 * * * *', 'UTC', after, before);
    expect(missed).toEqual(['2026-05-20T13:30', '2026-05-20T13:45', '2026-05-20T14:00']);
  });

  it('excludes the current minute (before)', () => {
    // now = 14:00:30, last_run = 13:45. The 14:00 tick should NOT be in missed
    // because findMissedCronTicks starts cursor at before - 1 minute.
    const after = new Date('2026-05-20T13:45:00Z');
    const before = new Date('2026-05-20T14:00:30Z');

    const missed = findMissedCronTicks('*/15 * * * *', 'UTC', after, before);
    // Only 13:59...13:46 are scanned, none match */15 except nothing (13:45 is excluded by after)
    expect(missed).toEqual([]);
  });

  it('excludes the last-run minute (after)', () => {
    // last_run = 13:50:02, now = 14:03. The */5 tick at 13:50 should be excluded.
    const after = new Date('2026-05-20T13:50:02Z');
    const before = new Date('2026-05-20T14:03:15Z');

    const missed = findMissedCronTicks('*/5 * * * *', 'UTC', after, before);
    expect(missed).toEqual(['2026-05-20T13:55', '2026-05-20T14:00']);
  });

  it('returns empty when last_run is exactly on the previous tick', () => {
    // last_run = 13:00:00.000Z, now = 13:01:30. Cron = 0 13 * * *.
    // The 13:00 tick already ran, nothing missed.
    const after = new Date('2026-05-20T13:00:00.000Z');
    const before = new Date('2026-05-20T13:01:30Z');

    const missed = findMissedCronTicks('0 13 * * *', 'UTC', after, before);
    expect(missed).toEqual([]);
  });

  it('returns empty when no ticks in window', () => {
    const after = new Date('2026-05-20T13:01:00Z');
    const before = new Date('2026-05-20T13:05:00Z');

    const missed = findMissedCronTicks('0 14 * * *', 'UTC', after, before);
    expect(missed).toEqual([]);
  });

  it('respects maxIterations cap', () => {
    // With maxIterations=5, we can only scan back 5 minutes
    const after = new Date('2026-05-20T12:00:00Z');
    const before = new Date('2026-05-20T14:00:00Z');

    const missed = findMissedCronTicks('* * * * *', 'UTC', after, before, 5);
    // Should find 13:59, 13:58, 13:57, 13:56, 13:55 (oldest first after reverse)
    expect(missed).toEqual([
      '2026-05-20T13:55',
      '2026-05-20T13:56',
      '2026-05-20T13:57',
      '2026-05-20T13:58',
      '2026-05-20T13:59',
    ]);
  });

  it('returns results in chronological order (oldest first)', () => {
    const after = new Date('2026-05-20T13:00:00Z');
    const before = new Date('2026-05-20T14:05:00Z');

    const missed = findMissedCronTicks('*/15 * * * *', 'UTC', after, before);
    // Should be: 13:15, 13:30, 13:45, 14:00 (oldest first)
    expect(missed).toEqual([
      '2026-05-20T13:15',
      '2026-05-20T13:30',
      '2026-05-20T13:45',
      '2026-05-20T14:00',
    ]);
  });

  it('does not match weekends for weekday-only cron', () => {
    // 2026-05-23 is Saturday, 2026-05-24 is Sunday
    const after = new Date('2026-05-22T14:00:00Z'); // Friday
    const before = new Date('2026-05-25T14:01:00Z'); // Monday

    const missed = findMissedCronTicks('0 9 * * 1-5', 'America/New_York', after, before);
    // Should find Monday 13:00 UTC (9 AM ET) only, not Saturday or Sunday
    expect(missed).toEqual(['2026-05-25T13:00']);
  });

  it('handles timezone-aware catch-up for LA trigger', () => {
    // Trigger: 0 7 * * 1-5 America/Los_Angeles (7 AM PDT = 14:00 UTC)
    // Last ran yesterday, now is 14:05 today
    const after = new Date('2026-05-19T14:00:00Z');
    const before = new Date('2026-05-20T14:05:00Z');

    const missed = findMissedCronTicks('0 7 * * 1-5', 'America/Los_Angeles', after, before);
    expect(missed).toEqual(['2026-05-20T14:00']);
  });

  it('handles hour/day boundary rollover', () => {
    // Crossing midnight: after is 23:50, before is 00:05 next day
    const after = new Date('2026-05-19T23:50:00Z');
    const before = new Date('2026-05-20T00:05:00Z');

    const missed = findMissedCronTicks('0 0 * * *', 'UTC', after, before);
    expect(missed).toEqual(['2026-05-20T00:00']);
  });
});

/**
 * Pure cron matching and missed-tick detection utilities.
 * Extracted from index.ts for testability.
 */

export function matchesCronField(field: string, value: number, min: number, max: number, sundayAlias = false): boolean {
  const normalizedValue = sundayAlias && value === 0 ? 7 : value;
  const parts = field.split(',');

  for (const partRaw of parts) {
    const part = partRaw.trim();
    if (!part) continue;

    if (part === '*') return true;

    if (part.startsWith('*/')) {
      const step = Number.parseInt(part.slice(2), 10);
      if (Number.isInteger(step) && step > 0 && value % step === 0) return true;
      continue;
    }

    const [base, stepPart] = part.split('/');
    const step = stepPart ? Number.parseInt(stepPart, 10) : 1;
    if (!Number.isInteger(step) || step <= 0) continue;

    if (base.includes('-')) {
      const [startRaw, endRaw] = base.split('-');
      const start = Number.parseInt(startRaw, 10);
      const end = Number.parseInt(endRaw, 10);
      if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
      if (start < min || end > max || start > end) continue;
      const target = sundayAlias ? normalizedValue : value;
      if (target >= start && target <= end && (target - start) % step === 0) return true;
      continue;
    }

    const exact = Number.parseInt(base, 10);
    if (!Number.isInteger(exact)) continue;
    if (exact < min || exact > max) continue;
    const target = sundayAlias ? normalizedValue : value;
    if (target === exact) return true;
  }

  return false;
}

export function getZonedDateParts(now: Date, timeZone: string): {
  minute: number;
  hour: number;
  day: number;
  month: number;
  dayOfWeek: number;
} | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      minute: 'numeric',
      hour: 'numeric',
      day: 'numeric',
      month: 'numeric',
      weekday: 'short',
      hourCycle: 'h23', // 0-23 range; hour12:false can return "24" for midnight on V8
    });

    const parts = formatter.formatToParts(now);
    const valueFor = (type: string): string | null =>
      parts.find((part) => part.type === type)?.value ?? null;

    const weekdayMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };

    const minute = Number.parseInt(valueFor('minute') || '', 10);
    const hour = Number.parseInt(valueFor('hour') || '', 10);
    const day = Number.parseInt(valueFor('day') || '', 10);
    const month = Number.parseInt(valueFor('month') || '', 10);
    const dayOfWeek = weekdayMap[valueFor('weekday') || ''];

    if (!Number.isInteger(minute) || !Number.isInteger(hour) || !Number.isInteger(day) || !Number.isInteger(month) || dayOfWeek === undefined) {
      return null;
    }

    return { minute, hour, day, month, dayOfWeek };
  } catch {
    return null;
  }
}

export function cronMatchesNow(cron: string, now: Date, timeZone: string = 'UTC'): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const zoned = getZonedDateParts(now, timeZone);
  if (!zoned) return false;

  return (
    matchesCronField(minute, zoned.minute, 0, 59) &&
    matchesCronField(hour, zoned.hour, 0, 23) &&
    matchesCronField(dayOfMonth, zoned.day, 1, 31) &&
    matchesCronField(month, zoned.month, 1, 12) &&
    (matchesCronField(dayOfWeek, zoned.dayOfWeek, 0, 7) || matchesCronField(dayOfWeek, zoned.dayOfWeek, 0, 7, true))
  );
}

/**
 * Find all missed cron ticks between `after` and `before` (exclusive on both ends).
 * Walks backwards from `before` checking each UTC minute against the cron expression
 * in the given timezone. Returns tick buckets in chronological order (oldest first)
 * so they can be dispatched in sequence. `maxIterations` caps the backward scan to
 * avoid burning CPU on frequent crons.
 */
export function findMissedCronTicks(
  cron: string,
  timezone: string,
  after: Date,
  before: Date,
  maxIterations = 240,
): string[] {
  // Floor `before` to the start of its minute, then step back one minute to avoid
  // matching the current tick (which the normal path already handles).
  const cursor = new Date(before);
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() - 1);

  // Floor `after` to minute precision for comparison
  const afterFloor = new Date(after);
  afterFloor.setUTCSeconds(0, 0);

  const missed: string[] = [];
  let iterations = 0;
  while (cursor > afterFloor && iterations < maxIterations) {
    if (cronMatchesNow(cron, cursor, timezone)) {
      missed.push(cursor.toISOString().slice(0, 16));
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() - 1);
    iterations++;
  }
  // Return oldest-first so dispatches happen in chronological order
  return missed.reverse();
}

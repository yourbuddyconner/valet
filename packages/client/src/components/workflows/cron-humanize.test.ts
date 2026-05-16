import { describe, it, expect } from 'vitest';
import { humanizeCron } from './cron-humanize';

describe('humanizeCron', () => {
  it('humanizes a daily 9am schedule', () => {
    expect(humanizeCron('0 9 * * *')).toMatch(/9:00 AM/i);
  });

  it('returns null for invalid input', () => {
    expect(humanizeCron('not a cron')).toBeNull();
    expect(humanizeCron('')).toBeNull();
  });

  it('handles step expressions', () => {
    expect(humanizeCron('*/15 * * * *')).toMatch(/15 minutes/i);
  });

  it('handles multiple values', () => {
    expect(humanizeCron('0 9,18 * * *')).toMatch(/9:00 AM/i);
  });
});

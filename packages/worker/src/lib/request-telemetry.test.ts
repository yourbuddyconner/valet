import { describe, expect, it } from 'vitest';
import { DEFAULT_SAMPLE_RATE, isAlwaysRecorded, resolveSampleRate, shouldSample } from './request-telemetry.js';

describe('isAlwaysRecorded', () => {
  it('flags server errors and authorization failures', () => {
    expect(isAlwaysRecorded(500)).toBe(true);
    expect(isAlwaysRecorded(503)).toBe(true);
    expect(isAlwaysRecorded(401)).toBe(true);
    expect(isAlwaysRecorded(403)).toBe(true);
  });

  it('does not flag ordinary success or client errors', () => {
    expect(isAlwaysRecorded(200)).toBe(false);
    expect(isAlwaysRecorded(404)).toBe(false);
    expect(isAlwaysRecorded(429)).toBe(false);
  });
});

describe('shouldSample', () => {
  // Constant rng so the decision is deterministic.
  const rng = (value: number) => () => value;

  it('always records server errors regardless of rate', () => {
    expect(shouldSample(500, 0, rng(0.99))).toBe(true);
    expect(shouldSample(503, 0, rng(0.99))).toBe(true);
  });

  it('always records authorization failures regardless of rate', () => {
    expect(shouldSample(401, 0, rng(0.99))).toBe(true);
    expect(shouldSample(403, 0, rng(0.99))).toBe(true);
  });

  it('records everything at rate >= 1', () => {
    expect(shouldSample(200, 1, rng(0.99))).toBe(true);
    expect(shouldSample(404, 1, rng(0.99))).toBe(true);
  });

  it('records nothing (except 5xx) at rate <= 0', () => {
    expect(shouldSample(200, 0, rng(0))).toBe(false);
    expect(shouldSample(404, 0, rng(0))).toBe(false);
  });

  it('keeps the rng < rate fraction', () => {
    expect(shouldSample(200, 0.5, rng(0.49))).toBe(true);
    expect(shouldSample(200, 0.5, rng(0.5))).toBe(false);
    expect(shouldSample(200, 0.5, rng(0.51))).toBe(false);
  });
});

describe('resolveSampleRate', () => {
  it('defaults when unset', () => {
    expect(resolveSampleRate({})).toBe(DEFAULT_SAMPLE_RATE);
  });

  it('parses a valid fraction', () => {
    expect(resolveSampleRate({ REQUEST_TELEMETRY_SAMPLE_RATE: '0.25' })).toBe(0.25);
    expect(resolveSampleRate({ REQUEST_TELEMETRY_SAMPLE_RATE: '0' })).toBe(0);
    expect(resolveSampleRate({ REQUEST_TELEMETRY_SAMPLE_RATE: '1' })).toBe(1);
  });

  it('falls back to the default for out-of-range or malformed values', () => {
    expect(resolveSampleRate({ REQUEST_TELEMETRY_SAMPLE_RATE: '1.5' })).toBe(DEFAULT_SAMPLE_RATE);
    expect(resolveSampleRate({ REQUEST_TELEMETRY_SAMPLE_RATE: '-0.2' })).toBe(DEFAULT_SAMPLE_RATE);
    expect(resolveSampleRate({ REQUEST_TELEMETRY_SAMPLE_RATE: 'abc' })).toBe(DEFAULT_SAMPLE_RATE);
  });
});

import { describe, expect, it } from 'vitest';
import { buildTraceConfig, isTracingEnabled, parseOtlpHeaders, resolveSampleRatio } from './config.js';

describe('isTracingEnabled', () => {
  it('is false when the endpoint is unset or blank', () => {
    expect(isTracingEnabled({})).toBe(false);
    expect(isTracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: '' })).toBe(false);
    expect(isTracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: '   ' })).toBe(false);
  });
  it('is true when the endpoint is set', () => {
    expect(isTracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' })).toBe(true);
  });
});

describe('parseOtlpHeaders', () => {
  it('returns empty for undefined', () => {
    expect(parseOtlpHeaders(undefined)).toEqual({});
  });
  it('parses comma-separated key=value pairs, trimming whitespace', () => {
    expect(parseOtlpHeaders('Authorization=Basic abc, X-Scope-OrgID = 1 ')).toEqual({
      Authorization: 'Basic abc',
      'X-Scope-OrgID': '1',
    });
  });
  it('ignores malformed pairs and keeps = inside values', () => {
    expect(parseOtlpHeaders('noequals,=novalue,k=a=b')).toEqual({ k: 'a=b' });
  });
});

describe('resolveSampleRatio', () => {
  it('is 0 when disabled (the no-op path)', () => {
    expect(resolveSampleRatio({})).toBe(0);
  });
  it('defaults to 1 when enabled', () => {
    expect(resolveSampleRatio({ OTEL_EXPORTER_OTLP_ENDPOINT: 'x' })).toBe(1);
  });
  it('honors a valid ratio', () => {
    expect(resolveSampleRatio({ OTEL_EXPORTER_OTLP_ENDPOINT: 'x', OTEL_TRACES_SAMPLER_RATIO: '0.25' })).toBe(0.25);
  });
  it('falls back to 1 for out-of-range or malformed ratios', () => {
    expect(resolveSampleRatio({ OTEL_EXPORTER_OTLP_ENDPOINT: 'x', OTEL_TRACES_SAMPLER_RATIO: '2' })).toBe(1);
    expect(resolveSampleRatio({ OTEL_EXPORTER_OTLP_ENDPOINT: 'x', OTEL_TRACES_SAMPLER_RATIO: 'abc' })).toBe(1);
  });
});

describe('buildTraceConfig', () => {
  it('produces a no-op config when disabled (ratio 0, default url)', () => {
    const cfg = buildTraceConfig({}, { name: 'valet-worker' });
    expect(cfg.service.name).toBe('valet-worker');
    expect(cfg.sampling?.headSampler).toMatchObject({ ratio: 0, acceptRemote: false });
    if (!('exporter' in cfg)) throw new Error('expected exporter config');
    expect(cfg.exporter).toMatchObject({ url: 'http://localhost:4318/v1/traces' });
  });

  it('uses the endpoint + headers and strips a trailing slash when enabled', () => {
    const cfg = buildTraceConfig(
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://tempo.example/', OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic xyz' },
      { name: 'valet-worker', version: '1.2.3' },
    );
    expect(cfg.service.version).toBe('1.2.3');
    expect(cfg.sampling?.headSampler).toMatchObject({ ratio: 1, acceptRemote: true });
    if (!('exporter' in cfg)) throw new Error('expected exporter config');
    expect(cfg.exporter).toMatchObject({
      url: 'https://tempo.example/v1/traces',
      headers: { Authorization: 'Basic xyz' },
    });
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { activeTraceparent, buildTraceConfig, isTracingEnabled, parseOtlpHeaders, redactUrlAttributes, setSessionAttributes } from './tracing.js';

describe('isTracingEnabled', () => {
  it('is false when the endpoint is unset or blank', () => {
    expect(isTracingEnabled({})).toBe(false);
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
  it('parses comma-separated key=value pairs, trimming, keeping = in values', () => {
    expect(parseOtlpHeaders('Authorization=Basic abc, k=a=b, bad')).toEqual({
      Authorization: 'Basic abc',
      k: 'a=b',
    });
  });
});

describe('buildTraceConfig', () => {
  it('is a no-op when disabled: head sampler ratio 0', () => {
    const cfg = buildTraceConfig({}, 'valet-worker');
    expect(cfg.service.name).toBe('valet-worker');
    expect(cfg.sampling?.headSampler).toMatchObject({ ratio: 0, acceptRemote: false });
    if (!('exporter' in cfg)) throw new Error('expected exporter config');
    expect(cfg.exporter).toMatchObject({ url: 'http://localhost:4318/v1/traces' });
  });

  it('uses endpoint + headers and strips a trailing slash when enabled (ratio 1)', () => {
    const cfg = buildTraceConfig(
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://tempo.example/', OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic xyz' },
      'valet-worker',
    );
    expect(cfg.sampling?.headSampler).toMatchObject({ ratio: 1, acceptRemote: true });
    if (!('exporter' in cfg)) throw new Error('expected exporter config');
    expect(cfg.exporter).toMatchObject({
      url: 'https://tempo.example/v1/traces',
      headers: { Authorization: 'Basic xyz' },
    });
  });
});

describe('redactUrlAttributes', () => {
  it('strips the query string from url.full and clears url.query (keeps path)', () => {
    const attrs: Record<string, unknown> = {
      'url.full': 'https://valet/auth/github/callback?code=SECRET&state=xyz',
      'url.query': '?code=SECRET&state=xyz',
      'url.path': '/auth/github/callback',
      'http.request.method': 'GET',
    };
    redactUrlAttributes(attrs);
    expect(attrs['url.full']).toBe('https://valet/auth/github/callback');
    expect(attrs['url.query']).toBe('');
    expect(attrs['url.path']).toBe('/auth/github/callback');
    expect(attrs['http.request.method']).toBe('GET');
  });

  it('leaves a query-less url unchanged', () => {
    const attrs: Record<string, unknown> = { 'url.full': 'https://valet/health' };
    redactUrlAttributes(attrs);
    expect(attrs['url.full']).toBe('https://valet/health');
  });
});

describe('setSessionAttributes', () => {
  const exporter = new InMemorySpanExporter();
  let provider: BasicTracerProvider;

  beforeAll(() => {
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  });
  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
  });
  beforeEach(() => exporter.reset());

  it('sets valet.* on the active span (span scope, not resource)', async () => {
    await trace.getTracer('t').startActiveSpan('op', async (span) => {
      setSessionAttributes({ sessionId: 's1', userId: 'u1', orgId: 'o1' });
      span.end();
    });
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes['valet.session.id']).toBe('s1');
    expect(span.attributes['valet.user.id']).toBe('u1');
    expect(span.attributes['valet.org.id']).toBe('o1');
  });

  it('omits null/undefined ids', async () => {
    await trace.getTracer('t').startActiveSpan('op', async (span) => {
      setSessionAttributes({ sessionId: 's1', userId: null });
      span.end();
    });
    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes['valet.session.id']).toBe('s1');
    expect(span.attributes['valet.user.id']).toBeUndefined();
  });

  it('is a no-op (does not throw) when there is no active span', () => {
    expect(() => setSessionAttributes({ sessionId: 's1' })).not.toThrow();
  });
});

describe('activeTraceparent', () => {
  let provider: BasicTracerProvider;
  beforeAll(() => {
    provider = new BasicTracerProvider();
    trace.setGlobalTracerProvider(provider);
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  });
  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
  });

  it('is null when there is no active span', () => {
    expect(activeTraceparent()).toBeNull();
  });

  it('formats the active span context as a sampled W3C traceparent', () => {
    trace.getTracer('t').startActiveSpan('op', (span) => {
      const sc = span.spanContext();
      expect(activeTraceparent()).toBe(`00-${sc.traceId}-${sc.spanId}-01`);
      span.end();
    });
  });
});

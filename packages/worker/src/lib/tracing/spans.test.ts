import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { setSessionAttributes, withSpan } from './spans.js';

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

const finished = (): ReadableSpan[] => exporter.getFinishedSpans();

describe('withSpan', () => {
  it('creates a named span, returns the value, and sets OK', async () => {
    const result = await withSpan('test.op', () => 42, { 'x.attr': 'v' });
    expect(result).toBe(42);
    const spans = finished();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('test.op');
    expect(spans[0].attributes['x.attr']).toBe('v');
    expect(spans[0].status.code).toBe(SpanStatusCode.OK);
  });

  it('records the exception, sets ERROR, and rethrows', async () => {
    await expect(withSpan('boom', () => { throw new Error('nope'); })).rejects.toThrow('nope');
    const span = finished()[0];
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.some((e) => e.name === 'exception')).toBe(true);
  });
});

describe('setSessionAttributes', () => {
  it('sets valet.* attributes on the active span (span scope, not resource)', async () => {
    await withSpan('op', () => setSessionAttributes({ sessionId: 's1', userId: 'u1', orgId: 'o1' }));
    const span = finished()[0];
    expect(span.attributes['valet.session.id']).toBe('s1');
    expect(span.attributes['valet.user.id']).toBe('u1');
    expect(span.attributes['valet.org.id']).toBe('o1');
  });

  it('omits null/undefined ids', async () => {
    await withSpan('op', () => setSessionAttributes({ sessionId: 's1', userId: null, orgId: undefined }));
    const span = finished()[0];
    expect(span.attributes['valet.session.id']).toBe('s1');
    expect(span.attributes['valet.user.id']).toBeUndefined();
    expect(span.attributes['valet.org.id']).toBeUndefined();
  });

  it('is a no-op (does not throw) when there is no active span', () => {
    expect(() => setSessionAttributes({ sessionId: 's1' }, undefined)).not.toThrow();
  });
});

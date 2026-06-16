import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { log, setLogLevel } from './log.js';
import { withSpan } from './tracing/spans.js';

let provider: BasicTracerProvider;

beforeAll(() => {
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())] });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});
afterEach(() => {
  setLogLevel('debug');
  vi.restoreAllMocks();
});

const spyConsole = (method: 'log' | 'warn' | 'error') =>
  vi.spyOn(console, method).mockImplementation(() => {});

const parse = (line: unknown): Record<string, unknown> =>
  JSON.parse(String(line)) as Record<string, unknown>;

describe('log', () => {
  it('emits one JSON line with level, message, time, and fields', () => {
    const spy = spyConsole('log');
    log.info('hello', { foo: 1, bar: 'b' });
    expect(spy).toHaveBeenCalledTimes(1);
    const entry = parse(spy.mock.calls[0][0]);
    expect(entry).toMatchObject({ level: 'info', message: 'hello', foo: 1, bar: 'b' });
    expect(typeof entry.time).toBe('string');
    expect(entry.trace_id).toBeUndefined(); // no active span
  });

  it('routes error → console.error and warn → console.warn', () => {
    const err = spyConsole('error');
    const warn = spyConsole('warn');
    log.error('bad');
    log.warn('careful');
    expect(err).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('drops lines below the configured threshold', () => {
    const spy = spyConsole('log');
    setLogLevel('warn');
    log.info('skip');
    log.debug('skip');
    expect(spy).not.toHaveBeenCalled();
  });

  it('stamps trace_id/span_id when emitted inside an active span', async () => {
    const spy = spyConsole('log');
    await withSpan('op', () => log.info('in-span'));
    const entry = parse(spy.mock.calls[0][0]);
    expect(entry.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(entry.span_id).toMatch(/^[0-9a-f]{16}$/);
  });
});

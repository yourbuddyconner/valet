import { describe, it, expect } from 'vitest';
import { trace } from '@opentelemetry/api';
import { parentContext } from './do-tracing.js';

// parentContext parses the Worker→DO `traceparent` header so DO-internal spans nest
// under the worker trace. Importing it does not trigger the lazy `cloudflare:workers`
// import (that lives inside createDoTracer), so this stays Node-testable.
describe('parentContext', () => {
  it('parses a valid sampled W3C traceparent into a remote parent span context', () => {
    const req = new Request('https://do/x', {
      headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
    });
    const sc = trace.getSpanContext(parentContext(req));
    expect(sc?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(sc?.spanId).toBe('b7ad6b7169203331');
    expect(sc?.traceFlags).toBe(1);
    expect(sc?.isRemote).toBe(true);
  });

  it('parses the unsampled flag (00) as traceFlags 0', () => {
    const req = new Request('https://do/x', {
      headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00' },
    });
    expect(trace.getSpanContext(parentContext(req))?.traceFlags).toBe(0);
  });

  it('returns a parent-less context when traceparent is absent', () => {
    expect(trace.getSpanContext(parentContext(new Request('https://do/x')))).toBeUndefined();
  });

  it('returns a parent-less context when traceparent ids are the wrong length', () => {
    const req = new Request('https://do/x', { headers: { traceparent: '00-abc-def-01' } });
    expect(trace.getSpanContext(parentContext(req))).toBeUndefined();
  });
});

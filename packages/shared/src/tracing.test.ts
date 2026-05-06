import { describe, expect, it } from 'vitest';
import { SimpleTracer, SpanKind } from './tracing.js';

describe('SimpleTracer', () => {
  it('exports OpenLIT-compatible span kinds and array attributes as OTLP JSON', async () => {
    let exportedBody: unknown;
    const tracer = new SimpleTracer({
      serviceName: 'valet-runner',
      endpoint: 'https://otel.example.test/otlp',
      fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
        exportedBody = JSON.parse(String(init?.body));
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });

    const span = tracer.startSpan('chat gpt-4o', {
      kind: SpanKind.CLIENT,
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.response.finish_reasons': ['stop'],
        'gen_ai.usage.total_tokens': 12,
      },
    });
    span.end();
    await tracer.flush();

    const body = exportedBody as {
      resourceSpans: Array<{
        scopeSpans: Array<{
          spans: Array<{
            name: string;
            kind: number;
            attributes: Array<{ key: string; value: Record<string, unknown> }>;
          }>;
        }>;
      }>;
    };
    const exportedSpan = body.resourceSpans[0]?.scopeSpans[0]?.spans[0];
    expect(exportedSpan?.name).toBe('chat gpt-4o');
    expect(exportedSpan?.kind).toBe(SpanKind.CLIENT);
    expect(exportedSpan?.attributes).toContainEqual({
      key: 'gen_ai.response.finish_reasons',
      value: { arrayValue: { values: [{ stringValue: 'stop' }] } },
    });
  });
});

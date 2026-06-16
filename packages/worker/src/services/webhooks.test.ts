import { describe, expect, it, vi } from 'vitest';
import { canonicalizeRawQuery, handleGenericWebhook } from './webhooks.js';
import type { Env } from '../env.js';

describe('canonicalizeRawQuery — webhook idempotency hash input', () => {
  // GET webhooks without a delivery header use this canonicalization to
  // distinguish otherwise-equivalent requests. Each property below
  // corresponds to a class of false-positive idempotency collision the
  // hash must not produce.

  it('orders pairs lexicographically (?b=2&a=1 ≡ ?a=1&b=2)', () => {
    expect(canonicalizeRawQuery('a=1&b=2')).toBe('a=1&b=2');
    expect(canonicalizeRawQuery('b=2&a=1')).toBe('a=1&b=2');
  });

  it('preserves duplicate keys — ?tag=a&tag=b is NOT the same as ?tag=b', () => {
    const both = canonicalizeRawQuery('tag=a&tag=b');
    const oneB = canonicalizeRawQuery('tag=b');
    expect(both).not.toBe(oneB);
    expect(both).toBe('tag=a&tag=b');
    expect(oneB).toBe('tag=b');
  });

  it('keeps url-encoded values distinct from their decoded form', () => {
    // ?a=1%26b%3D2 carries one value "1&b=2"; ?a=1&b=2 carries two
    // pairs. A Record-based canonicalization would conflate them.
    const encoded = canonicalizeRawQuery('a=1%26b%3D2');
    const decoded = canonicalizeRawQuery('a=1&b=2');
    expect(encoded).not.toBe(decoded);
    expect(encoded).toBe('a=1%26b%3D2');
    expect(decoded).toBe('a=1&b=2');
  });

  it('returns empty string for empty input (no GET ?... segment)', () => {
    expect(canonicalizeRawQuery('')).toBe('');
  });

  it('strips empty pairs from accidental && / leading-& artifacts', () => {
    expect(canonicalizeRawQuery('&a=1&&b=2&')).toBe('a=1&b=2');
  });
});

describe('handleGenericWebhook — tokenized triggers refuse the path-based route', () => {
  // The token model (X-Valet-Trigger-Token against /api/triggers/:id/webhook)
  // is the only supported entry once a trigger has a token minted. If the
  // path-based /webhooks/:path route accepted requests for those triggers,
  // an operator who configured "token-protected webhook" with no legacy
  // config.secret would still serve unauthenticated callers — that's an
  // auth bypass and contradicts migration 0020's stated security model.

  function makeMockEnv(triggerRow: Record<string, unknown> | null): Env {
    const db = {
      prepare: () => ({
        bind: () => ({
          first: vi.fn().mockResolvedValue(triggerRow),
        }),
      }),
    } as unknown as Env['DB'];
    return { DB: db } as unknown as Env;
  }

  it('returns 404 (not 200) when the trigger has webhook_token set, regardless of body or method', async () => {
    const env = makeMockEnv({
      id: 'tr-1',
      workflow_id: 'wf-1',
      workflow_name: 'hooks',
      user_id: 'user-1',
      version: '1',
      data: '{}',
      // Token-protected trigger with NO legacy secret — historically
      // the path-based handler would have dispatched without auth.
      config: JSON.stringify({ type: 'webhook', path: 'incoming/test', method: 'POST' }),
      webhook_token: 'present-but-not-asked-for',
      variable_mapping: null,
    });

    const result = await handleGenericWebhook(
      env,
      'incoming/test',
      'POST',
      JSON.stringify({ event: 'tampered' }),
      { 'content-type': 'application/json' },
      {},
      '',
    );

    expect(result?.statusCode).toBe(404);
  });

  it('returns 401 (not 200) when a non-tokenized trigger has a config.secret but the header is missing', async () => {
    // Sanity-check the legacy-path auth still applies for rows without a
    // webhook_token but with a config.secret set. The tokenized-refuse
    // branch must NOT pre-empt the secret check.
    const env = makeMockEnv({
      id: 'tr-legacy',
      workflow_id: 'wf-legacy',
      workflow_name: 'hooks',
      user_id: 'user-1',
      version: '1',
      data: '{}',
      config: JSON.stringify({
        type: 'webhook',
        path: 'legacy/test',
        method: 'POST',
        secret: 's3cret',
      }),
      webhook_token: null,
      variable_mapping: null,
    });

    const result = await handleGenericWebhook(
      env,
      'legacy/test',
      'POST',
      '{}',
      { 'content-type': 'application/json' },
      {},
      '',
    );

    expect(result?.statusCode).toBe(401);
  });

  it('returns 404 for a missing path (no trigger row at all)', async () => {
    const env = makeMockEnv(null);
    const result = await handleGenericWebhook(
      env,
      'does/not/exist',
      'POST',
      '{}',
      {},
      {},
      '',
    );
    expect(result?.statusCode).toBe(404);
  });
});

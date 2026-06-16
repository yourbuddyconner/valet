import { describe, expect, it } from 'vitest';
import { canonicalizeRawQuery } from './webhooks.js';

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

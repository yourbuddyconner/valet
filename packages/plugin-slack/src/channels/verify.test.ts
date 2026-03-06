import { describe, it, expect } from 'vitest';
import { verifySlackSignature } from './verify.js';

// Helper to generate a valid signature
async function generateSignature(
  timestamp: string,
  body: string,
  secret: string,
): Promise<string> {
  const baseString = `v0:${timestamp}:${body}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(baseString));
  const digest = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `v0=${digest}`;
}

describe('verifySlackSignature', () => {
  const secret = 'test-signing-secret-123';
  const body = '{"type":"event_callback","event":{"type":"message"}}';

  it('returns true for valid signature', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await generateSignature(timestamp, body, secret);

    const result = await verifySlackSignature(
      {
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': signature,
      },
      body,
      secret,
    );

    expect(result).toBe(true);
  });

  it('returns false for invalid signature', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));

    const result = await verifySlackSignature(
      {
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': 'v0=invalid_signature_that_does_not_match',
      },
      body,
      secret,
    );

    expect(result).toBe(false);
  });

  it('returns false for expired timestamp (>5 min old)', async () => {
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 400);
    const signature = await generateSignature(oldTimestamp, body, secret);

    const result = await verifySlackSignature(
      {
        'x-slack-request-timestamp': oldTimestamp,
        'x-slack-signature': signature,
      },
      body,
      secret,
    );

    expect(result).toBe(false);
  });

  it('returns false for missing timestamp header', async () => {
    const result = await verifySlackSignature(
      {
        'x-slack-signature': 'v0=something',
      },
      body,
      secret,
    );

    expect(result).toBe(false);
  });

  it('returns false for missing signature header', async () => {
    const result = await verifySlackSignature(
      {
        'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
      },
      body,
      secret,
    );

    expect(result).toBe(false);
  });

  it('returns false for wrong secret', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await generateSignature(timestamp, body, 'wrong-secret');

    const result = await verifySlackSignature(
      {
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': signature,
      },
      body,
      secret,
    );

    expect(result).toBe(false);
  });
});

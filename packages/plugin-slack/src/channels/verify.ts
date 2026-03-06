/**
 * Verify Slack request signature using HMAC-SHA256.
 * Uses Web Crypto API for Cloudflare Workers compatibility.
 */
export async function verifySlackSignature(
  rawHeaders: Record<string, string>,
  rawBody: string,
  signingSecret: string,
): Promise<boolean> {
  const timestamp = rawHeaders['x-slack-request-timestamp'];
  const signature = rawHeaders['x-slack-signature'];

  if (!timestamp || !signature) return false;

  // Reject requests older than 5 minutes (replay protection)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 300) return false;

  // Compute HMAC-SHA256
  const baseString = `v0:${timestamp}:${rawBody}`;
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(baseString));

  // Convert to hex
  const digest = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const expected = `v0=${digest}`;

  // Timing-safe comparison
  if (expected.length !== signature.length) return false;

  const expectedBytes = encoder.encode(expected);
  const signatureBytes = encoder.encode(signature);

  // Use constant-time comparison
  let mismatch = 0;
  for (let i = 0; i < expectedBytes.length; i++) {
    mismatch |= expectedBytes[i] ^ signatureBytes[i];
  }

  return mismatch === 0;
}

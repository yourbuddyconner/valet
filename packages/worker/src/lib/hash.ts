/**
 * Pure SHA-256 helper used by workflow snapshots, idempotency keys, and
 * the publish-time definition hash. Standalone so callers don't pull
 * in any DB or session code transitively.
 */

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

import type { TriggerSource, ParsedWebhookEvent } from '@valet/sdk';

const GITHUB_EVENT_TYPES = [
  'push',
  'pull_request',
  'issues',
  'issue_comment',
  'create',
  'delete',
  'release',
  'workflow_run',
  'check_run',
  'check_suite',
  'status',
  'ping',
];

export const githubTriggers: TriggerSource = {
  service: 'github',

  listEventTypes(): string[] {
    return GITHUB_EVENT_TYPES;
  },

  async verifySignature(
    rawHeaders: Record<string, string>,
    rawBody: string,
    secret: string,
  ): Promise<boolean> {
    const signature =
      rawHeaders['x-hub-signature-256'] || rawHeaders['X-Hub-Signature-256'];
    if (!signature) return false;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );

    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
    const expected =
      'sha256=' +
      Array.from(new Uint8Array(sig))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

    // Timing-safe comparison (constant-time for equal-length strings)
    if (signature.length !== expected.length) return false;
    let mismatch = 0;
    for (let i = 0; i < signature.length; i++) {
      mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return mismatch === 0;
  },

  parseWebhook(
    rawHeaders: Record<string, string>,
    rawBody: string,
  ): ParsedWebhookEvent {
    const eventType =
      rawHeaders['x-github-event'] || rawHeaders['X-GitHub-Event'] || 'unknown';
    const deliveryId =
      rawHeaders['x-github-delivery'] || rawHeaders['X-GitHub-Delivery'];

    const payload = JSON.parse(rawBody);
    const action = typeof payload.action === 'string' ? payload.action : undefined;

    return {
      eventType,
      action,
      payload,
      deliveryId,
    };
  },
};

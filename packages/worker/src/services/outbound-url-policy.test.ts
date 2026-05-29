import { describe, expect, it } from 'vitest';
import { validateOutboundUrl } from './outbound-url-policy.js';

describe('outbound URL policy', () => {
  it('accepts public HTTPS URLs and validates resolved addresses when provided', async () => {
    await expect(validateOutboundUrl('https://mcp.salesforce.com/platform/mcp')).resolves.toEqual(
      new URL('https://mcp.salesforce.com/platform/mcp'),
    );

    await expect(validateOutboundUrl('https://mcp.example.com', {
      resolveHost: async () => ['203.0.113.10'],
    })).rejects.toThrow(/not allowed/i);

    await expect(validateOutboundUrl('https://mcp.example.com', {
      resolveHost: async () => ['8.8.8.8', '2001:4860:4860::8888'],
    })).resolves.toEqual(new URL('https://mcp.example.com/'));
  });

  it('rejects non-public URL forms before they can be stored or fetched', async () => {
    const rejected = [
      'http://mcp.example.com',
      'https://user:pass@mcp.example.com',
      'https://mcp.example.com:8443',
      'https://mcp.example.com/path#fragment',
      'https://localhost/mcp',
      'https://api.local/mcp',
      'https://api.internal/mcp',
      'https://internal/mcp',
      'https://127.0.0.1/mcp',
      'https://10.0.0.5/mcp',
      'https://[::1]/mcp',
      'https://[fd00::1]/mcp',
      'https://[::ffff:10.0.0.5]/mcp',
      'https://169.254.169.254/latest/meta-data',
    ];

    for (const url of rejected) {
      await expect(validateOutboundUrl(url)).rejects.toThrow(/not allowed|https|credentials|fragment|port/i);
    }
  });

  it('rejects injected resolved addresses that are private, reserved, or metadata ranges', async () => {
    const blockedAnswers = [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.0.1',
      '100.64.0.1',
      '169.254.169.254',
      '192.0.2.10',
      '198.51.100.10',
      '203.0.113.10',
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:192.168.0.1',
    ];

    for (const address of blockedAnswers) {
      await expect(validateOutboundUrl('https://mcp.example.com', {
        resolveHost: async () => [address],
      })).rejects.toThrow(/resolved/i);
    }
  });
});

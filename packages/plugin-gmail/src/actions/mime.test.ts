import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMimeMessage } from './actions.js';

function extractBoundary(mime: string): string {
  const match = mime.match(/boundary="([^"]+)"/);
  if (!match) throw new Error(`No MIME boundary found:\n${mime}`);
  return match[1];
}

describe('buildMimeMessage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('builds multipart alternative with markdown plain text and rendered HTML', () => {
    const markdown = [
      '# Hello',
      '',
      'This is **formatted** and includes https://example.com.',
    ].join('\n');

    const mime = buildMimeMessage({
      to: ['alice@example.com'],
      cc: ['bob@example.com'],
      bcc: ['carol@example.com'],
      subject: 'Résumé ✓',
      body: markdown,
      inReplyTo: '<message-1@example.com>',
      references: '<message-0@example.com> <message-1@example.com>',
    });
    const boundary = extractBoundary(mime);
    const outerHeaders = mime.slice(0, mime.indexOf('\r\n\r\n'));

    expect(outerHeaders).toContain('To: alice@example.com');
    expect(outerHeaders).toContain('Cc: bob@example.com');
    expect(outerHeaders).toContain('Bcc: carol@example.com');
    expect(outerHeaders).toContain('Subject: =?UTF-8?B?');
    expect(outerHeaders).toContain('MIME-Version: 1.0');
    expect(outerHeaders).toContain('In-Reply-To: <message-1@example.com>');
    expect(outerHeaders).toContain(
      'References: <message-0@example.com> <message-1@example.com>',
    );
    expect(outerHeaders).toContain(
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
    );

    expect(mime).toContain(`--${boundary}\r\nContent-Type: text/plain; charset="UTF-8"`);
    expect(mime).toContain('Content-Transfer-Encoding: 8bit\r\n\r\n# Hello');
    expect(mime).toContain(
      `--${boundary}\r\nContent-Type: text/html; charset="UTF-8"`,
    );
    expect(mime).toContain('<!DOCTYPE html>');
    expect(mime).toContain('<h1>Hello</h1>');
    expect(mime).toContain('<strong>formatted</strong>');
    expect(mime).toContain(
      '<a href="https://example.com">https://example.com</a>',
    );
    expect(mime.endsWith(`\r\n--${boundary}--`)).toBe(true);
  });

  it('generates a unique boundary for each message', () => {
    const first = buildMimeMessage({
      to: ['alice@example.com'],
      subject: 'First',
      body: 'Hello',
    });
    const second = buildMimeMessage({
      to: ['alice@example.com'],
      subject: 'Second',
      body: 'Hello',
    });

    expect(extractBoundary(first)).not.toBe(extractBoundary(second));
  });

  it('regenerates the boundary if a candidate appears in message content', () => {
    const collisionUuid = '00000000-0000-4000-8000-000000000000';
    const safeUuid = '11111111-1111-4111-8111-111111111111';
    const randomUUID = vi.spyOn(globalThis.crypto, 'randomUUID');
    randomUUID
      .mockReturnValueOnce(collisionUuid)
      .mockReturnValueOnce(safeUuid);

    const mime = buildMimeMessage({
      to: ['alice@example.com'],
      subject: 'Boundary collision',
      body: `This body mentions b1_${collisionUuid}.`,
    });

    expect(extractBoundary(mime)).toBe(`b1_${safeUuid}`);
    expect(randomUUID).toHaveBeenCalledTimes(2);
  });
});

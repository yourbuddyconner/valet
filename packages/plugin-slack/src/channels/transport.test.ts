import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackTransport } from './transport.js';
import type { ChannelTarget, ChannelContext } from '@valet/sdk';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('SlackTransport', () => {
  let transport: SlackTransport;

  beforeEach(() => {
    transport = new SlackTransport();
    vi.clearAllMocks();
  });

  // ─── Properties ────────────────────────────────────────────────────

  it('has channelType "slack"', () => {
    expect(transport.channelType).toBe('slack');
  });

  // ─── verifySignature ──────────────────────────────────────────────

  it('returns true (verification handled externally)', () => {
    expect(transport.verifySignature()).toBe(true);
  });

  // ─── scopeKeyParts ────────────────────────────────────────────────

  it('returns composite channelId with teamId and channelId', () => {
    const result = transport.scopeKeyParts(
      {
        channelType: 'slack',
        channelId: 'C123',
        senderId: 'U1',
        senderName: 'Alice',
        text: 'hello',
        attachments: [],
        metadata: { teamId: 'T456' },
      },
      'user-1',
    );
    expect(result).toEqual({ channelType: 'slack', channelId: 'T456:C123' });
  });

  it('includes threadTs in channelId when present', () => {
    const result = transport.scopeKeyParts(
      {
        channelType: 'slack',
        channelId: 'C123',
        senderId: 'U1',
        senderName: 'Alice',
        text: 'hello',
        attachments: [],
        metadata: { teamId: 'T456', threadTs: '1234567890.123456' },
      },
      'user-1',
    );
    expect(result).toEqual({
      channelType: 'slack',
      channelId: 'T456:C123:1234567890.123456',
    });
  });

  // ─── formatMarkdown ───────────────────────────────────────────────

  it('delegates to markdownToSlackMrkdwn', () => {
    const result = transport.formatMarkdown('**bold**');
    expect(result).toBe('*bold*');
  });

  // ─── parseInbound ─────────────────────────────────────────────────

  describe('parseInbound', () => {
    it('returns null for invalid JSON', async () => {
      const result = await transport.parseInbound({}, 'not-json', { userId: 'u1' });
      expect(result).toBeNull();
    });

    it('returns null for url_verification events', async () => {
      const body = JSON.stringify({
        type: 'url_verification',
        challenge: 'abc123',
      });
      const result = await transport.parseInbound({}, body, { userId: 'u1' });
      expect(result).toBeNull();
    });

    it('returns null for non-event_callback types', async () => {
      const body = JSON.stringify({
        type: 'app_rate_limited',
      });
      const result = await transport.parseInbound({}, body, { userId: 'u1' });
      expect(result).toBeNull();
    });

    it('returns null for events without event object', async () => {
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
      });
      const result = await transport.parseInbound({}, body, { userId: 'u1' });
      expect(result).toBeNull();
    });

    it('parses regular message events', async () => {
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'message',
          channel: 'C456',
          user: 'U789',
          text: 'hello agent',
          ts: '1234567890.123456',
          event_ts: '1234567890.123456',
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1' });
      expect(result).not.toBeNull();
      expect(result!.channelType).toBe('slack');
      expect(result!.channelId).toBe('C456');
      expect(result!.senderId).toBe('U789');
      expect(result!.text).toBe('hello agent');
      expect(result!.command).toBeUndefined();
      expect(result!.attachments).toHaveLength(0);
      expect(result!.messageId).toBe('1234567890.123456');
      expect(result!.metadata).toEqual({
        teamId: 'T123',
        threadTs: undefined,
        eventTs: '1234567890.123456',
        slackEventType: 'message',
        slackChannelType: undefined,
      });
    });

    it('parses threaded message events', async () => {
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'message',
          channel: 'C456',
          user: 'U789',
          text: 'reply in thread',
          ts: '1234567891.000000',
          thread_ts: '1234567890.123456',
          event_ts: '1234567891.000000',
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1' });
      expect(result).not.toBeNull();
      expect(result!.metadata?.threadTs).toBe('1234567890.123456');
    });

    it('parses app_mention events', async () => {
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'app_mention',
          channel: 'C456',
          user: 'U789',
          text: '<@U_BOT> do something',
          ts: '1234567890.123456',
          event_ts: '1234567890.123456',
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1' });
      expect(result).not.toBeNull();
      expect(result!.text).toBe('<@U_BOT> do something');
    });

    it('skips bot_message subtypes', async () => {
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'message',
          subtype: 'bot_message',
          channel: 'C456',
          text: 'bot says hi',
          ts: '1234567890.123456',
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1' });
      expect(result).toBeNull();
    });

    it('skips message_changed subtypes', async () => {
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'message',
          subtype: 'message_changed',
          channel: 'C456',
          ts: '1234567890.123456',
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1' });
      expect(result).toBeNull();
    });

    it('skips message_deleted subtypes', async () => {
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'message',
          subtype: 'message_deleted',
          channel: 'C456',
          ts: '1234567890.123456',
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1' });
      expect(result).toBeNull();
    });

    it('skips channel_join subtypes', async () => {
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'message',
          subtype: 'channel_join',
          channel: 'C456',
          user: 'U789',
          ts: '1234567890.123456',
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1' });
      expect(result).toBeNull();
    });

    it('skips messages from bots (bot_id present)', async () => {
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'message',
          channel: 'C456',
          user: 'U789',
          bot_id: 'B123',
          text: 'bot says hi',
          ts: '1234567890.123456',
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1' });
      expect(result).toBeNull();
    });

    it('parses file_share subtype', async () => {
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'message',
          subtype: 'file_share',
          channel: 'C456',
          user: 'U789',
          text: 'here is a file',
          ts: '1234567890.123456',
          files: [
            {
              url_private: 'https://files.slack.com/files-pri/T123-F456/image.png',
              mimetype: 'image/png',
              name: 'image.png',
              size: 12345,
              filetype: 'png',
            },
          ],
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1' });
      expect(result).not.toBeNull();
      expect(result!.text).toBe('here is a file');
      expect(result!.attachments).toHaveLength(1);
      expect(result!.attachments[0].type).toBe('image');
      expect(result!.attachments[0].mimeType).toBe('image/png');
      expect(result!.attachments[0].fileName).toBe('image.png');
      expect(result!.attachments[0].size).toBe(12345);
    });

    it('parses non-image file attachments', async () => {
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'message',
          subtype: 'file_share',
          channel: 'C456',
          user: 'U789',
          text: '',
          ts: '1234567890.123456',
          files: [
            {
              url_private: 'https://files.slack.com/files-pri/T123-F456/doc.pdf',
              mimetype: 'application/pdf',
              name: 'doc.pdf',
              size: 54321,
              filetype: 'pdf',
            },
          ],
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1' });
      expect(result).not.toBeNull();
      expect(result!.text).toBe('[Attachment]');
      expect(result!.attachments).toHaveLength(1);
      expect(result!.attachments[0].type).toBe('file');
      expect(result!.attachments[0].mimeType).toBe('application/pdf');
    });

    it('parses slash command patterns in text', async () => {
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'message',
          channel: 'C456',
          user: 'U789',
          text: '/status check now',
          ts: '1234567890.123456',
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1' });
      expect(result).not.toBeNull();
      expect(result!.command).toBe('status');
      expect(result!.commandArgs).toBe('check now');
      expect(result!.text).toBe('check now');
    });

    it('parses slash command with no args', async () => {
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'message',
          channel: 'C456',
          user: 'U789',
          text: '/help',
          ts: '1234567890.123456',
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1' });
      expect(result!.command).toBe('help');
      expect(result!.text).toBe('');
    });

    it('returns null for events without user or channel', async () => {
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'message',
          text: 'orphan message',
          ts: '1234567890.123456',
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1' });
      expect(result).toBeNull();
    });
  });

  // ─── sendMessage ──────────────────────────────────────────────────

  describe('sendMessage', () => {
    const target: ChannelTarget = { channelType: 'slack', channelId: 'C456' };
    const ctx: ChannelContext = { token: 'xoxb-test-token', userId: 'u1' };

    it('sends text message with mrkdwn formatting', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: true, ts: '1234567890.123456' })
      );

      const result = await transport.sendMessage(target, { markdown: '**hello**' }, ctx);

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('1234567890.123456');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://slack.com/api/chat.postMessage');
      const body = JSON.parse(opts.body);
      expect(body.channel).toBe('C456');
      expect(body.text).toBe('*hello*');
      expect(body.unfurl_links).toBe(false);
    });

    it('sends plain text when no markdown', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: true, ts: '1234567890.123456' })
      );

      const result = await transport.sendMessage(target, { text: 'plain text' }, ctx);
      expect(result.success).toBe(true);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.text).toBe('plain text');
    });

    it('includes thread_ts when target has threadId', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: true, ts: '1234567891.000000' })
      );

      const threadTarget: ChannelTarget = {
        channelType: 'slack',
        channelId: 'C456',
        threadId: '1234567890.123456',
      };

      await transport.sendMessage(threadTarget, { text: 'threaded reply' }, ctx);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.thread_ts).toBe('1234567890.123456');
    });

    it('returns error on API failure', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: false, error: 'channel_not_found' })
      );

      const result = await transport.sendMessage(target, { markdown: 'test' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('channel_not_found');
    });

    it('returns error on HTTP failure', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Internal Server Error', { status: 500 })
      );

      const result = await transport.sendMessage(target, { markdown: 'test' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('500');
    });

    it('includes authorization header', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: true, ts: '1234567890.123456' })
      );

      await transport.sendMessage(target, { text: 'test' }, ctx);

      const opts = mockFetch.mock.calls[0][1];
      expect(opts.headers.Authorization).toBe('Bearer xoxb-test-token');
    });
  });

  // ─── editMessage ──────────────────────────────────────────────────

  describe('editMessage', () => {
    const target: ChannelTarget = { channelType: 'slack', channelId: 'C456' };
    const ctx: ChannelContext = { token: 'xoxb-test-token', userId: 'u1' };

    it('calls chat.update API', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: true, ts: '1234567890.123456' })
      );

      const result = await transport.editMessage(
        target, '1234567890.123456', { markdown: 'updated' }, ctx,
      );

      expect(result.success).toBe(true);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://slack.com/api/chat.update');
      const body = JSON.parse(opts.body);
      expect(body.channel).toBe('C456');
      expect(body.ts).toBe('1234567890.123456');
      expect(body.text).toBe('updated');
    });

    it('returns error on failure', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: false, error: 'message_not_found' })
      );

      const result = await transport.editMessage(
        target, '1234567890.123456', { markdown: 'fail' }, ctx,
      );
      expect(result.success).toBe(false);
    });
  });

  // ─── deleteMessage ────────────────────────────────────────────────

  describe('deleteMessage', () => {
    const target: ChannelTarget = { channelType: 'slack', channelId: 'C456' };
    const ctx: ChannelContext = { token: 'xoxb-test-token', userId: 'u1' };

    it('calls chat.delete API and returns true', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

      const result = await transport.deleteMessage(target, '1234567890.123456', ctx);
      expect(result).toBe(true);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://slack.com/api/chat.delete');
      const body = JSON.parse(opts.body);
      expect(body.channel).toBe('C456');
      expect(body.ts).toBe('1234567890.123456');
    });

    it('returns false on failure', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: false, error: 'cant_delete_message' })
      );

      const result = await transport.deleteMessage(target, '1234567890.123456', ctx);
      expect(result).toBe(false);
    });
  });

  // ─── No sendTypingIndicator / registerWebhook / unregisterWebhook ─

  it('does not implement sendTypingIndicator', () => {
    expect((transport as any).sendTypingIndicator).toBeUndefined();
  });

  it('does not implement registerWebhook', () => {
    expect((transport as any).registerWebhook).toBeUndefined();
  });

  it('does not implement unregisterWebhook', () => {
    expect((transport as any).unregisterWebhook).toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackTransport } from './transport.js';
import type { ChannelTarget, ChannelContext, InteractivePrompt } from '@valet/sdk';

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
    mockFetch.mockReset();
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

  // ─── parseTarget ──────────────────────────────────────────────────

  describe('parseTarget', () => {
    it('splits composite channel:thread_ts into channelId and threadId', () => {
      const result = transport.parseTarget('C123ABC:1234567890.123456');
      expect(result).toEqual({
        channelType: 'slack',
        channelId: 'C123ABC',
        threadId: '1234567890.123456',
      });
    });

    it('returns bare channelId when no colon present', () => {
      const result = transport.parseTarget('C123ABC');
      expect(result).toEqual({
        channelType: 'slack',
        channelId: 'C123ABC',
      });
    });
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

    it('downloads file_share images as base64 data URLs when botToken provided', async () => {
      const fakeImageBytes = new Uint8Array([137, 80, 78, 71]); // PNG magic bytes
      mockFetch.mockResolvedValueOnce(
        new Response(fakeImageBytes, { status: 200 }),
      );

      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'message',
          subtype: 'file_share',
          channel: 'C456',
          user: 'U789',
          text: 'check this out',
          ts: '1234567890.123456',
          files: [
            {
              url_private: 'https://files.slack.com/files-pri/T123-F456/photo.png',
              mimetype: 'image/png',
              name: 'photo.png',
              size: 4,
              filetype: 'png',
            },
          ],
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1', botToken: 'xoxb-test' });
      expect(result).not.toBeNull();
      expect(result!.attachments).toHaveLength(1);
      expect(result!.attachments[0].type).toBe('image');
      expect(result!.attachments[0].url).toMatch(/^data:image\/png;base64,/);
      expect(result!.attachments[0].mimeType).toBe('image/png');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [fetchUrl, fetchOpts] = mockFetch.mock.calls[0];
      expect(fetchUrl).toBe('https://files.slack.com/files-pri/T123-F456/photo.png');
      expect(fetchOpts.headers.Authorization).toBe('Bearer xoxb-test');
    });

    it('falls back to url_private when botToken is not provided', async () => {
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'message',
          subtype: 'file_share',
          channel: 'C456',
          user: 'U789',
          text: 'file here',
          ts: '1234567890.123456',
          files: [
            {
              url_private: 'https://files.slack.com/files-pri/T123-F456/photo.png',
              mimetype: 'image/png',
              name: 'photo.png',
              size: 4,
              filetype: 'png',
            },
          ],
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1' });
      expect(result!.attachments[0].url).toBe('https://files.slack.com/files-pri/T123-F456/photo.png');
    });

    it('skips files larger than 10MB during download', async () => {
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
              url_private: 'https://files.slack.com/files-pri/T123-F456/huge.zip',
              mimetype: 'application/zip',
              name: 'huge.zip',
              size: 11 * 1024 * 1024,
              filetype: 'zip',
            },
          ],
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1', botToken: 'xoxb-test' });
      expect(result!.attachments).toHaveLength(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('gracefully handles download failure', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));

      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'message',
          subtype: 'file_share',
          channel: 'C456',
          user: 'U789',
          text: 'file',
          ts: '1234567890.123456',
          files: [
            {
              url_private: 'https://files.slack.com/files-pri/T123-F456/secret.png',
              mimetype: 'image/png',
              name: 'secret.png',
              size: 1000,
              filetype: 'png',
            },
          ],
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1', botToken: 'xoxb-test' });
      expect(result!.attachments).toHaveLength(0);
    });

    it('prefers Slack thumbnail over full-size image when available', async () => {
      const fakeThumbBytes = new Uint8Array([137, 80, 78, 71]); // PNG magic bytes
      mockFetch.mockResolvedValueOnce(
        new Response(fakeThumbBytes, { status: 200 }),
      );

      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'message',
          subtype: 'file_share',
          channel: 'C456',
          user: 'U789',
          text: 'big photo',
          ts: '1234567890.123456',
          files: [
            {
              url_private: 'https://files.slack.com/files-pri/T123-F456/huge_photo.png',
              mimetype: 'image/png',
              name: 'huge_photo.png',
              size: 8 * 1024 * 1024, // 8MB original
              filetype: 'png',
              thumb_1024: 'https://files.slack.com/files-tmb/T123-F456/huge_photo_1024.png',
              thumb_720: 'https://files.slack.com/files-tmb/T123-F456/huge_photo_720.png',
            },
          ],
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1', botToken: 'xoxb-test' });
      expect(result).not.toBeNull();
      expect(result!.attachments).toHaveLength(1);
      expect(result!.attachments[0].url).toMatch(/^data:image\/png;base64,/);

      // Should have downloaded the thumb_1024, not url_private
      const [fetchUrl] = mockFetch.mock.calls[0];
      expect(fetchUrl).toBe('https://files.slack.com/files-tmb/T123-F456/huge_photo_1024.png');
    });

    it('falls back to url_private when no thumbnails available for images', async () => {
      const fakeImageBytes = new Uint8Array([137, 80, 78, 71]);
      mockFetch.mockResolvedValueOnce(
        new Response(fakeImageBytes, { status: 200 }),
      );

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
              url_private: 'https://files.slack.com/files-pri/T123-F456/photo.png',
              mimetype: 'image/png',
              name: 'photo.png',
              size: 5000,
              filetype: 'png',
              // no thumb_* fields
            },
          ],
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1', botToken: 'xoxb-test' });
      expect(result!.attachments).toHaveLength(1);
      const [fetchUrl] = mockFetch.mock.calls[0];
      expect(fetchUrl).toBe('https://files.slack.com/files-pri/T123-F456/photo.png');
    });

    it('does not use thumbnails for non-image files', async () => {
      const fakePdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
      mockFetch.mockResolvedValueOnce(
        new Response(fakePdfBytes, { status: 200 }),
      );

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
              size: 5000,
              filetype: 'pdf',
              thumb_720: 'https://files.slack.com/files-tmb/T123-F456/doc_720.png',
            },
          ],
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1', botToken: 'xoxb-test' });
      expect(result!.attachments).toHaveLength(1);
      // Should download the original PDF, not the thumbnail
      const [fetchUrl] = mockFetch.mock.calls[0];
      expect(fetchUrl).toBe('https://files.slack.com/files-pri/T123-F456/doc.pdf');
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
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: true })
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

    it('clears shimmer after successful threaded sendMessage', async () => {
      const threadTarget: ChannelTarget = {
        channelType: 'slack',
        channelId: 'C456',
        threadId: '1234567890.123456',
      };

      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: true, ts: '1234567891.000000' })
      );
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: true })
      );

      const result = await transport.sendMessage(threadTarget, { text: 'threaded reply' }, ctx);

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const shimmerCall = mockFetch.mock.calls[1];
      expect(shimmerCall[0]).toBe('https://slack.com/api/assistant.threads.setStatus');
      const shimmerBody = JSON.parse(shimmerCall[1].body);
      expect(shimmerBody.channel_id).toBe('C456');
      expect(shimmerBody.thread_ts).toBe('1234567890.123456');
      expect(shimmerBody.status).toBe('');
    });

    it('does not clear shimmer for non-threaded sendMessage', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: true, ts: '1234567891.000000' })
      );

      const result = await transport.sendMessage(target, { text: 'plain text' }, ctx);

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
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

    it('uploads image attachment via files.getUploadURLExternal + completeUploadExternal', async () => {
      // 1. files.getUploadURLExternal response
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          upload_url: 'https://files.slack.com/upload/v1/ABC123',
          file_id: 'F_UPLOAD_1',
        }),
      );
      // 2. POST to upload URL
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));
      // 3. files.completeUploadExternal response
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
      // 4. shimmer clear for threaded attachment-only send
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

      const target: ChannelTarget = { channelType: 'slack', channelId: 'C456', threadId: '111.222' };

      const result = await transport.sendMessage(
        target,
        {
          attachments: [{
            type: 'image' as const,
            url: 'data:image/png;base64,iVBORw0KGgo=',
            mimeType: 'image/png',
            fileName: 'chart.png',
          }],
        },
        ctx,
      );

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(4);

      // Verify getUploadURLExternal call
      const [url1, opts1] = mockFetch.mock.calls[0];
      expect(url1).toBe('https://slack.com/api/files.getUploadURLExternal');
      const body1 = JSON.parse(opts1.body);
      expect(body1.filename).toBe('chart.png');
      expect(body1.length).toBeGreaterThan(0);

      // Verify upload to pre-signed URL
      const [url2, opts2] = mockFetch.mock.calls[1];
      expect(url2).toBe('https://files.slack.com/upload/v1/ABC123');
      expect(opts2.method).toBe('POST');

      // Verify completeUploadExternal call
      const [url3, opts3] = mockFetch.mock.calls[2];
      expect(url3).toBe('https://slack.com/api/files.completeUploadExternal');
      const body3 = JSON.parse(opts3.body);
      expect(body3.files).toEqual([{ id: 'F_UPLOAD_1' }]);
      expect(body3.channel_id).toBe('C456');
      expect(body3.thread_ts).toBe('111.222');

      const [url4, opts4] = mockFetch.mock.calls[3];
      expect(url4).toBe('https://slack.com/api/assistant.threads.setStatus');
      const body4 = JSON.parse(opts4.body);
      expect(body4.channel_id).toBe('C456');
      expect(body4.thread_ts).toBe('111.222');
      expect(body4.status).toBe('');
    });

    it('sends text alongside file attachment as separate message', async () => {
      // File upload flow (3 calls)
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: true, upload_url: 'https://upload.example.com', file_id: 'F1' }),
      );
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
      // chat.postMessage for text
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true, ts: '111.333' }));
      // shimmer clear
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

      const result = await transport.sendMessage(
        { channelType: 'slack', channelId: 'C456', threadId: '111.222' },
        {
          markdown: 'Here is the file',
          attachments: [{
            type: 'file' as const,
            url: 'data:application/pdf;base64,JVBERi0=',
            mimeType: 'application/pdf',
            fileName: 'report.pdf',
          }],
        },
        ctx,
      );

      expect(result.success).toBe(true);
      // 3 for upload + 1 for text + 1 for shimmer clear
      expect(mockFetch).toHaveBeenCalledTimes(5);
      const [textUrl] = mockFetch.mock.calls[3];
      expect(textUrl).toBe('https://slack.com/api/chat.postMessage');
    });

    it('clears shimmer after successful threaded attachment-only sendMessage', async () => {
      const setThreadStatusSpy = vi.spyOn(transport, 'setThreadStatus').mockResolvedValue(true);
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: true, upload_url: 'https://upload.example.com', file_id: 'F1' }),
      );
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

      const result = await transport.sendMessage(
        { channelType: 'slack', channelId: 'C456', threadId: '111.222' },
        {
          attachments: [{
            type: 'file' as const,
            url: 'data:application/pdf;base64,JVBERi0=',
            mimeType: 'application/pdf',
            fileName: 'report.pdf',
          }],
        },
        ctx,
      );

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(setThreadStatusSpy).toHaveBeenCalledWith(
        { channelType: 'slack', channelId: 'C456', threadId: '111.222' },
        '',
        ctx,
      );
    });

    it('returns error when file upload fails at getUploadURLExternal', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: false, error: 'not_allowed' }),
      );

      const result = await transport.sendMessage(
        { channelType: 'slack', channelId: 'C456' },
        {
          attachments: [{
            type: 'image' as const,
            url: 'data:image/png;base64,iVBORw0KGgo=',
            mimeType: 'image/png',
          }],
        },
        ctx,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not_allowed');
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

  // ─── Round-trip file handling ───────────────────────────────────────

  describe('round-trip file handling', () => {
    it('inbound file can be sent back outbound', async () => {
      const fakeFileBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // PDF magic bytes

      // Mock inbound download
      mockFetch.mockResolvedValueOnce(new Response(fakeFileBytes, { status: 200 }));

      const inboundBody = JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'message',
          subtype: 'file_share',
          channel: 'C456',
          user: 'U789',
          text: '',
          ts: '1234567890.123456',
          files: [{
            url_private: 'https://files.slack.com/files-pri/T123-F456/report.pdf',
            mimetype: 'application/pdf',
            name: 'report.pdf',
            size: 4,
            filetype: 'pdf',
          }],
        },
      });

      const inbound = await transport.parseInbound({}, inboundBody, { userId: 'u1', botToken: 'xoxb-test' });
      expect(inbound).not.toBeNull();
      expect(inbound!.attachments).toHaveLength(1);
      expect(inbound!.attachments[0].url).toMatch(/^data:application\/pdf;base64,/);

      // Now send it back outbound
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: true, upload_url: 'https://upload.example.com', file_id: 'F1' }),
      );
      mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

      const target: ChannelTarget = { channelType: 'slack', channelId: 'C456', threadId: '1234567890.123456' };
      const ctx: ChannelContext = { token: 'xoxb-test', userId: 'u1' };

      const result = await transport.sendMessage(target, {
        attachments: [{
          type: inbound!.attachments[0].type as 'image' | 'file',
          url: inbound!.attachments[0].url,
          mimeType: inbound!.attachments[0].mimeType,
          fileName: inbound!.attachments[0].fileName,
        }],
      }, ctx);

      expect(result.success).toBe(true);
      // 1 for inbound download + 3 for outbound upload + 1 shimmer clear
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });
  });

  // ─── sendInteractivePrompt ────────────────────────────────────────

  describe('sendInteractivePrompt', () => {
    const ctx: ChannelContext = { token: 'xoxb-test-token', userId: 'u1' };

    it('posts interactive prompts into the exact Slack thread target', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: true, ts: '1234567891.000000' })
      );

      const target: ChannelTarget = {
        channelType: 'slack',
        channelId: 'C456',
        threadId: '1234567890.123456',
      };
      const prompt: InteractivePrompt = {
        id: 'prompt-1',
        sessionId: 'orchestrator:user-1',
        type: 'approval',
        title: 'Action requires approval',
        actions: [
          { id: 'approve', label: 'Approve', style: 'primary' },
          { id: 'deny', label: 'Deny', style: 'danger' },
        ],
      };

      const ref = await transport.sendInteractivePrompt(target, prompt, ctx);

      expect(ref).toEqual({ messageId: '1234567891.000000', channelId: 'C456' });
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://slack.com/api/chat.postMessage');
      const body = JSON.parse(opts.body);
      expect(body.channel).toBe('C456');
      expect(body.thread_ts).toBe('1234567890.123456');
      expect(body.blocks[1].elements[0].value).toBe('orchestrator:user-1:prompt-1');
    });
  });
});

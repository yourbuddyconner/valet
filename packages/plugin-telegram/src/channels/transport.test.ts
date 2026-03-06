import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramTransport } from './transport.js';
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

describe('TelegramTransport', () => {
  let transport: TelegramTransport;

  beforeEach(() => {
    transport = new TelegramTransport();
    vi.clearAllMocks();
  });

  // ─── Properties ────────────────────────────────────────────────────

  it('has channelType "telegram"', () => {
    expect(transport.channelType).toBe('telegram');
  });

  // ─── verifySignature ──────────────────────────────────────────────

  it('always returns true (Telegram uses URL-based auth)', () => {
    expect(transport.verifySignature()).toBe(true);
  });

  // ─── scopeKeyParts ────────────────────────────────────────────────

  it('returns channelType and channelId', () => {
    const result = transport.scopeKeyParts(
      { channelType: 'telegram', channelId: '12345', senderId: '', senderName: '', text: '', attachments: [] },
      'user-1',
    );
    expect(result).toEqual({ channelType: 'telegram', channelId: '12345' });
  });

  // ─── formatMarkdown ───────────────────────────────────────────────

  it('delegates to markdownToTelegramHtml', () => {
    const result = transport.formatMarkdown('**bold**');
    expect(result).toBe('<b>bold</b>');
  });

  // ─── parseInbound ─────────────────────────────────────────────────

  describe('parseInbound', () => {
    it('returns null if botToken is missing', async () => {
      const result = await transport.parseInbound({}, '{}', { userId: 'u1' });
      expect(result).toBeNull();
    });

    it('returns null for invalid JSON', async () => {
      const result = await transport.parseInbound({}, 'not-json', { userId: 'u1', botToken: 'tok' });
      expect(result).toBeNull();
    });

    it('returns null for updates without message', async () => {
      const body = JSON.stringify({ update_id: 1, callback_query: {} });
      const result = await transport.parseInbound({}, body, { userId: 'u1', botToken: 'tok' });
      expect(result).toBeNull();
    });

    it('parses text messages', async () => {
      const body = JSON.stringify({
        update_id: 1,
        message: {
          message_id: 42,
          from: { id: 100, first_name: 'Alice', last_name: 'B' },
          chat: { id: 999 },
          text: 'hello agent',
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1', botToken: 'tok' });
      expect(result).not.toBeNull();
      expect(result!.channelType).toBe('telegram');
      expect(result!.channelId).toBe('999');
      expect(result!.senderId).toBe('100');
      expect(result!.senderName).toBe('Alice B');
      expect(result!.text).toBe('hello agent');
      expect(result!.command).toBeUndefined();
      expect(result!.attachments).toHaveLength(0);
      expect(result!.messageId).toBe('42');
    });

    it('parses slash commands', async () => {
      const body = JSON.stringify({
        update_id: 1,
        message: {
          message_id: 43,
          from: { id: 100, first_name: 'Alice' },
          chat: { id: 999 },
          text: '/status check now',
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1', botToken: 'tok' });
      expect(result).not.toBeNull();
      expect(result!.command).toBe('status');
      expect(result!.commandArgs).toBe('check now');
      expect(result!.text).toBe('check now');
    });

    it('parses slash commands with no args', async () => {
      const body = JSON.stringify({
        update_id: 1,
        message: {
          message_id: 44,
          from: { id: 100, first_name: 'Alice' },
          chat: { id: 999 },
          text: '/help',
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1', botToken: 'tok' });
      expect(result!.command).toBe('help');
      expect(result!.text).toBe('');
    });

    it('parses forwarded messages with attribution', async () => {
      const body = JSON.stringify({
        update_id: 1,
        message: {
          message_id: 45,
          from: { id: 100, first_name: 'Alice' },
          chat: { id: 999 },
          text: 'forwarded content',
          forward_origin: {
            type: 'user',
            sender_user: { first_name: 'Bob', last_name: 'C', username: 'bobc' },
          },
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1', botToken: 'tok' });
      expect(result).not.toBeNull();
      expect(result!.text).toContain('Forwarded from Bob C (@bobc)');
      expect(result!.text).toContain('> forwarded content');
    });

    it('parses photo messages with download', async () => {
      // Mock getFile API call
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: true, result: { file_path: 'photos/file_1.jpg' } })
      );
      // Mock file download
      mockFetch.mockResolvedValueOnce(
        new Response(new Uint8Array([0xFF, 0xD8, 0xFF]), { status: 200 })
      );

      const body = JSON.stringify({
        update_id: 1,
        message: {
          message_id: 46,
          from: { id: 100, first_name: 'Alice' },
          chat: { id: 999 },
          caption: 'my photo',
          photo: [
            { file_id: 'small', width: 100, height: 100 },
            { file_id: 'large', width: 800, height: 600 },
          ],
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1', botToken: 'tok' });
      expect(result).not.toBeNull();
      expect(result!.text).toBe('my photo');
      expect(result!.attachments).toHaveLength(1);
      expect(result!.attachments[0].type).toBe('image');
      expect(result!.attachments[0].mimeType).toBe('image/jpeg');
      expect(result!.attachments[0].url).toMatch(/^data:image\/jpeg;base64,/);

      // Should use getFile for the largest photo (last in array)
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const getFileCall = mockFetch.mock.calls[0];
      expect(getFileCall[0]).toContain('/getFile');
      expect(JSON.parse(getFileCall[1].body)).toEqual({ file_id: 'large' });
    });

    it('parses voice messages', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: true, result: { file_path: 'voice/file_2.ogg' } })
      );
      mockFetch.mockResolvedValueOnce(
        new Response(new Uint8Array([0x4F, 0x67, 0x67]), { status: 200 })
      );

      const body = JSON.stringify({
        update_id: 1,
        message: {
          message_id: 47,
          from: { id: 100, first_name: 'Alice' },
          chat: { id: 999 },
          voice: { file_id: 'voice-1', duration: 12 },
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1', botToken: 'tok' });
      expect(result).not.toBeNull();
      expect(result!.text).toBe('[Voice note, 12s]');
      expect(result!.attachments).toHaveLength(1);
      expect(result!.attachments[0].type).toBe('audio');
      expect(result!.attachments[0].mimeType).toBe('audio/ogg');
      expect(result!.attachments[0].duration).toBe(12);
    });

    it('parses audio messages', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: true, result: { file_path: 'audio/file_3.mp3' } })
      );
      mockFetch.mockResolvedValueOnce(
        new Response(new Uint8Array([0x49, 0x44, 0x33]), { status: 200 })
      );

      const body = JSON.stringify({
        update_id: 1,
        message: {
          message_id: 48,
          from: { id: 100, first_name: 'Alice' },
          chat: { id: 999 },
          audio: {
            file_id: 'audio-1',
            duration: 180,
            mime_type: 'audio/mpeg',
            title: 'My Song',
            file_name: 'song.mp3',
          },
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1', botToken: 'tok' });
      expect(result).not.toBeNull();
      expect(result!.text).toBe('[Audio: My Song, 180s]');
      expect(result!.attachments).toHaveLength(1);
      expect(result!.attachments[0].type).toBe('audio');
      expect(result!.attachments[0].mimeType).toBe('audio/mpeg');
      expect(result!.attachments[0].fileName).toBe('song.mp3');
    });

    it('parses edited_message like a regular message', async () => {
      const body = JSON.stringify({
        update_id: 1,
        edited_message: {
          message_id: 49,
          from: { id: 100, first_name: 'Alice' },
          chat: { id: 999 },
          text: 'edited text',
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1', botToken: 'tok' });
      expect(result).not.toBeNull();
      expect(result!.text).toBe('edited text');
    });

    it('handles photo with failed download gracefully', async () => {
      // getFile returns ok but download fails
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: true, result: { file_path: 'photos/file_1.jpg' } })
      );
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 }));

      const body = JSON.stringify({
        update_id: 1,
        message: {
          message_id: 50,
          from: { id: 100, first_name: 'Alice' },
          chat: { id: 999 },
          photo: [{ file_id: 'photo-1', width: 100, height: 100 }],
        },
      });

      const result = await transport.parseInbound({}, body, { userId: 'u1', botToken: 'tok' });
      expect(result).not.toBeNull();
      // No attachment since download failed, but message still parses
      expect(result!.attachments).toHaveLength(0);
      expect(result!.text).toBe('');
    });
  });

  // ─── sendMessage ──────────────────────────────────────────────────

  describe('sendMessage', () => {
    const target: ChannelTarget = { channelType: 'telegram', channelId: '999' };
    const ctx: ChannelContext = { token: 'bot-token-123', userId: 'u1' };

    it('sends text message with HTML formatting', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: true, result: { message_id: 101 } })
      );

      const result = await transport.sendMessage(target, { markdown: '**hello**' }, ctx);

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('101');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.telegram.org/botbot-token-123/sendMessage');
      const body = JSON.parse(opts.body);
      expect(body.chat_id).toBe('999');
      expect(body.text).toBe('<b>hello</b>');
      expect(body.parse_mode).toBe('HTML');
    });

    it('sends plain text when no markdown', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: true, result: { message_id: 102 } })
      );

      const result = await transport.sendMessage(target, { text: 'plain text' }, ctx);
      expect(result.success).toBe(true);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.text).toBe('plain text');
    });

    it('returns error on API failure', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('{"ok":false,"description":"Bad Request"}', { status: 400 })
      );

      const result = await transport.sendMessage(target, { markdown: 'test' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('400');
    });

    it('uses sendPhoto for image attachments', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: true, result: { message_id: 103 } })
      );

      const result = await transport.sendMessage(target, {
        markdown: 'caption',
        attachments: [{
          type: 'image',
          url: 'data:image/jpeg;base64,/9j/4AAQ',
          mimeType: 'image/jpeg',
        }],
      }, ctx);

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.telegram.org/botbot-token-123/sendPhoto');
    });
  });

  // ─── editMessage ──────────────────────────────────────────────────

  describe('editMessage', () => {
    const target: ChannelTarget = { channelType: 'telegram', channelId: '999' };
    const ctx: ChannelContext = { token: 'bot-token-123', userId: 'u1' };

    it('calls editMessageText API', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: true, result: { message_id: 101 } })
      );

      const result = await transport.editMessage(target, '101', { markdown: 'updated' }, ctx);

      expect(result.success).toBe(true);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.telegram.org/botbot-token-123/editMessageText');
      const body = JSON.parse(opts.body);
      expect(body.chat_id).toBe('999');
      expect(body.message_id).toBe(101);
      expect(body.text).toBe('updated');
      expect(body.parse_mode).toBe('HTML');
    });

    it('returns error on failure', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('{"ok":false}', { status: 400 })
      );

      const result = await transport.editMessage(target, '101', { markdown: 'fail' }, ctx);
      expect(result.success).toBe(false);
    });
  });

  // ─── deleteMessage ────────────────────────────────────────────────

  describe('deleteMessage', () => {
    const target: ChannelTarget = { channelType: 'telegram', channelId: '999' };
    const ctx: ChannelContext = { token: 'bot-token-123', userId: 'u1' };

    it('calls deleteMessage API and returns true', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

      const result = await transport.deleteMessage(target, '101', ctx);
      expect(result).toBe(true);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.telegram.org/botbot-token-123/deleteMessage');
      const body = JSON.parse(opts.body);
      expect(body.chat_id).toBe('999');
      expect(body.message_id).toBe(101);
    });

    it('returns false on failure', async () => {
      mockFetch.mockResolvedValueOnce(new Response('error', { status: 400 }));

      const result = await transport.deleteMessage(target, '101', ctx);
      expect(result).toBe(false);
    });
  });

  // ─── sendTypingIndicator ──────────────────────────────────────────

  describe('sendTypingIndicator', () => {
    it('calls sendChatAction with typing', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

      const target: ChannelTarget = { channelType: 'telegram', channelId: '999' };
      const ctx: ChannelContext = { token: 'bot-token-123', userId: 'u1' };
      await transport.sendTypingIndicator(target, ctx);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.telegram.org/botbot-token-123/sendChatAction');
      const body = JSON.parse(opts.body);
      expect(body.chat_id).toBe('999');
      expect(body.action).toBe('typing');
    });
  });

  // ─── registerWebhook / unregisterWebhook ──────────────────────────

  describe('registerWebhook', () => {
    it('calls setWebhook API', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

      const ctx: ChannelContext = { token: 'bot-token-123', userId: 'u1' };
      const result = await transport.registerWebhook('https://example.com/webhook', ctx);

      expect(result).toBe(true);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.telegram.org/botbot-token-123/setWebhook');
      const body = JSON.parse(opts.body);
      expect(body.url).toBe('https://example.com/webhook');
    });

    it('returns false on failure', async () => {
      mockFetch.mockResolvedValueOnce(new Response('error', { status: 500 }));

      const ctx: ChannelContext = { token: 'bot-token-123', userId: 'u1' };
      const result = await transport.registerWebhook('https://example.com/webhook', ctx);
      expect(result).toBe(false);
    });
  });

  describe('unregisterWebhook', () => {
    it('calls deleteWebhook API', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

      const ctx: ChannelContext = { token: 'bot-token-123', userId: 'u1' };
      const result = await transport.unregisterWebhook(ctx);

      expect(result).toBe(true);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.telegram.org/botbot-token-123/deleteWebhook');
    });
  });
});

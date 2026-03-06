import type {
  ChannelTransport,
  ChannelTarget,
  ChannelContext,
  InboundMessage,
  InboundAttachment,
  OutboundMessage,
  RoutingMetadata,
  SendResult,
} from '@valet/sdk';
import { markdownToTelegramHtml } from './format.js';

// ─── Telegram API Helpers ────────────────────────────────────────────────────

const TG_API = 'https://api.telegram.org';

function botUrl(token: string, method: string): string {
  return `${TG_API}/bot${token}/${method}`;
}

async function downloadFileAsBase64(
  token: string,
  fileId: string,
): Promise<{ base64: string; filePath: string } | null> {
  const getFileResp = await fetch(botUrl(token, 'getFile'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!getFileResp.ok) return null;

  const getFileResult = (await getFileResp.json()) as {
    ok: boolean;
    result?: { file_path?: string };
  };
  const filePath = getFileResult.result?.file_path;
  if (!filePath) return null;

  const fileUrl = `${TG_API}/file/bot${token}/${filePath}`;
  const resp = await fetch(fileUrl);
  if (!resp.ok) return null;

  const buffer = await resp.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return { base64: btoa(binary), filePath };
}

// ─── Forward / Quote Formatting ──────────────────────────────────────────────

function getForwardAttribution(message: Record<string, unknown>): string | null {
  const origin = message.forward_origin as Record<string, unknown> | undefined;
  if (!origin) return null;

  const type = origin.type as string;
  switch (type) {
    case 'user': {
      const user = origin.sender_user as Record<string, unknown> | undefined;
      if (!user) return 'Forwarded message';
      const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
      const username = user.username ? ` (@${user.username})` : '';
      return `Forwarded from ${name}${username}`;
    }
    case 'hidden_user': {
      const name = origin.sender_user_name as string | undefined;
      return name ? `Forwarded from ${name}` : 'Forwarded message';
    }
    case 'chat': {
      const chat = origin.sender_chat as Record<string, unknown> | undefined;
      const title = chat?.title as string | undefined;
      return title ? `Forwarded from ${title}` : 'Forwarded from a group chat';
    }
    case 'channel': {
      const chat = origin.chat as Record<string, unknown> | undefined;
      const title = chat?.title as string | undefined;
      return title ? `Forwarded from ${title}` : 'Forwarded from a channel';
    }
    default:
      return 'Forwarded message';
  }
}

function formatTelegramMessage(text: string, message: Record<string, unknown>): string {
  const attribution = getForwardAttribution(message);
  if (!attribution) return text;

  const quotedLines = text.split('\n').map((line) => `> ${line}`).join('\n');
  return `**${attribution}:**\n${quotedLines}`;
}

function senderName(from: Record<string, unknown> | undefined): string {
  if (!from) return 'Unknown';
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Unknown';
}

// ─── TelegramTransport ──────────────────────────────────────────────────────

export class TelegramTransport implements ChannelTransport {
  readonly channelType = 'telegram';

  verifySignature(): boolean {
    // Telegram uses secret URL path, not request signatures
    return true;
  }

  async parseInbound(
    _rawHeaders: Record<string, string>,
    rawBody: string,
    routing: RoutingMetadata,
  ): Promise<InboundMessage | null> {
    const token = routing.botToken as string | undefined;
    if (!token) return null;

    let update: Record<string, unknown>;
    try {
      update = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return null;
    }

    // Handle message or edited_message
    const message = (update.message ?? update.edited_message) as Record<string, unknown> | undefined;
    if (!message) return null;

    const chat = message.chat as Record<string, unknown> | undefined;
    if (!chat) return null;

    const chatId = String(chat.id);
    const from = message.from as Record<string, unknown> | undefined;
    const senderId = from?.id ? String(from.id) : '';
    const name = senderName(from);

    // Check for text message
    const rawText = message.text as string | undefined;

    // Check for slash command
    if (rawText) {
      const commandMatch = rawText.match(/^\/(\w+)(?:\s+(.*))?$/s);
      if (commandMatch) {
        return {
          channelType: 'telegram',
          channelId: chatId,
          senderId,
          senderName: name,
          text: commandMatch[2]?.trim() || '',
          attachments: [],
          command: commandMatch[1],
          commandArgs: commandMatch[2]?.trim(),
          messageId: message.message_id ? String(message.message_id) : undefined,
        };
      }

      // Regular text message with forward attribution
      const formattedText = formatTelegramMessage(rawText, message);
      return {
        channelType: 'telegram',
        channelId: chatId,
        senderId,
        senderName: name,
        text: formattedText,
        attachments: [],
        messageId: message.message_id ? String(message.message_id) : undefined,
      };
    }

    // Check for photo
    const photo = message.photo as Array<Record<string, unknown>> | undefined;
    if (photo && photo.length > 0) {
      const largest = photo[photo.length - 1];
      const fileId = largest.file_id as string;
      const caption = (message.caption as string) || '';
      const attachments: InboundAttachment[] = [];

      const downloaded = await downloadFileAsBase64(token, fileId);
      if (downloaded) {
        const mime = downloaded.filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
        attachments.push({
          type: 'image',
          url: `data:${mime};base64,${downloaded.base64}`,
          mimeType: mime,
          fileName: downloaded.filePath.split('/').pop(),
        });
      }

      return {
        channelType: 'telegram',
        channelId: chatId,
        senderId,
        senderName: name,
        text: caption || (attachments.length > 0 ? '[Image]' : ''),
        attachments,
        messageId: message.message_id ? String(message.message_id) : undefined,
      };
    }

    // Check for voice
    const voice = message.voice as Record<string, unknown> | undefined;
    if (voice) {
      const fileId = voice.file_id as string;
      const duration = voice.duration as number | undefined;
      const caption = (message.caption as string) || '';
      const attachments: InboundAttachment[] = [];

      const downloaded = await downloadFileAsBase64(token, fileId);
      if (downloaded) {
        attachments.push({
          type: 'audio',
          url: `data:audio/ogg;base64,${downloaded.base64}`,
          mimeType: 'audio/ogg',
          fileName: downloaded.filePath.split('/').pop() || `voice-${Date.now()}.ogg`,
          duration,
        });
      }

      return {
        channelType: 'telegram',
        channelId: chatId,
        senderId,
        senderName: name,
        text: caption || `[Voice note, ${duration ?? 0}s]`,
        attachments,
        messageId: message.message_id ? String(message.message_id) : undefined,
      };
    }

    // Check for audio
    const audio = message.audio as Record<string, unknown> | undefined;
    if (audio) {
      const fileId = audio.file_id as string;
      const duration = audio.duration as number | undefined;
      const mime = (audio.mime_type as string) || 'audio/mpeg';
      const audioFileName = (audio.file_name as string) || undefined;
      const audioTitle = (audio.title as string) || undefined;
      const caption = (message.caption as string) || '';
      const attachments: InboundAttachment[] = [];

      const downloaded = await downloadFileAsBase64(token, fileId);
      if (downloaded) {
        attachments.push({
          type: 'audio',
          url: `data:${mime};base64,${downloaded.base64}`,
          mimeType: mime,
          fileName: audioFileName || downloaded.filePath.split('/').pop() || `audio-${Date.now()}.mp3`,
          duration,
        });
      }

      return {
        channelType: 'telegram',
        channelId: chatId,
        senderId,
        senderName: name,
        text: caption || `[Audio: ${audioTitle || audioFileName || 'untitled'}, ${duration ?? 0}s]`,
        attachments,
        messageId: message.message_id ? String(message.message_id) : undefined,
      };
    }

    // Unsupported message type (sticker, callback_query, etc.)
    return null;
  }

  scopeKeyParts(message: InboundMessage, _userId: string): { channelType: string; channelId: string } {
    return { channelType: 'telegram', channelId: message.channelId };
  }

  formatMarkdown(markdown: string): string {
    return markdownToTelegramHtml(markdown);
  }

  async sendMessage(
    target: ChannelTarget,
    message: OutboundMessage,
    ctx: ChannelContext,
  ): Promise<SendResult> {
    // If there's an image attachment, use sendPhoto
    const imageAttachment = message.attachments?.find((a) => a.type === 'image');
    if (imageAttachment) {
      return this.sendPhoto(target, imageAttachment.url, imageAttachment.mimeType, message.markdown || message.text, ctx);
    }

    // Send text message
    const text = message.markdown || message.text || '';
    const html = this.formatMarkdown(text);
    const resp = await fetch(botUrl(ctx.token, 'sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: target.channelId,
        text: html,
        parse_mode: 'HTML',
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { success: false, error: `Telegram API error ${resp.status}: ${body.slice(0, 200)}` };
    }

    const result = (await resp.json()) as { ok: boolean; result?: { message_id?: number } };
    return {
      success: result.ok,
      messageId: result.result?.message_id ? String(result.result.message_id) : undefined,
    };
  }

  async editMessage(
    target: ChannelTarget,
    messageId: string,
    message: OutboundMessage,
    ctx: ChannelContext,
  ): Promise<SendResult> {
    const text = message.markdown || message.text || '';
    const html = this.formatMarkdown(text);
    const resp = await fetch(botUrl(ctx.token, 'editMessageText'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: target.channelId,
        message_id: Number(messageId),
        text: html,
        parse_mode: 'HTML',
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { success: false, error: `Telegram editMessage error ${resp.status}: ${body.slice(0, 200)}` };
    }

    const result = (await resp.json()) as { ok: boolean; result?: { message_id?: number } };
    return {
      success: result.ok,
      messageId: result.result?.message_id ? String(result.result.message_id) : undefined,
    };
  }

  async deleteMessage(
    target: ChannelTarget,
    messageId: string,
    ctx: ChannelContext,
  ): Promise<boolean> {
    const resp = await fetch(botUrl(ctx.token, 'deleteMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: target.channelId,
        message_id: Number(messageId),
      }),
    });
    if (!resp.ok) return false;
    const result = (await resp.json()) as { ok: boolean };
    return result.ok;
  }

  async sendTypingIndicator(target: ChannelTarget, ctx: ChannelContext): Promise<void> {
    await fetch(botUrl(ctx.token, 'sendChatAction'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: target.channelId,
        action: 'typing',
      }),
    });
  }

  async registerWebhook(webhookUrl: string, ctx: ChannelContext): Promise<boolean> {
    const resp = await fetch(botUrl(ctx.token, 'setWebhook'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    });
    if (!resp.ok) return false;
    const result = (await resp.json()) as { ok: boolean };
    return result.ok;
  }

  async unregisterWebhook(ctx: ChannelContext): Promise<boolean> {
    const resp = await fetch(botUrl(ctx.token, 'deleteWebhook'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!resp.ok) return false;
    const result = (await resp.json()) as { ok: boolean };
    return result.ok;
  }

  // ─── Private Helpers ─────────────────────────────────────────────────

  private async sendPhoto(
    target: ChannelTarget,
    photoUrl: string,
    mimeType: string,
    caption?: string,
    ctx?: ChannelContext,
  ): Promise<SendResult> {
    if (!ctx) return { success: false, error: 'No context provided' };

    // Handle base64 data URLs
    let photoBlob: Blob;
    if (photoUrl.startsWith('data:')) {
      const base64Data = photoUrl.split(',')[1];
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      photoBlob = new Blob([bytes], { type: mimeType });
    } else {
      const resp = await fetch(photoUrl);
      if (!resp.ok) return { success: false, error: 'Failed to fetch photo' };
      photoBlob = await resp.blob();
    }

    const ext = mimeType === 'image/png' ? 'png' : 'jpg';
    const formData = new FormData();
    formData.append('chat_id', target.channelId);
    formData.append('photo', photoBlob, `image.${ext}`);
    if (caption) {
      formData.append('caption', this.formatMarkdown(caption));
      formData.append('parse_mode', 'HTML');
    }

    const resp = await fetch(botUrl(ctx.token, 'sendPhoto'), {
      method: 'POST',
      body: formData,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { success: false, error: `Telegram sendPhoto error ${resp.status}: ${body.slice(0, 200)}` };
    }

    const result = (await resp.json()) as { ok: boolean; result?: { message_id?: number } };
    return {
      success: result.ok,
      messageId: result.result?.message_id ? String(result.result.message_id) : undefined,
    };
  }
}

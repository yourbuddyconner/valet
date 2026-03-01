import { describe, it, expect } from 'vitest';
import type {
  ChannelTransport,
  ChannelPackage,
  InboundMessage,
  OutboundMessage,
  ChannelTarget,
  ChannelContext,
  SendResult,
  InboundAttachment,
  OutboundAttachment,
  RoutingMetadata,
  IntegrationProvider,
} from './index.js';

describe('channel-sdk type contracts', () => {
  it('InboundMessage shape is structurally sound', () => {
    const msg: InboundMessage = {
      channelType: 'test',
      channelId: 'ch-1',
      senderId: 'user-1',
      senderName: 'Alice',
      text: 'hello',
      attachments: [],
    };
    expect(msg.channelType).toBe('test');
    expect(msg.attachments).toHaveLength(0);
  });

  it('InboundMessage supports optional fields', () => {
    const msg: InboundMessage = {
      channelType: 'test',
      channelId: 'ch-1',
      senderId: 'user-1',
      senderName: 'Alice',
      text: '/help',
      attachments: [],
      command: 'help',
      commandArgs: '',
      messageId: 'msg-123',
      metadata: { raw: true },
    };
    expect(msg.command).toBe('help');
    expect(msg.messageId).toBe('msg-123');
  });

  it('InboundAttachment covers all types', () => {
    const image: InboundAttachment = { type: 'image', url: 'data:image/png;base64,...', mimeType: 'image/png' };
    const audio: InboundAttachment = { type: 'audio', url: 'data:audio/ogg;base64,...', mimeType: 'audio/ogg', duration: 5 };
    const video: InboundAttachment = { type: 'video', url: 'https://example.com/v.mp4', mimeType: 'video/mp4', size: 1024 };
    const file: InboundAttachment = { type: 'file', url: 'https://example.com/f.pdf', mimeType: 'application/pdf', fileName: 'doc.pdf' };

    expect(image.type).toBe('image');
    expect(audio.duration).toBe(5);
    expect(video.size).toBe(1024);
    expect(file.fileName).toBe('doc.pdf');
  });

  it('OutboundMessage supports markdown and attachments', () => {
    const msg: OutboundMessage = {
      markdown: '**bold**',
      attachments: [
        { type: 'image', url: 'https://example.com/img.png', mimeType: 'image/png', caption: 'A picture' },
      ],
      replyToMessageId: 'msg-1',
    };
    expect(msg.markdown).toBe('**bold**');
    expect(msg.attachments).toHaveLength(1);
  });

  it('SendResult represents success and failure', () => {
    const ok: SendResult = { success: true, messageId: '42' };
    const err: SendResult = { success: false, error: 'rate limited' };
    expect(ok.success).toBe(true);
    expect(err.error).toBe('rate limited');
  });

  it('ChannelPackage shape includes all required fields', () => {
    const pkg: ChannelPackage = {
      name: '@agent-ops/channel-test',
      version: '1.0.0',
      channelType: 'test',
      createTransport: () => ({
        channelType: 'test',
        verifySignature: () => true,
        parseInbound: async () => null,
        scopeKeyParts: () => ({ channelType: 'test', channelId: '' }),
        formatMarkdown: (md) => md,
        sendMessage: async () => ({ success: true }),
      }),
    };
    expect(pkg.channelType).toBe('test');
    const transport = pkg.createTransport();
    expect(transport.channelType).toBe('test');
  });

  it('ChannelTransport optional methods can be omitted', () => {
    const transport: ChannelTransport = {
      channelType: 'minimal',
      verifySignature: () => true,
      parseInbound: async () => null,
      scopeKeyParts: () => ({ channelType: 'minimal', channelId: '' }),
      formatMarkdown: (md) => md,
      sendMessage: async () => ({ success: true }),
      // editMessage, deleteMessage, sendTypingIndicator, registerWebhook, unregisterWebhook — all omitted
    };
    expect(transport.editMessage).toBeUndefined();
    expect(transport.deleteMessage).toBeUndefined();
    expect(transport.sendTypingIndicator).toBeUndefined();
    expect(transport.registerWebhook).toBeUndefined();
    expect(transport.unregisterWebhook).toBeUndefined();
  });

  it('IntegrationProvider type is usable', () => {
    const provider: IntegrationProvider = {
      service: 'test',
      displayName: 'Test',
      authType: 'api_key',
      supportedEntities: ['items'],
      validateCredentials: () => true,
      testConnection: async () => true,
    };
    expect(provider.authType).toBe('api_key');
    expect(provider.supportedEntities).toEqual(['items']);
  });
});

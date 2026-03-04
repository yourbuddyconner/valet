import { describe, it, expect } from 'vitest';
import telegramChannelPackage, { TelegramTransport, telegramProvider, markdownToTelegramHtml } from './index.js';

describe('channel-telegram package', () => {
  it('exports default ChannelPackage with correct metadata', () => {
    expect(telegramChannelPackage.name).toBe('@valet/channel-telegram');
    expect(telegramChannelPackage.version).toBe('0.0.1');
    expect(telegramChannelPackage.channelType).toBe('telegram');
  });

  it('createTransport returns a TelegramTransport instance', () => {
    const transport = telegramChannelPackage.createTransport();
    expect(transport).toBeInstanceOf(TelegramTransport);
    expect(transport.channelType).toBe('telegram');
  });

  it('includes the integration provider', () => {
    expect(telegramChannelPackage.provider).toBeDefined();
    expect(telegramChannelPackage.provider!.service).toBe('telegram');
    expect(telegramChannelPackage.provider!.displayName).toBe('Telegram');
    expect(telegramChannelPackage.provider!.authType).toBe('bot_token');
  });

  it('exports telegramProvider directly', () => {
    expect(telegramProvider.service).toBe('telegram');
  });

  it('exports markdownToTelegramHtml', () => {
    expect(typeof markdownToTelegramHtml).toBe('function');
    expect(markdownToTelegramHtml('**test**')).toBe('<b>test</b>');
  });
});

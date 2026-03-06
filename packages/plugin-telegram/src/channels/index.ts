import type { ChannelPackage } from '@valet/sdk';
import { TelegramTransport } from './transport.js';
import { telegramProvider } from './provider.js';

export { TelegramTransport } from './transport.js';
export { telegramProvider } from './provider.js';
export { markdownToTelegramHtml } from './format.js';

const telegramChannelPackage: ChannelPackage = {
  name: '@valet/channel-telegram',
  version: '0.0.1',
  channelType: 'telegram',
  createTransport: () => new TelegramTransport(),
  provider: telegramProvider,
};

export default telegramChannelPackage;

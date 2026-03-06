import type { ChannelPackage } from '@valet/sdk';
import { SlackTransport } from './transport.js';
import { slackProvider } from './provider.js';

export { SlackTransport } from './transport.js';
export { slackProvider } from './provider.js';
export { markdownToSlackMrkdwn } from './format.js';
export { verifySlackSignature } from './verify.js';

const slackChannelPackage: ChannelPackage = {
  name: '@valet/channel-slack',
  version: '0.0.1',
  channelType: 'slack',
  createTransport: () => new SlackTransport(),
  provider: slackProvider,
};

export default slackChannelPackage;

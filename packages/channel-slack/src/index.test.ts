import { describe, it, expect } from 'vitest';
import slackChannelPackage, { SlackTransport, slackProvider, markdownToSlackMrkdwn, verifySlackSignature } from './index.js';

describe('channel-slack package', () => {
  it('exports default ChannelPackage with correct metadata', () => {
    expect(slackChannelPackage.name).toBe('@valet/channel-slack');
    expect(slackChannelPackage.version).toBe('0.0.1');
    expect(slackChannelPackage.channelType).toBe('slack');
  });

  it('createTransport returns a SlackTransport instance', () => {
    const transport = slackChannelPackage.createTransport();
    expect(transport).toBeInstanceOf(SlackTransport);
    expect(transport.channelType).toBe('slack');
  });

  it('includes the integration provider', () => {
    expect(slackChannelPackage.provider).toBeDefined();
    expect(slackChannelPackage.provider!.service).toBe('slack');
    expect(slackChannelPackage.provider!.displayName).toBe('Slack');
    expect(slackChannelPackage.provider!.authType).toBe('oauth2');
  });

  it('exports slackProvider directly', () => {
    expect(slackProvider.service).toBe('slack');
  });

  it('exports markdownToSlackMrkdwn', () => {
    expect(typeof markdownToSlackMrkdwn).toBe('function');
    expect(markdownToSlackMrkdwn('**test**')).toBe('*test*');
  });

  it('exports verifySlackSignature', () => {
    expect(typeof verifySlackSignature).toBe('function');
  });
});

import { describe, it, expect } from 'vitest';
import { ChannelRegistry, channelRegistry } from './registry.js';

describe('ChannelRegistry', () => {
  it('singleton is initialized with telegram', () => {
    const transport = channelRegistry.getTransport('telegram');
    expect(transport).toBeDefined();
    expect(transport!.channelType).toBe('telegram');
  });

  it('returns undefined for unknown channel types', () => {
    expect(channelRegistry.getTransport('discord')).toBeUndefined();
    expect(channelRegistry.getPackage('discord')).toBeUndefined();
  });

  it('getPackage returns the telegram package', () => {
    const pkg = channelRegistry.getPackage('telegram');
    expect(pkg).toBeDefined();
    expect(pkg!.name).toBe('@valet/channel-telegram');
    expect(pkg!.channelType).toBe('telegram');
  });

  it('listChannelTypes includes telegram', () => {
    const types = channelRegistry.listChannelTypes();
    expect(types).toContain('telegram');
  });

  it('constructs fresh instance with init()', () => {
    const registry = new ChannelRegistry();
    expect(registry.listChannelTypes()).toHaveLength(0);

    registry.init();
    expect(registry.listChannelTypes()).toContain('telegram');
    expect(registry.getTransport('telegram')).toBeDefined();
  });

  it('transports from the same registry are the same instance', () => {
    const a = channelRegistry.getTransport('telegram');
    const b = channelRegistry.getTransport('telegram');
    expect(a).toBe(b);
  });
});

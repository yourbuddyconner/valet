import type { ChannelTransport, ChannelPackage } from '@valet/sdk';
import { installedChannels } from './packages.js';

export class ChannelRegistry {
  private transports = new Map<string, ChannelTransport>();
  private packages = new Map<string, ChannelPackage>();

  init(): void {
    for (const pkg of installedChannels) {
      const transport = pkg.createTransport();
      this.transports.set(pkg.channelType, transport);
      this.packages.set(pkg.channelType, pkg);
    }
  }

  getTransport(channelType: string): ChannelTransport | undefined {
    return this.transports.get(channelType);
  }

  getPackage(channelType: string): ChannelPackage | undefined {
    return this.packages.get(channelType);
  }

  listChannelTypes(): string[] {
    return Array.from(this.transports.keys());
  }
}

export const channelRegistry = new ChannelRegistry();
channelRegistry.init();

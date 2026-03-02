import type {
  IntegrationPackage,
  IntegrationProvider,
  ActionSource,
  TriggerSource,
} from '@agent-ops/sdk';
import { installedIntegrations } from './packages.js';

export class IntegrationRegistry {
  private packages = new Map<string, IntegrationPackage>();

  init(): void {
    for (const pkg of installedIntegrations) {
      this.packages.set(pkg.service, pkg);
    }
  }

  getPackage(service: string): IntegrationPackage | undefined {
    return this.packages.get(service);
  }

  getProvider(service: string): IntegrationProvider | undefined {
    return this.packages.get(service)?.provider;
  }

  getActions(service: string): ActionSource | undefined {
    return this.packages.get(service)?.actions;
  }

  getTriggers(service: string): TriggerSource | undefined {
    return this.packages.get(service)?.triggers;
  }

  listServices(): string[] {
    return Array.from(this.packages.keys());
  }

  listPackages(): IntegrationPackage[] {
    return Array.from(this.packages.values());
  }
}

export const integrationRegistry = new IntegrationRegistry();
integrationRegistry.init();

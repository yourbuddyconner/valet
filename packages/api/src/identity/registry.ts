import type { IdentityProvider } from '@valet/sdk/identity';
import { installedIdentityProviders } from './packages.js';

class IdentityProviderRegistry {
  private providers = new Map<string, IdentityProvider>();

  register(provider: IdentityProvider) {
    this.providers.set(provider.id, provider);
  }

  get(id: string): IdentityProvider | undefined {
    return this.providers.get(id);
  }

  list(): IdentityProvider[] {
    return Array.from(this.providers.values());
  }

  listEnabled(): IdentityProvider[] {
    // TODO: filter by org settings once admin config is implemented
    return this.list();
  }
}

export const identityRegistry = new IdentityProviderRegistry();

// Auto-register discovered identity providers
for (const provider of installedIdentityProviders) {
  identityRegistry.register(provider);
}

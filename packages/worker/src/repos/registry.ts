import type { RepoProvider } from '@valet/sdk/repos';
import { installedRepoProviders } from './packages.js';

class RepoProviderRegistry {
  private providers = new Map<string, RepoProvider>();

  register(provider: RepoProvider) {
    this.providers.set(provider.id, provider);
  }

  get(id: string): RepoProvider | undefined {
    return this.providers.get(id);
  }

  /** Return ALL providers whose URL patterns match. */
  resolveAllByUrl(repoUrl: string): RepoProvider[] {
    const matches: RepoProvider[] = [];
    for (const provider of this.providers.values()) {
      if (provider.urlPatterns.some((p) => p.test(repoUrl))) {
        matches.push(provider);
      }
    }
    return matches;
  }

  list(): RepoProvider[] {
    return Array.from(this.providers.values());
  }
}

export const repoProviderRegistry = new RepoProviderRegistry();

/**
 * Derive the shared credential provider name from a provider ID.
 * e.g. 'github-oauth' → 'github', 'github-app' → 'github'
 * TODO: Replace with an explicit `credentialProvider` field on RepoProvider interface.
 */
export function stripProviderSuffix(providerId: string): string {
  return providerId.replace(/-(?:oauth|app)$/, '');
}

// Auto-register discovered repo providers
for (const provider of installedRepoProviders) {
  repoProviderRegistry.register(provider);
}

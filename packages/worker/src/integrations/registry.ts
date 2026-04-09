import type {
  IntegrationPackage,
  IntegrationProvider,
  ActionSource,
  TriggerSource,
} from '@valet/sdk';
import type { Env } from '../env.js';
import type { CredentialResult } from '../services/credentials.js';
import { installedIntegrations } from './packages.js';
import { defaultCredentialResolver } from './resolvers/default.js';
import { slackCredentialResolver } from './resolvers/slack.js';
import { githubCredentialResolver } from './resolvers/github.js';

// ─── Credential Resolver ────────────────────────────────────────────────────

export interface CredentialSourceInfo {
  scope: 'user' | 'org';
  integrationId: string;
  userId: string;
}

export interface CredentialResolverContext {
  params?: Record<string, unknown>;
  credentialSources: CredentialSourceInfo[];
  forceRefresh?: boolean;
  skipScope?: 'user' | 'org';
  /** Pre-fetched accessible owners for GitHub App install (avoids D1 lookup in resolver). */
  accessibleOwners?: string[];
}

/**
 * A credential resolver fetches credentials for a service.
 * Custom resolvers override the default per-user D1 lookup.
 */
export type CredentialResolver = (
  service: string,
  env: Env,
  userId: string,
  context: CredentialResolverContext,
) => Promise<CredentialResult>;

// ─── Registry ───────────────────────────────────────────────────────────────

export class IntegrationRegistry {
  private packages = new Map<string, IntegrationPackage>();
  private credentialResolvers = new Map<string, CredentialResolver>();

  init(): void {
    for (const pkg of installedIntegrations) {
      this.packages.set(pkg.service, pkg);
    }

    // Register custom credential resolvers
    this.credentialResolvers.set('slack', slackCredentialResolver);
    this.credentialResolvers.set('github', githubCredentialResolver);
  }

  // ─── Package Accessors ──────────────────────────────────────────────────

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

  // ─── Credential Resolution ──────────────────────────────────────────────

  registerCredentialResolver(service: string, resolver: CredentialResolver): void {
    this.credentialResolvers.set(service, resolver);
  }

  /**
   * Resolve credentials for a service.
   * Uses a custom resolver if registered, otherwise the default (per-user D1 lookup).
   */
  resolveCredentials(
    service: string,
    env: Env,
    userId: string,
    context: CredentialResolverContext,
  ): Promise<CredentialResult> {
    const resolver = this.credentialResolvers.get(service) ?? defaultCredentialResolver;
    return resolver(service, env, userId, context);
  }
}

export const integrationRegistry = new IntegrationRegistry();
integrationRegistry.init();

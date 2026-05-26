import type {
  IntegrationPackage,
  IntegrationProvider,
  ActionSource,
  TriggerSource,
} from '@valet/sdk';
import { McpActionSource } from '@valet/sdk';
import type { Env } from '../env.js';
import type { CredentialResult } from '../services/credentials.js';
import type { CustomMcpConnectorContext, ResolvedCustomMcpConnector } from '../services/custom-mcp-connectors.js';
import { installedIntegrations } from './packages.js';
import { defaultCredentialResolver } from './resolvers/default.js';
import { slackCredentialResolver } from './resolvers/slack.js';
import { githubCredentialResolver } from './resolvers/github.js';

export type { CustomMcpConnectorContext } from '../services/custom-mcp-connectors.js';

// ─── Credential Resolver ────────────────────────────────────────────────────

export interface CredentialResolverContext {
  params?: Record<string, unknown>;
  forceRefresh?: boolean;
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

  getProvider(service: string, customContext?: CustomMcpConnectorContext): IntegrationProvider | undefined {
    const builtIn = this.packages.get(service)?.provider;
    if (builtIn) return builtIn;

    if (!customContext) return undefined;

    const connector = customContext.connectors.get(service);
    return connector ? buildCustomProvider(connector) : undefined;
  }

  getActions(service: string, customContext?: CustomMcpConnectorContext): ActionSource | undefined {
    const builtIn = this.packages.get(service)?.actions;
    if (builtIn) return builtIn;

    if (!customContext) return undefined;

    const connector = customContext.connectors.get(service);
    if (!connector) return undefined;
    return new McpActionSource({
      mcpUrl: connector.serverUrl,
      serviceName: connector.serviceSlug,
      noAuth: connector.authType !== 'oauth',
      additionalHeaders: connector.additionalHeaders,
      staticAuthHeader: connector.staticAuthHeader,
      fetch: customContext.fetch,
    });
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

  isBuiltinService(service: string): boolean {
    return this.packages.has(service);
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

function buildCustomProvider(connector: ResolvedCustomMcpConnector): IntegrationProvider {
  return {
    service: connector.serviceSlug,
    displayName: connector.displayName,
    authType: mapCustomAuthType(connector.authType),
    supportedEntities: [],
    oauthScopes: connector.oauthScopes?.split(/\s+/).filter(Boolean) ?? undefined,
    mcpServerUrl: connector.serverUrl,
    isCustomConnector: true,
    validateCredentials(credentials) {
      if (connector.authType !== 'oauth') return true;
      return typeof credentials.access_token === 'string' && credentials.access_token.length > 0;
    },
    async testConnection() {
      return true;
    },
  };
}

function mapCustomAuthType(authType: ResolvedCustomMcpConnector['authType']): IntegrationProvider['authType'] {
  if (authType === 'none') return 'none';
  if (authType === 'oauth') return 'oauth2';
  return 'api_key';
}

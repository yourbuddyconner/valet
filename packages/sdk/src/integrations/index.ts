import type { SyncResult, SyncError } from '@agent-ops/shared';
import { z } from 'zod';

// Re-export shared sync types for convenience
export type { SyncResult, SyncError };

// ─── Credentials ─────────────────────────────────────────────────────────────

/** Generic key-value credential store. */
export type IntegrationCredentials = Record<string, string>;

/** OAuth client credentials, resolved by the worker from env vars. */
export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
}

// ─── Risk Level ──────────────────────────────────────────────────────────────

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

// ─── Action Definitions (Zod-based) ──────────────────────────────────────────

/** A single action definition with typed params via Zod. */
export interface ActionDefinition<TParams extends z.ZodType = z.ZodType> {
  id: string;
  name: string;
  description: string;
  riskLevel: RiskLevel;
  params: TParams;
}

/** Context passed to action execution. */
export interface ActionContext {
  credentials: IntegrationCredentials;
  userId: string;
  orgId?: string;
}

/** Result of executing an action. */
export interface ActionResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/** Source of typed actions for a service. */
export interface ActionSource {
  listActions(): ActionDefinition[];
  execute(actionId: string, params: unknown, ctx: ActionContext): Promise<ActionResult>;
}

// ─── Trigger Definitions ─────────────────────────────────────────────────────

/** A parsed webhook event. */
export interface ParsedWebhookEvent {
  eventType: string;
  action?: string;
  payload: unknown;
  deliveryId?: string;
}

/** Source of trigger/webhook handling for a service. */
export interface TriggerSource {
  readonly service: string;
  listEventTypes(): string[];
  verifySignature(rawHeaders: Record<string, string>, rawBody: string, secret: string): Promise<boolean>;
  parseWebhook(rawHeaders: Record<string, string>, rawBody: string): ParsedWebhookEvent;
}

// ─── Integration Provider ────────────────────────────────────────────────────

export interface IntegrationProvider {
  readonly service: string;
  readonly displayName: string;
  readonly authType: 'oauth2' | 'bot_token' | 'api_key';
  readonly supportedEntities: string[];
  readonly oauthScopes?: string[];
  /** Env var names the Worker should read to build OAuthConfig for this provider. */
  readonly oauthEnvKeys?: { clientId: string; clientSecret: string };

  validateCredentials(credentials: IntegrationCredentials): boolean;
  testConnection(credentials: IntegrationCredentials): Promise<boolean>;

  // OAuth methods (optional — only for oauth2 auth type)
  getOAuthUrl?(oauth: OAuthConfig, redirectUri: string, state: string): string;
  exchangeOAuthCode?(oauth: OAuthConfig, code: string, redirectUri: string): Promise<IntegrationCredentials>;
  refreshOAuthTokens?(oauth: OAuthConfig, refreshToken: string): Promise<IntegrationCredentials>;
}

// ─── Sync Definitions ────────────────────────────────────────────────────────

export interface SyncOptions {
  entities?: string[];
  fullSync?: boolean;
  cursor?: string;
}

/** Source of data sync for a service. */
export interface SyncSource {
  sync(credentials: IntegrationCredentials, options: SyncOptions): Promise<SyncResult>;
}

// ─── Integration Package Manifest ────────────────────────────────────────────

/** Complete integration package manifest — the unit of registration. */
export interface IntegrationPackage {
  name: string;
  version: string;
  service: string;
  provider: IntegrationProvider;
  actions?: ActionSource;
  triggers?: TriggerSource;
  sync?: SyncSource;
}

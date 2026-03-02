// Channel transport types (backend contract)
export * from './channels/index.js';

// Integration types (action/trigger/sync contracts)
export * from './integrations/index.js';

// Channel metadata (display info, capabilities — usable by both backend and frontend)
export * from './meta.js';

// MCP client infrastructure (for MCP-backed action sources)
export { McpClient } from './mcp/client.js';
export { McpActionSource } from './mcp/action-source.js';
export type { McpActionSourceOptions } from './mcp/action-source.js';
export type { McpTool, McpToolResult } from './mcp/types.js';

// MCP OAuth (dynamic client registration + PKCE)
export {
  discoverAuthServer,
  registerClient,
  generatePkceChallenge,
  buildAuthorizationUrl,
  exchangeCodePkce,
  refreshTokenPkce,
} from './mcp/oauth.js';
export type { AuthServerMetadata, RegisteredClient, TokenResponse } from './mcp/oauth.js';

// NOTE: React UI components are exported from '@agent-ops/sdk/ui'
// to avoid pulling React into backend bundles.

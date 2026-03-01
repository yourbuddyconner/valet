// Channel transport types (backend contract)
export * from './channels/index.js';

// Integration types (action/trigger/sync contracts)
export * from './integrations/index.js';

// Channel metadata (display info, capabilities — usable by both backend and frontend)
export * from './meta.js';

// NOTE: React UI components are exported from '@agent-ops/sdk/ui'
// to avoid pulling React into backend bundles.

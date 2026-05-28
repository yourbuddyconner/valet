import type { IntegrationPackage } from '@valet/sdk';
import type { IntegrationRegistry } from '../registry.js';
import workflowsPackage from './workflows/index.js';

/**
 * Worker-internal integration packages — they live in the worker so their actions
 * can call worker services directly. Registered by the composition root (index.ts)
 * via registerInternalIntegrations(), NOT by registry.ts (which would create an
 * import cycle: registry → internal → actions → services → registry).
 */
export const internalIntegrations: IntegrationPackage[] = [workflowsPackage];

export function registerInternalIntegrations(registry: IntegrationRegistry): void {
  for (const pkg of internalIntegrations) registry.registerPackage(pkg);
}

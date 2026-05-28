import type { IntegrationPackage } from '@valet/sdk';
import workflowsPackage from './workflows/index.js';

/**
 * Worker-internal integration packages. Unlike plugin packages (which live in
 * packages/plugin-* and are auto-generated into packages.ts), these live inside
 * the worker so their actions can call worker services directly. Registered by
 * IntegrationRegistry.init() alongside installedIntegrations.
 */
export const internalIntegrations: IntegrationPackage[] = [workflowsPackage];

/**
 * Engine-native plugin export. The `githubPlugin: ActionPlugin` is the
 * canonical entry point for the engine's plugin catalog. The provider
 * (OAuth flows) and triggers (webhooks) modules remain separate concerns
 * the engine doesn't currently consume — they continue to live alongside
 * for future integration with the platform adapters.
 */
export { githubPlugin } from "./actions.js";
export { githubProvider } from "./provider.js";
export { githubTriggers } from "./triggers.js";
export { githubFetch } from "./api.js";

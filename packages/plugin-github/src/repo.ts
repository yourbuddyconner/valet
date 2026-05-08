// Re-export both repo providers for plugin discovery.
//
// Both providers serve the same GitHub App — the split is by token type:
//   - github-user (repo-oauth.ts): User-to-server OAuth tokens (8h expiry, auto-refreshed)
//   - github-app  (repo-app.ts):   Installation tokens (1h expiry, minted on-demand)
//
// assembleRepoEnv() in env-assembly.ts selects the provider based on which
// credential is available, preferring user OAuth over installation tokens.
export { githubUserRepoProvider } from './repo-oauth.js';
export { githubAppRepoProvider } from './repo-app.js';

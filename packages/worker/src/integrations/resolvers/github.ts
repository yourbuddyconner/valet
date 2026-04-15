import { eq } from 'drizzle-orm';
import { getCredential } from '../../services/credentials.js';
import { getDb } from '../../lib/drizzle.js';
import type { AppDb } from '../../lib/drizzle.js';
import { getServiceMetadata } from '../../lib/db/service-configs.js';
import {
  getGithubInstallationByLogin,
  listGithubInstallationsByAccountType,
} from '../../lib/db/github-installations.js';
import { loadGitHubApp, getOrMintInstallationToken } from '../../services/github-app.js';
import { users } from '../../lib/schema/users.js';
import type { Env } from '../../env.js';
import type { CredentialResolver } from '../registry.js';
import type { GitHubServiceMetadata } from '../../services/github-config.js';
import type { GithubInstallation } from '../../lib/schema/github-installations.js';

/**
 * GitHub credential resolver — unified App model.
 *
 * Resolution chain:
 * 1. User has a linked GitHub account (stored oauth2 credential)? → return user token
 * 2. Anonymous access allowed (metadata flag)? → if NO, fail with "not connected"
 * 3. If repo `owner` is specified → strict match against `github_installations` by account_login.
 *    No match → FAIL (do NOT fall through to "any installation")
 * 4. If no repo owner specified → use any active org installation (prefer Organization over User)
 * 5. No installation → fail
 *
 * Steps 3-4 mint an installation bot token via getOrMintInstallationToken (D1-cached)
 * and attach user attribution (name + email from the users table).
 */
export const githubCredentialResolver: CredentialResolver = async (
  service,
  env,
  userId,
  context,
) => {
  const { forceRefresh, params } = context;

  // ── Step 1: Try user's personal OAuth token ────────────────────────────
  const userResult = await getCredential(env, 'user', userId, service, { forceRefresh });
  if (userResult.ok) {
    return userResult;
  }

  // ── Step 2: Check if anonymous (app-based) access is allowed ───────────
  const db = getDb(env.DB);
  const meta = await getServiceMetadata<GitHubServiceMetadata>(db, 'github').catch(() => null);
  if (!meta?.allowAnonymousGitHubAccess) {
    return {
      ok: false as const,
      error: {
        service,
        reason: 'not_found' as const,
        message: 'GitHub not connected. Connect your GitHub account in Settings > Integrations.',
      },
    };
  }

  const owner = params?.owner as string | undefined;

  // ── Step 3: Owner specified → strict match ─────────────────────────────
  if (owner) {
    const installation = await getGithubInstallationByLogin(db, owner);
    if (!installation) {
      return {
        ok: false as const,
        error: {
          service,
          reason: 'not_found' as const,
          message: `No GitHub installation available for owner ${owner}`,
        },
      };
    }
    return mintBotCredential(env, db, userId, installation);
  }

  // ── Step 4: No owner → use any active installation (prefer Org) ────────
  const orgInstalls = await listGithubInstallationsByAccountType(db, 'Organization');
  if (orgInstalls.length > 0) {
    return mintBotCredential(env, db, userId, orgInstalls[0]);
  }

  const userInstalls = await listGithubInstallationsByAccountType(db, 'User');
  if (userInstalls.length > 0) {
    return mintBotCredential(env, db, userId, userInstalls[0]);
  }

  // ── Step 5: No installation → fail ─────────────────────────────────────
  return {
    ok: false as const,
    error: {
      service,
      reason: 'not_found' as const,
      message: 'No GitHub installation available',
    },
  };
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function mintBotCredential(
  env: Env,
  db: AppDb,
  userId: string,
  installation: GithubInstallation,
) {
  const app = await loadGitHubApp(env, db);
  if (!app) {
    return {
      ok: false as const,
      error: {
        service: 'github',
        reason: 'not_found' as const,
        message: 'GitHub App is not configured. Ask an admin to set up the GitHub App in Settings.',
      },
    };
  }

  const { token, expiresAt } = await getOrMintInstallationToken(
    app,
    db,
    env.ENCRYPTION_KEY,
    {
      id: installation.id,
      githubInstallationId: installation.githubInstallationId,
      cachedTokenEncrypted: installation.cachedTokenEncrypted,
      cachedTokenExpiresAt: installation.cachedTokenExpiresAt,
    },
  );

  // Fetch user record for attribution
  const user = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .get();

  const attribution = user
    ? { name: user.name || user.email, email: user.email }
    : undefined;

  return {
    ok: true as const,
    credential: {
      accessToken: token,
      expiresAt: new Date(expiresAt),
      credentialType: 'app_install' as const,
      refreshed: false,
      attribution,
    },
  };
}

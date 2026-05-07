import type { App, Octokit } from 'octokit';
import { eq } from 'drizzle-orm';
import type { AppDb } from '../lib/drizzle.js';
import { users } from '../lib/schema/users.js';
import {
  upsertGithubInstallation,
  updateGithubInstallationStatus,
} from '../lib/db/github-installations.js';

// ── Types ─────────────────────────────────────────────────────────────────

export interface InstallationWebhookPayload {
  action: 'created' | 'deleted' | 'suspend' | 'unsuspend';
  installation: {
    id: number;
    account: { login: string; id: number; type: 'Organization' | 'User' };
    repository_selection: 'all' | 'selected';
    permissions: Record<string, unknown>;
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────

/**
 * Given a GitHub account id (numeric), find the matching valet user id
 * by looking up users.github_id. Returns null if no match.
 */
async function findUserByGithubAccountId(
  db: AppDb,
  githubAccountId: number,
): Promise<string | null> {
  const row = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.githubId, String(githubAccountId)))
    .get();

  return row?.id ?? null;
}

// ── refreshAllInstallations ───────────────────────────────────────────────

/**
 * Paginate `GET /app/installations` and upsert every installation into D1.
 * For personal (User-type) installs, auto-link by matching `account.id`
 * to `users.github_id`.
 */
export async function refreshAllInstallations(
  app: App,
  db: AppDb,
): Promise<{ count: number }> {
  const installations = await app.octokit.paginate('GET /app/installations', {
    per_page: 100,
  });

  let count = 0;

  for (const install of installations) {
    const account = install.account as {
      login: string;
      id: number;
      type: 'Organization' | 'User';
    };

    let linkedUserId: string | null = null;

    if (account.type === 'User') {
      linkedUserId = await findUserByGithubAccountId(db, account.id);
    }

    await upsertGithubInstallation(db, {
      githubInstallationId: String(install.id),
      accountLogin: account.login,
      accountId: String(account.id),
      accountType: account.type,
      repositorySelection: install.repository_selection as 'all' | 'selected',
      permissions: install.permissions as Record<string, unknown> | undefined,
      linkedUserId,
    });

    count++;
  }

  return { count };
}

// ── reconcileUserInstallations ────────────────────────────────────────────

/**
 * Paginate `GET /user/installations` for a user-authenticated Octokit and link
 * any personal installations whose `account.id` matches `expectedGithubUserId`.
 * Only updates installations not already linked.
 */
export async function reconcileUserInstallations(
  userOctokit: Octokit,
  db: AppDb,
  valetUserId: string,
  expectedGithubUserId: string,
): Promise<{ linked: number }> {
  const installations = await userOctokit.paginate('GET /user/installations', {
    per_page: 100,
  });

  let linked = 0;

  for (const install of installations) {
    const account = install.account as {
      login: string;
      id: number;
      type: 'Organization' | 'User';
    };

    // Only link personal installs that match the expected GitHub user
    if (account.type !== 'User' || String(account.id) !== expectedGithubUserId) {
      continue;
    }

    // Upsert the installation row — it may not exist yet if the webhook hasn't
    // fired or refreshAllInstallations hasn't been run. We have all the data
    // from the API response, so create/update the row AND set linkedUserId.
    await upsertGithubInstallation(db, {
      githubInstallationId: String(install.id),
      accountLogin: account.login,
      accountId: String(account.id),
      accountType: 'User',
      repositorySelection: (install.repository_selection ?? 'all') as 'all' | 'selected',
      permissions: (install.permissions ?? {}) as Record<string, unknown>,
      linkedUserId: valetUserId,
    });
    linked++;
  }

  return { linked };
}

// ── handleInstallationWebhook ─────────────────────────────────────────────

/**
 * Handle GitHub App installation webhook events: created, deleted,
 * suspend, unsuspend.
 */
export async function handleInstallationWebhook(
  db: AppDb,
  payload: InstallationWebhookPayload,
): Promise<void> {
  const { action, installation } = payload;
  const githubInstallationId = String(installation.id);

  switch (action) {
    case 'created': {
      let linkedUserId: string | null = null;

      if (installation.account.type === 'User') {
        linkedUserId = await findUserByGithubAccountId(db, installation.account.id);
      }

      await upsertGithubInstallation(db, {
        githubInstallationId,
        accountLogin: installation.account.login,
        accountId: String(installation.account.id),
        accountType: installation.account.type,
        repositorySelection: installation.repository_selection,
        permissions: installation.permissions,
        linkedUserId,
      });
      break;
    }

    case 'deleted': {
      await updateGithubInstallationStatus(db, githubInstallationId, 'removed');
      break;
    }

    case 'suspend': {
      await updateGithubInstallationStatus(db, githubInstallationId, 'suspended');
      break;
    }

    case 'unsuspend': {
      await updateGithubInstallationStatus(db, githubInstallationId, 'active');
      break;
    }
  }
}

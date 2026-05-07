import type { UserIdentityLink } from '@valet/shared';
import type { Env } from '../env.js';
import * as db from '../lib/db.js';
import { getDb } from '../lib/drizzle.js';

const SLACK_API = 'https://slack.com/api';

// ─── Install Slack App (org-level) ─────────────────────────────────────────

export type InstallSlackResult =
  | { ok: true; install: db.SlackInstallInfo }
  | { ok: false; error: string };

export async function installSlackApp(
  env: Env,
  installedBy: string,
  botToken: string,
  signingSecret?: string,
  teamId?: string,
  teamName?: string,
): Promise<InstallSlackResult> {
  if (!botToken || typeof botToken !== 'string' || !botToken.trim()) {
    return { ok: false, error: 'botToken is required' };
  }

  const trimmedToken = botToken.trim();

  // Validate token via auth.test
  let authResult: {
    ok: boolean;
    team_id?: string;
    team?: string;
    user_id?: string;
    bot_id?: string;
    app_id?: string;
  };
  try {
    const resp = await fetch(`${SLACK_API}/auth.test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${trimmedToken}`,
      },
      body: '{}',
    });
    if (!resp.ok) {
      return { ok: false, error: 'Invalid bot token — could not reach Slack API' };
    }
    authResult = (await resp.json()) as typeof authResult;
    if (!authResult.ok) {
      return { ok: false, error: 'Invalid bot token — Slack API rejected the token' };
    }
  } catch {
    return { ok: false, error: 'Invalid bot token — could not reach Slack API' };
  }

  const resolvedTeamId = teamId || authResult.team_id;
  const resolvedTeamName = teamName || authResult.team;
  const botUserId = authResult.user_id || authResult.bot_id || '';

  if (!resolvedTeamId) {
    return { ok: false, error: 'Could not determine team_id from token' };
  }

  const appDb = getDb(env.DB);

  // Upsert into org_service_configs (encryption handled internally)
  const install = await db.saveOrgSlackInstall(appDb, env.ENCRYPTION_KEY, {
    teamId: resolvedTeamId,
    teamName: resolvedTeamName,
    botUserId,
    appId: authResult.app_id,
    botToken: trimmedToken,
    signingSecret: signingSecret?.trim() || undefined,
    installedBy,
  });

  // Ensure an active org-scoped integration row exists so tools discover Slack.
  // On reinstall the INSERT may fail (unique constraint on userId+service),
  // so always update the existing row to 'active' as a fallback.
  try {
    const integrationId = crypto.randomUUID();
    await db.createIntegration(appDb, {
      id: integrationId,
      userId: installedBy,
      service: 'slack',
      config: { entities: ['channels', 'messages', 'users'] },
      scope: 'org',
    });
    await db.updateIntegrationStatus(appDb, integrationId, 'active');
  } catch {
    // Row already exists — reactivate it
    const existing = (await db.getUserIntegrations(appDb, installedBy))
      .find((i) => i.service === 'slack');
    if (existing && existing.status !== 'active') {
      await db.updateIntegrationStatus(appDb, existing.id, 'active');
    }
  }

  return { ok: true, install };
}

// ─── Install via OAuth ──────────────────────────────────────────────────────

export async function installSlackAppOAuth(
  env: Env,
  installedBy: string,
  code: string,
  redirectUri: string,
): Promise<InstallSlackResult> {
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
    return { ok: false, error: 'Slack OAuth is not configured' };
  }

  let tokenResult: {
    ok: boolean;
    access_token?: string;
    team?: { id?: string; name?: string };
    bot_user_id?: string;
    app_id?: string;
    authed_user?: { id?: string };
    error?: string;
  };

  try {
    const resp = await fetch(`${SLACK_API}/oauth.v2.access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.SLACK_CLIENT_ID,
        client_secret: env.SLACK_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });

    if (!resp.ok) {
      return { ok: false, error: 'Failed to exchange OAuth code' };
    }

    tokenResult = (await resp.json()) as typeof tokenResult;
    if (!tokenResult.ok || !tokenResult.access_token) {
      return { ok: false, error: `OAuth exchange failed: ${tokenResult.error || 'unknown'}` };
    }
  } catch {
    return { ok: false, error: 'Failed to exchange OAuth code' };
  }

  return installSlackApp(
    env,
    installedBy,
    tokenResult.access_token!,
    undefined, // signingSecret not available via OAuth flow
    tokenResult.team?.id,
    tokenResult.team?.name,
  );
}

// ─── Uninstall Slack App ────────────────────────────────────────────────────

export async function uninstallSlackApp(
  env: Env,
  teamId: string,
): Promise<void> {
  const appDb = getDb(env.DB);
  await db.deleteOrgSlackInstall(appDb);
  await db.deleteOrgIntegrationByService(appDb, 'slack');
}

// ─── List Slack Workspace Users ─────────────────────────────────────────────

export interface SlackWorkspaceUser {
  id: string;
  displayName: string;
  realName: string;
  avatar: string | null;
}

export async function listSlackWorkspaceUsers(
  env: Env,
): Promise<SlackWorkspaceUser[]> {
  const appDb = getDb(env.DB);
  const install = await db.getOrgSlackInstallAny(appDb, env.ENCRYPTION_KEY);
  if (!install) {
    return [];
  }

  const botToken = install.botToken;

  let result: {
    ok: boolean;
    members?: Array<{
      id: string;
      name: string;
      real_name?: string;
      deleted?: boolean;
      is_bot?: boolean;
      is_app_user?: boolean;
      profile?: {
        display_name?: string;
        real_name?: string;
        image_48?: string;
      };
    }>;
  };

  try {
    const resp = await fetch(`${SLACK_API}/users.list`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${botToken}`,
      },
      body: '{}',
    });

    if (!resp.ok) return [];
    result = (await resp.json()) as typeof result;
    if (!result.ok || !result.members) return [];
  } catch {
    return [];
  }

  return result.members
    .filter((m) => !m.deleted && !m.is_bot && !m.is_app_user && m.id !== 'USLACKBOT')
    .map((m) => ({
      id: m.id,
      displayName: m.profile?.display_name || m.name,
      realName: m.profile?.real_name || m.real_name || m.name,
      avatar: m.profile?.image_48 || null,
    }));
}

// ─── Slack User Info (single user lookup) ─────────────────────────────────

export interface SlackUserProfile {
  displayName: string;
  realName: string;
  avatar: string | null;
}

export async function getSlackUserInfo(
  botToken: string,
  slackUserId: string,
): Promise<SlackUserProfile | null> {
  try {
    const resp = await fetch(`${SLACK_API}/users.info?user=${encodeURIComponent(slackUserId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${botToken}`,
      },
    });

    if (!resp.ok) {
      console.log(`[Slack] users.info HTTP error: status=${resp.status} user=${slackUserId}`);
      return null;
    }

    const result = (await resp.json()) as {
      ok: boolean;
      error?: string;
      user?: {
        name?: string;
        real_name?: string;
        profile?: {
          display_name?: string;
          real_name?: string;
          image_48?: string;
        };
      };
    };

    if (!result.ok || !result.user) {
      console.log(`[Slack] users.info API error: ok=${result.ok} error=${result.error} user=${slackUserId}`);
      return null;
    }

    const u = result.user;
    const profile: SlackUserProfile = {
      displayName: u.profile?.display_name || u.name || slackUserId,
      realName: u.profile?.real_name || u.real_name || u.name || slackUserId,
      avatar: u.profile?.image_48 || null,
    };
    console.log(`[Slack] users.info resolved: user=${slackUserId} displayName=${profile.displayName} realName=${profile.realName}`);
    return profile;
  } catch (err) {
    console.error(`[Slack] users.info fetch error: user=${slackUserId}`, err);
    return null;
  }
}

// ─── Bot Info (via bots.info) ────────────────────────────────────────────────

export interface SlackBotInfo {
  id: string;
  name: string;
  userId?: string;
  icons?: { image_36?: string; image_48?: string; image_72?: string };
}

/**
 * Get bot metadata via bots.info. Requires the B-prefixed bot ID.
 * Falls back to auth.test to discover the bot_id if not provided.
 */
export async function getSlackBotInfo(
  botToken: string,
  botId?: string,
): Promise<SlackBotInfo | null> {
  try {
    // If no B-prefixed bot ID, discover it via auth.test
    let resolvedBotId = botId;
    if (!resolvedBotId) {
      const authResp = await fetch(`${SLACK_API}/auth.test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${botToken}`,
        },
        body: '{}',
      });
      if (!authResp.ok) return null;
      const authResult = (await authResp.json()) as { ok: boolean; bot_id?: string };
      if (!authResult.ok || !authResult.bot_id) return null;
      resolvedBotId = authResult.bot_id;
    }

    const resp = await fetch(`${SLACK_API}/bots.info?bot=${encodeURIComponent(resolvedBotId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${botToken}` },
    });
    if (!resp.ok) return null;

    const result = (await resp.json()) as {
      ok: boolean;
      error?: string;
      bot?: {
        id: string;
        name?: string;
        user_id?: string;
        icons?: { image_36?: string; image_48?: string; image_72?: string };
      };
    };

    if (!result.ok || !result.bot) {
      console.log(`[Slack] bots.info error: ok=${result.ok} error=${result.error} botId=${resolvedBotId}`);
      return null;
    }

    return {
      id: result.bot.id,
      name: result.bot.name || resolvedBotId,
      userId: result.bot.user_id,
      icons: result.bot.icons,
    };
  } catch (err) {
    console.error(`[Slack] bots.info fetch error:`, err);
    return null;
  }
}

// ─── Org-level Bot Token Resolution ─────────────────────────────────────────

export async function getSlackBotToken(env: Env): Promise<string | null> {
  const appDb = getDb(env.DB);
  const install = await db.getOrgSlackInstallAny(appDb, env.ENCRYPTION_KEY);
  if (!install) return null;
  return install.botToken;
}

// ─── Initiate Slack Link ────────────────────────────────────────────────────

export interface InitiateSlackLinkResult {
  slackUserId: string;
  expiresAt: string;
}

export async function initiateSlackLink(
  env: Env,
  userId: string,
  slackUserId: string,
  slackDisplayName?: string,
): Promise<InitiateSlackLinkResult> {
  const appDb = getDb(env.DB);
  const install = await db.getOrgSlackInstallAny(appDb, env.ENCRYPTION_KEY);
  if (!install) {
    throw new Error('Slack is not installed for this organization');
  }

  const botToken = install.botToken;

  // Generate 6-character alphanumeric code (uppercase + digits)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 to avoid confusion
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const code = Array.from(bytes).map((b) => chars[b % chars.length]).join('');

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

  // Delete any existing pending verification for this user
  const existing = await db.getSlackLinkVerification(appDb, userId);
  if (existing) {
    await db.deleteSlackLinkVerification(appDb, existing.id);
  }

  // Insert new verification
  await db.createSlackLinkVerification(appDb, {
    id: crypto.randomUUID(),
    userId,
    slackUserId,
    slackDisplayName,
    code,
    expiresAt,
  });

  // Open DM channel with the Slack user
  let dmChannelId: string;
  try {
    const openResp = await fetch(`${SLACK_API}/conversations.open`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({ users: slackUserId }),
    });
    const openResult = (await openResp.json()) as {
      ok: boolean;
      channel?: { id: string };
    };
    if (!openResult.ok || !openResult.channel?.id) {
      throw new Error('Could not open DM with Slack user');
    }
    dmChannelId = openResult.channel.id;
  } catch (err) {
    throw new Error(`Failed to open DM with Slack user: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  // Send verification code via DM
  try {
    await fetch(`${SLACK_API}/chat.postMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({
        channel: dmChannelId,
        text: `Your Valet verification code is: *${code}*. Paste this in Valet to link your account. Expires in 10 minutes.`,
      }),
    });
  } catch {
    // Non-fatal: verification row is created, user can still verify
  }

  return { slackUserId, expiresAt };
}

// ─── Verify Slack Link ──────────────────────────────────────────────────────

export async function verifySlackLink(
  env: Env,
  userId: string,
  code: string,
): Promise<{ ok: true; identityLink: UserIdentityLink } | { ok: false; error: string }> {
  const appDb = getDb(env.DB);

  const verification = await db.getSlackLinkVerification(appDb, userId);
  if (!verification) {
    return { ok: false, error: 'No pending verification found or it has expired' };
  }

  if (verification.code !== code.toUpperCase().trim()) {
    return { ok: false, error: 'Invalid verification code' };
  }

  // Create identity link
  const identityLink = await db.createIdentityLink(appDb, {
    id: crypto.randomUUID(),
    userId,
    provider: 'slack',
    externalId: verification.slackUserId,
    externalName: verification.slackDisplayName || undefined,
  });

  // Clean up verification
  await db.deleteSlackLinkVerification(appDb, verification.id);

  return { ok: true, identityLink };
}

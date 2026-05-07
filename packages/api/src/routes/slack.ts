import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { adminMiddleware } from '../middleware/admin.js';
import * as db from '../lib/db.js';
import * as slackService from '../services/slack.js';

// ─── Admin Router (mounted at /api/admin/slack) ────────────────────────────

export const slackAdminRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

slackAdminRouter.use('*', adminMiddleware);

/**
 * POST /api/admin/slack — Install Slack app
 * Body: { botToken: string } or { code: string, redirectUri: string }
 */
slackAdminRouter.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{
    botToken?: string;
    signingSecret?: string;
    code?: string;
    redirectUri?: string;
  }>();

  let result: slackService.InstallSlackResult;

  if (body.code && body.redirectUri) {
    result = await slackService.installSlackAppOAuth(
      c.env, user.id, body.code, body.redirectUri,
    );
  } else if (body.botToken) {
    result = await slackService.installSlackApp(
      c.env, user.id, body.botToken, body.signingSecret,
    );
  } else {
    return c.json({ error: 'Either botToken or code+redirectUri is required' }, 400);
  }

  if (!result.ok) {
    return c.json({ error: result.error }, 400);
  }

  return c.json({
    install: {
      teamId: result.install.teamId,
      teamName: result.install.teamName,
      botUserId: result.install.botUserId,
      appId: result.install.appId,
      installedBy: result.install.configuredBy,
      createdAt: result.install.createdAt,
    },
  });
});

/**
 * GET /api/admin/slack — Get install status
 */
slackAdminRouter.get('/', async (c) => {
  const install = await db.getOrgSlackInstallAny(c.get('db'), c.env.ENCRYPTION_KEY);
  if (!install) {
    return c.json({ installed: false });
  }

  return c.json({
    installed: true,
    teamId: install.teamId,
    teamName: install.teamName,
    botUserId: install.botUserId,
    appId: install.appId,
    hasSigningSecret: !!install.signingSecret,
    installedBy: install.configuredBy,
    createdAt: install.createdAt,
  });
});

/**
 * DELETE /api/admin/slack — Uninstall Slack app
 */
slackAdminRouter.delete('/', async (c) => {
  const install = await db.getOrgSlackInstallAny(c.get('db'), c.env.ENCRYPTION_KEY);
  if (!install) {
    return c.json({ error: 'Slack is not installed' }, 404);
  }

  await slackService.uninstallSlackApp(c.env, install.teamId);
  return c.json({ success: true });
});

// ─── User Router (mounted at /api/me/slack) ────────────────────────────────

export const slackUserRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /api/me/slack — Get user's link status + install info
 */
slackUserRouter.get('/', async (c) => {
  const user = c.get('user');
  const appDb = c.get('db');

  const install = await db.getOrgSlackInstallAny(appDb, c.env.ENCRYPTION_KEY);
  const identityLinks = await db.getUserIdentityLinks(appDb, user.id);
  const slackLink = identityLinks.find((l) => l.provider === 'slack');

  return c.json({
    installed: !!install,
    teamName: install?.teamName || null,
    linked: !!slackLink,
    slackUserId: slackLink?.externalId || null,
    slackDisplayName: slackLink?.externalName || null,
  });
});

/**
 * GET /api/me/slack/users — List Slack workspace members for typeahead
 */
slackUserRouter.get('/users', async (c) => {
  const install = await db.getOrgSlackInstallAny(c.get('db'), c.env.ENCRYPTION_KEY);
  if (!install) {
    return c.json({ error: 'Slack is not installed for this organization' }, 400);
  }

  const users = await slackService.listSlackWorkspaceUsers(c.env);
  return c.json({ users });
});

/**
 * POST /api/me/slack/link — Initiate identity link
 * Body: { slackUserId: "U..." }
 */
slackUserRouter.post('/link', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ slackUserId: string; slackDisplayName?: string }>();

  if (!body.slackUserId || !body.slackUserId.startsWith('U')) {
    return c.json({ error: 'Invalid slackUserId' }, 400);
  }

  try {
    const result = await slackService.initiateSlackLink(
      c.env, user.id, body.slackUserId, body.slackDisplayName,
    );
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to initiate link' }, 400);
  }
});

/**
 * POST /api/me/slack/verify — Complete identity link
 * Body: { code: "AX7K2M" }
 */
slackUserRouter.post('/verify', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ code: string }>();

  if (!body.code || body.code.length !== 6) {
    return c.json({ error: 'Invalid verification code' }, 400);
  }

  const result = await slackService.verifySlackLink(c.env, user.id, body.code);
  if (!result.ok) {
    return c.json({ error: result.error }, 400);
  }

  return c.json({ identityLink: result.identityLink });
});

/**
 * DELETE /api/me/slack/link — Unlink Slack identity
 */
slackUserRouter.delete('/link', async (c) => {
  const user = c.get('user');
  const appDb = c.get('db');

  const identityLinks = await db.getUserIdentityLinks(appDb, user.id);
  const slackLink = identityLinks.find((l) => l.provider === 'slack');

  if (!slackLink) {
    return c.json({ error: 'No Slack identity link found' }, 404);
  }

  await db.deleteIdentityLink(appDb, slackLink.id, user.id);
  return c.json({ success: true });
});

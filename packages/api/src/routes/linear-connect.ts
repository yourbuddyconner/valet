/**
 * `/api/org/linear` — org-level Linear workspace connection (event-system
 * plan, Task 9). Mirrors the `github-app.ts` admin routes + the
 * `github-connect.ts` OAuth-callback shape: an org admin authorizes Valet
 * against a Linear workspace (`actor=app`), the callback exchanges the code,
 * auto-creates a workspace webhook pointed at the generic event ingress
 * (`/webhooks/events/linear`, `routes/event-webhooks.ts`), stores the org
 * `linear` credential (with the webhook signing secret in `metadata` —
 * exactly where the ingest route reads it from), and upserts
 * `linear_installations` (the `workspaceId -> orgId` mapping the ingest
 * route resolves against).
 *
 * Organization admins store app credentials in the encrypted credential store.
 * Deployment environment credentials remain a fallback for existing installs.
 * OAuth state binds the signed-in user, organization, and app client ID.
 *
 * Every route (callback included — the admin's own browser lands there with
 * their session cookie, same model as `github-connect.ts`'s callback) is
 * behind `requireOrgAdmin`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import { requireOrgAdmin } from "./_org-admin.js";
import { publicUrlFromEnv } from "../channels/host.js";
import { decryptSecret, deriveSecretKey } from "../lib/secret-crypto.js";
import { isRecord, signState, verifyState, STATE_TTL_MS } from "../lib/oauth-state.js";
import { resolveReturnOrigin } from "./credential-connect.js";
import { createLinearService, resolveLinearOauthUrl, type LinearService } from "../services/linear.js";
import { loadLinearAppConfig, LINEAR_APP_SERVICE } from "../services/linear-app.js";
import { getLinearIngressStatus } from "../services/linear-ingress.js";
import { replaceCredential } from "../services/credential-insert.js";
import { credentials, orgs, linearInstallations } from "../schema/index.js";

export const linearConnectRouter = new Hono<AppEnv>();

const LINEAR_CREDENTIAL_SERVICE = "linear";
const OAUTH_SCOPES = "read,write,admin";

interface ConnectState {
  userId: string;
  orgId: string;
  nonce: string;
  exp: number;
  /** Origin to return the browser to. Captured at mint time, because the
   * callback's referer is the provider. Empty when same-origin, which is
   * the deployed shape. */
  returnTo?: string;
  clientId?: string;
}

function verifyConnectState(state: string, key: Buffer, nowMs: number): ConnectState | null {
  return verifyState<ConnectState>(state, key, (payload) => {
    if (!isRecord(payload)) return null;
    const { userId, orgId, nonce, exp, returnTo } = payload;
    if (typeof userId !== "string" || typeof orgId !== "string") return null;
    if (typeof nonce !== "string" || typeof exp !== "number") return null;
    if (exp < nowMs) return null;
    return { userId, orgId, nonce, exp, clientId: typeof payload.clientId === "string" ? payload.clientId : undefined, returnTo: typeof returnTo === "string" ? returnTo : "" };
  });
}

interface OauthAppConfig {
  clientId: string;
  clientSecret: string;
}

/** Same fallback `github-app.ts`'s manifest route uses: the configured
 * public URL when there is one, else the request's own origin (local dev /
 * tests, where the API is reached directly). */
function apiBase(c: Context<AppEnv>): string {
  return publicUrlFromEnv(process.env) ?? new URL(c.req.url).origin;
}

function callbackUrl(c: Context<AppEnv>): string {
  return `${apiBase(c)}/api/org/linear/callback`;
}

function linearService(config: OauthAppConfig): LinearService {
  return createLinearService(config, process.env);
}

linearConnectRouter.put("/app", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;
  const body: unknown = await c.req.json().catch(() => null);
  if (!isRecord(body) || typeof body.clientId !== "string" || typeof body.clientSecret !== "string"
    || !body.clientId.trim() || !body.clientSecret.trim() || body.clientId.length > 512 || body.clientSecret.length > 4096) {
    return c.json({ error: "Enter the Linear application's client ID and client secret." }, 400);
  }
  const { clientId, clientSecret } = body;
  const orgId = c.var.user.orgId;
  const { db } = c.var.providers;
  return db.transaction(async (tx) => {
    await tx.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, orgId)).for("update");
    const [install] = await tx.select().from(linearInstallations).where(eq(linearInstallations.orgId, orgId)).limit(1);
    if (install) return c.json({ error: "Disconnect Linear events before changing the application credentials." }, 409);
    await replaceCredential(tx, c.var.providers.encryptionKey, { type: "org", id: orgId }, LINEAR_APP_SERVICE, {
      type: "service_account", apiKey: clientSecret.trim(), metadata: { clientId: clientId.trim() },
    });
    return c.body(null, 204);
  });
});

linearConnectRouter.post("/connect", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const config = await loadLinearAppConfig(c.var.providers.engineCredentials, c.var.user.orgId);
  if (!config) {
    return c.json({ error: "Configure the Linear app in Organization settings > Linear events, or set LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET." }, 503);
  }

  const user = c.var.user;
  const key = deriveSecretKey(c.var.providers.encryptionKey);
  const returnTo = resolveReturnOrigin(c.req.url, c.req.header("referer"), process.env);
  const statePayload: ConnectState = {
    clientId: config.clientId,
    userId: user.id,
    orgId: user.orgId,
    nonce: randomBytes(16).toString("hex"),
    exp: Date.now() + STATE_TTL_MS,
    ...(returnTo ? { returnTo } : {}),
  };
  const state = signState(statePayload, key);

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: callbackUrl(c),
    response_type: "code",
    scope: OAUTH_SCOPES,
    state,
    actor: "app",
  });
  const url = `${resolveLinearOauthUrl(process.env)}/oauth/authorize?${params.toString()}`;
  return c.json({ url });
});

linearConnectRouter.get("/callback", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.json({ error: "missing code or state" }, 400);

  const config = await loadLinearAppConfig(c.var.providers.engineCredentials, c.var.user.orgId);
  if (!config) {
    return c.json({ error: "Configure the Linear app in Organization settings > Linear events, or set LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET." }, 503);
  }

  const user = c.var.user;
  const { db, encryptionKey } = c.var.providers;
  const key = deriveSecretKey(encryptionKey);
  const verified = verifyConnectState(state, key, Date.now());
  if (!verified) return c.json({ error: "invalid or expired state" }, 400);
  if (verified.orgId !== user.orgId || verified.userId !== user.id) {
    return c.json({ error: "this authorization was not started by the signed-in user" }, 400);
  }

  if (verified.clientId && verified.clientId !== config.clientId) {
    return c.json({ error: "Linear app configuration changed. Start the connection again." }, 409);
  }
  const service = linearService(config);
  let accessToken: string;
  let workspaceId: string;
  let workspaceName: string;
  let webhookId: string;
  const webhookSecret = randomBytes(32).toString("hex");
  try {
    ({ accessToken } = await service.exchangeCode(code, callbackUrl(c)));
    ({ workspaceId, workspaceName } = await service.fetchWorkspace(accessToken));
  } catch (err) {
    console.error("linear connect callback failed:", err);
    return c.json({ error: "failed to complete the Linear connection" }, 502);
  }

  const persisted = await db.transaction(async (tx) => {
    await tx.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, user.orgId)).for("update");
    const [app] = await tx.select().from(credentials).where(and(
      eq(credentials.ownerType, "org"), eq(credentials.ownerId, user.orgId), eq(credentials.service, LINEAR_APP_SERVICE),
    )).limit(1);
    // Recheck after the provider request, under the same lock as app writes.
    const changed = app
      ? config.source !== "organization" || !isRecord(app.metadata) || app.metadata.clientId !== config.clientId
        || !app.apiKeyEnc || decryptSecret(app.apiKeyEnc, key) !== config.clientSecret
      : config.source !== "deployment";
    if (changed) return c.json({ error: "Linear app configuration changed. Start the connection again." }, 409);
  // One workspace per org: the org `linear` credential holds exactly one
  // access token, so a second workspace's install rows would be orphaned the
  // moment the credential is overwritten (its webhook could never be deleted
  // again — the stored token isn't scoped to it). Reject instead of silently
  // wedging; the admin disconnects first.
  const orgInstalls = await tx
    .select()
    .from(linearInstallations)
    .where(eq(linearInstallations.orgId, verified.orgId));
  const foreign = orgInstalls.find((i) => i.workspaceId !== workspaceId);
  if (foreign) {
    return c.json(
      { error: `another Linear workspace (${foreign.workspaceName}) is already connected — disconnect it first` },
      409,
    );
  }
  const existing = orgInstalls.find((i) => i.workspaceId === workspaceId);

  if (existing?.webhookId) {
    // Reconnect: clean up the old webhook so it doesn't keep delivering with
    // a dead secret.
    try {
      await service.deleteWebhook(accessToken, existing.webhookId);
    } catch (err) {
      console.error("linear reconnect: best-effort old webhookDelete failed:", err);
    }
  }

  // Persist the credential (with the signing secret) and the installation
  // row BEFORE creating the webhook: Linear can start delivering the moment
  // `webhookCreate` returns, and a delivery that arrives before the ingress
  // can resolve the install + secret is 204'd and never retried — permanent
  // loss. `webhookId` is patched in after creation succeeds.
  await replaceCredential(tx, encryptionKey, { type: "org", id: verified.orgId }, LINEAR_CREDENTIAL_SERVICE, {
    type: "oauth2",
    accessToken,
    metadata: { webhookSecret, workspaceId },
  });

  const now = Date.now();
  let installId: string;
  if (existing) {
    installId = existing.id;
    await tx
      .update(linearInstallations)
      .set({ workspaceName, webhookId: null, connectedBy: user.id, updatedAt: now })
      .where(and(eq(linearInstallations.id, existing.id), eq(linearInstallations.orgId, user.orgId)));
  } else {
    installId = `lin_${randomUUID()}`;
    await tx.insert(linearInstallations).values({
      id: installId,
      orgId: verified.orgId,
      workspaceId,
      workspaceName,
      webhookId: null,
      connectedBy: user.id,
      createdAt: now,
      updatedAt: now,
    });
  }

  return installId;
  });
  if (persisted instanceof Response) return persisted;
  const installId = persisted;

  try {
    ({ webhookId } = await service.createWebhook(accessToken, {
      url: `${apiBase(c)}/webhooks/events/linear`,
      secret: webhookSecret,
    }));
  } catch (err) {
    // Credential + install row stay (the status route reports
    // webhookConfigured: false); a re-run of the connect flow repairs this.
    console.error("linear connect callback failed:", err);
    return c.json({ error: "failed to complete the Linear connection" }, 502);
  }

  await db
    .update(linearInstallations)
    .set({ webhookId, updatedAt: Date.now() })
    .where(and(eq(linearInstallations.id, installId), eq(linearInstallations.orgId, user.orgId)));

  return c.redirect(`${verified.returnTo ?? ""}/settings/organization/linear?setup=ok`, 302);
});

linearConnectRouter.get("/", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const { db, engineCredentials } = c.var.providers;
  return c.json({ ...await getLinearIngressStatus(db,engineCredentials,c.var.user.orgId), redirectUri: callbackUrl(c) });
});

linearConnectRouter.delete("/", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const orgId = c.var.user.orgId;
  const { db, engineCredentials } = c.var.providers;

  // Best-effort webhook cleanup: a transient Linear failure shouldn't block
  // disconnecting — an orphaned webhook just delivers to an ingress that no
  // longer resolves the workspace (204 no-op). The token is only scoped to
  // the workspace it was minted for (the connect flow enforces one workspace
  // per org, so normally that's every install); a drifted row from another
  // workspace can't be cleaned with this token — log it loudly instead of
  // issuing a call Linear will reject.
  const config = await loadLinearAppConfig(c.var.providers.engineCredentials, c.var.user.orgId);
  const cred = await engineCredentials.get({ type: "org", id: orgId }, LINEAR_CREDENTIAL_SERVICE);
  if (config && cred?.accessToken) {
    const tokenWorkspaceId =
      isRecord(cred.metadata) && typeof cred.metadata.workspaceId === "string" ? cred.metadata.workspaceId : null;
    const installs = await db.select().from(linearInstallations).where(eq(linearInstallations.orgId, orgId));
    const service = linearService(config);
    for (const install of installs) {
      if (!install.webhookId) continue;
      if (tokenWorkspaceId !== null && install.workspaceId !== tokenWorkspaceId) {
        console.error(
          `linear disconnect: webhook ${install.webhookId} in workspace ${install.workspaceId} cannot be deleted ` +
            `with the stored token (scoped to ${tokenWorkspaceId}) — remove it in Linear's settings manually`,
        );
        continue;
      }
      try {
        await service.deleteWebhook(cred.accessToken, install.webhookId);
      } catch (err) {
        console.error("linear disconnect: best-effort webhookDelete failed:", err);
      }
    }
  }

  await db.delete(linearInstallations).where(eq(linearInstallations.orgId, orgId));
  await engineCredentials.delete({ type: "org", id: orgId }, LINEAR_CREDENTIAL_SERVICE);
  return c.body(null, 204);
});

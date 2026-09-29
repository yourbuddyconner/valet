import { deleteTeamCredential } from "../services/team-resource-deletion.js";
/**
 * `/api/credentials` — manual token entry + connection summary for the
 * connect UI (plugin-system-v2 plan Task 15). OAuth connect/callback lives
 * in `routes/credential-connect.ts` (integration-oauth design); this file
 * remains the manual-entry and summary surface for every service,
 * including oauth2-typed credentials once connected. Owner defaults to the
 * authenticated caller's `user:{id}`
 * scope — same `CredentialOwner` shape `plugins/action-invoker.ts` and the
 * engine's `Session.credentialProvider` read at call time. `PUT`'s optional
 * `scope: "org"` body field (and `GET`/`DELETE`'s `?scope=org` query param)
 * maps the owner to `{type:"org", id:user.orgId}` instead — org admins only
 * (`requireOrgAdmin` against `org_members.role`, not `users.role`).
 * This is how an org admin pastes a shared credential (e.g. a Telegram bot
 * token `ChannelHost` resolves at `{type:"org",id}`) rather than a personal
 * one.
 *
 * `GET` never returns secret material — only `type`/`scopes`/`connectedAt`
 * plus a health-relevant whitelist (`expiresAt`, `metadata.login`,
 * `metadata.identityOnly`, `metadata.refreshFailedAt` — see
 * `services/github-tokens.ts`'s "healthy" definition, which these fields
 * mirror; the connect UI's health badges read them). `metadata` itself is
 * NEVER spread wholesale into the summary — only these four named fields,
 * so a future credential type whose `metadata` happens to carry
 * secret-shaped data can't leak through this route by accident. `list()`
 * doesn't carry `type`, so this reads each entry back through `get()` to
 * report it — an N+1 over a small per-user list, traded for not widening
 * the `CredentialStore` port's `list` return shape for one read-only
 * field.
 *
 * `PUT` validates exactly one of `accessToken`/`apiKey` is present —
 * `refreshToken` is additionally accepted, but only for `type: "oauth2"`.
 * The `service` path param isn't validated against any plugin's declared
 * credential services: `CredentialStore` has no notion of "known" services
 * (it's a flat owner+service keyspace), and rejecting unknown services here
 * would just be a static allowlist this route has no other reason to own.
 * `DELETE` is idempotent for the same reason — deleting an unconnected
 * service 200s rather than 404ing.
 *
 * One service is checked before it is stored: `slack` at `scope: "org"`.
 * That credential drives the Slack agent surface, whose misconfigurations
 * are all silent, so the route validates the token and signing secret
 * against Slack and records the workspace identity. See
 * `services/slack-connect.ts`.
 */
import { invalidateWorkflowSources } from "../services/content-sync/invalidation.js";
import { refreshCredentialReadiness } from "../services/credential-readiness.js";
import { Hono, type Context } from "hono";
import { insertCredentialIfAbsent, lockTeamCredentialAuthority, replaceCredential } from "../services/credential-insert.js";
import { and, eq } from "drizzle-orm";
import { fromJsonbColumn } from "@valet/store-postgres";
import { credentialSecret, type CredentialOwner, type StoredCredential } from "@valet/engine";
import type { AppEnv } from "../env.js";
import { requireOrgAdmin } from "./_org-admin.js";
import { requiredScopeError, verifySlackBotToken } from "../services/slack-connect.js";
import { connectModeFor, findCredentialDeclaration } from "../services/integration-availability.js";
import {
  isOnePasswordReference,
  ONEPASSWORD_SERVICE,
  OnePasswordAuthError,
  onePasswordMeta,
} from "../services/onepassword.js";
import { mutateTeamOnePassword } from "../services/team-onepassword-token.js";
import { isDeniedCredentialService } from "../services/credential-resolution.js";
import { mapOnePasswordError } from "./_onepassword-errors.js";
import { canAdministerTeam, canViewTeam, getTeamInOrg, isTeamMember } from "../services/teams.js";
import { deleteDelegationsFrom, listDelegationsFrom } from "../services/credential-delegations.js";
import { GITHUB_CREDENTIAL_SERVICE, checkGithubUserRow } from "../services/github-tokens.js";
import { credentials } from "../schema/index.js";
import { serviceDisplayName } from "../lib/service-display-name.js";
import type {
  CredentialSummary,
  DelegateCredentialRequest,
  DelegateCredentialResponse,
  DeleteCredentialResponse,
  ListCredentialsResponse,
  PutCredentialRequest,
  PutCredentialResponse,
} from "../wire/types.js";

export const credentialsRouter = new Hono<AppEnv>();

const CREDENTIAL_TYPES: PutCredentialRequest["type"][] = ["oauth2", "api_key", "bot_token", "service_account"];

// The row types a reference may carry. `service_account` is the reserved
// 1Password token itself and never a reference.
const ONEPASSWORD_REFERENCE_TYPES: PutCredentialRequest["type"][] = ["api_key", "oauth2", "bot_token"];

type CredentialScope = "user" | "org" | "team";

function parseCredentialScope(raw: string | undefined): CredentialScope {
  if (raw === "org" || raw === "team") return raw;
  return "user";
}

function delegatedFromMeta(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const raw = (metadata as Record<string, unknown>).delegatedFrom;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/** The metadata keys only `POST /:service/delegate` may write. */
const DELEGATION_METADATA_KEYS = ["delegatedFrom", "sourceType"] as const;

function reservedDelegationKey(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  return DELEGATION_METADATA_KEYS.find((key) => key in metadata);
}

function rowHasSecret(stored: StoredCredential): boolean {
  const value = stored.accessToken ?? stored.apiKey;
  return typeof value === "string" && value.length > 0;
}

/** A delegated user reference can use the org token, never a personal or team token. */
function usableByTeamRead(stored: StoredCredential): boolean {
  return onePasswordMeta(stored)?.tokenScope === "org";
}

/**
 * Team / org / user owner for a credential route. A failed team check
 * returns 404, same as the other team surfaces — existence-hiding.
 */
async function resolveCredentialOwner(
  c: Context<AppEnv>,
  scope: CredentialScope,
  teamId: string | undefined,
  access: "read" | "write",
): Promise<CredentialOwner | Response> {
  const user = c.var.user;
  if (scope === "org") {
    const gate = await requireOrgAdmin(c);
    if (gate) return gate;
    return { type: "org", id: user.orgId };
  }
  if (scope === "team") {
    if (!teamId) {
      return c.json({ error: "teamId is required for scope=team. Pass teamId." }, 400);
    }
    const { db } = c.var.providers;
    const team = await getTeamInOrg(db, user.orgId, teamId);
    if (!team) return c.json({ error: "Team not found." }, 404);
    // Reads admit an org admin off the team, the same gate the team roster
    // uses: an admin who can already store the team's credentials must be
    // able to see them.
    const allowed =
      access === "write"
        ? await canAdministerTeam(db, teamId, user.id)
        : await canViewTeam(db, teamId, user.id);
    if (!allowed) return c.json({ error: "Team not found." }, 404);
    return { type: "team", id: teamId };
  }
  return { type: "user", id: user.id };
}

/**
 * A team credential write changes which of the team's mirrored workflows
 * may arm, and no commit lands to make the sync notice. Runs after the
 * write, so the pass reads the credential as it now stands.
 */
async function resyncTeamWorkflows(c: Context<AppEnv>, teamIds: Iterable<string>): Promise<void> {
  for (const teamId of new Set(teamIds)) {
    await c.var.providers.contentSync.resyncTeamWorkflowSources(teamId);
  }
}

function isCredentialKind(type: StoredCredential["type"]): type is PutCredentialRequest["type"] {
  return (CREDENTIAL_TYPES as StoredCredential["type"][]).includes(type);
}

function parseOnePasswordField(
  value: unknown,
): { ok: true; reference: string; tokenScope: "org" | "personal" | "team" } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "onepassword must be an object with reference and tokenScope" };
  }
  const candidate = value as Record<string, unknown>;
  const { reference, tokenScope } = candidate;
  // Use the same reference grammar as the sandbox broker.
  if (typeof reference !== "string" || !isOnePasswordReference(reference)) {
    return { ok: false, error: "onepassword.reference must be an op://vault/item/field reference" };
  }
  if (tokenScope !== "org" && tokenScope !== "personal" && tokenScope !== "team") {
    return { ok: false, error: "onepassword.tokenScope must be org, personal, or team" };
  }
  return { ok: true, reference, tokenScope };
}

/**
 * Checks a Slack bot token against Slack before it is stored, and records
 * the workspace identity the rest of the integration depends on. Every
 * failure this catches is otherwise invisible: a user token posts as a
 * human, and a missing scope only shows up hours later on one API call.
 * Returns the rejection to send, or `undefined` when the token may be
 * saved. Shared by the org and team scopes. A user-scoped Slack credential
 * is a personal token for the action plugin and is not checked.
 */
async function verifySlackCredentialToken(
  c: Context<AppEnv>,
  credential: StoredCredential,
  token: string,
): Promise<Response | undefined> {
  const check = await verifySlackBotToken(token);
  if (!check.ok) return c.json({ error: check.error }, 400);
  const scopeError = requiredScopeError(check.identity.grantedScopes);
  if (scopeError) return c.json({ error: scopeError }, 400);
  credential.metadata = {
    ...credential.metadata,
    // The webhook route answers this workspace and drops every other one.
    // A shared app's signing secret is valid for every workspace that
    // installs the app, so this id is the workspace boundary.
    teamId: check.identity.teamId,
    teamName: check.identity.teamName,
    botUserId: check.identity.botUserId,
    botId: check.identity.botId,
  };
  // Recorded so the setup route can report missing optional scopes without
  // calling Slack again. `undefined` when Slack sent no scope header.
  credential.scopes = check.identity.grantedScopes ?? undefined;
  return undefined;
}

/**
 * The org Slack credential also receives Slack events, so it needs the
 * app's signing secret on top of the token check. A wrong secret only
 * shows up as 401s on an unauthenticated webhook, so it is required here.
 * A team token needs no secret: events route through the org app.
 */
async function verifyOrgSlackCredential(
  c: Context<AppEnv>,
  credential: StoredCredential,
  token: string,
): Promise<Response | undefined> {
  const webhookSecret = credential.metadata?.webhookSecret;
  if (typeof webhookSecret !== "string" || webhookSecret === "") {
    return c.json(
      { error: "Slack needs metadata.webhookSecret. Copy the Signing Secret from Basic Information in your Slack app settings." },
      400,
    );
  }
  return verifySlackCredentialToken(c, credential, token);
}

/** Routes a Slack save to the check its scope needs. */
async function verifySlackCredential(
  c: Context<AppEnv>,
  scope: CredentialScope,
  credential: StoredCredential,
  token: string,
): Promise<Response | undefined> {
  if (scope === "org") return verifyOrgSlackCredential(c, credential, token);
  if (scope === "team") return verifySlackCredentialToken(c, credential, token);
  return undefined;
}

async function toSummary(
  service: string,
  stored: StoredCredential,
  connectedAt: string,
  extra?: { delegatedFrom?: string; referenceBroken?: boolean },
): Promise<CredentialSummary | null> {
  if (!isCredentialKind(stored.type)) return null;
  const metadata = stored.metadata;
  return {
    service,
    type: stored.type,
    scopes: stored.scopes,
    connectedAt,
    expiresAt: stored.expiresAt,
    login: typeof metadata?.login === "string" ? metadata.login : undefined,
    identityOnly: metadata?.identityOnly === true ? true : undefined,
    refreshFailedAt: typeof metadata?.refreshFailedAt === "number" ? metadata.refreshFailedAt : undefined,
    onepasswordRef: onePasswordMeta(stored)?.reference,
    onepasswordTokenScope: onePasswordMeta(stored)?.tokenScope,
    ...extra,
  };
}

credentialsRouter.get("/", async (c) => {
  const { engineCredentials, db } = c.var.providers;
  const scope = parseCredentialScope(c.req.query("scope"));
  const ownerOrErr = await resolveCredentialOwner(c, scope, c.req.query("teamId"), "read");
  if (ownerOrErr instanceof Response) return ownerOrErr;
  const owner = ownerOrErr;

  const listed: CredentialSummary[] = [];
  if (owner.type === "team") {
    // Read the team rows directly. `engineCredentials.get` follows a
    // delegated reference and throws when it is broken — a list must not.
    const rows = await db
      .select()
      .from(credentials)
      .where(and(eq(credentials.ownerType, "team"), eq(credentials.ownerId, owner.id)));
    for (const row of rows) {
      // Reserved token status has its own endpoint; never list token rows
      // as integration credentials.
      if (row.service === ONEPASSWORD_SERVICE) continue;
      if (!isCredentialKind(row.type)) continue;
      const from = delegatedFromMeta(row.metadata);
      let referenceBroken: boolean | undefined;
      if (from) {
        const stillMember = await isTeamMember(db, owner.id, from);
        const source = stillMember ? await engineCredentials.get({ type: "user", id: from }, row.service) : null;
        // A source row with neither a secret nor a reference has nothing
        // to resolve. A personal-scope reference has one the team read
        // cannot use: team reads never consult personal tokens.
        referenceBroken =
          !stillMember || source === null || (!rowHasSecret(source) && !usableByTeamRead(source));
      }
      // The same summary a user row gets, so health fields and the
      // 1Password reference are not lost. Secret columns are left out;
      // `toSummary` never reads them.
      const summary = await toSummary(
        row.service,
        {
          type: row.type,
          expiresAt: row.expiresAt ?? undefined,
          scopes: Array.isArray(row.scopes) ? row.scopes.filter((s): s is string => typeof s === "string") : undefined,
          metadata: fromJsonbColumn<Record<string, unknown>>(row.metadata),
        },
        new Date(row.createdAt).toISOString(),
        { delegatedFrom: from, referenceBroken },
      );
      if (summary) listed.push(summary);
    }
    return c.json({ credentials: listed } satisfies ListCredentialsResponse);
  }

  const items = await engineCredentials.list(owner);
  for (const item of items) {
    const stored = await engineCredentials.get(owner, item.service);
    if (!stored) continue;
    const summary = await toSummary(item.service, stored, item.connectedAt);
    if (summary) listed.push(summary);
  }

  const resp: ListCredentialsResponse = { credentials: listed };
  return c.json(resp);
});

credentialsRouter.put("/:service", async (c) => {
  const { engineCredentials, onePassword, db, plugins } = c.var.providers;
  const user = c.var.user;
  const service = c.req.param("service");
  if (service === "linear_app") return c.json({ error: "Configure the Linear application in Organization settings > Linear events." }, 400);

  let body: PutCredentialRequest;
  try {
    body = (await c.req.json()) as PutCredentialRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const scope = parseCredentialScope(body.scope);
  const ownerOrErr = await resolveCredentialOwner(c, scope, body.teamId, "write");
  if (ownerOrErr instanceof Response) return ownerOrErr;
  const owner = ownerOrErr;
  if (body.createOnly !== undefined && typeof body.createOnly !== "boolean") {
    return c.json({ error: "createOnly must be a boolean. Send true to add a team connection." }, 400);
  }
  if (body.createOnly && (scope !== "team" || body.onepassword)) {
    return c.json({ error: "createOnly supports direct team tokens. Select team scope and enter a token." }, 400);
  }

  // Availability gate (integration-availability design): a user-scope save
  // for a declared service whose deployment/org prerequisite is missing is
  // rejected — the token could never power a working integration. Org-scope
  // saves stay open (an admin's org save IS the configuration step), and
  // services with no declaration stay accepted per the note above.
  if (scope === "user") {
    const declared = findCredentialDeclaration(plugins, service);
    if (declared) {
      const mode = await connectModeFor({
        plugins: plugins,
        decl: declared,
        service,
        orgId: user.orgId,
        credentials: engineCredentials,
        env: process.env,
      });
      if (mode === "unconfigured") {
        return c.json(
          { error: `${serviceDisplayName(service)} is not configured for this organization. An admin can set it up in Settings → Organization.` },
          403,
        );
      }
      // "org": the org credential IS the integration and sessions resolve
      // it by owner escalation, so a personal token adds nothing a member
      // should paste. The personal path, when one exists, is its own
      // declaration (e.g. slack-user OAuth).
      if (mode === "org") {
        return c.json(
          { error: `${serviceDisplayName(service)} is provided by your organization and needs no personal token. An admin manages it in Settings → Organization.` },
          403,
        );
      }
    }
  }

  if (!CREDENTIAL_TYPES.includes(body.type)) {
    return c.json({ error: `type must be one of ${CREDENTIAL_TYPES.join("|")}` }, 400);
  }

  // `metadata.onepassword` is a write-once-by-this-route field: the ONLY
  // place a `{reference, tokenScope}` pair may land in a stored credential's
  // metadata is the validated `body.onepassword` branch below, which runs
  // save-time `resolveReference` + the type/mutual-exclusion checks before
  // persisting it. `host.ts`'s resolver seam keys purely off
  // `onePasswordMeta(stored)` reading `metadata.onepassword` — an
  // unvalidated `metadata.onepassword` smuggled in through the plain path
  // would get live-resolved at read time with none of those guarantees.
  // Reject rather than silently strip, and unconditionally (regardless of
  // whether `body.onepassword` is ALSO present) — a caller sending both is
  // an ambiguous request, not a merge to resolve implicitly.
  if (body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) && "onepassword" in body.metadata) {
    return c.json({ error: "metadata.onepassword is reserved; use the onepassword request field" }, 400);
  }
  // The delegation keys are reserved the same way, on every scope. The
  // team read (`plugins/team-credential-store.ts`) follows
  // `metadata.delegatedFrom` on a secretless team row to that member's
  // personal row, so a PUT carrying it would let a team admin point the
  // team at any member's token without that member's consent. Only the
  // delegate route writes these keys, and it runs as the member sharing.
  const smuggled = reservedDelegationKey(body.metadata);
  if (smuggled) {
    return c.json(
      {
        error:
          `metadata.${smuggled} is reserved. To share a personal credential with a team, ` +
          `POST /api/credentials/${service}/delegate as the member who holds it.`,
      },
      400,
    );
  }

  if (body.onepassword) {
    // Structural validation (reserved service name) takes precedence over
    // every policy check below — a request naming the reserved service is
    // malformed whoever sends it.
    if (service === ONEPASSWORD_SERVICE) {
      return c.json({ error: "onepassword is a reserved service name" }, 400);
    }
    // `github` is resolved through `services/session-github-token.ts` at
    // session-build time (`host.ts`'s `buildCredentialResolver`), which
    // takes the `github`-service branch unconditionally when `githubTokenDeps`
    // + `db` are wired — an onepassword-reference row stored here would be
    // silently ignored, never resolved. Reject at write time instead of
    // shipping a credential nothing reads.
    if (service === "github") {
      return c.json(
        { error: `${serviceDisplayName(service)} credentials cannot be 1Password references; use the GitHub connect flow` },
        400,
      );
    }
    // The services the read path denies outright are read RAW by the code
    // that owns them: an `llm:*` key through `services/model-resolution.ts`,
    // the App private key through `services/github-app.ts`. A reference
    // stored under one of them resolves at save time, replaces the working
    // row, and is then read as a credential with no secret in it — the LLM
    // provider still lists as keyed, and the GitHub App throws on every
    // code path. Refuse the write rather than ship a row nothing resolves.
    if (isDeniedCredentialService(service)) {
      return c.json(
        { error: `${serviceDisplayName(service)} credentials cannot be 1Password references; set them in their own settings page` },
        400,
      );
    }
    const hasInlineSecret =
      (typeof body.accessToken === "string" && body.accessToken.length > 0) ||
      (typeof body.apiKey === "string" && body.apiKey.length > 0);
    if (hasInlineSecret) {
      return c.json({ error: "onepassword reference and inline secret are mutually exclusive" }, 400);
    }
    if (!ONEPASSWORD_REFERENCE_TYPES.includes(body.type)) {
      return c.json({ error: `type must be one of ${ONEPASSWORD_REFERENCE_TYPES.join("|")} for an onepassword reference` }, 400);
    }
    const parsed = parseOnePasswordField(body.onepassword);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    // The row's type decides which field the resolved secret lands in, and the
    // consumer reads one fixed field. A Slack bot token saved as `api_key`
    // verified against Slack and then never started the transport, which
    // reads `accessToken`. The plugin declares the type it consumes; hold the
    // reference to it.
    const declared = findCredentialDeclaration(plugins, service);
    if (declared && declared.type !== body.type) {
      return c.json(
        { error: `${serviceDisplayName(service)} credentials are ${declared.type}. Set type to ${declared.type} for this reference.` },
        400,
      );
    }
    if (parsed.tokenScope === "team" && owner.type !== "team") {
      return c.json({ error: "A team reference requires team ownership. Set scope to team and pass teamId." }, 400);
    }
    if (scope === "org" && parsed.tokenScope === "personal") {
      return c.json(
        { error: "An org-scoped credential cannot use a personal 1Password token. Set tokenScope to org." },
        400,
      );
    }
    // Team reads never borrow a member's personal token.
    if (scope === "team" && parsed.tokenScope === "personal") {
      return c.json(
        {
          error:
            "A team credential cannot use a personal 1Password token. Set tokenScope to org, or store the secret directly.",
        },
        400,
      );
    }
    const { reference, tokenScope } = parsed;
    if (tokenScope === "personal") {
      // Delegated user references can use only org scope, so a personal
      // reference would leave each team with a
      // reference that never resolves. Refuse while shares exist: the
      // caller revokes them on purpose, or stores a reference a team can
      // read.
      const shared = await listDelegationsFrom(db, { userId: user.id, service });
      if (shared.length > 0) {
        const teams = shared.length === 1 ? "1 team" : `${shared.length} teams`;
        return c.json(
          {
            error:
              `${service} is shared with ${teams}, and a team cannot read a personal 1Password reference. ` +
              "Revoke those shares in Integrations first, or set tokenScope to org.",
          },
          400,
        );
      }
    }

    let resolved: string;
    try {
      resolved = await onePassword.resolveReference(tokenScope, { orgId: user.orgId, userId: user.id, teamId: owner.type === "team" ? owner.id : undefined }, reference);
    } catch (err) {
      return mapOnePasswordError(c, err);
    }

    const credential: StoredCredential = {
      type: body.type,
      metadata: { ...body.metadata, onepassword: { reference, tokenScope } },
    };
    // A reference-backed Slack credential drives the same agent surface as
    // a pasted one, so it passes the same check before it is stored.
    if (service === "slack") {
      const rejected = await verifySlackCredential(c, scope, credential, resolved);
      if (rejected) return rejected;
    }
    await engineCredentials.save(owner, service, credential);
    await refreshCredentialReadiness(c.var.providers, owner, service);
    const resp: PutCredentialResponse = { ok: true };
    return c.json(resp);
  }

  if (service === ONEPASSWORD_SERVICE && owner.type === "team") {
    if (body.type !== "service_account" || typeof body.apiKey !== "string" || !body.apiKey.trim() ||
        body.accessToken !== undefined || body.refreshToken !== undefined || body.metadata !== undefined) {
      return c.json({ error: "Send a service_account with apiKey only. Configure vault permissions in 1Password." }, 400);
    }
    const ok = await mutateTeamOnePassword(db, c.var.providers.encryptionKey,
      { orgId: user.orgId, userId: user.id, teamId: owner.id }, { kind: "token", token: body.apiKey.trim() });
    if (!ok) return c.json({ error: "Team not found." }, 404);
    await resyncTeamWorkflows(c, [owner.id]);
    return c.json({ ok: true } satisfies PutCredentialResponse);
  }

  const accessToken = typeof body.accessToken === "string" && body.accessToken.length > 0 ? body.accessToken : undefined;
  const apiKey = typeof body.apiKey === "string" && body.apiKey.length > 0 ? body.apiKey : undefined;
  if (!accessToken && !apiKey) {
    return c.json({ error: "exactly one of accessToken or apiKey is required" }, 400);
  }
  if (accessToken && apiKey) {
    return c.json({ error: "accessToken and apiKey are mutually exclusive" }, 400);
  }
  if (body.refreshToken !== undefined && body.type !== "oauth2") {
    return c.json({ error: "refreshToken is only accepted for type=\"oauth2\"" }, 400);
  }

  const credential: StoredCredential = {
    type: body.type,
    accessToken,
    apiKey,
    refreshToken: body.type === "oauth2" ? body.refreshToken : undefined,
    metadata: body.metadata,
  };

  if (service === "slack") {
    const rejected = await verifySlackCredential(c, scope, credential, accessToken ?? apiKey ?? "");
    if (rejected) return rejected;
  }

  if (owner.type === "team") {
    const outcome = await db.transaction(async (tx) => {
      if (!(await lockTeamCredentialAuthority(tx, { orgId: user.orgId, userId: user.id, teamId: owner.id }))) {
        return "access_changed";
      }
      if (body.createOnly) {
        const inserted = await insertCredentialIfAbsent(tx, c.var.providers.encryptionKey, owner, service, credential);
        if (inserted) await invalidateWorkflowSources(tx, { teamId: owner.id });
        return inserted ? "created" : "exists";
      }
      await replaceCredential(tx, c.var.providers.encryptionKey, owner, service, credential);
      await invalidateWorkflowSources(tx, { teamId: owner.id });
      return "created";
    });
    if (outcome === "access_changed") {
      return c.json({ error: "Team access changed. Ask a team admin to restart the connection." }, 404);
    }
    if (outcome === "exists") {
      return c.json({ error: "This team already has a connection for this service. Ask a team admin to remove it before connecting another account." }, 409);
    }
  } else {
    await engineCredentials.save(owner, service, credential);
  }

  await refreshCredentialReadiness(c.var.providers, owner, service);

  const resp: PutCredentialResponse = { ok: true };
  return c.json(resp);
});

credentialsRouter.post("/:service/delegate", async (c) => {
  const { engineCredentials, db, plugins } = c.var.providers;
  const user = c.var.user;
  const service = c.req.param("service");
  // Every refusal below names the service the way the product does. The
  // route param is an id (`github`), not a name, and reads as neither
  // when it is dropped into a sentence.
  const label = serviceDisplayName(service);
  if (service === ONEPASSWORD_SERVICE) {
    return c.json(
      {
        error:
          "1Password tokens cannot be delegated. Ask a team admin to connect a team service account.",
      },
      400,
    );
  }
  let body: DelegateCredentialRequest;
  try {
    body = (await c.req.json()) as DelegateCredentialRequest;
  } catch {
    return c.json({ error: "invalid JSON body. Send a JSON body with teamId." }, 400);
  }
  if (!body.teamId || typeof body.teamId !== "string") {
    return c.json({ error: "teamId is required. Pass the team to share this credential with." }, 400);
  }
  const team = await getTeamInOrg(db, user.orgId, body.teamId);
  if (!team || !(await isTeamMember(db, body.teamId, user.id))) {
    return c.json({ error: "Team not found." }, 404);
  }
  // An org-provided service (`requires.orgCredential`, Slack today) is
  // never shared from a personal row: that row is one person's identity.
  // A team runs on a verified token stored at team scope (the team PUT
  // checks it the way the org PUT does) or on the org credential. This is
  // decided before the caller's row is read, because connecting one would
  // not change the answer.
  const declared = findCredentialDeclaration(plugins, service);
  if (declared?.requires?.orgCredential) {
    return c.json(
      {
        error:
          `${label} cannot be shared from a personal connection. ` +
          `Store a team ${declared.type.replace("_", " ")} in Settings → Organization → Teams, ` +
          `or use the organization's ${label}.`,
      },
      400,
    );
  }
  // The caller's own credential is checked before the team slot. A caller
  // with nothing to share is told to connect first; the slot answer only
  // matters once there is a credential to share.
  const source = await engineCredentials.get({ type: "user", id: user.id }, service);
  if (!source || (!rowHasSecret(source) && !onePasswordMeta(source))) {
    return c.json(
      { error: `Connect ${label} in Integrations first, then share it with the team.` },
      400,
    );
  }
  // Delegated references must use org scope; a user row cannot select a team token
  // (`resolveTeamCredentialRead`), the same rule the team PUT applies. A
  // reference-only source row with a personal token would leave the team
  // with a reference that never resolves.
  if (!rowHasSecret(source) && onePasswordMeta(source)?.tokenScope === "personal") {
    return c.json(
      {
        error:
          `${label} is stored as a personal 1Password reference, which a team cannot read. ` +
          "Store it again with tokenScope org, or store the secret directly, then share it.",
      },
      400,
    );
  }
  if (!isCredentialKind(source.type)) {
    return c.json(
      { error: `${label} cannot be shared with a team. Ask a team admin to connect ${label} for the team instead.` },
      400,
    );
  }
  // A github row the member's own runs would refuse (identity-only sign-in
  // scopes, a failed refresh, an expired token with no refresh token) is
  // held to the same rule here: the team read follows the reference to
  // this row, so sharing it would hand the team a credential every run
  // rejects. Same predicate the invoker's team branch applies.
  // A 1Password reference cannot be checked without resolving it; the team
  // read resolves it under the org token, so it is admitted as is.
  if (service === GITHUB_CREDENTIAL_SERVICE && onePasswordMeta(source) === null) {
    const health = checkGithubUserRow(
      { accessToken: credentialSecret(source), refreshToken: source.refreshToken, expiresAt: source.expiresAt, metadata: source.metadata },
      Date.now(),
    );
    if (!health.ok) {
      return c.json(
        {
          error:
            `Your GitHub connection cannot be shared: ${health.reason}. ` +
            "Connect GitHub in Settings → Connected accounts, then share it with the team.",
        },
        400,
      );
    }
  }
  // Insert-only. `engineCredentials.save` upserts on the owner+service key,
  // so a list-then-save would let a concurrent delegation, or an admin's
  // direct team PUT, be overwritten with a 201 to both callers. The row
  // shape matches what `PgCredentialStore.save` writes for a reference row
  // with no secret: every secret column NULL, no scopes, no expiry.
  const now = Date.now();
  const inserted = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(credentials)
      .values({
        ownerType: "team",
        ownerId: body.teamId,
        service,
        type: source.type,
        metadata: { delegatedFrom: user.id, sourceType: source.type },
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ service: credentials.service });
    if (rows.length > 0) await invalidateWorkflowSources(tx, { teamId: body.teamId });
    return rows;
  });
  if (inserted.length === 0) {
    // The slot holds either another member's share or a secret the team
    // stores, and the two are removed under different labels ("Stop
    // sharing" and "Disconnect"). This answer cannot tell them apart, so it
    // names the page that shows which one is there rather than a verb that
    // fits only one of them. The web client's own 409 copy
    // (`components/integrations/share-with-team.tsx`) says the same thing.
    return c.json(
      { error: `This team already has ${label}. Ask a team admin to change it in Settings → Organization → Teams.` },
      409,
    );
  }
  await resyncTeamWorkflows(c, [body.teamId]);
  const resp: DelegateCredentialResponse = { ok: true };
  return c.json(resp, 201);
});

credentialsRouter.delete("/:service/delegations/:teamId", async (c) => {
  const { engineCredentials, db } = c.var.providers;
  const user = c.var.user;
  const service = c.req.param("service");
  const teamId = c.req.param("teamId");
  const team = await getTeamInOrg(db, user.orgId, teamId);
  if (!team) return c.json({ error: "Team not found." }, 404);
  const rows = await db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.ownerType, "team"),
        eq(credentials.ownerId, teamId),
        eq(credentials.service, service),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || delegatedFromMeta(row.metadata) !== user.id) {
    return c.json({ error: "Team not found." }, 404);
  }
  await engineCredentials.delete({ type: "team", id: teamId }, service);
  await resyncTeamWorkflows(c, [teamId]);
  const resp: DeleteCredentialResponse = { ok: true };
  return c.json(resp);
});

credentialsRouter.delete("/:service", async (c) => {
  const { engineCredentials, db } = c.var.providers;
  const user = c.var.user;
  const scope = parseCredentialScope(c.req.query("scope"));
  const ownerOrErr = await resolveCredentialOwner(c, scope, c.req.query("teamId"), "read");
  if (ownerOrErr instanceof Response) return ownerOrErr;
  const owner = ownerOrErr;
  const service = c.req.param("service");
  if (service === "linear_app") return c.json({ error: "Configure the Linear application in Organization settings > Linear events." }, 400);
  if (service === ONEPASSWORD_SERVICE && owner.type === "team") {
    const ok = await mutateTeamOnePassword(db, c.var.providers.encryptionKey,
      { orgId: user.orgId, userId: user.id, teamId: owner.id }, { kind: "token", token: null });
    if (!ok) return c.json({ error: "Team not found." }, 404);
    await resyncTeamWorkflows(c, [owner.id]);
    return c.json({ ok: true } satisfies DeleteCredentialResponse);
  }

  if (owner.type === "team") await deleteTeamCredential(db, { orgId: user.orgId, userId: user.id }, owner.id, service);
  else await engineCredentials.delete(owner, service);
  if (owner.type !== "user") await refreshCredentialReadiness(c.var.providers, owner, service);
  if (owner.type === "user") {
    // Every team that rode this credential loses it, so each is resynced.
    const revoked = await deleteDelegationsFrom(db, { userId: user.id, service });
    await resyncTeamWorkflows(c, revoked);
  }

  const resp: DeleteCredentialResponse = { ok: true };
  return c.json(resp);
});

/**
 * Owner-precedence contract (1Password credential provider plan, Task 6):
 * ONE shared read implementation for "user row shadows org row" (ALL
 * credential kinds, not just 1Password references) plus 1Password reference
 * resolution built into the read. Consumed by all three credential readers
 * that used to duplicate or omit pieces of this logic:
 *
 *   - the session resolver (`engine/host.ts`'s `buildCredentialResolver`,
 *     non-github branch) via `resolveUserCredentialRead`
 *   - the workflow tool-node action invoker (`plugins/action-invoker.ts`)
 *     via `resolveUserCredentialRead` (user-owned runs) or
 *     `resolveOrgCredentialRead` (org-owned runs)
 *   - `ChannelHost`'s bot-token read (`channels/host.ts`) via
 *     `resolveOrgCredentialRead`
 *
 * The escalation is DECLARED, not assumed. Every caller states an
 * `OrgFallback`, and the default a caller derives from the plugin registry
 * (`orgFallbackPolicy`) reaches an org row only for a service some plugin
 * declared org-provided, or when the org row is an admin's 1Password
 * pointer. A plain org row stays invisible to a member's session.
 *
 * That line is deliberate. Org-ownership is an addressing detail for
 * machinery, not a statement of sharing: an org-owned `linear` row carries
 * `metadata.webhookSecret` (`routes/linear-connect.ts`), which the inbound
 * webhook verifies HMACs with, so handing whole org rows to member sessions
 * would hand out that secret. Reads are not free either —
 * `OAuthRefreshingCredentialStore.get` refreshes and writes back under the
 * owner it read, so an org read is an org write.
 *
 * This replaces the `service === "slack"` literal the session path used to
 * carry: `plugin-slack` declares `requires.orgCredential`, so the policy
 * covers it without naming it.
 */
import type { CredentialStore, StoredCredential, ValetPlugin } from "@valet/engine";
import { CredentialReferenceBrokenError } from "../plugins/team-credential-store.js";
import { findCredentialDeclaration } from "./integration-availability.js";
import {
  ONEPASSWORD_SERVICE,
  OnePasswordAuthError,
  onePasswordMeta,
  type OnePasswordService,
  OnePasswordScope,
} from "./onepassword.js";

/** Internal services that must never surface as ordinary session/workflow
 * credentials. `onepassword` rows are the service-account tokens themselves;
 * `github_app` holds the GitHub App PEM/secrets; `llm:*` rows are org LLM
 * provider keys resolved only through the model/OpenAI probe paths.
 *
 * Exported so the write path can refuse the same set: every consumer of these
 * services reads its row RAW, so a 1Password reference stored under one would
 * verify at save time and then be read as an empty credential forever. */
export function isDeniedCredentialService(service: string): boolean {
  return service === ONEPASSWORD_SERVICE || service === "github_app" || service === "linear_app" || service.startsWith("llm:");
}

export interface CredentialReadDeps {
  credentials: CredentialStore;
  onePassword?: OnePasswordService;
}

export interface CredentialReadCtx {
  orgId: string;
  userId?: string;
  /** Which 1Password token scopes a vault lookup may consult. Absent means
   * both, which is right only for a read made on behalf of the user
   * themselves. Session-bound readers pass `onePasswordScopesFor(ownerType)`. */
  scopes?: readonly OnePasswordScope[];
}

/**
 * The 1Password scopes a session's reads may consult, from who owns it.
 *
 * The user id on a session is the actor frozen onto it at creation, not
 * whoever is prompting it now. A team- or org-owned session can be prompted
 * by anyone in that group, so consulting the frozen actor's PERSONAL vault
 * would hand their private items to their colleagues. Only a user-owned
 * session reaches the personal scope; an unknown owner gets the org scope
 * alone, which is the safe side of the mistake.
 */
export function onePasswordScopesFor(ownerType: string | undefined, teamId?: string): readonly OnePasswordScope[] {
  if (ownerType === "team" && teamId) return ["team", "org"];
  return ownerType === "user" ? ["org", "personal"] : ["org"];
}

/** A read made as a specific user: `orgId`, `userId`, and the scopes the
 * session's owner allows (`onePasswordScopesFor`). Required, so no caller can
 * reach the personal vault by forgetting to decide. */
export type UserReadCtx = Required<Pick<CredentialReadCtx, "orgId" | "userId" | "scopes">> & { teamId?: string };

/**
 * Resolves a raw store row through 1Password when applicable. `onePassword`
 * absent, or the row carries no `metadata.onepassword` -> the row is
 * returned UNCHANGED (same object reference, no clone) so a non-1Password
 * deployment/row is byte-identical to a plain `CredentialStore.get` read.
 * `OnePasswordAuthError` from `resolveCredential` propagates unchanged.
 *
 * This is the one door every stored row passes through, so the owner rule
 * holds here for the user row, the org row, and the channel host alike: a
 * caller cannot reach a personal vault through a row it could not reach
 * through the vault lookup. `excluded` is the reader's choice for a row
 * whose `tokenScope` its scopes leave out. A user read skips it, so the read
 * falls through to the org row and the vaults as if the row were absent. An
 * org read refuses it with the typed `OnePasswordAuthError`, the fail-loud
 * contract `resolveOrgCredentialRead` documents.
 *
 * The org read refuses on the scopes alone rather than trusting the write
 * path. `PUT /api/credentials/:service` rejects a personal `tokenScope` on an
 * org-scoped row today, and it is the only writer of `metadata.onepassword`,
 * but a caller that supplies a `userId` (an org-owned workflow run does)
 * would otherwise resolve such a row through THAT person's personal token.
 * The rule belongs where every row passes, not only where rows are written.
 */
async function resolveRow(
  deps: CredentialReadDeps,
  row: StoredCredential | null,
  ctx: UserReadCtx,
  excluded: "skip" | "resolve",
): Promise<StoredCredential | null> {
  if (!row) return null;
  const meta = onePasswordMeta(row);
  if (!deps.onePassword || !meta) return row;
  if (!ctx.scopes.includes(meta.tokenScope)) {
    if (excluded === "skip") return null;
    throw new OnePasswordAuthError(
      `This credential reads a ${meta.tokenScope} 1Password token, which this session may not use.`,
      "scope",
    );
  }
  return deps.onePassword.resolveCredential(row, ctx);
}

/**
 * How far a user-owner read may escalate when the user has no row of their own.
 *
 * `"org-provided"` — a plugin declared the service org-provided
 * (`requires.orgCredential`), so the org row IS the configured credential for
 * everybody. `"reference-only"` — the org row is reachable only when it is an
 * admin's 1Password pointer, which is a deliberate act of sharing. `"none"` —
 * no escalation, for an incidental read of some other service.
 */
export type OrgFallback = "none" | "reference-only" | "org-provided";

/**
 * The escalation policy for one service, read from the plugin declarations.
 * An absent registry yields `"reference-only"`, so a caller that cannot see
 * the declarations escalates less rather than more.
 */
export function orgFallbackPolicy(plugins: ValetPlugin[] | undefined, service: string): OrgFallback {
  return findCredentialDeclaration(plugins ?? [], service)?.requires?.orgCredential === true
    ? "org-provided"
    : "reference-only";
}

/**
 * User-then-org precedence read for every credential kind, plus 1Password
 * reference resolution. `ctx.userId` is required: this is the "acting as a
 * specific user" half of the contract, and a personal-scope reference on
 * either row resolves against that user.
 *
 * The user row wins outright when present, reference or plain, and the org
 * row is not read. On a user-row miss the org row is consulted only as far
 * as `orgFallback` allows, and the vaults only when the caller has a row
 * for nothing.
 */
export async function resolveUserCredentialRead(
  deps: CredentialReadDeps,
  ctx: UserReadCtx,
  service: string,
  orgFallback: OrgFallback,
): Promise<StoredCredential | null> {
  if (isDeniedCredentialService(service)) return null;
  const userRow = await deps.credentials.get({ type: "user", id: ctx.userId }, service);
  const fromUser = await resolveRow(deps, userRow, ctx, "skip");
  if (fromUser) return fromUser;
  if (orgFallback === "none") return null;
  // Skip the org read entirely when only a reference could qualify and no
  // 1Password service is wired. `CredentialStore.get` is NOT side-effect free:
  // `OAuthRefreshingCredentialStore` refreshes on read and writes the result
  // back under the owner it read, so an org read is an org write.
  if (orgFallback === "reference-only" && !deps.onePassword) return null;
  // Falls through to the vault lookup below when no row answers.
  const orgRow = await deps.credentials.get({ type: "org", id: ctx.orgId }, service);
  if (!orgRow) return lookupInOnePassword(deps, ctx, service);
  // A plain org row stays invisible. An org-owned `linear` row carries
  // `metadata.webhookSecret` (`routes/linear-connect.ts`), so returning the
  // whole row to every member's session would hand out the webhook HMAC.
  if (orgFallback === "reference-only" && !onePasswordMeta(orgRow)) {
    return lookupInOnePassword(deps, ctx, service);
  }
  return resolveRow(deps, orgRow, ctx, "skip");
}

/**
 * The secret for `service` from 1Password, when Valet holds no row for it.
 *
 * This is the point of connecting a token: an agent or subagent asking for a
 * credential nobody configured gets the one already sitting in the vaults,
 * rather than a null and a hidden tool. Nothing is written — the value is
 * read at the moment it is needed, the same as a stored reference.
 *
 * The match is on the item title, so whoever can name items in an accessible
 * vault decides what an integration authenticates as. That is why the vaults
 * a service account may read are the security boundary here, and why the
 * token should be scoped to vaults chosen for this.
 *
 * Exported for `workflows/team-service-readiness.ts`, which has to give the
 * same answer a team run gets when it reaches this lookup.
 */
export async function lookupInOnePassword(
  deps: CredentialReadDeps,
  ctx: UserReadCtx,
  service: string,
): Promise<StoredCredential | null> {
  if (!deps.onePassword) return null;
  // Team is authoritative when configured; only no_token permits fallback.
  // User sessions retain org/personal ordering. Explicit rows bypass discovery.
  for (const scope of ctx.scopes) {
    try {
      const secret = await deps.onePassword.findCredentialForService(scope, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        teamId: ctx.teamId,
      }, service);
      if (secret) return { type: "api_key", apiKey: secret };
      if (scope === "team") return null;
    } catch (err) {
      if (err instanceof OnePasswordAuthError && err.kind === "ambiguous") throw err;
      // A configured team token must not silently substitute org credentials.
      if (scope === "team" && !(err instanceof OnePasswordAuthError && err.kind === "no_token")) throw err;
      // No token for this scope, or 1Password refused. Neither is an error
      // for a credential read: it just means this scope has no answer.
    }
  }
  return null;
}

/**
 * Org-row-only read (no user row is ever consulted), plus 1Password
 * reference resolution — for readers with no live user in scope (ChannelHost
 * bot tokens, org-owned workflow runs). Without `ctx.userId`, a
 * personal-tokenScope reference on the org row resolves against
 * `userId: ""`, which `OnePasswordService.resolveCredential` turns into the
 * typed `OnePasswordAuthError` (no personal token owner to look up) rather
 * than a silent null — callers must handle that error explicitly.
 */
export async function resolveOrgCredentialRead(
  deps: CredentialReadDeps,
  ctx: CredentialReadCtx,
  service: string,
): Promise<StoredCredential | null> {
  if (isDeniedCredentialService(service)) return null;
  const orgRow = await deps.credentials.get({ type: "org", id: ctx.orgId }, service);
  return resolveRow(deps, orgRow, { orgId: ctx.orgId, userId: ctx.userId ?? "", scopes: ctx.scopes ?? ["org"] }, "resolve");
}

/**
 * Team-row-only read, plus 1Password resolution on that row. A team run
 * never borrows a member's personal credential. The org row is consulted
 * only when `orgFallback` is `"org-provided"` — a plugin declared the
 * service as the org bot. `"reference-only"` stops at the team row;
 * `"none"` stops there and skips the vaults too, the same escalation line
 * the user read draws.
 *
 * When no row answers, a configured team token is authoritative for discovery.
 * An absent token preserves org discovery. Plain org rows remain restricted
 * to the existing org-provided policy.
 *
 * `ctx.teamId` is the team principal. `ctx.userId` is unused for the team
 * row itself; a personal-tokenScope 1Password pointer on a team row fails
 * closed through `resolveRow` (`excluded: "resolve"`).
 *
 * A team row that throws `CredentialReferenceBrokenError` — a delegation
 * whose delegator left the team, or whose source row no longer resolves —
 * does not end the read. The fallback behind it is a credential the team is
 * entitled to in its own right, and the catalog already reports the service
 * as connected on that credential, so a broken delegation must not fail
 * every team run. The error is raised again when nothing else answers, so
 * the message that names the corrective action still reaches the user.
 */
export async function resolveTeamCredentialRead(
  deps: CredentialReadDeps,
  ctx: { orgId: string; teamId: string; userId?: string; scopes?: readonly OnePasswordScope[] },
  service: string,
  orgFallback: OrgFallback,
): Promise<StoredCredential | null> {
  if (isDeniedCredentialService(service)) return null;
  const scopes = (ctx.scopes ?? onePasswordScopesFor("team", ctx.teamId)).filter((scope) => scope !== "personal");
  const readCtx = { orgId: ctx.orgId, teamId: ctx.teamId, userId: ctx.userId ?? "", scopes };
  let fromTeam: StoredCredential | null = null;
  let broken: CredentialReferenceBrokenError | null = null;
  try {
    const teamRow = await deps.credentials.get({ type: "team", id: ctx.teamId }, service);
    fromTeam = await resolveRow(deps, teamRow, readCtx, "resolve");
  } catch (err) {
    if (!(err instanceof CredentialReferenceBrokenError)) throw err;
    // A delegation to a departed member, or to a source row that no longer
    // resolves. The credential behind the fallback is a different one the
    // team is entitled to, so the read continues. The error is held for the
    // case where nothing else answers: the user still needs the message
    // that names the corrective action.
    broken = err;
  }
  if (fromTeam) return fromTeam;
  if (orgFallback === "none") {
    if (broken) throw broken;
    return null;
  }
  if (orgFallback === "org-provided") {
    const orgRow = await deps.credentials.get({ type: "org", id: ctx.orgId }, service);
    const fromOrg = await resolveRow(deps, orgRow, readCtx, "resolve");
    if (fromOrg) return fromOrg;
  }
  const fromVault = await lookupInOnePassword(deps, readCtx, service);
  if (fromVault) return fromVault;
  if (broken) throw broken;
  return null;
}

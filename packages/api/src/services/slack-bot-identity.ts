import { createHash } from "node:crypto";
import { verifySlackBotToken, type SlackWorkspaceIdentity } from "./slack-connect.js";

interface IdentityInput {
  orgId: string;
  accessToken: string;
  teamId: string;
  botUserId?: string;
}

interface CachedIdentity {
  key: string;
  expiresAt: number;
  result: Promise<SlackWorkspaceIdentity | undefined>;
}

// One entry per credential-store instance: this deployment resolves one org.
// The weak key isolates API instances without retaining disposed stores.
const identities = new WeakMap<object, CachedIdentity>();
const SUCCESS_TTL_MS = 10 * 60_000;
const FAILURE_TTL_MS = 60_000;

/** Legacy installations predate botId metadata. Resolve their identity from
 * the saved token, without rewriting credentials or racing a reconnect. */
export function resolveSlackBotIdentity(cacheOwner: object, input: IdentityInput): Promise<SlackWorkspaceIdentity | undefined> {
  const key = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const cached = identities.get(cacheOwner);
  if (cached?.key === key && cached.expiresAt > Date.now()) return cached.result;

  const result = verifySlackBotToken(input.accessToken).then((check) =>
    check.ok && check.identity.teamId === input.teamId
      && (!input.botUserId || check.identity.botUserId === input.botUserId)
      ? check.identity : undefined,
    () => undefined,
  ).then((identity) => {
    entry.expiresAt = Date.now() + (identity ? SUCCESS_TTL_MS : FAILURE_TTL_MS);
    return identity;
  });
  // Share pending lookups. auth.test has a bounded timeout; expiry starts
  // when it settles so a slow failure cannot cause a burst of retries.
  const entry: CachedIdentity = { key, expiresAt: Infinity, result };
  identities.set(cacheOwner, entry);
  return result;
}

/**
 * 1Password credential provider plan, Task 6: unit coverage for the shared
 * owner-precedence + 1Password-reference-resolution helper. See
 * `credential-resolution.ts`'s module doc for the contract and the
 * deliberate behavior change (plain org rows now resolve via user-row-miss
 * fallback, not just 1Password reference rows).
 */
import { describe, expect, it } from "vitest";
import type { CredentialOwner, CredentialStore, StoredCredential } from "@valet/engine";
import { InMemoryCredentialStore } from "@valet/engine";
import { OnePasswordAuthError, type OnePasswordCtx, type OnePasswordService } from "./onepassword.js";
import { CredentialReferenceBrokenError, TeamCredentialStore } from "../plugins/team-credential-store.js";
import {
  resolveOrgCredentialRead,
  resolveTeamCredentialRead,
  resolveUserCredentialRead,
  onePasswordScopesFor,
} from "./credential-resolution.js";

const orgId = "cr-org";
const userId = "cr-user";

/** Minimal in-memory `CredentialStore` — keyed by `${owner.type}:${owner.id}:${service}`. */
const fakeCredentialStore = (): CredentialStore => new InMemoryCredentialStore();

/** Fake `OnePasswordService` — only `resolveCredential` is exercised by this helper. */
function fakeOnePassword(
  resolveCredential: OnePasswordService["resolveCredential"],
): OnePasswordService {
  const unused = () => {
    throw new Error("not exercised by this suite");
  };
  return {
    tokenConnected: unused,
    listVaults: unused,
    resolveReference: unused,
    findCredentialForService: async () => null,
    findCandidates: async () => [],
    resolveCredential,
  };
}

describe("internal-service deny list", () => {
  // `onepassword` / `github_app` / `llm:*` rows are internal secrets. Without
  // this guard a user-row miss would hand them back as ordinary credentials.
  it("resolveUserCredentialRead returns null for service 'onepassword' even when the org token row exists", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, "onepassword", {
      type: "service_account",
      apiKey: "raw-org-service-account-token",
    });
    await credentials.save({ type: "user", id: userId }, "onepassword", {
      type: "service_account",
      apiKey: "raw-personal-service-account-token",
    });
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — reserved service");
    });

    const result = await resolveUserCredentialRead({ credentials, onePassword }, { orgId, userId, scopes: ["org", "personal"] }, "onepassword", "org-provided");

    expect(result).toBeNull();
  });

  it("resolveOrgCredentialRead returns null for service 'onepassword'", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, "onepassword", {
      type: "service_account",
      apiKey: "raw-org-service-account-token",
    });
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — reserved service");
    });

    const result = await resolveOrgCredentialRead({ credentials, onePassword }, { orgId }, "onepassword");

    expect(result).toBeNull();
  });

  it("resolveUserCredentialRead returns null for service 'github_app'", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, "github_app", {
      type: "service_account",
      apiKey: "-----BEGIN RSA PRIVATE KEY-----",
    });
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — denied service");
    });

    const result = await resolveUserCredentialRead({ credentials, onePassword }, { orgId, userId, scopes: ["org", "personal"] }, "github_app", "org-provided");

    expect(result).toBeNull();
  });

  it.each(["github_app", "linear_app"])("resolveOrgCredentialRead returns null for service %s", async (service) => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, service, {
      type: "service_account",
      apiKey: "-----BEGIN RSA PRIVATE KEY-----",
    });
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — denied service");
    });

    const result = await resolveOrgCredentialRead({ credentials, onePassword }, { orgId }, service);

    expect(result).toBeNull();
  });

  it("resolveUserCredentialRead returns null for llm:* provider keys", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, "llm:prov_1", {
      type: "api_key",
      apiKey: "sk-org-provider",
    });
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — denied service");
    });

    const result = await resolveUserCredentialRead({ credentials, onePassword }, { orgId, userId, scopes: ["org", "personal"] }, "llm:prov_1", "org-provided");

    expect(result).toBeNull();
  });
});

describe("resolveUserCredentialRead", () => {
  it("user row (plain) shadows an org row for the same service", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, "linear", { type: "api_key", apiKey: "org-key" });
    const userRow: StoredCredential = { type: "api_key", apiKey: "my-key" };
    await credentials.save({ type: "user", id: userId }, "linear", userRow);
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — plain row");
    });

    const result = await resolveUserCredentialRead({ credentials, onePassword }, { orgId, userId, scopes: ["org", "personal"] }, "linear", "org-provided");

    expect(result).toBe(userRow);
  });

  it("user row (1Password reference) shadows an org row — org row never read", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, "acme", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://org/acme/field", tokenScope: "org" } },
    });
    const userRow: StoredCredential = {
      type: "api_key",
      metadata: { onepassword: { reference: "op://user/acme/field", tokenScope: "personal" } },
    };
    await credentials.save({ type: "user", id: userId }, "acme", userRow);
    let sawRow: StoredCredential | undefined;
    const onePassword = fakeOnePassword(async (row, ctx: OnePasswordCtx) => {
      sawRow = row;
      return { type: row.type, metadata: row.metadata, apiKey: `resolved-for-${ctx.userId}` };
    });

    const result = await resolveUserCredentialRead({ credentials, onePassword }, { orgId, userId, scopes: ["org", "personal"] }, "acme", "org-provided");

    expect(sawRow).toBe(userRow);
    expect(result?.apiKey).toBe(`resolved-for-${userId}`);
  });

  it("user-row miss reaches a plain org row when the service is org-provided", async () => {
    const credentials = fakeCredentialStore();
    const orgRow: StoredCredential = { type: "bot_token", apiKey: "org-bot-token" };
    await credentials.save({ type: "org", id: orgId }, "telegram", orgRow);
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — plain row");
    });

    const result = await resolveUserCredentialRead({ credentials, onePassword }, { orgId, userId, scopes: ["org", "personal"] }, "telegram", "org-provided");

    expect(result).toBe(orgRow);
  });

  // The containment rule. A plain org row is machinery, not a shared secret:
  // an org-owned `linear` row carries `metadata.webhookSecret`
  // (`routes/linear-connect.ts`), so a service nobody declared org-provided
  // must not hand its whole row to a member's session.
  it("user-row miss does NOT reach a plain org row under reference-only", async () => {
    const credentials = fakeCredentialStore();
    const orgRow: StoredCredential = {
      type: "api_key",
      apiKey: "org-linear-key",
      metadata: { webhookSecret: "must-not-leak" },
    };
    await credentials.save({ type: "org", id: orgId }, "linear", orgRow);
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — the org row must not even be read");
    });

    const result = await resolveUserCredentialRead(
      { credentials, onePassword },
      { orgId, userId, scopes: ["org", "personal"] },
      "linear",
      "reference-only",
    );

    expect(result).toBeNull();
  });

  it('"none" never reaches the org row, even for a reference', async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, "acme", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://v/i/f", tokenScope: "org" } },
    });
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve under 'none'");
    });

    const result = await resolveUserCredentialRead(
      { credentials, onePassword },
      { orgId, userId, scopes: ["org", "personal"] },
      "acme",
      "none",
    );

    expect(result).toBeNull();
  });

  it("user-row miss falls back to an org row carrying a 1Password reference", async () => {
    const credentials = fakeCredentialStore();
    const orgRow: StoredCredential = {
      type: "api_key",
      metadata: { onepassword: { reference: "op://Shared/Acme/credential", tokenScope: "org" } },
    };
    await credentials.save({ type: "org", id: orgId }, "acme", orgRow);
    let sawRow: StoredCredential | undefined;
    const onePassword = fakeOnePassword(async (row, ctx: OnePasswordCtx) => {
      sawRow = row;
      return { type: row.type, metadata: row.metadata, apiKey: `org-secret-for-${ctx.userId}` };
    });

    const result = await resolveUserCredentialRead({ credentials, onePassword }, { orgId, userId, scopes: ["org", "personal"] }, "acme", "org-provided");

    expect(sawRow).toBe(orgRow);
    expect(result?.apiKey).toBe(`org-secret-for-${userId}`);
  });

  it("returns null when neither the user nor the org row exists", async () => {
    const credentials = fakeCredentialStore();
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — nothing stored");
    });

    const result = await resolveUserCredentialRead({ credentials, onePassword }, { orgId, userId, scopes: ["org", "personal"] }, "nope", "org-provided");

    expect(result).toBeNull();
  });

  it("onePassword absent: rows pass through byte-identical (same object, no clone)", async () => {
    const credentials = fakeCredentialStore();
    const userRow: StoredCredential = {
      type: "api_key",
      metadata: { onepassword: { reference: "op://vault/item/field", tokenScope: "org" } },
    };
    await credentials.save({ type: "user", id: userId }, "acme", userRow);

    const result = await resolveUserCredentialRead({ credentials }, { orgId, userId, scopes: ["org", "personal"] }, "acme", "org-provided");

    expect(result).toBe(userRow);
  });
});

describe("resolveOrgCredentialRead", () => {
  it("resolves an org-owned 1Password reference row with no userId in ctx", async () => {
    const credentials = fakeCredentialStore();
    const orgRow: StoredCredential = {
      type: "bot_token",
      metadata: { onepassword: { reference: "op://Shared/Bot/token", tokenScope: "org" } },
    };
    await credentials.save({ type: "org", id: orgId }, "telegram", orgRow);
    let sawCtx: OnePasswordCtx | undefined;
    const onePassword = fakeOnePassword(async (row, ctx) => {
      sawCtx = ctx;
      return { type: row.type, metadata: row.metadata, apiKey: "resolved-bot-token" };
    });

    const result = await resolveOrgCredentialRead({ credentials, onePassword }, { orgId }, "telegram");

    expect(result?.apiKey).toBe("resolved-bot-token");
    expect(sawCtx).toEqual({ orgId, userId: "", scopes: ["org"] });
  });

  // An org read refuses a personal-scope row on the scopes alone, before the
  // service is consulted at all. The write path rejects this combination
  // today, so the row is unreachable through the API — but an org-owned
  // workflow run supplies a real `userId`, and without this gate such a row
  // would resolve through THAT person's personal token.
  it("org row carrying a personal-tokenScope reference is refused, and the service is never called", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, "acme", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://Personal/Acme/field", tokenScope: "personal" } },
    });
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — the scopes exclude personal");
    });

    await expect(
      resolveOrgCredentialRead({ credentials, onePassword }, { orgId }, "acme"),
    ).rejects.toMatchObject({ kind: "scope" });
    await expect(
      resolveOrgCredentialRead({ credentials, onePassword }, { orgId, userId, scopes: ["org"] }, "acme"),
    ).rejects.toBeInstanceOf(OnePasswordAuthError);
  });

  it("plain org row passes through unchanged (no onePassword call)", async () => {
    const credentials = fakeCredentialStore();
    const orgRow: StoredCredential = { type: "api_key", apiKey: "plain-org-key" };
    await credentials.save({ type: "org", id: orgId }, "linear", orgRow);
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — plain row");
    });

    const result = await resolveOrgCredentialRead({ credentials, onePassword }, { orgId }, "linear");

    expect(result).toBe(orgRow);
  });

  it("returns null when no org row exists", async () => {
    const credentials = fakeCredentialStore();
    const onePassword = fakeOnePassword(async () => {
      throw new Error("must not resolve — nothing stored");
    });

    const result = await resolveOrgCredentialRead({ credentials, onePassword }, { orgId }, "nope");

    expect(result).toBeNull();
  });
});

// The point of connecting a token: an agent asking for a credential nobody
// configured gets the one already in the vaults.
describe("vault lookup when no row exists", () => {
  const orgId = "org-1";
  const userId = "user-1";

  function fakeWithLookup(secret: string | null, onLookup?: (scope: string) => void): OnePasswordService {
    const unused = (): never => {
      throw new Error("not exercised by this suite");
    };
    return {
      tokenConnected: unused,
      listVaults: unused,
      resolveReference: unused,
      findCandidates: async () => [],
      findCredentialForService: async (scope) => {
        onLookup?.(scope);
        return secret;
      },
      resolveCredential: async (row: StoredCredential) => row,
    };
  }

  it("resolves a service with no user or org row from the vaults", async () => {
    const credentials = fakeCredentialStore();
    const onePassword = fakeWithLookup("vault-secret");

    const result = await resolveUserCredentialRead(
      { credentials, onePassword },
      { orgId, userId, scopes: ["org", "personal"] },
      "linear",
      "reference-only",
    );

    expect(result?.apiKey).toBe("vault-secret");
  });

  it("returns null when nothing in the vaults matches", async () => {
    const credentials = fakeCredentialStore();
    const onePassword = fakeWithLookup(null);

    const result = await resolveUserCredentialRead(
      { credentials, onePassword },
      { orgId, userId, scopes: ["org", "personal"] },
      "linear",
      "reference-only",
    );

    expect(result).toBeNull();
  });

  it("a stored row still wins: the vaults are the fallback, not the source", async () => {
    const credentials = fakeCredentialStore();
    const userRow: StoredCredential = { type: "api_key", apiKey: "my-own-key" };
    await credentials.save({ type: "user", id: userId }, "linear", userRow);
    const onePassword = fakeWithLookup("vault-secret");

    const result = await resolveUserCredentialRead(
      { credentials, onePassword },
      { orgId, userId, scopes: ["org", "personal"] },
      "linear",
      "reference-only",
    );

    expect(result?.apiKey).toBe("my-own-key");
  });
  // The scope set is decided from the session owner, once, and honored here.
  it("with scopes [org] never consults the personal vault", async () => {
    const tried: string[] = [];
    const credentials = fakeCredentialStore();
    const onePassword = fakeWithLookup("ACTOR-PRIVATE", (scope) => tried.push(scope));
    const got = await resolveUserCredentialRead(
      { credentials, onePassword },
      { orgId, userId, scopes: ["org"] },
      "linear",
      "reference-only",
    );
    expect(tried).toEqual(["org"]);
    expect(got?.apiKey).toBe("ACTOR-PRIVATE");
  });

  // "none" means no escalation at all; a vault lookup is an escalation.
  it("orgFallback none returns null without a vault lookup", async () => {
    const tried: string[] = [];
    const credentials = fakeCredentialStore();
    const onePassword = fakeWithLookup("SHOULD-NOT-BE-READ", (scope) => tried.push(scope));
    const got = await resolveUserCredentialRead({ credentials, onePassword }, { orgId, userId, scopes: ["org", "personal"] }, "linear", "none");
    expect(got).toBeNull();
    expect(tried).toEqual([]);
  });
  // The stored-row path is the one the vault-title search does not cover: a
  // user row carrying a personal-scope reference must not resolve for a
  // session whose owner rule excludes the personal scope.
  it("a personal-scope user row reads as absent when scopes exclude personal", async () => {
    const tried: string[] = [];
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "user", id: userId }, "linear", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://Private/Linear/token", tokenScope: "personal" } },
    });
    const onePassword: OnePasswordService = {
      ...fakeWithLookup(null, (scope) => tried.push(`lookup:${scope}`)),
      resolveCredential: async (row: StoredCredential) => {
        tried.push("resolveCredential");
        return { ...row, apiKey: "ACTOR-PRIVATE" };
      },
    };
    const got = await resolveUserCredentialRead(
      { credentials, onePassword },
      { orgId, userId, scopes: ["org"] },
      "linear",
      "reference-only",
    );
    // Not resolved through the personal token; the read falls through to the
    // org row (none) and the org-scope vault lookup (nothing), and answers null.
    expect(tried).toEqual(["lookup:org"]);
    expect(got).toBeNull();
  });

  it("the same row resolves for a user-owned session", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "user", id: userId }, "linear", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://Private/Linear/token", tokenScope: "personal" } },
    });
    const onePassword: OnePasswordService = {
      ...fakeWithLookup(null),
      resolveCredential: async (row: StoredCredential) => ({ ...row, apiKey: "ACTOR-PRIVATE" }),
    };
    const got = await resolveUserCredentialRead(
      { credentials, onePassword },
      { orgId, userId, scopes: onePasswordScopesFor("user") },
      "linear",
      "reference-only",
    );
    expect(got?.apiKey).toBe("ACTOR-PRIVATE");
  });
});

describe("resolveTeamCredentialRead", () => {
  const teamId = "cr-team";

  it("returns a direct team row and does not read the org row", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "team", id: teamId }, "linear", {
      type: "api_key",
      apiKey: "team-secret",
    });
    await credentials.save({ type: "org", id: orgId }, "linear", {
      type: "api_key",
      apiKey: "org-secret",
    });
    const got = await resolveTeamCredentialRead(
      { credentials },
      { orgId, teamId },
      "linear",
      "reference-only",
    );
    expect(got?.apiKey).toBe("team-secret");
  });

  it("does not fall back to a plain org row when the team has no credential", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, "linear", {
      type: "api_key",
      apiKey: "org-secret",
    });
    const got = await resolveTeamCredentialRead(
      { credentials },
      { orgId, teamId },
      "linear",
      "reference-only",
    );
    expect(got).toBeNull();
  });

  it("reads the org row when the service is org-provided", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, "slack", {
      type: "bot_token",
      accessToken: "org-bot",
    });
    const got = await resolveTeamCredentialRead(
      { credentials },
      { orgId, teamId },
      "slack",
      "org-provided",
    );
    expect(got?.accessToken).toBe("org-bot");
  });

  function vaultWithLookup(secret: string | null, onLookup: (scope: string) => void): OnePasswordService {
    const unused = (): never => {
      throw new Error("not exercised by this suite");
    };
    return {
      tokenConnected: unused,
      listVaults: unused,
      resolveReference: unused,
      findCandidates: async () => [],
      findCredentialForService: async (scope) => {
        onLookup(scope);
        return secret;
      },
      resolveCredential: async (row: StoredCredential) => row,
    };
  }

  it("team-row miss reaches the org-scoped 1Password item, on the caller's scopes alone", async () => {
    const scopesTried: string[] = [];
    const credentials = fakeCredentialStore();
    const onePassword = vaultWithLookup("vault-secret", (scope) => scopesTried.push(scope));
    const got = await resolveTeamCredentialRead(
      { credentials, onePassword },
      { orgId, teamId, scopes: onePasswordScopesFor("team") },
      "linear",
      "reference-only",
    );
    expect(scopesTried).toEqual(["org"]);
    expect(got?.apiKey).toBe("vault-secret");
  });

  it("a team row wins without consulting the vault", async () => {
    const scopesTried: string[] = [];
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "team", id: teamId }, "linear", {
      type: "api_key",
      apiKey: "team-secret",
    });
    const onePassword = vaultWithLookup("vault-secret", (scope) => scopesTried.push(scope));
    const got = await resolveTeamCredentialRead(
      { credentials, onePassword },
      { orgId, teamId, scopes: onePasswordScopesFor("team") },
      "linear",
      "reference-only",
    );
    expect(scopesTried).toEqual([]);
    expect(got?.apiKey).toBe("team-secret");
  });

  it("resolves a granted 1Password reference on a team row", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "team", id: teamId }, "onepassword", {
      type: "service_account",
      metadata: { refs: ["op://Shared/Acme/credential"] },
    });
    await credentials.save({ type: "team", id: teamId }, "linear", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://Shared/Acme/credential", tokenScope: "org" } },
    });
    const onePassword = fakeOnePassword(async (row) => ({ ...row, apiKey: "from-vault" }));
    const got = await resolveTeamCredentialRead(
      { credentials, onePassword },
      { orgId, teamId },
      "linear",
      "reference-only",
    );
    expect(got?.apiKey).toBe("from-vault");
  });

  it("resolves a team row reference when the team has no grant row", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "team", id: teamId }, "linear", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://Shared/Acme/credential", tokenScope: "org" } },
    });
    const onePassword = fakeOnePassword(async (row) => ({ ...row, apiKey: "from-vault" }));
    const got = await resolveTeamCredentialRead(
      { credentials, onePassword },
      { orgId, teamId },
      "linear",
      "reference-only",
    );
    expect(got?.apiKey).toBe("from-vault");
  });

  // The org-provided row is the other place a team read dereferences an
  // op:// ref. A lease narrows that read too, or the grant is a fence with a
  // gate left open for every service a plugin declares org-provided.
  it("ignores obsolete grants for a 1Password reference on the org-provided row", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "team", id: teamId }, "onepassword", {
      type: "service_account",
      metadata: { refs: ["op://Shared/Acme/credential"] },
    });
    await credentials.save({ type: "org", id: orgId }, "slack", {
      type: "bot_token",
      metadata: { onepassword: { reference: "op://Shared/Other/bot", tokenScope: "org" } },
    });
    const onePassword = fakeOnePassword(async (row) => ({ ...row, apiKey: "resolved" }));
    await expect(
      resolveTeamCredentialRead({ credentials, onePassword }, { orgId, teamId }, "slack", "org-provided"),
    ).resolves.toMatchObject({ apiKey: "resolved" });
  });

  it("resolves a granted 1Password reference on the org-provided row", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "team", id: teamId }, "onepassword", {
      type: "service_account",
      metadata: { refs: ["op://Shared/Acme/bot"] },
    });
    await credentials.save({ type: "org", id: orgId }, "slack", {
      type: "bot_token",
      metadata: { onepassword: { reference: "op://Shared/Acme/bot", tokenScope: "org" } },
    });
    const onePassword = fakeOnePassword(async (row) => ({ ...row, accessToken: "bot-from-vault" }));
    const got = await resolveTeamCredentialRead({ credentials, onePassword }, { orgId, teamId }, "slack", "org-provided");
    expect(got?.accessToken).toBe("bot-from-vault");
  });

  it("ignores obsolete grants for a 1Password reference on a team row", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "team", id: teamId }, "onepassword", {
      type: "service_account",
      metadata: { refs: ["op://Shared/Acme/credential"] },
    });
    await credentials.save({ type: "team", id: teamId }, "linear", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://Shared/Other/password", tokenScope: "org" } },
    });
    const onePassword = fakeOnePassword(async (row) => ({ ...row, apiKey: "resolved" }));
    await expect(
      resolveTeamCredentialRead(
        { credentials, onePassword },
        { orgId, teamId },
        "linear",
        "reference-only",
      ),
    ).resolves.toMatchObject({ apiKey: "resolved" });
  });

  // A delegation whose source row is gone throws out of the store. The org
  // bot is a different credential the team is entitled to, so a service the
  // catalog reports as connected must still run.
  describe("a broken delegation", () => {
    function storeWithBrokenDelegation(): Promise<CredentialStore> {
      const inner = fakeCredentialStore();
      return inner
        .save({ type: "team", id: teamId }, "slack", {
          type: "bot_token",
          metadata: { delegatedFrom: "departed-user" },
        })
        .then(() => new TeamCredentialStore(inner, { isMember: async () => false }));
    }

    it("falls back to the org row when the service is org-provided", async () => {
      const credentials = await storeWithBrokenDelegation();
      await credentials.save({ type: "org", id: orgId }, "slack", {
        type: "bot_token",
        accessToken: "org-bot",
      });
      const got = await resolveTeamCredentialRead(
        { credentials },
        { orgId, teamId },
        "slack",
        "org-provided",
      );
      expect(got?.accessToken).toBe("org-bot");
    });

    it("surfaces the typed error when no org row answers", async () => {
      const credentials = await storeWithBrokenDelegation();
      await expect(
        resolveTeamCredentialRead({ credentials }, { orgId, teamId }, "slack", "org-provided"),
      ).rejects.toBeInstanceOf(CredentialReferenceBrokenError);
    });

    // Readiness reads with "none" and reports a broken row as broken. A
    // silent null there would arm a trigger that fails on every fire.
    it("surfaces the typed error when the caller allows no fallback", async () => {
      const credentials = await storeWithBrokenDelegation();
      await expect(
        resolveTeamCredentialRead({ credentials }, { orgId, teamId }, "slack", "none"),
      ).rejects.toBeInstanceOf(CredentialReferenceBrokenError);
    });
  });

  it("returns null for denied services", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "team", id: teamId }, "onepassword", {
      type: "service_account",
      apiKey: "must-not-leak",
    });
    const got = await resolveTeamCredentialRead(
      { credentials },
      { orgId, teamId },
      "onepassword",
      "org-provided",
    );
    expect(got).toBeNull();
  });
});

import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  jsonb,
  timestamp,
  index,
  primaryKey,
  uniqueIndex,
  check,
  doublePrecision,
  numeric,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { ParamMatcher } from "../policies/matchers.js";
import type { PrebuildResources } from "../prebuilds/recipe.js";

// Postgres rewrite of `schema/index.ts` (docs/specs/2026-07-15-postgres-backend-design.md,
// decision 7). Timestamps convert SELECTIVELY, not blanket:
//   - Columns services do numeric-ms arithmetic on, or compare against
//     `Date.now()` directly, stay `bigint` (mode: "number", read as a plain
//     number) — this is every Valet-owned table below except `invites` and
//     `sandbox_tokens`.
//   - Columns the sqlite schema already declared `{ mode: "timestamp_ms" }`
//     (i.e. genuinely consumed as JS `Date` objects — traced via
//     `packages/api/src/auth/invites.ts` and `.../sandbox-tokens.ts`, both of
//     which call `.getTime()` / compare against `new Date()`) become
//     `timestamp` here: `orgs`... no, `invites`, `sandbox_tokens`, and the
//     entire better-auth block.
// JSON-as-text becomes `jsonb` only where a reader consumes the column as
// JSON (traced via grep — see the per-column disposition table in the task
// report); everything else (e.g. `memory_files.tags`/`.extras`, which Task 9
// feeds into the tsvector generated column as text) stays `text`. The
// driver returns jsonb already parsed — readers must NOT `JSON.parse` the
// value (see `fromJsonbColumn` in `@valet/store-postgres`).
// Boolean-as-integer (`0`/`1` flags with no arithmetic) becomes `boolean`.
// `AUTOINCREMENT` becomes `generated always as identity`.

// ─── Identity ───────────────────────────────────────────────────────────────

export const orgs = pgTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // JSON object of feature flags, e.g. `{ organizations: boolean }`. Read
  // driver-parsed by `services/org.ts` — jsonb.
  features: jsonb("features").notNull().default({}),
  // Top-level group paths the login team sync mirrors (e.g. `["/platform"]`),
  // editable from Settings (`services/org.ts`). NULL means "never set",
  // which mirrors nothing — the same fail-closed answer as an empty list.
  // When `valet.yaml` declares `auth.sso.teams.groups`, the boot reconciler
  // writes the file's list over this column, so the file wins at every boot
  // — the same precedence as `features` (`services/config-reconcile.ts`).
  ssoTeamGroups: jsonb("sso_team_groups"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  // Org-level toggle: present skill names as bare slash-commands instead of
  // prefixed `/skill <name>`. Replaces the deleted per-user `users.bareSkillCommands`.
  bareSkillCommands: boolean("bare_skill_commands").notNull().default(false),
  // Org-level opt-in for anonymous artifact links (artifacts design). Off =
  // every artifact link requires a logged-in org member, and the `public`
  // visibility option is not offered. Live-checked on every artifact read,
  // so flipping it off immediately re-gates existing `public` artifacts.
  allowPublicArtifacts: boolean("allow_public_artifacts").notNull().default(false),
  /** Allow repository bakes without an org Git credential. Admin opt-in. */
  allowAnonymousImageBakes: boolean("allow_anonymous_image_bakes").notNull().default(false),
  /** Allow members to install the GitHub App on personal accounts. */
  allowPersonalInstallations: boolean("allow_personal_installations").notNull().default(true),
  // Tier map: `{ xs: ["anthropic/claude-haiku-4-5"], ... }`. Nullable — null
  // means "use built-in defaults" (same pattern as `ssoTeamGroups`).
  modelTiers: jsonb("model_tiers"),
  /** Org allowlist of selectable model ids. Null = whole catalog approved.
   * Empty array is rejected at the API. Admins bypass the list. */
  approvedModels: jsonb("approved_models"),
  /** { default?: ThinkingLevel, max?: ThinkingLevel }. Null = no default,
   * no cap. */
  reasoningSettings: jsonb("reasoning_settings"),
});

// better-auth's default model name for the user table is "user" (singular);
// we keep the Drizzle export name `users` so existing call sites still
// compile, but the underlying table is named "user" — do not fight
// better-auth with model remapping (auth-v2 design, Schema).
//
// Regenerated via `npx -y @better-auth/cli generate` against a scratch
// `provider: "pg"` config mirroring `src/auth/index.ts` (same plugins: sso,
// apiKey, mcp; same `user.additionalFields`). The CLI's own pg output uses
// plain `timestamp` (no time zone option exists in better-auth's generator
// for any provider — verified by inspecting the installed 1.6.23 CLI/core
// dist for a `timezone`/`withTimezone` knob; there is none), so
// "timestamp with time zone" in the spec's decision 7 is directional (Date-
// typed vs bigint-ms), not literal — this file transcribes the CLI's actual
// `timestamp` output verbatim. Only the two `additionalFields` columns
// (`role`, `defaultModel`) are hand-adjusted to our conventions (role gets
// the literal union type); every other column, including the `$onUpdate`
// callbacks the CLI emits for this version, is verbatim.
export const users = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
  role: text("role", { enum: ["admin", "member"] }).notNull().default("member"),
  // Nullable user preference feeding `EngineHost`'s model override seam;
  // null falls back to the host default (split-settings design, decision 9).
  defaultModel: text("default_model"),
  /** Personal default reasoning level. Null = inherit. */
  defaultReasoning: text("default_reasoning"),
  /** Controls whether a new thread keeps active settings or uses defaults. */
  newThreadBehavior: text("new_thread_behavior", {
    enum: ["keep_current", "use_defaults"],
  }).notNull().default("keep_current"),
});

// ─── better-auth core + plugin tables ───────────────────────────────────────
//
// Verbatim transcription of the better-auth CLI-generated pg schema for our
// enabled plugins (core, sso, api-key, oidc-provider) — see auth-v2 design
// §Schema and the file-header note above. Do not hand-tune column shapes
// here; regenerate via `npx -y @better-auth/cli generate` against a
// `provider: "pg"` config and diff instead.

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_userId_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index("account_userId_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

export const ssoProvider = pgTable("sso_provider", {
  id: text("id").primaryKey(),
  issuer: text("issuer").notNull(),
  oidcConfig: text("oidc_config"),
  samlConfig: text("saml_config"),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull().unique(),
  organizationId: text("organization_id"),
  domain: text("domain").notNull(),
});

export const apikey = pgTable(
  "apikey",
  {
    id: text("id").primaryKey(),
    configId: text("config_id").default("default").notNull(),
    name: text("name"),
    start: text("start"),
    referenceId: text("reference_id").notNull(),
    prefix: text("prefix"),
    key: text("key").notNull(),
    refillInterval: integer("refill_interval"),
    refillAmount: integer("refill_amount"),
    lastRefillAt: timestamp("last_refill_at"),
    enabled: boolean("enabled").default(true),
    rateLimitEnabled: boolean("rate_limit_enabled").default(true),
    rateLimitTimeWindow: integer("rate_limit_time_window").default(86400000),
    rateLimitMax: integer("rate_limit_max").default(10),
    requestCount: integer("request_count").default(0),
    remaining: integer("remaining"),
    lastRequest: timestamp("last_request"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    permissions: text("permissions"),
    metadata: text("metadata"),
    /**
     * Valet-owned pin for a team `vlt_` key (TKAI-396). Set by the team
     * key route together with `metadata.teamId`; the auth ladder reads the
     * metadata (it is what `verifyApiKey` returns), the team list filters
     * on this indexed column. Null on a personal key.
     */
    teamId: text("team_id"),
  },
  (t) => [
    index("apikey_configId_idx").on(t.configId),
    index("apikey_referenceId_idx").on(t.referenceId),
    index("apikey_key_idx").on(t.key),
    index("apikey_teamId_idx").on(t.teamId),
  ],
);

export const oauthApplication = pgTable(
  "oauth_application",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    icon: text("icon"),
    metadata: text("metadata"),
    clientId: text("client_id").unique(),
    clientSecret: text("client_secret"),
    redirectUrls: text("redirect_urls"),
    type: text("type"),
    disabled: boolean("disabled").default(false),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (t) => [index("oauthApplication_userId_idx").on(t.userId)],
);

export const oauthAccessToken = pgTable(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    accessToken: text("access_token").unique(),
    refreshToken: text("refresh_token").unique(),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    clientId: text("client_id").references(() => oauthApplication.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    scopes: text("scopes"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (t) => [
    index("oauthAccessToken_clientId_idx").on(t.clientId),
    index("oauthAccessToken_userId_idx").on(t.userId),
  ],
);

export const oauthConsent = pgTable(
  "oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").references(() => oauthApplication.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    scopes: text("scopes"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
    consentGiven: boolean("consent_given"),
  },
  (t) => [
    index("oauthConsent_clientId_idx").on(t.clientId),
    index("oauthConsent_userId_idx").on(t.userId),
  ],
);

// ─── Valet-owned auth adjuncts ──────────────────────────────────────────────
//
// `invites` and `sandbox_tokens` are Valet-owned (not part of the CLI-
// regenerated block above) but were declared `{ mode: "timestamp_ms" }` in
// the sqlite schema, and their readers genuinely consume `Date` objects
// (`packages/api/src/auth/invites.ts`'s `row.expiresAt.getTime()` /
// `row.expiresAt <= now` where `now = new Date()`; `sandbox-tokens.ts`'s
// `new Date(now)` inserts and `row.expiresAt <= now` reads) — decision 7's
// "columns consumed as Date become timestamp" rule applies to these two
// tables even though they're not part of the better-auth block.

export const invites = pgTable("invites", {
  id: text("id").primaryKey(),
  codeHash: text("code_hash").notNull().unique(),
  email: text("email"),
  role: text("role", { enum: ["admin", "member"] }).notNull().default("member"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  acceptedBy: text("accepted_by"),
  acceptedAt: timestamp("accepted_at"),
});

export const sandboxTokens = pgTable("sandbox_tokens", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  sessionId: text("session_id").notNull(),
  userId: text("user_id").notNull(),
  orgId: text("org_id").notNull(),
  createdAt: timestamp("created_at").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
});

export const orgMembers = pgTable(
  "org_members",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

// ─── Agent sessions ─────────────────────────────────────────────────────────
//
// One row per session the user creates from the UI. The engine maintains its
// own internal state in `engine_sessions`/`engine_threads`/`engine_entries`
// (managed by @valet/store-postgres). This table holds only what the UI cares
// about: human-visible metadata, workspace path, status.

export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    workspace: text("workspace").notNull(),
    title: text("title"),
    status: text("status", {
      enum: ["active", "hibernated", "archived", "deleted"],
    })
      .notNull()
      .default("active"),
    // Principal ownership (decision 8/20 — engine v2). Default 'user'/''
    // matches pre-owner rows; routes that create sessions should populate
    // both explicitly (owner_id = user_id for today's user-owned sessions).
    ownerType: text("owner_type").notNull().default("user"),
    ownerId: text("owner_id").notNull().default(""),
    // Whose credentials a TEAM-owned session reads (team credentials
    // design, deviation 13). `owner` = the team principal. `actor` = the
    // prompting member with org fallback, the contract every session had
    // before team-owner resolution shipped; a boot pass stamps it onto
    // team rows that predate the column, and no writer sets it since.
    // NULL reads as `owner`. Ignored for user- and org-owned rows.
    credentialOwnerMode: text("credential_owner_mode", { enum: ["owner", "actor"] }),
    // Interactive-service profile (sandbox auth gateway plan, Task 5).
    // "headless" (default) is agent-only; "full" additionally runs
    // ttyd + code-server + the auth gateway inside the sandbox.
    // Web-created interactive sessions may request "full", and so may
    // child sessions via the task tool's profile parameter; orchestrator
    // and workflow sessions always hardcode "headless".
    profile: text("profile", { enum: ["headless", "full"] }).notNull().default("headless"),
    // Request a rootless docker daemon inside this session's sandbox
    // (docker-in-sandbox). See docs/specs/2026-08-15-sandbox-docker-design.md.
    docker: boolean("docker").notNull().default(false),
    // Persisted repository capability. Failed YAML reads preserve this value.
    kubernetes: boolean("kubernetes").notNull().default(false),
    // Per-child CPU and memory overrides from the task tool. Null means the
    // session uses repository or deployment defaults.
    sandboxResourceOverrides: jsonb("sandbox_resource_overrides").$type<PrebuildResources>(),
    // Which authoring surface the session drives ('code' default,
    // 'security' = engagement runner). Distinct from the engine's
    // lifecycle `purpose`. Shared shape with the Valet Design PR (#396),
    // which adds 'design' — second-lander rebases to a no-op.
    kind: text("kind").notNull().default("code"),
    // The `bakes.id` this session's sandbox booted from, when session
    // create resolved the primary repo binding to a `pushed` bake image
    // (sandbox images v2 plan, Task 4). Null for cold-start sessions (no
    // matching source/bake, or a `customImage: false` provider). Nullable
    // — the vast majority of sessions never resolve a bake.
    bakeId: text("bake_id"),
    // Sandbox id recorded at hibernate time — the reaper's destroy handle
    // for sessions an api restart evicts from the host cache (same rationale
    // as child_watches.parked_sandbox_id).
    hibernatedSandboxId: text("hibernated_sandbox_id"),
    // Stamped once the reaper has destroyed the hibernated sandbox, so the
    // row stops sweeping. Cleared by the next hibernate write.
    sandboxReclaimedAt: bigint("sandbox_reclaimed_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    // Epoch ms of the most recent user or agent activity in this session.
    // Updated on every prompt submission (web, channel, child signal) and
    // on session create. The session list sorts by this column so a
    // long-lived channel-bound session rises when it receives a message.
    // Nullable: pre-column rows default to NULL; queries fall back to
    // `updatedAt` via COALESCE.
    lastActivityAt: bigint("last_activity_at", { mode: "number" }),
  },
  (t) => [
    index("agent_sessions_user").on(t.userId),
    index("agent_sessions_usage_scope").on(t.orgId, t.userId, t.id),
    index("agent_sessions_status").on(t.status),
  ],
);

// Threads — the UI groups messages by thread. The engine has its own thread
// concept too; here we mirror just the fields the chat list needs.
export const sessionThreads = pgTable(
  "session_threads",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    title: text("title"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    // Most recent user action on this thread. Agent events never update it.
    lastUserActivityAt: bigint("last_user_activity_at", { mode: "number" }),
    // Display-state only: an archived thread leaves the default sidebar
    // list. The engine thread and its history are untouched.
    archivedAt: bigint("archived_at", { mode: "number" }),
  },
  (t) => [index("session_threads_session").on(t.sessionId)],
);

// Messages — the visible chat log. Each row is a single message the UI
// renders. `parts` is JSON-encoded MessagePart[] (text/tool_use/tool_result)
// — read as JSON (decision 7 names this column explicitly) — jsonb.
// `content` is the flat-string projection for legacy/simple consumers.
export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    threadId: text("thread_id"),
    role: text("role", {
      enum: ["user", "assistant", "system", "tool"],
    }).notNull(),
    content: text("content").notNull(),
    parts: jsonb("parts"),
    authorId: text("author_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("messages_session").on(t.sessionId),
    index("messages_thread").on(t.threadId),
    index("messages_created").on(t.createdAt),
  ],
);

// ─── Teams ──────────────────────────────────────────────────────────────────
//
// Teams are the org's membership structure (orchestrator spec, "Identity").
// Names unique per org; last-admin guards on role change/removal and
// creator-auto-admin live in service code (`services/teams.ts`), inside one
// transaction — not expressible as table constraints.
//
// `origin` records where a row came from, as `skills.origin` does below.
// An `idp` row can receive explicit join suggestions, but login does not
// write its membership. A `config` row is declared in `valet.yaml`; the boot
// reconciler asserts its declared members and never removes one. A `local`
// row was created in Valet. The team routes manage membership for all rows.
//
// `external_id` holds the full group path (`/platform`). The path is what the
// token claim carries, it survives a realm re-import, and it stays legible in
// a query result. It is NULL for a `local` team and for a `config` team: the
// file identifies a team by `teams[].name`, which `teams_org_name` already
// keeps unique, so a second column would only duplicate the first. Postgres
// treats NULLs as distinct, so `teams_org_external` constrains the mirrored
// rows only, and unlimited NULL rows coexist in it. `origin` is part of that
// key so `external_id` is a per-origin namespace the day a second origin
// populates it.

export const teams = pgTable(
  "teams",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    /**
     * `local` = created in Valet. `config` = declared in `valet.yaml`.
     * `idp` = mirrored from an identity-provider group.
     */
    origin: text("origin", { enum: ["local", "config", "idp"] })
      .notNull()
      .default("local"),
    /**
     * Full identity-provider group path this team mirrors. Null for a `local`
     * and for a `config` team.
     */
    externalId: text("external_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    /**
     * Team default model for sessions this team owns (TKAI-255). Sits
     * between the member's `users.default_model` and the org's tier map in
     * the resolution chain. Null = no override.
     */
    defaultModel: text("default_model"),
    /** Team default reasoning level. Null = inherit. */
    defaultReasoning: text("default_reasoning"),
    slackHomeChannelId: text("slack_home_channel_id"),
  },
  (t) => [
    uniqueIndex("teams_org_name").on(t.orgId, t.name),
    uniqueIndex("teams_org_external").on(t.orgId, t.origin, t.externalId),
  ],
);

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: text("team_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    index("team_members_user").on(t.userId),
  ],
);

// Current identity-provider eligibility for an explicit team join. The row
// stores no group path. The team row owns that sensitive mapping.
export const teamJoinEligibilities = pgTable(
  "team_join_eligibilities",
  {
    teamId: text("team_id").notNull(),
    userId: text("user_id").notNull(),
    observedAt: bigint("observed_at", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    index("team_join_eligibilities_user").on(t.userId),
  ],
);

// ─── Assistants ─────────────────────────────────────────────────────────────

/** One runtime identity per personal or team workspace. Ownership is unique,
 * including retired identities. Threads share this identity and execution
 * sessions retain separate sandbox lifecycles. */
export const assistants = pgTable(
  "assistants",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    ownerType: text("owner_type", { enum: ["user", "team", "org"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    sessionId: text("session_id").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    /** Null while live. Team teardown retires the workspace identity; the
     * owner slot remains reserved. */
    archivedAt: bigint("archived_at", { mode: "number" }),
  },
  (t) => [
    uniqueIndex("assistants_session").on(t.sessionId),
    uniqueIndex("assistants_workspace").on(t.orgId, t.ownerType, t.ownerId),
  ],
);

// ─── Child watches ───────────────────────────────────────────────────────────
//
// Durable record of a spawned child session's pending settlement (decision
// 11). The ChildWatcher (Task 8) arms `awaitResult` per unsettled row and
// re-arms every unsettled row on boot — this table is the restart-survival
// mechanism for `child.settled` reporting. `settled` is a plain 0/1 flag
// with no arithmetic on it (only `eq(childWatches.settled, 0)` equality
// filters) — boolean per decision 7's "boolean-as-integer" rule. NOTE for
// Task 7 (cutover): every `eq(childWatches.settled, 0)` call site
// (`routes/orchestrator.ts`, `orchestrator/children.ts`) must flip to
// `eq(childWatches.settled, false)`, and `r.settled === 1` (`routes/
// orchestrator.ts`) to `r.settled`.

export const childWatches = pgTable(
  "child_watches",
  {
    childSessionId: text("child_session_id").primaryKey(),
    queueItemId: text("queue_item_id").notNull(),
    parentSessionId: text("parent_session_id").notNull(),
    parentThreadId: text("parent_thread_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    orgId: text("org_id").notNull(),
    settled: boolean("settled").notNull().default(false),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    // The spawning submission's ChannelOrigin as JSON, inherited by the
    // child.settled signal so the settlement turn can reach the channel
    // that asked. Null for spawns from non-channel turns.
    originJson: text("origin_json"),
    // Display-state only: a dismissed watch leaves the thread tree. The
    // child session row and its history stay reachable from Sessions.
    dismissedAt: bigint("dismissed_at", { mode: "number" }),
    // Retention clock: stamped by markSettled, re-stamped on every settle.
    // The retention sweep destroys a parked sandbox once this is older
    // than the retention window.
    settledAt: bigint("settled_at", { mode: "number" }),
    // Set once the child's sandbox is actually destroyed (eagerly on a
    // non-hibernating backend, by the retention sweep on a hibernating
    // one). NULL on a settled row means a reclaim is still owed;
    // markSettled clears it so a re-opened child starts a fresh cycle.
    sandboxReclaimedAt: bigint("sandbox_reclaimed_at", { mode: "number" }),
    // Provider sandbox id recorded at park time. The retention sweep needs
    // it for a child evicted from the host cache (an api restart) — the
    // engine session row's sandbox_id is only written at creation, before
    // any sandbox provisions, so it cannot serve as the handle.
    parkedSandboxId: text("parked_sandbox_id"),
  },
  (t) => [
    index("child_watches_parent").on(t.parentSessionId),
    index("child_watches_settled").on(t.settled),
    // Partial index for the retention sweep: rows are never deleted and
    // every historical child ends settled, so the sweep's candidate scan
    // must be bounded by the (small) unreclaimed set, not table history.
    index("child_watches_retention")
      .on(t.settledAt)
      .where(sql`${t.settled} = true AND ${t.sandboxReclaimedAt} IS NULL`),
  ],
);

// ─── Notifications + preferences ────────────────────────────────────────────

export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    urgency: text("urgency").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    href: text("href"),
    sessionId: text("session_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    readAt: bigint("read_at", { mode: "number" }),
  },
  (t) => [index("notifications_user_read").on(t.userId, t.readAt)],
);

// `web` is a plain 0/1 flag (`select({ web: ... })`, read truthily by the
// notification-fanout check) — boolean per decision 7. NOTE for Task 7: the
// insert default flips from `.default(1)` to `.default(true)`, and any
// call site treating the read value as a number (none found by grep at
// task time) must switch to boolean comparison.
export const userNotificationPreferences = pgTable(
  "user_notification_preferences",
  {
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    web: boolean("web").notNull().default(true),
    teamDm: boolean("team_dm").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind] })],
);

// ─── Event drop log ──────────────────────────────────────────────────────────
//
// Durable record of every event/signal rejected by routing or admission
// policy (orchestrator spec, "Policy drops are never invisible"). Reasons
// this phase (Phase 4): hop_budget | edge_denied | pending_cap | child_cap |
// org_ceiling. Phase 6 adds routing-specific reasons (unlinked bindings,
// non-member senders, unbound conversations, trigger-mode filtering) once
// channel routing lands.

export const eventReceipts = pgTable("event_receipts", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  service: text("service").notNull(),
  externalId: text("external_id"),
  metadata: jsonb("metadata").notNull().default({}),
  stages: jsonb("stages").notNull().default([]),
  eventKey: text("event_key"),
  eventId: text("event_id"),
  subscriptions: jsonb("subscriptions").notNull().default([]),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (t) => [index("event_receipts_page").on(t.orgId, t.createdAt, t.id)]);

export const eventDropLog = pgTable(
  "event_drop_log",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    reason: text("reason").notNull(),
    conversationKey: text("conversation_key"),
    /** Normalized key for an event-ingest diagnostic. Null for non-event drops. */
    eventKey: text("event_key"),
    /** Redacted event identity only. Never retain the source payload here. */
    eventMetadata: jsonb("event_metadata"),
    detail: text("detail").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("event_drop_log_org").on(t.orgId),
    index("event_drop_log_page").on(t.orgId, t.createdAt, t.id),
    index("event_drop_log_event_key").on(t.orgId, t.eventKey, t.createdAt),
  ],
);

// ─── Channel bindings + identity links ──────────────────────────────────────
//
// Shapes only (orchestrator spec, "Channel Bindings and Routing") — no
// routing logic lands this phase (Phase 6). One binding per external
// conversation per org is the hard uniqueness rule.

export const channelBindings = pgTable(
  "channel_bindings",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    channelType: text("channel_type").notNull(),
    conversationKey: text("conversation_key").notNull(),
    ownerType: text("owner_type", { enum: ["user", "team", "org"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    sessionId: text("session_id").notNull(),
    threadKeyTemplate: text("thread_key_template").notNull(),
    queueMode: text("queue_mode").notNull(),
    triggerMode: text("trigger_mode", { enum: ["mention", "all"] }).notNull(),
    createdBy: text("created_by", {
      enum: ["user_link", "admin", "agent_outbound"],
    }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("channel_bindings_conversation").on(t.orgId, t.channelType, t.conversationKey),
  ],
);

export const userIdentityLinks = pgTable(
  "user_identity_links",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    notifyAttention: boolean("notify_attention").notNull().default(true),
  },
  (t) => [uniqueIndex("user_identity_links_provider_external").on(t.provider, t.externalId)],
);

// Single-use, short-lived codes for linking an external chat identity to a
// Valet user (deep-link /start flow). Only the sha256 hash is stored.
export const identityLinkCodes = pgTable(
  "identity_link_codes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("identity_link_codes_provider").on(t.provider, t.codeHash)],
);

// One row per provider stream the api has started and not yet stopped.
//
// The engine publishes `text_delta` through `publishEphemeral` — live-only,
// no offset, no replay. An api that dies mid-stream therefore cannot rebuild
// the text, and the reader keeps a message that shimmers forever because
// Slack documents no timeout for an unclosed stream. This table is the
// durable "a stream is open" fact that lets the next boot close it. The text
// itself is not recoverable here and is not meant to be: the `message_end`
// entry in `engine_entries` is the source of truth, and the web UI shows it.
export const channelActiveStreams = pgTable(
  "channel_active_streams",
  {
    channelType: text("channel_type").notNull(),
    conversationKey: text("conversation_key").notNull(),
    /** Provider handle for the streaming message (Slack: chat.startStream's `ts`). */
    messageId: text("message_id").notNull(),
    threadTs: text("thread_ts").notNull(),
    sessionId: text("session_id").notNull(),
    threadId: text("thread_id").notNull(),
    /** Engine message this stream renders. Null until the first message_start. */
    engineMessageId: text("engine_message_id"),
    orgId: text("org_id").notNull(),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({
      name: "channel_active_streams_pk",
      columns: [t.channelType, t.conversationKey, t.messageId],
    }),
    index("channel_active_streams_started").on(t.startedAt),
  ],
);

// ─── Memory (OKF) ────────────────────────────────────────────────────────────
//
// Owner-tuple scoped memory store (decision 13, exact). `search_vector` is a
// `tsvector` GENERATED ALWAYS column — Drizzle's pg-core can't express
// generated-column expressions with weighted `setweight`/`to_tsvector`
// calls, so it's created via raw SQL in `migrations/pg/0000_app.sql`
// (mirrors the old fts5-virtual-table comment: intentionally no Drizzle
// column definition for it here) plus a GIN index. Weights (spec decision
// 9): A=title, B=description, C=path+tags, D=content — path must NOT
// collapse into the same weight class as content, or a path-term match
// ranks like a body mention. The weight-C expression also runs
// `path || ' ' || tags` through `regexp_replace(..., '[^a-zA-Z0-9]+', ' ',
// 'g')` before `to_tsvector` — verified empirically that Postgres's parser
// otherwise classifies a slash-containing string like
// `instruments/xylophone/setup.md` as a single opaque "file" token instead
// of splitting it into searchable words, so a bare path-term query would
// never match (see the migration's comment for the raw tsvector output that
// caught this).
//
// `tags`/`extras` stay `text` (JSON.stringify'd), NOT jsonb: `tags` feeds
// the weight-C generated-column expression as a plain string
// (`coalesce(path,'') || ' ' || coalesce(tags,'')`) — concatenating a jsonb
// array into a tsvector needs an extra unnest/aggregate step Task 9 (memory
// service port) owns; keeping `tags` as text keeps the generated-column
// expression a straight string concat, matching how `ftsTags()` already
// flattens the JSON array to a space-joined string before feeding fts5
// today. `expires`/`updatedAt`/`createdAt` stay bigint ms — the service's
// `expiresMs`/`updatedAtMs` contract (decision 7, named explicitly) reads
// them as plain numbers, never as `Date`.

export const memoryFiles = pgTable(
  "memory_files",
  {
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    path: text("path").notNull(),
    title: text("title").notNull().default(""),
    content: text("content").notNull(),
    type: text("type").notNull().default(""),
    description: text("description").notNull().default(""),
    tags: text("tags").notNull().default("[]"),
    resource: text("resource").notNull().default(""),
    extras: text("extras").notNull().default("{}"),
    sensitivity: text("sensitivity").notNull().default("private"),
    origin: text("origin").notNull().default(""),
    expires: bigint("expires", { mode: "number" }),
    pinned: boolean("pinned").notNull().default(false),
    actorUserId: text("actor_user_id").notNull().default(""),
    sourceSessionId: text("source_session_id").notNull().default(""),
    orgId: text("org_id").notNull().default(""),
    version: integer("version").notNull().default(1),
    /** The content source that mirrors this row, or null on a row the
     * product wrote. A mirrored row lands under `lib/`, which
     * `assertWritablePath` already reserves for mounted libraries, so the
     * product refuses to write it with no new guard.
     *
     * NOT `origin` above: that column is OKF provenance of the fact and is
     * already spent. */
    sourceId: text("source_id"),
    upstreamPath: text("upstream_path"),
    contentSha: text("content_sha"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerType, t.ownerId, t.path] })],
);

// ─── Artifacts ──────────────────────────────────────────────────────────────
//
// Published pages (2026-08-22 artifacts design; extended by the 2026-09-02
// artifact-pages design). A row is a COPY of content at publish time, not a
// live reference — later edits never publish until an explicit re-publish.
// `token` is the unguessable capability in the share URL (`/a/{token}`);
// `visibility` gates who may open it: `org` (a logged-in member of `org_id`)
// or `public` (anyone, only while `orgs.allow_public_artifacts` is on). The
// tool surface can only create `org` rows; widening to `public` is a human UI
// action recorded in `public_by`. Revoke sets `revoked_at` and keeps the row
// for audit; re-publish after revoke mints a fresh token (a leaked link stays
// dead) AND resets visibility to `org` — revoke ends the audience decision
// along with the link, so the tool surface can never restore anonymous
// access.
//
// `format` names the compiler for `content` (the SOURCE): `markdown` compiles
// through GFM at publish, `html` passes verbatim. `rendered` is the compiled
// page body every viewer renders in the sandboxed frame; "" on a pre-pages
// row means "compile `content` on read". `version` counts publishes;
// `shared_version` pins viewers to one `artifact_versions` row (null =
// latest). `source_memory_path` is the PUBLISH KEY: the normalized memory
// path for a `mem_share`, the caller's key for an inline `artifact_publish` —
// not renamed because a rename cannot be rolled back safely under
// SCHEMA_REPAIRS.
export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull(),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    orgId: text("org_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    sourceSessionId: text("source_session_id").notNull().default(""),
    sourceThreadId: text("source_thread_id"),
    sourceMemoryPath: text("source_memory_path").notNull(),
    title: text("title").notNull().default(""),
    content: text("content").notNull(),
    format: text("format", { enum: ["markdown", "html"] }).notNull().default("markdown"),
    rendered: text("rendered").notNull().default(""),
    description: text("description").notNull().default(""),
    icon: text("icon").notNull().default(""),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    sharedVersion: bigint("shared_version", { mode: "number" }),
    visibility: text("visibility", { enum: ["org", "public"] }).notNull().default("org"),
    publicBy: text("public_by"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    revokedAt: bigint("revoked_at", { mode: "number" }),
  },
  (t) => [
    uniqueIndex("artifacts_token_unique").on(t.token),
    // One artifact per publish key: re-publish is an update, never a second row.
    uniqueIndex("artifacts_owner_path_unique").on(t.ownerType, t.ownerId, t.sourceMemoryPath),
  ],
);

// Version history (artifact-pages design). One row per publish, append-only.
// `content` is the source, `rendered` the compiled page body — both captured
// so pinning `shared_version` to an old row needs no recompilation. The
// public read serves exactly one version and takes no version parameter:
// a link holder must never walk the history.
export const artifactVersions = pgTable(
  "artifact_versions",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id").notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    title: text("title").notNull().default(""),
    format: text("format", { enum: ["markdown", "html"] }).notNull().default("markdown"),
    content: text("content").notNull(),
    rendered: text("rendered").notNull().default(""),
    actorUserId: text("actor_user_id").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("artifact_versions_unique").on(t.artifactId, t.version)],
);

// Element-anchored comments on a published page (artifact-pages design).
// `vdid` is the content-hashed element id the viewer's comment runtime
// computes (null = a page-level comment); `version` records what the
// commenter was looking at. `parent_id` threads replies one level under a
// root. `sent_to_session` records delivery of the comment into the source
// session's prompt queue — allowed only when the commenter passes
// `canViewSession` there, so sending grants nothing that typing into the
// session would not. Resolve is a flag, never a delete.
export const artifactComments = pgTable(
  "artifact_comments",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id").notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    vdid: text("vdid"),
    parentId: text("parent_id"),
    body: text("body").notNull(),
    authorUserId: text("author_user_id").notNull(),
    sentToSession: text("sent_to_session"),
    resolvedAt: bigint("resolved_at", { mode: "number" }),
    resolvedBy: text("resolved_by"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("artifact_comments_artifact").on(t.artifactId)],
);

// ─── Skills ─────────────────────────────────────────────────────────────────
//
// Stored skills — the markdown playbooks a person writes in the product, and
// (later) the ones a repository supplies. Plugin skills are NOT here: they
// ship inside plugin packages and are assembled from the manifest, so the
// two sets meet only at delivery time (`plugins/assemble.ts`).
//
// `content` holds the BODY, with the frontmatter already removed, and
// `frontmatter` holds the parsed frontmatter map. The split is what keeps a
// bad row from breaking a session build: delivery reads `name`,
// `description`, and `content` straight from these columns, so it never
// parses and never throws. Every frontmatter rule is checked once, on write
// (`services/skills.ts`).
//
// `content_sha` is the SHA-256 of `content`. The repo importer will compare
// it to decide whether an upstream body changed.
//
// `source_id` names the `contentSources` row this skill is mirrored from.
// It carries no foreign key, and `services/content-sources.ts` deletes the
// mirrored rows with the source.
//
// Ownership columns and the owner index mirror `workflow_definitions` below,
// because skill access follows the same rule: your own rows plus the rows of
// every team you belong to. The UNIQUE index is the backstop for the one
// collision the delivery seam must never see twice — two stored skills with
// one name inside a single owner scope.
export const skills = pgTable(
  "skills",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    ownerType: text("owner_type", { enum: ["user", "team", "org"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    /** `local` = authored in the product. `repo` = synced from a repository. */
    origin: text("origin", { enum: ["local", "repo"] }).notNull(),
    sourceId: text("source_id"),
    name: text("name").notNull(),
    description: text("description").notNull(),
    content: text("content").notNull(),
    frontmatter: jsonb("frontmatter").notNull().default({}),
    contentSha: text("content_sha").notNull(),
    /** Path of the `SKILL.md` inside its repository. Null for a local skill. */
    upstreamPath: text("upstream_path"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("skills_owner").on(t.orgId, t.ownerType, t.ownerId),
    uniqueIndex("skills_owner_name").on(t.orgId, t.ownerType, t.ownerId, t.name),
  ],
);

// Immutable facts for skill adoption and marginal context telemetry.
export const skillInvocations = pgTable(
  "skill_invocations",
  {
    id: text("id").primaryKey(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    orgId: text("org_id").notNull(),
    sessionId: text("session_id").notNull(),
    threadId: text("thread_id").notNull(),
    invokerUserId: text("invoker_user_id"),
    invocationEntryId: text("invocation_entry_id"),
    path: text("path", {
      enum: ["model_tool", "host_thread_skill", "slash_context", "slash_prompt"],
    }).notNull(),
    skillKey: text("skill_key").notNull(),
    skillName: text("skill_name").notNull(),
    storedSkillId: text("stored_skill_id"),
    pluginName: text("plugin_name"),
    origin: text("origin", { enum: ["plugin", "local", "repo"] }).notNull(),
    contentSha: text("content_sha").notNull(),
    injectedCharacters: integer("injected_characters").notNull(),
    estimatedBodyTokens: integer("estimated_body_tokens").notNull(),
  },
  (t) => [
    index("skill_invocations_org_created").on(t.orgId, t.createdAt),
    index("skill_invocations_session_thread_created").on(t.sessionId, t.threadId, t.createdAt),
    index("skill_invocations_skill_created").on(t.skillKey, t.createdAt),
    index("skill_invocations_usage_window").on(t.createdAt, t.sessionId),
  ],
);

export const skillContextAttributions = pgTable(
  "skill_context_attributions",
  {
    skillInvocationId: text("skill_invocation_id").notNull(),
    llmRequestId: text("llm_request_id").notNull(),
    sessionId: text("session_id").notNull(),
    threadId: text("thread_id").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    estimatedSkillTokens: integer("estimated_skill_tokens").notNull(),
  },
  (t) => [primaryKey({ columns: [t.skillInvocationId, t.llmRequestId] }),
    index("skill_context_attributions_window").on(t.createdAt, t.skillInvocationId)],
);

/** What one tracked repository mirrors. `skills` is the kind that ships; the
 * other two join the same rail
 * (`docs/specs/2026-08-24-workflows-mvp-design.md`). */
export type ContentKind = "skills" | "workflows" | "templates" | "memories";

// One tracked repository. A `repo`-origin row in `skills` above is a MIRROR
// of a `SKILL.md` in one of these repositories, and sync is the only thing
// that writes those rows, so a source and the content it carries are created
// and destroyed together.
//
// Do not confuse this row with the engine's `SkillSource` type, which is one
// assembled skill on its way into a session. In prose here, "content source"
// always means the tracked repository.
//
// `kinds` says which content the sync collects. One collector per kind reads
// the same tree, so a repository tracked for two kinds still costs one
// head-commit read per poll — see `services/content-sync/collector.ts`.
//
// `ref` empty means the repository's default branch. `subpath` empty means
// the repository root. Both are part of the UNIQUE key, so one repository can
// be tracked twice from two different subdirectories.
//
// The sync columns are the whole change-detection state: `last_sha` is the
// commit the last sync read, `last_manifest_hash` is a hash over the tracked
// files that commit held, and `discovery_scan` pairs the path-rules version
// with the commit read under it. The compares that use them are in
// `services/content-sync/service.ts`.
//
// `status`/`attempts`/`next_attempt_at`/`last_error` are the sweep's claim
// and retry state, shaped like `event_deliveries` — see
// `services/content-sync/service.ts` for the claim statement and the backoff
// ladder. `last_error` carries whatever the last sync needs to tell the
// reader: the failure for `status='error'`, and the per-file warnings for
// `status='warning'` (a sync that succeeded but skipped a malformed file).
//
// The SQL name stays `skill_sources`, and so do its three indexes. The
// release before this one repairs `skill_sources` by name at boot, so a
// rename would crash-loop the api a rollback lands on.
export const contentSources = pgTable(
  "skill_sources",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    ownerType: text("owner_type", { enum: ["user", "team", "org"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    /** The user who added the source. A UI team source uses this person's
     * GitHub credential. NULL means nobody is named: a pre-column row, or a
     * config-managed `skillsrc_cfg_*` insert (the reconciler has no adding
     * user). A NULL UI team row syncs with no credential. A NULL
     * config-managed team row uses the org App. */
    createdBy: text("created_by"),
    /** `owner/repo`. */
    repoFullName: text("repo_full_name").notNull(),
    /** Branch, tag, or commit. Empty means the default branch. */
    ref: text("ref").notNull().default(""),
    /** Narrows the scan to one directory. Empty scans the whole repository,
     * which is the normal case. */
    subpath: text("subpath").notNull().default(""),
    /** Defaults to skills only, so every row written before workflow sync
     * existed keeps its behavior. */
    kinds: jsonb("kinds").notNull().default(["skills"]).$type<ContentKind[]>(),
    enabled: boolean("enabled").notNull().default(true),
    status: text("status", { enum: ["pending", "ok", "warning", "error"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: bigint("next_attempt_at", { mode: "number" }).notNull(),
    lastSha: text("last_sha"),
    lastManifestHash: text("last_manifest_hash"),
    /** `<rules version>:<sha>` from the last complete sync. NULL when the
     * row predates the column or never synced. A value that does not describe
     * the current head takes no head-commit short-circuit, which is what
     * makes the mechanism survive a release that does not write it. */
    discoveryScan: text("discovery_scan"),
    /** Fences sync completion against newer passes and readiness changes. */
    syncRevision: bigint("sync_revision", { mode: "number" }).notNull().default(0),
    lastSyncedAt: bigint("last_synced_at", { mode: "number" }),
    lastError: text("last_error"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("skill_sources_owner").on(t.orgId, t.ownerType, t.ownerId),
    index("skill_sources_due").on(t.enabled, t.nextAttemptAt),
    uniqueIndex("skill_sources_repo").on(
      t.orgId,
      t.ownerType,
      t.ownerId,
      t.repoFullName,
      t.subpath,
    ),
  ],
);

// ─── Workflows (engine v2 Phase 5) ──────────────────────────────────────────
//
// App-side persistence for the `@valet/workflow` run host (plan decision
// 17). `workflow_runs` is the durable `WorkflowRun` row (park state +
// ownership + immutable-at-start params/definition snapshot);
// `workflow_checkpoints`/`workflow_signals` back the `WorkflowStore` port's
// checkpoint and signal contracts exactly (`packages/api/src/workflows/
// pg-store.ts` implements the port over these three tables plus
// `workflow_definitions`). JSON columns (`definition`, `params`,
// `waiting_on`, `result`, `effects`, `payload`, `consumed_by`) are `jsonb`
// here — decision 7 names "workflow definitions" explicitly, and the same
// read-as-JSON rule extends to every other jsonb column `pg-store.ts`
// touches (written `JSON.stringify`'d, read back already-parsed — see that
// file's doc comment). `error` stays `text` — it's a plain error message
// string, never parsed as JSON.

export const workflowDefinitions = pgTable(
  "workflow_definitions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    ownerType: text("owner_type", { enum: ["user", "team", "org"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    definition: jsonb("definition").notNull(),
    /** `repo` rows mirror one workflow file and are read-only in the product:
     * editing the file is the edit, deleting the file is the delete. */
    origin: text("origin", { enum: ["local", "repo"] }).notNull().default("local"),
    /** The content source that mirrors this row. Null on a `local` row. */
    sourceId: text("source_id"),
    /** Repo-relative path of the file. Identity is (sourceId, upstreamPath)
     * and nothing else — not the name, not any id the file writes — so a
     * rename deletes one workflow and creates another. */
    upstreamPath: text("upstream_path"),
    /** Hash of the mirrored file, so a re-sync can skip an unchanged row. */
    contentSha: text("content_sha"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("workflow_definitions_owner").on(t.orgId, t.ownerType, t.ownerId),
    uniqueIndex("workflow_definitions_source_path")
      .on(t.sourceId, t.upstreamPath)
      .where(sql`"source_id" IS NOT NULL`),
  ],
);

// Immutable snapshot per save: version 1 on create, +1 on every
// update/patch. Reads join through `workflow_definitions` for ownership,
// so no owner columns here.
export const workflowVersions = pgTable(
  "workflow_versions",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id").notNull(),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    definition: jsonb("definition").notNull(),
    /** Which write produced this version, and from which commit. Both null on
     * every version a product edit wrote, and on every row older than the
     * repository mirror. */
    origin: text("origin", { enum: ["local", "repo"] }),
    sourceCommit: text("source_commit"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("workflow_versions_wf_version").on(t.workflowId, t.version)],
);

/**
 * Templates mirrored from a repository. A row is a COPY of one template file,
 * and installing it produces an ordinary `local` workflow the installer may
 * edit. That is the whole difference between a template and a mirrored
 * definition, which stays read-only and keeps syncing.
 */
export const workflowTemplates = pgTable(
  "workflow_templates",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    ownerType: text("owner_type", { enum: ["user", "team", "org"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    /** The id the FILE declares, which the gallery and the install route
     * use. Distinct from `id`, which identifies this row. */
    templateId: text("template_id").notNull(),
    origin: text("origin", { enum: ["local", "repo"] }).notNull().default("local"),
    sourceId: text("source_id"),
    upstreamPath: text("upstream_path").notNull(),
    contentSha: text("content_sha"),
    template: jsonb("template").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    // One template id per owner: the gallery lists by id, and two rows
    // claiming one id would make which one installs undefined.
    uniqueIndex("workflow_templates_owner_template").on(
      t.orgId,
      t.ownerType,
      t.ownerId,
      t.templateId,
    ),
    uniqueIndex("workflow_templates_source_path")
      .on(t.sourceId, t.upstreamPath)
      .where(sql`"source_id" IS NOT NULL`),
  ],
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id").notNull(),
    definitionVersionId: text("definition_version_id").notNull(),
    definition: jsonb("definition").notNull(),
    params: jsonb("params").notNull(),
    status: text("status", {
      enum: ["pending", "running", "parked", "terminalizing", "settled"],
    })
      .notNull()
      .default("pending"),
    outcome: text("outcome", { enum: ["completed", "failed", "cancelled"] }),
    waitingOn: jsonb("waiting_on").notNull().default([]),
    wakeAt: bigint("wake_at", { mode: "number" }),
    // Plain 0/1 flag (`row.wake_requested !== 0` in sqlite-store.ts) — boolean.
    wakeRequested: boolean("wake_requested").notNull().default(false),
    // Named `lease_owner_id` (not `owner_id`) to avoid clashing with the
    // principal-ownership `owner_type`/`owner_id` columns below (plan
    // decision 17).
    leaseOwnerId: text("lease_owner_id"),
    leaseExpiresAt: bigint("lease_expires_at", { mode: "number" }),
    attempt: integer("attempt").notNull().default(0),
    // Principal ownership, resolved from the parent `workflow_definitions`
    // row by the API layer (Task 10) — the `WorkflowStore` port's
    // `createRun(runId, params, ...)` doesn't carry owner info (`RunParams`
    // has no owner fields), so `createRun` writes these defaults, matching
    // `agent_sessions`' pre-owner-column backfill convention; the route
    // handler that starts a run sets the real values in the same insert
    // path once it resolves the workflow's owner.
    ownerType: text("owner_type").notNull().default("user"),
    ownerId: text("owner_id").notNull().default(""),
    // Who clicked Run. Null on a scheduled, event, or webhook start.
    // Display and audit only — credential resolution uses owner_type/owner_id.
    actorUserId: text("actor_user_id"),
    // When the settled-run sandbox reclaim destroyed this run's session
    // sandboxes (workflows/sandbox-reclaim.ts). NULL until the run settles
    // AND every session sandbox is gone — the sweep retries NULL rows.
    sandboxReclaimedAt: bigint("sandbox_reclaimed_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("workflow_runs_status_updated").on(t.status, t.updatedAt),
    index("workflow_runs_workflow").on(t.workflowId),
  ],
);

export const workflowCheckpoints = pgTable(
  "workflow_checkpoints",
  {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    iteration: integer("iteration").notNull().default(0),
    attempt: integer("attempt").notNull(),
    status: text("status", {
      enum: ["intent", "completed", "failed", "skipped"],
    }).notNull(),
    result: jsonb("result"),
    effects: jsonb("effects"),
    error: text("error"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.nodeId, t.iteration] }),
    index("workflow_checkpoints_run").on(t.runId),
  ],
);

export const workflowSignals = pgTable(
  "workflow_signals",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    runId: text("run_id").notNull(),
    signalId: text("signal_id").notNull(),
    signalType: text("signal_type").notNull(),
    payload: jsonb("payload"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    consumedAt: bigint("consumed_at", { mode: "number" }),
    consumedBy: jsonb("consumed_by"),
  },
  (t) => [
    uniqueIndex("workflow_signals_run_signal").on(t.runId, t.signalId),
    index("workflow_signals_run").on(t.runId),
  ],
);

// ─── Credentials (plugin-system-v2 Task 3) ──────────────────────────────────
//
// Durable, encrypted store backing the engine's `CredentialStore` port
// (`packages/engine/src/types.ts`). Secret columns hold AES-256-GCM
// ciphertext produced by `src/lib/secret-crypto.ts` — plaintext tokens are
// never persisted. `scopes`/`metadata` are jsonb, read driver-parsed by
// `plugins/credential-store.ts` (never re-`JSON.parse`'d).

export const credentials = pgTable(
  "credentials",
  {
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    service: text("service").notNull(),
    type: text("type", {
      enum: ["oauth2", "api_key", "bot_token", "service_account", "app_install"],
    }).notNull(),
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    apiKeyEnc: text("api_key_enc"),
    expiresAt: bigint("expires_at", { mode: "number" }),
    scopes: jsonb("scopes"),
    metadata: jsonb("metadata"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerType, t.ownerId, t.service] })],
);

// `mcp_oauth_clients` — one dynamically-registered OAuth client per MCP
// service, shared across all users (integration-OAuth design,
// docs/specs/2026-07-20-integration-oauth-design.md). Never deleted on
// disconnect; if the deployment's public URL changes the registered
// redirect URI goes stale and the recovery is deleting the row.
export const mcpOauthClients = pgTable("mcp_oauth_clients", {
  service: text("service").primaryKey(),
  clientId: text("client_id").notNull(),
  clientSecretEnc: text("client_secret_enc"),
  authorizationEndpoint: text("authorization_endpoint").notNull(),
  tokenEndpoint: text("token_endpoint").notNull(),
  registrationEndpoint: text("registration_endpoint"),
  // The RFC 7591 scope set the client was registered with (sorted). Null on
  // rows registered before scopes support; a declared-scope change
  // re-registers and replaces the row (integration-oauth.ts).
  registeredScopes: jsonb("registered_scopes").$type<string[]>(),
  // What discovery advertised as scopes_supported, captured at registration
  // (or lazily backfilled). Drives the scopeless-entry warning on every
  // connect. [] = the server advertises none; null = not yet captured.
  scopesSupported: jsonb("scopes_supported").$type<string[]>(),
  metadata: jsonb("metadata"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
// ─── Org action-policy engine (action-policies plan, Task 2) ───────────────
//
// Three tables: `action_policies` holds org and team rules. User-principal
// rows remain reserved; personal overrides use `action_policy_overrides`.
// `runtime_grants` (ephemeral "allow for this session/run" quiets, always
// `mode: "allow"`), `action_policy_overrides` (durable per-user overrides).
// All three feed `policies/resolution.ts`'s pure `resolvePolicyDecision` —
// see that module's doc comment for the full precedence order. The
// "exactly one of service/actionId/riskLevel" and "exactly one of
// sessionId/workflowExecutionId" CHECK constraints below are the DB-level
// backstop for `resolution.ts`'s `matchesTarget`/one-of assumptions; a
// service layer (T3-T5) is expected to validate the same shape before
// insert so a bad row never reaches the DB in the first place.

export const actionPolicies = pgTable(
  "action_policies",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    principalType: text("principal_type", { enum: ["org", "user", "team"] }).notNull(),
    principalId: text("principal_id").notNull(),
    service: text("service"),
    actionId: text("action_id"),
    riskLevel: text("risk_level", { enum: ["low", "medium", "high", "critical"] }),
    mode: text("mode", { enum: ["allow", "require_approval", "deny"] }).notNull(),
    paramMatchers: jsonb("param_matchers").notNull().default([]).$type<ParamMatcher[]>(),
    appliesIn: text("applies_in", { enum: ["any", "workflow", "session"] })
      .notNull()
      .default("any"),
    origin: text("origin", {
      enum: ["settings", "approval_prompt", "workflow_editor", "admin"],
    }).notNull(),
    managedBy: text("managed_by"),
    expiresAt: bigint("expires_at", { mode: "number" }),
    revokedAt: bigint("revoked_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("action_policies_org_revoked").on(t.orgId, t.revokedAt),
    check(
      "action_policies_one_of_target",
      sql`((${t.service} is not null)::int + (${t.actionId} is not null)::int + (${t.riskLevel} is not null)::int) = 1`,
    ),
  ],
);

// Ephemeral allow-only grants scoped to a live session or workflow
// execution. Hard-deleted by the owning service on terminal-state
// transition of the parent context (no FK cascade — matches the sibling
// tables' convention of "cascade by code, not by constraint"). `policyKey`
// is the exact `service.actionId` idempotency/match key computed by
// `policies/resolution.ts`'s `grantPolicyKey` — grants quiet ONE exact
// action, not a broader service/risk-level target.
export const runtimeGrants = pgTable(
  "runtime_grants",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    sessionId: text("session_id"),
    workflowExecutionId: text("workflow_execution_id"),
    policyKey: text("policy_key").notNull(),
    mode: text("mode", { enum: ["allow"] }).notNull().default("allow"),
    grantedBy: text("granted_by").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    revokedAt: bigint("revoked_at", { mode: "number" }),
  },
  (t) => [
    check(
      "runtime_grants_one_of_scope",
      sql`((${t.sessionId} is not null)::int + (${t.workflowExecutionId} is not null)::int) = 1`,
    ),
    // Per-scope grant idempotency (mirrors legacy's select-before-insert):
    // partial unique indexes live in migrations/pg/0000_app.sql directly —
    // Drizzle's pg-core `uniqueIndex()` has no portable WHERE clause.
  ],
);

// Durable per-user overrides. Unlike `action_policies` these have no
// `appliesIn`/expiry — a user's override applies everywhere until replaced.
export const actionPolicyOverrides = pgTable(
  "action_policy_overrides",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    service: text("service"),
    actionId: text("action_id"),
    riskLevel: text("risk_level", { enum: ["low", "medium", "high", "critical"] }),
    mode: text("mode", { enum: ["allow", "require_approval", "deny"] }).notNull(),
    paramMatchers: jsonb("param_matchers").notNull().default([]).$type<ParamMatcher[]>(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("action_policy_overrides_org_user").on(t.orgId, t.userId),
    check(
      "action_policy_overrides_one_of_target",
      sql`((${t.service} is not null)::int + (${t.actionId} is not null)::int + (${t.riskLevel} is not null)::int) = 1`,
    ),
  ],
);

// `action_invocations` — durable dedup table for the workflow `tool` node's
// `invokeAction` seam (plugin-system-v2 plan Task 6). `result` is jsonb:
// written by `plugins/action-invoker.ts`, read back driver-parsed.
// A duplicate `invocationId` (crash-and-retry, concurrent
// dispatch) reads back the original row rather than re-invoking the action.
//
// Extended (action-policies plan, Task 2) into a general policy-invocation
// audit log: every column below `createdAt` is new and NULLABLE, so the
// original 3-column workflow-node insert shape (`invocationId`, `result`,
// `createdAt`) keeps working unmodified — see `schema/pg-schema.test.ts`'s
// pinned regression test. `result` itself is relaxed from NOT NULL to
// nullable (an audit row for a denied/rejected invocation has no result
// yet) rather than adding a second column of the same name; existing
// writers always populate it, so this is additive in practice.
// `params`/`result` are capped at 8KB by the writer, with the paired
// `*Truncated` booleans recording when that cap was hit.
export const actionInvocations = pgTable(
  "action_invocations",
  {
    invocationId: text("invocation_id").primaryKey(),
    result: jsonb("result"),
    resultTruncated: boolean("result_truncated"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    service: text("service"),
    actionId: text("action_id"),
    riskLevel: text("risk_level", { enum: ["low", "medium", "high", "critical"] }),
    resolvedMode: text("resolved_mode", { enum: ["allow", "require_approval", "deny"] }),
    baseMode: text("base_mode", { enum: ["allow", "require_approval", "deny"] }),
    matchedPolicyId: text("matched_policy_id"),
    matchedGrantId: text("matched_grant_id"),
    matchedOverrideId: text("matched_override_id"),
    status: text("status", {
      enum: ["pending", "allowed", "denied", "approved", "rejected", "error", "completed", "cancelled", "timeout"],
    }),
    sessionId: text("session_id"),
    workflowExecutionId: text("workflow_execution_id"),
    userId: text("user_id"),
    orgId: text("org_id"),
    params: jsonb("params"),
    paramsTruncated: boolean("params_truncated"),
    durationMs: bigint("duration_ms", { mode: "number" }),
    error: text("error"),
    startedAt: bigint("started_at", { mode: "number" }),
    resolvedBy: text("resolved_by"),
  },
  (t) => [
    index("action_invocations_session").on(t.sessionId),
    index("action_invocations_outcome_time").on(t.orgId, sql`COALESCE(${t.startedAt}, ${t.createdAt})`)
      .where(sql`${t.status} = 'completed' AND ${t.durationMs} IS NOT NULL AND ${t.actionId} IN
        ('github.create_pull_request', 'github.create_review', 'slack.send_message', 'slack.reply_to_origin', 'slack.dm_owner', 'slack.dm_user')`),
    index("action_invocations_org_created").on(t.orgId, t.createdAt),
    index("action_invocations_usage_time").on(t.orgId, sql`COALESCE(${t.startedAt}, ${t.createdAt})`)
      .where(sql`${t.status} IN ('completed', 'error') AND ${t.durationMs} IS NOT NULL`),
  ],
);

// ─── LLM providers (org BYO keys + custom providers) ────────────────────────
//
// One row per org-configured LLM provider. The known kinds
// (`anthropic`/`openai`/`google`/`openrouter`) are per-org singletons —
// enforced here via a partial unique index (Drizzle's pg-core has no
// portable way to express a `WHERE` clause on a `uniqueIndex()`, so it's
// declared in `migrations/pg/0000_app.sql` directly) AND in
// `services/org.ts` / the Task 3-5 provider service (the service-layer
// check is the one tests pin — see task brief). `openai_compatible` rows
// are custom providers and may have any number per org. `models` is
// populated for `openai_compatible` providers (their full declared list)
// and for `openrouter` rows (the admin's curated selection from pi-ai's
// openrouter registry — seeded with `OPENROUTER_DEFAULT_MODEL_IDS` at
// create); the other known kinds resolve their model list from the
// engine's built-in catalog. Read/written as JSON, jsonb per the
// `features` convention above.

export interface LlmProviderModel {
  id: string;
  name: string;
  contextWindow?: number;
  pricing?: { input: number; output: number };
}

export const llmProviders = pgTable(
  "llm_providers",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    kind: text("kind", {
      enum: ["anthropic", "openai", "google", "openrouter", "openai_compatible"],
    }).notNull(),
    name: text("name").notNull(),
    baseUrl: text("base_url"),
    enabled: boolean("enabled").notNull().default(true),
    models: jsonb("models").notNull().default([]).$type<LlmProviderModel[]>(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("llm_providers_org").on(t.orgId)],
);

/** One cached pi-ai model record, as stored. The column is opaque JSON on
 * purpose: it caches a REMOTE payload, so nothing may assume the row is
 * well-formed. `services/model-registry-parse.ts` validates every entry on
 * read before it reaches the catalog. */
export type RegistryCacheModel = unknown;

// The runtime model-registry cache (TKAI-327). One row per pi-ai provider
// id. It holds the catalog fetched from upstream, plus the HTTP validators
// that make the next check a 304. The table is deployment-wide, not
// org-scoped: the upstream registry is the same for every org, so all api
// replicas share one row instead of each process refetching.
//
// This table is a CACHE. Every read has a bundled compile-time fallback
// (`services/model-registry.ts`), so an empty or stale table degrades the
// catalog to the bundled list. It never fails a turn.
export const modelRegistryCache = pgTable("model_registry_cache", {
  providerId: text("provider_id").primaryKey(),
  models: jsonb("models").notNull().default([]).$type<RegistryCacheModel[]>(),
  /** Opaque ETag from the upstream response, kept verbatim (quotes included). */
  etag: text("etag"),
  /** Upstream `Last-Modified`, as epoch ms. */
  lastModified: bigint("last_modified", { mode: "number" }),
  /** When the last upstream check completed, as epoch ms. Null means never. */
  checkedAt: bigint("checked_at", { mode: "number" }),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const llmProxyRequests = pgTable(
  "llm_proxy_requests",
  {
    id: text("id").primaryKey(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id"),
    teamId: text("team_id"),
    apiKeyId: text("api_key_id").notNull(),
    providerKind: text("provider_kind", { enum: ["anthropic", "openai"] }).notNull(),
    model: text("model"),
    harness: text("harness"),
    endpoint: text("endpoint").notNull(),
    providerResponseId: text("provider_response_id"),
    previousResponseId: text("previous_response_id"),
    stream: boolean("stream").notNull(),
    statusCode: integer("status_code").notNull(),
    requestBody: text("request_body").notNull(),
    responseBody: text("response_body"),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull().default(0),
    totalTokens: bigint("total_tokens", { mode: "number" }).notNull().default(0),
    costUsd: doublePrecision("cost_usd"),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    parsed: jsonb("parsed"),
    hourlyAccounted: boolean("hourly_accounted").notNull().default(false),
    parseVersion: integer("parse_version"),
    parseError: text("parse_error"),
  },
  (t) => [index("llm_proxy_requests_org_created").on(t.orgId, t.createdAt),
          index("llm_proxy_requests_user_created").on(t.userId, t.createdAt),
          index("llm_proxy_requests_team_created").on(t.teamId, t.createdAt)],
);

export type LlmProxyRequestRow = typeof llmProxyRequests.$inferSelect;

// ─── Plugin store (docs/specs/2026-08-29-plugin-store-design.md) ───────────
//
// One core table for plugin-owned persistence. `plugin` is the owning
// plugin's name ("valet" for core-owned data, e.g. the entitlement rail);
// `(scope_type, scope_id)` maps `PluginStoreScope` ("" id for global);
// `collection` is the plugin's namespace within its data. `doc` is opaque
// jsonb the plugin validates. Read/written by `services/plugin-store.ts`;
// declared expression indexes ride on top via `ensurePluginStoreIndexes`.
export const pluginStore = pgTable(
  "plugin_store",
  {
    id: text("id").primaryKey(),
    plugin: text("plugin").notNull(),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id").notNull(),
    collection: text("collection").notNull(),
    key: text("key").notNull(),
    doc: jsonb("doc").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("plugin_store_identity_unique").on(
      t.plugin,
      t.scopeType,
      t.scopeId,
      t.collection,
      t.key,
    ),
    index("plugin_store_list").on(t.plugin, t.scopeType, t.scopeId, t.collection),
    index("plugin_store_doc_gin").using("gin", t.doc),
  ],
);

export type PluginStoreRow = typeof pluginStore.$inferSelect;

// ─── Session repo bindings (GitHub/repo integration plan, Task 2) ──────────
//
// One row per repo bound to a session (session-create route accepts
// `repo`/`repos` and inserts a row per binding, position = array order).
// No actual FK to `agent_sessions` — matches sibling tables' convention
// (`session_threads`, `messages`) of a plain indexed `session_id` text
// column with cascade-by-code, not by constraint.
export const sessionRepos = pgTable(
  "session_repos",
  {
    sessionId: text("session_id").notNull(),
    host: text("host").notNull().default("github"),
    fullName: text("full_name").notNull(),
    cloneUrl: text("clone_url").notNull(),
    ref: text("ref"),
    // Immutable startup snapshot; `ref` remains the user-selected branch/tag.
    resolvedRef: text("resolved_ref"),
    auth: text("auth", { enum: ["auto", "app", "user"] })
      .notNull()
      .default("auto"),
    position: integer("position").notNull(),
    // Target directory inside the sandbox workspace for this repo binding.
    // Set ONCE at bind time by the session-create route and never relocated
    // afterward (decision 15 — a binding's target dir is stable for its life).
    // NULL marks a legacy binding created before decision 15 landed.
    targetDir: text("target_dir"),
  },
  (t) => [
    index("session_repos_session").on(t.sessionId),
    uniqueIndex("session_repos_session_position").on(t.sessionId, t.position),
  ],
);

// ─── GitHub App installations (GitHub/repo integration plan, Task 2) ───────
//
// One row per org-linked GitHub App installation. `cachedToken` /
// `cachedTokenExpiresAt` cache the short-lived installation access token
// (encrypted at rest by the writer, like `credentials.*Enc` columns) so
// later tasks (sandbox clone auth) don't mint a new one per request.
export const githubInstallations = pgTable(
  "github_installations",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(),
    repositorySelection: text("repository_selection"),
    suspended: boolean("suspended").notNull().default(false),
    linkedUserId: text("linked_user_id"),
    cachedToken: text("cached_token"),
    cachedTokenExpiresAt: bigint("cached_token_expires_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("github_installations_org_installation").on(t.orgId, t.installationId),
    index("github_installations_org_account").on(t.orgId, t.accountLogin),
  ],
);

// ─── Sandbox image sources + bakes (sandbox-reconciliation plan, Task 13) ──
//
// Two tables replace the old image_catalog/prebuild_configs/prebuilds trio:
//
// `image_sources` — one row per named image source an org has registered.
//   kind='external': a plain external image ref (replaces image_catalog).
//   kind='base': the org's single base image layer (partial unique index).
//   kind='repo': a repo-tied source whose nightly/manual bakes produce the
//     prebuilt sandbox image (replaces prebuild_configs). Partial unique
//     index on (org_id, repo_host, repo_full_name) for kind='repo' only.
//   `parent_id` chains sources (e.g. repo source → base source). Nullable;
//   Task 15 owns real parent-first resolution.
//
// `bakes` — one row per build attempt for a source (replaces prebuilds).
//   `identity_hash` is the recipe-content hash used to detect unnecessary
//   rebuilds; Task 15 populates it with a real hash. This task uses "".
//   `recipe`/`builder_backend` are nullable (unlike old prebuilds) because
//   kind='external'/'base' sources may never bake. `commit_sha` is optional
//   for the same reason.

export const imageSources = pgTable(
  "image_sources",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    kind: text("kind", { enum: ["external", "base", "repo"] }).notNull(),
    parentId: text("parent_id"),
    name: text("name").notNull(),
    // kind='external' fields
    externalRef: text("external_ref"),
    pullSecretName: text("pull_secret_name"),
    // kind='base' fields
    setupCommands: jsonb("setup_commands"),
    // Populated only for kind='base' rows. Identifies which session profile
    // this base image targets. Null for kind='external' and kind='repo'.
    profile: text("profile", { enum: ["headless", "full"] }),
    // kind='repo' fields
    repoHost: text("repo_host"),
    repoFullName: text("repo_full_name"),
    cloneUrl: text("clone_url"),
    sandboxResources: jsonb("sandbox_resources").$type<PrebuildResources>(),
    // Shared scheduling/state
    schedule: text("schedule", { enum: ["nightly", "off"] })
      .notNull()
      .default("nightly"),
    enabled: boolean("enabled").notNull().default(true),
    lastBoundAt: bigint("last_bound_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  // Partial unique indexes are not expressible via Drizzle's uniqueIndex()
  // with a WHERE clause — declared in migrations/pg/0000_app.sql instead
  // (same pattern as llm_providers_org_kind_singleton).
  () => [],
);

export const bakes = pgTable(
  "bakes",
  {
    id: text("id").primaryKey(),
    // ON DELETE CASCADE: dropping a source purges its build history.
    sourceId: text("source_id").notNull(),
    // Recipe-content hash for redundant-rebuild detection (Task 15 owns real
    // hash; this task seeds "" as a placeholder).
    identityHash: text("identity_hash").notNull(),
    // Nullable: kind='external'/'base' bakes may have no commit.
    commitSha: text("commit_sha"),
    imageRef: text("image_ref").notNull(),
    status: text("status", {
      enum: ["queued", "building", "pushed", "failed"],
    }).notNull(),
    // Nullable to match DDL (base/external sources may omit builder details).
    builderBackend: text("builder_backend"),
    recipe: jsonb("recipe"),
    error: text("error"),
    logTail: text("log_tail"),
    startedAt: bigint("started_at", { mode: "number" }),
    finishedAt: bigint("finished_at", { mode: "number" }),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("bakes_source_status_created").on(t.sourceId, t.status, t.createdAt)],
);

// ─── Event system (event-system plan, Task 3) ───────────────────────────────
//
// Four tables: `events` (the canonical deduped event record), `event_subscriptions`
// (org-owned subscriptions with pattern-matching + filters), `event_deliveries`
// (per-subscription delivery tracking with retry state), `linear_installations`
// (Linear workspace OAuth installs, analogous to `github_installations`).

export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    service: text("service").notNull(),
    eventKey: text("event_key").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    actor: jsonb("actor"),
    refs: jsonb("refs").notNull().default({}),
    summary: text("summary").notNull(),
    payload: jsonb("payload").notNull(),
    occurredAt: bigint("occurred_at", { mode: "number" }).notNull(),
    receivedAt: bigint("received_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("events_service_dedupe").on(t.service, t.dedupeKey),
    index("events_org_received").on(t.orgId, t.receivedAt),
    index("events_org_key").on(t.orgId, t.eventKey),
  ],
);

export const eventSubscriptions = pgTable(
  "event_subscriptions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    ownerType: text("owner_type", { enum: ["user", "team", "org"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    /** Event key patterns; trailing `.*` wildcard supported (e.g. "github.pull_request.*"). */
    eventKeys: jsonb("event_keys").notNull(),
    /** `{ field, op: "eq"|"in"|"prefix"|"contains", value }[]` over catalog-declared fields. */
    filters: jsonb("filters").notNull().default([]),
    /** `{ kind: "workflow", workflowId } | { kind: "orchestrator" } | { kind: "signal" }`. */
    target: jsonb("target").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** Who may invoke a team assistant by mention. Null reads as `team` —
     * the meaning every row written before this column carries. Only a team
     * assistant target may set it (`events/mention-scope.ts`). */
    audience: text("audience", { enum: ["team", "organization"] }),
    /** `repo` rows are armed from a mirrored workflow file. The sync updates
     * and deletes only these, so a subscription a person armed on the same
     * workflow is never touched. */
    origin: text("origin", { enum: ["local", "repo"] }).notNull().default("local"),
    createdBy: text("created_by").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("event_subscriptions_org_enabled").on(t.orgId, t.enabled)],
);

/**
 * A Slack thread the assistant follows: once bound (by a follow-enabled
 * mention), later messages in the thread route to the bound owner's assistant
 * without a re-mention. One row per `(org, channel, thread)`.
 */
export const followedThreads = pgTable(
  "followed_threads",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    channelType: text("channel_type").notNull(),
    channelId: text("channel_id").notNull(),
    threadTs: text("thread_ts").notNull(),
    ownerType: text("owner_type", { enum: ["user", "team", "org"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    lastActivityAt: bigint("last_activity_at", { mode: "number" }).notNull(),
    /** Provider ts of the last message delivered through this follow. The
     * follow-router hydrates the gap between this and a new message, so an
     * overheard line after downtime arrives with the missed context. Null on
     * rows from before the column: the first delivery starts tracking. */
    lastSeenTs: text("last_seen_ts"),
    /** The assistant that answered the mention this follow was bound from, so
     * later messages in the thread reach the SAME assistant rather than the
     * owner's default. Null on rows from before the column, and on any follow
     * whose rule named no assistant — both read as "the owner's default". */
    /** The mention rule this thread was bound from. The follow router reads
     * that row's CURRENT invocation audience, because the audience is the
     * rule's state, not the conversation's: narrowing a rule back to the team
     * must narrow every thread it opened. Null on a follow bound before the
     * column, and on one no mention rule bound; both read as team-only. */
    subscriptionId: text("subscription_id"),
  },
  (t) => [uniqueIndex("followed_threads_key").on(t.orgId, t.channelType, t.channelId, t.threadTs)],
);

// Workflow schedules — cron-driven run starts (the time-based counterpart
// of `{kind:"workflow"}` event subscriptions). `next_fire_at` is
// PRECOMPUTED at write time and after every fire so the scheduler's poll
// is one indexed range scan; `cron` is a 5-field expression evaluated in
// `timezone` (IANA name, default UTC). Missed occurrences (downtime)
// collapse into ONE catch-up fire — the scheduler advances from `now`, not
// from the missed slot, so a weekend outage doesn't replay 200 runs.
export const workflowSchedules = pgTable(
  "workflow_schedules",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    ownerType: text("owner_type", { enum: ["user", "team", "org"] }).notNull().default("user"),
    ownerId: text("owner_id").notNull(),
    /** Fire target: start a workflow run, or prompt the orchestrator
     * (V1's `schedule_target=orchestrator`). `workflow_id`/`prompt` are
     * each required only for their own kind. */
    targetKind: text("target_kind", { enum: ["workflow", "orchestrator"] })
      .notNull()
      .default("workflow"),
    workflowId: text("workflow_id"),
    /** Prompt submitted to the orchestrator's "schedules" thread when
     * `target_kind = 'orchestrator'`. */
    prompt: text("prompt"),
    /** Which of the owner's assistants the prompt goes to, when
     * `target_kind = 'orchestrator'`. Null on rows from before the column, and
     * on any schedule that named none — both read as "the owner's default".
     * Ignored for a `workflow` target, which has no assistant. */
    name: text("name").notNull(),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    /** Optional static payload delivered as `trigger.data.input`. */
    input: jsonb("input"),
    enabled: boolean("enabled").notNull().default(true),
    /** `repo` rows are armed from a mirrored workflow file. The sync updates
     * and deletes only these, so a schedule a person armed on the same
     * workflow is never touched. */
    origin: text("origin", { enum: ["local", "repo"] }).notNull().default("local"),
    lastFiredAt: bigint("last_fired_at", { mode: "number" }),
    nextFireAt: bigint("next_fire_at", { mode: "number" }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("workflow_schedules_due").on(t.enabled, t.nextFireAt),
    index("workflow_schedules_workflow").on(t.workflowId),
  ],
);

// The bearer secret IS the primary key: `id` is the opaque hookId minted
// into the trigger URL (`POST /api/hooks/workflows/:workflowId/:hookId`),
// not a surrogate row id. `workflow_id` is unique — one active hook per
// workflow — so minting again replaces the row and invalidates the old
// URL (overhaul design decision 5's "regenerable").
export const workflowWebhooks = pgTable(
  "workflow_webhooks",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id").notNull(),
    orgId: text("org_id").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("workflow_webhooks_workflow").on(t.workflowId)],
);

export const eventDeliveries = pgTable(
  "event_deliveries",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    subscriptionId: text("subscription_id").notNull(),
    status: text("status", { enum: ["pending", "delivered", "failed", "dead", "skipped"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: bigint("next_attempt_at", { mode: "number" }).notNull(),
    lastError: text("last_error"),
    deliveredAt: bigint("delivered_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("event_deliveries_due").on(t.status, t.nextAttemptAt),
    index("event_deliveries_event").on(t.eventId),
  ],
);

export const linearInstallations = pgTable(
  "linear_installations",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    workspaceName: text("workspace_name").notNull(),
    webhookId: text("webhook_id"),
    connectedBy: text("connected_by").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("linear_installations_org_workspace").on(t.orgId, t.workspaceId)],
);

// ─── Inferred row types ─────────────────────────────────────────────────────

export type OrgRow = typeof orgs.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof session.$inferSelect;
export type AccountRow = typeof account.$inferSelect;
export type VerificationRow = typeof verification.$inferSelect;
export type SsoProviderRow = typeof ssoProvider.$inferSelect;
export type ApikeyRow = typeof apikey.$inferSelect;
export type OauthApplicationRow = typeof oauthApplication.$inferSelect;
export type OauthAccessTokenRow = typeof oauthAccessToken.$inferSelect;
export type OauthConsentRow = typeof oauthConsent.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;
export type SandboxTokenRow = typeof sandboxTokens.$inferSelect;
export type OrgMemberRow = typeof orgMembers.$inferSelect;
export type AgentSessionRow = typeof agentSessions.$inferSelect;
export type SessionThreadRow = typeof sessionThreads.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type TeamRow = typeof teams.$inferSelect;
export type TeamMemberRow = typeof teamMembers.$inferSelect;
export type TeamJoinEligibilityRow = typeof teamJoinEligibilities.$inferSelect;
export type AssistantRow = typeof assistants.$inferSelect;
export type ChildWatchRow = typeof childWatches.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type UserNotificationPreferenceRow = typeof userNotificationPreferences.$inferSelect;
export type EventDropLogRow = typeof eventDropLog.$inferSelect;
export type ChannelBindingRow = typeof channelBindings.$inferSelect;
export type UserIdentityLinkRow = typeof userIdentityLinks.$inferSelect;
export type IdentityLinkCodeRow = typeof identityLinkCodes.$inferSelect;
export type ChannelActiveStreamRow = typeof channelActiveStreams.$inferSelect;
export type MemoryFileRow = typeof memoryFiles.$inferSelect;
export type SkillRow = typeof skills.$inferSelect;
/** One tracked repository. Not the engine's `SkillSource`. */
export type ContentSourceRow = typeof contentSources.$inferSelect;
export type WorkflowDefinitionRow = typeof workflowDefinitions.$inferSelect;
export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type WorkflowCheckpointRow = typeof workflowCheckpoints.$inferSelect;
export type WorkflowSignalRow = typeof workflowSignals.$inferSelect;
export type CredentialRow = typeof credentials.$inferSelect;
export type ActionPolicyRow = typeof actionPolicies.$inferSelect;
export type RuntimeGrantRow = typeof runtimeGrants.$inferSelect;
export type ActionPolicyOverrideRow = typeof actionPolicyOverrides.$inferSelect;
export type ActionInvocationRow = typeof actionInvocations.$inferSelect;
export type LlmProviderRow = typeof llmProviders.$inferSelect;
export type ModelRegistryCacheRow = typeof modelRegistryCache.$inferSelect;
export type SessionRepoRow = typeof sessionRepos.$inferSelect;
export type GithubInstallationRow = typeof githubInstallations.$inferSelect;
export type ImageSourceRow = typeof imageSources.$inferSelect;
export type BakeRow = typeof bakes.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type EventSubscriptionRow = typeof eventSubscriptions.$inferSelect;
export type EventDeliveryRow = typeof eventDeliveries.$inferSelect;
export type LinearInstallationRow = typeof linearInstallations.$inferSelect;

// ── Valet Security (docs/specs/2026-08-27-valet-security-design.md) ───────
//
// One engagement per kind='security' session; cells dispatch persona child
// sessions; security_files is the append-only engagement tree.

export const securityEngagements = pgTable(
  "security_engagements",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    status: text("status", {
      enum: ["planning", "running", "completed", "failed", "cancelled"],
    })
      .notNull()
      .default("planning"),
    repoFullName: text("repo_full_name").notNull(),
    // Pinned at sec_start to a resolved commit SHA so every persona reads
    // an identical tree. Empty while planning.
    repoRef: text("repo_ref").notNull().default(""),
    // Engagement plan YAML — the note's orchestration.yml. Immutable once
    // the engagement is running.
    plan: text("plan").notNull().default(""),
    // The prior engagement this one re-scans (re-scan / iterate). Null on a
    // first review; set to the parent engagement id on a re-scan. No unique
    // constraint — a parent may be re-scanned any number of times.
    parentEngagementId: text("parent_engagement_id"),
    // Diff-scoped re-scan (re-scan / iterate). Set only on a re-scan whose
    // parent had a pinned SHA. `base_ref` is the parent's pinned SHA the diff
    // ran against (base); `changed_paths` is the JSON array of changed file
    // paths from the GitHub compare (base..new HEAD). Both null on a first
    // review, or on a re-scan that fell back to a full scan (compare failed,
    // or the parent had no pinned SHA).
    baseRef: text("base_ref"),
    changedPaths: text("changed_paths"),
    // Repo config context (dynamic-config M-F1): parsed from `.valet/security.yml`
    // at create, stored for later milestones. `hasRepoConfig` records whether a
    // valid repo config seeded this engagement (the panel shows the source); the
    // other columns hold the config's context. `focus` is free text; the rest are
    // JSON. Null on an engagement seeded from a preset (no repo config, or the
    // config was absent/invalid).
    focus: text("focus"),
    invariants: text("invariants"),
    categories: text("categories"),
    configPersonas: text("config_personas"),
    // Repo-defined persona role markdown, fetched from the clone through the
    // GitHub contents API at create (M-P2c). JSON Record id → markdown. Keyed
    // by the same ids as `configPersonas` (which holds id → path). The host's
    // `securityRolesForCell` reads this at persona-child build so a repo persona
    // runs under its OWN role, not the code-review fallback. Null when the
    // config declares no personas, or none of the declared files were readable.
    configPersonaMarkdown: text("config_persona_markdown"),
    // Declared tools (M-P4a): the config's `tools` list as a JSON `ToolDecl[]`
    // (id + optional install/image/mcp/egress). The host provisions a persona
    // child's declared tools from this at build. Null when the config declares
    // no tools.
    configTools: text("config_tools"),
    // Authorized live-testing scope (M-P4b): the config's `scope` as a JSON
    // `{ hosts: string[] }`. The live personas (dast/fuzz/exploit) may reach
    // ONLY these hosts; the dispatch prompt names them, and the child sandbox's
    // egress allowlist is derived from them. Null when the config declares no
    // scope (no live testing is authorized).
    authorizedScope: text("authorized_scope"),
    hasRepoConfig: boolean("has_repo_config").notNull().default(false),
    // The report artifact (M-P3): the report cell writes both with
    // `sec_report_write`, and the panel/export surface them. `reportMarkdown`
    // is the multi-audience markdown report; `reportJson` is a machine-readable
    // JSON snapshot (stored as a JSON string). `reportGeneratedAt` is the
    // write time. All null until the report cell runs.
    reportMarkdown: text("report_markdown"),
    reportJson: text("report_json"),
    reportGeneratedAt: bigint("report_generated_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("security_engagements_session_unique").on(t.sessionId),
    index("security_engagements_parent").on(t.parentEngagementId),
  ],
);

export const securityCells = pgTable(
  "security_cells",
  {
    id: text("id").primaryKey(),
    engagementId: text("engagement_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    persona: text("persona").notNull(),
    mode: text("mode", { enum: ["fresh", "resume"] }).notNull().default("fresh"),
    goal: text("goal").notNull(),
    // Stable engagement-tree directory slug ("01-recon"), stamped at
    // sec_start so dispatch prompts can name literal paths.
    dir: text("dir").notNull(),
    // JSON array of earlier ordinals whose state docs this cell's dispatch
    // prompt names (the plan's DAG edges — selective context).
    reads: text("reads").notNull().default("[]"),
    // Grants sec_finding_review to this cell's persona. Only review cells
    // may flip finding statuses.
    review: boolean("review").notNull().default(false),
    status: text("status", {
      enum: ["pending", "running", "completed", "yielded", "failed"],
    })
      .notNull()
      .default("pending"),
    // Why a cell reached its terminal status — set when dispatchCell fails a
    // cell for exhausting the attempt cap (fix 5). Null on a normally-settled
    // cell. Surfaced on the cell rail so a human sees why it stopped.
    statusReason: text("status_reason"),
    attempts: integer("attempts").notNull().default(0),
    // Stamped by the compaction hook when the claiming child's thread
    // compacts — surfaced as a badge on the cell rail, never auto-repaired.
    compactedAt: bigint("compacted_at", { mode: "number" }),
    childSessionId: text("child_session_id"),
    dispatchedAt: bigint("dispatched_at", { mode: "number" }),
    settledAt: bigint("settled_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("security_cells_engagement_ordinal_unique").on(t.engagementId, t.ordinal),
    index("security_cells_child_session").on(t.childSessionId),
  ],
);

export const securityFiles = pgTable(
  "security_files",
  {
    id: text("id").primaryKey(),
    engagementId: text("engagement_id").notNull(),
    // Owning cell — the path-prefix write claim resolves through it.
    cellId: text("cell_id").notNull(),
    path: text("path").notNull(),
    // Append-only: a write to an existing path inserts revision + 1.
    revision: integer("revision").notNull(),
    content: text("content").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("security_files_path_revision_unique").on(t.engagementId, t.path, t.revision),
  ],
);

export const securityFindings = pgTable(
  "security_findings",
  {
    id: text("id").primaryKey(),
    engagementId: text("engagement_id").notNull(),
    cellId: text("cell_id").notNull(),
    // sha256(file, line bucket, normalized title) first 16 hex — advisory
    // dedup and the manifest's distinct counts.
    fingerprint: text("fingerprint").notNull(),
    severity: text("severity", {
      enum: ["critical", "high", "medium", "low", "info"],
    }).notNull(),
    title: text("title").notNull(),
    file: text("file"),
    line: integer("line"),
    body: text("body").notNull().default(""),
    // Forward-only: open → verified | refuted | fixed, and verified → fixed. No
    // route mutates the other columns after insert ("verifier flips bits, never
    // rewrites"). `fixed` = the finding was real and is now resolved (re-scan
    // v2); distinct from `refuted` = a false positive.
    status: text("status", { enum: ["open", "verified", "refuted", "fixed"] })
      .notNull()
      .default("open"),
    statusReason: text("status_reason"),
    // Cell id or `user:<id>` — who flipped the status.
    statusActor: text("status_actor"),
    // Re-scan v2 (re-scan / iterate): true when this finding was carried from
    // the parent engagement at re-scan start, or a diff-sweep re-report matched
    // a carried fingerprint. A first review's rows are all false.
    recurring: boolean("recurring").notNull().default(false),
    // The parent engagement's finding this row was seeded from (re-scan v2), so
    // provenance is traceable. Null on a first-seen finding.
    carriedFromFindingId: text("carried_from_finding_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("security_findings_engagement").on(t.engagementId)],
);

export const securityFindingLinks = pgTable(
  "security_finding_links",
  {
    id: text("id").primaryKey(),
    findingId: text("finding_id").notNull(),
    engagementId: text("engagement_id").notNull(),
    provider: text("provider", { enum: ["github", "linear"] }).notNull(),
    externalId: text("external_id").notNull(),
    url: text("url").notNull(),
    // Always a user id — only humans file issues (spec Decision 10).
    createdBy: text("created_by").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    // The idempotency guard: one issue per finding per provider.
    uniqueIndex("security_finding_links_provider_unique").on(t.findingId, t.provider),
  ],
);

export const securityHandoffs = pgTable(
  "security_handoffs",
  {
    id: text("id").primaryKey(),
    engagementId: text("engagement_id").notNull(),
    findingId: text("finding_id").notNull(),
    // The spawned fix session — opened through the child slide-over.
    childSessionId: text("child_session_id").notNull(),
    title: text("title").notNull(),
    // The optional extra instruction the runner passed to sec_handoff.
    task: text("task"),
    createdBy: text("created_by").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  // No unique constraint: a finding may spawn several fix sessions.
  (t) => [
    index("security_handoffs_engagement").on(t.engagementId),
    index("security_handoffs_finding").on(t.findingId),
  ],
);

export const securityFindingComments = pgTable(
  "security_finding_comments",
  {
    id: text("id").primaryKey(),
    findingId: text("finding_id").notNull(),
    engagementId: text("engagement_id").notNull(),
    body: text("body").notNull(),
    // Always a user id — commenting is a human triage action (spec §Re-scan /
    // iterate). The runner and personas never comment through this route.
    authorUserId: text("author_user_id").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  // No unique constraint: a finding may carry a thread of many comments.
  (t) => [
    index("security_finding_comments_finding").on(t.findingId),
    index("security_finding_comments_engagement").on(t.engagementId),
  ],
);

// One row per coverage claim a persona records (NOT_ASSESSED ledger, M-P2d,
// spec §Coverage honesty). `status` is `assessed` when a check ran or
// `not_assessed` when its tool was absent; a not_assessed row carries a
// `reason` naming the consequence ("secrets not scanned because gitleaks is
// missing"). Insert-only, no unique constraint — a cell records one row per
// area it covered or skipped. The close manifest rolls these into an
// assessed/not_assessed count plus the gap list.
export const securityCoverage = pgTable(
  "security_coverage",
  {
    id: text("id").primaryKey(),
    engagementId: text("engagement_id").notNull(),
    // The cell that recorded the coverage — the persona's claim.
    cellId: text("cell_id").notNull(),
    // What was in scope, e.g. "secrets scan", "semgrep owasp".
    area: text("area").notNull(),
    status: text("status", { enum: ["assessed", "not_assessed"] }).notNull(),
    // The tool involved (gitleaks, semgrep, …). Null when no specific tool
    // backs the area.
    tool: text("tool"),
    // The consequence / why-not. Required for not_assessed (the service and
    // route reject a not_assessed without one); null for an assessed row.
    reason: text("reason"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("security_coverage_engagement").on(t.engagementId),
    index("security_coverage_cell").on(t.cellId),
  ],
);

// One row per need a persona records (pivot-coordinator + needs loop, M-P4c,
// spec §Pivot-coordinator). During a sweep a persona that cannot go deeper —
// it lacks a credential, a running dependency, a scope expansion, or an
// out-of-band decision — records a structured need instead of stopping (a
// silent gap) or blocking a human per item. The coordinator auto-resolves
// what is unambiguously already-authorized (a declared tool, an in-scope
// item), batches the rest into ONE consolidated human ask, then re-runs only
// the affected cells. `kind` classes the need; `status` tracks it through the
// loop; `resolution` records the auto-resolution note or the human answer.
// Insert-only rows, forward status. No unique constraint — a cell may record
// several needs.
export const securityNeeds = pgTable(
  "security_needs",
  {
    id: text("id").primaryKey(),
    engagementId: text("engagement_id").notNull(),
    // The cell that recorded the need — the persona's claim. The delta re-run
    // resets this cell to pending once its need is answered.
    cellId: text("cell_id").notNull(),
    // What class of thing is blocked: a 'credential', a running 'dependency',
    // a 'scope' expansion, an out-of-band 'decision', or a 'tool' to provision.
    kind: text("kind", {
      enum: ["credential", "dependency", "scope", "decision", "tool"],
    }).notNull(),
    description: text("description").notNull(),
    // 'open' when recorded; the coordinator flips it to 'auto_resolved' (an
    // already-authorized item), 'needs_human' (the consolidated ask), then
    // 'answered' (the human resolved it). 'dismissed' is a human no-op.
    status: text("status", {
      enum: ["open", "auto_resolved", "needs_human", "answered", "dismissed"],
    })
      .notNull()
      .default("open"),
    // The auto-resolution note or the human answer. Null while open/needs_human.
    resolution: text("resolution"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    resolvedAt: bigint("resolved_at", { mode: "number" }),
  },
  (t) => [
    index("security_needs_engagement").on(t.engagementId),
    index("security_needs_cell").on(t.cellId),
  ],
);

export type SecurityEngagementRow = typeof securityEngagements.$inferSelect;
export type SecurityCellRow = typeof securityCells.$inferSelect;
export type SecurityFileRow = typeof securityFiles.$inferSelect;
export type SecurityFindingRow = typeof securityFindings.$inferSelect;
export type SecurityFindingLinkRow = typeof securityFindingLinks.$inferSelect;
export type SecurityHandoffRow = typeof securityHandoffs.$inferSelect;
export type SecurityFindingCommentRow = typeof securityFindingComments.$inferSelect;
export type SecurityCoverageRow = typeof securityCoverage.$inferSelect;
export type SecurityNeedRow = typeof securityNeeds.$inferSelect;

// ── Ratings (TKAI-334) ─────────────────────────────────────────────────────
// Thumbs up/down feedback. One table, polymorphic target: a session-level
// rating (`target_type = 'session'`, target_id = session id) is the primary
// eval-seeding signal; an entry-level rating (`target_type = 'entry'`,
// target_id = engine entry id) is finer-grained debugging data. One rating
// per (user, target); re-rating updates the row, null clears it.
export const ratings = pgTable(
  "ratings",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    targetType: text("target_type", { enum: ["session", "entry"] }).notNull(),
    targetId: text("target_id").notNull(),
    sessionId: text("session_id").notNull(),
    // Engine thread holding the rated entry. Null for session-level rows.
    threadId: text("thread_id"),
    rating: text("rating", { enum: ["positive", "negative"] }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("ratings_user_target").on(t.userId, t.targetType, t.targetId),
    index("ratings_session").on(t.sessionId),
    index("ratings_type_rating").on(t.targetType, t.rating),
  ],
);

export type RatingRow = typeof ratings.$inferSelect;

/** One pending decision per team resource. Expiry is interpreted on read. */
export const teamDeletionRequests = pgTable("team_deletion_requests", {
  id: text("id").primaryKey(), orgId: text("org_id").notNull(), teamId: text("team_id").notNull(),
  resourceType: text("resource_type").$type<"workflow" | "skill" | "content_source" | "credential" | "api_key" | "team">().notNull(),
  resourceId: text("resource_id").notNull(), resourceLabel: text("resource_label").notNull(),
  requestedBy: text("requested_by").notNull(), reason: text("reason"),
  requestedAt: bigint("requested_at", { mode: "number" }).notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  status: text("status").$type<"pending" | "approved" | "declined" | "withdrawn">().notNull().default("pending"),
  decidedBy: text("decided_by"), decidedAt: bigint("decided_at", { mode: "number" }),
  decisionNote: text("decision_note"), lastRefusal: text("last_refusal"),
}, (t) => [
  uniqueIndex("team_deletion_requests_pending").on(t.teamId, t.resourceType, t.resourceId).where(sql`${t.status} = 'pending'`),
  index("team_deletion_requests_team_status").on(t.teamId, t.status),
]);

/** Database-maintained projection. The migration owns its source FK and trigger. */
export const usageEntryFacts = pgTable("usage_entry_facts", {
  entryId: text("entry_id").primaryKey(),
  sessionId: text("session_id").notNull(),
  workflowRunId: text("workflow_run_id"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  model: text("model"),
  usage: jsonb("usage"),
  cost: jsonb("cost"),
  hourlyAccounted: boolean("hourly_accounted").notNull().default(false),
  toolCalls: bigint("tool_calls", { mode: "number" }).notNull(),
  pullRequests: bigint("pull_requests", { mode: "number" }).notNull(),
  reviews: bigint("reviews", { mode: "number" }).notNull(),
}, (t) => [
  index("usage_entry_facts_window").on(t.createdAt, t.sessionId),
  index("usage_entry_facts_cost_window").on(t.createdAt, t.sessionId).where(sql`${t.usage} IS NOT NULL`),
  index("usage_entry_facts_tools_window").on(t.createdAt, t.sessionId).where(sql`${t.toolCalls} > 0`),
  index("usage_entry_facts_outcomes_window").on(t.createdAt, t.sessionId).where(sql`${t.pullRequests} > 0 OR ${t.reviews} > 0`),
  index("usage_entry_facts_session_window").on(t.sessionId, t.createdAt),
  index("usage_entry_facts_workflow_window").on(t.workflowRunId, t.createdAt).where(sql`${t.workflowRunId} IS NOT NULL`),
]);

/** Exact hourly source totals. Ownership is resolved through the summary view. */
export const usageHourly = pgTable("usage_hourly", {
 dimensions: jsonb("dimensions").notNull(), sourceKind: text("source_kind").notNull(),
 sessionId:text("session_id"),orgId:text("org_id"),userId:text("user_id"),teamId:text("team_id"),
 model:text("model"),provider:text("provider"),createdAt:bigint("created_at",{mode:"number"}).notNull(),
 turns:bigint("turns",{mode:"number"}).notNull(),
 unpricedTurns:bigint("unpriced_turns",{mode:"number"}).notNull(),
 positiveTurns:bigint("positive_turns",{mode:"number"}).notNull(),
 inputTokens:bigint("input_tokens",{mode:"number"}).notNull(),
 outputTokens:bigint("output_tokens",{mode:"number"}).notNull(),
 cacheReadTokens:bigint("cache_read_tokens",{mode:"number"}).notNull(),
 cacheWriteTokens:bigint("cache_write_tokens",{mode:"number"}).notNull(),
 totalTokens:bigint("total_tokens",{mode:"number"}).notNull(),
 toolCalls:bigint("tool_calls",{mode:"number"}).notNull(),
 pullRequests:bigint("pull_requests",{mode:"number"}).notNull(),
 reviews:bigint("reviews",{mode:"number"}).notNull(),
 costTotal:numeric("cost_total").notNull(),
},t=>[primaryKey({columns:[t.dimensions,t.createdAt]}),
 index("usage_hourly_window").on(t.createdAt,t.sessionId),
 index("usage_hourly_session_window").on(t.sessionId,t.createdAt),
 index("usage_hourly_org_window").on(t.orgId,t.createdAt),
 index("usage_hourly_outcomes").on(t.createdAt,t.sessionId).where(sql`${t.pullRequests}>0 OR ${t.reviews}>0`),
 index("usage_hourly_empty").on(t.createdAt).where(sql`${t.turns}=0 AND ${t.toolCalls}=0 AND ${t.pullRequests}=0 AND ${t.reviews}=0`)]);

export const usageActionFacts = pgTable("usage_action_facts", {
  invocationId: text("invocation_id").primaryKey().references(() => actionInvocations.invocationId, { onDelete: "cascade" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  orgId: text("org_id"),
  sessionId: text("session_id"),
  workflowExecutionId: text("workflow_execution_id"),
  toolCalls: bigint("tool_calls", { mode: "number" }).notNull(),
  outcomeKind: text("outcome_kind"),
}, t => [
  index("usage_action_facts_window").on(t.orgId, t.createdAt)
]);

export const usageActionHourly = pgTable("usage_action_hourly", {
  dimensionKey: text("dimension_key").notNull(),
  hourMs: bigint("hour_ms", { mode: "number" }).notNull(),
  orgId: text("org_id"),
  sessionId: text("session_id"),
  workflowExecutionId: text("workflow_execution_id"),
  outcomeKind: text("outcome_kind"),
  toolCalls: bigint("tool_calls", { mode: "number" }).notNull(),
  outcomes: bigint("outcomes", { mode: "number" }).notNull(),
  facts: bigint("facts", { mode: "number" }).notNull(),
}, t => [
  primaryKey({ columns: [t.dimensionKey, t.hourMs] }),
  index("usage_action_hourly_window").on(t.orgId, t.hourMs)
]);

export const usageSkillFacts = pgTable("usage_skill_facts", {
  factKey: text("fact_key").primaryKey(),
  invocationId: text("invocation_id").notNull().references(() => skillInvocations.id, { onDelete: "cascade" }),
  requestId: text("request_id"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  sessionId: text("session_id").notNull(),
  skillKey: text("skill_key").notNull(),
  skillName: text("skill_name").notNull(),
  origin: text("origin").notNull(),
  pluginName: text("plugin_name"),
  invokerUserId: text("invoker_user_id"),
  tokens: bigint("tokens", { mode: "number" }).notNull(),
  invoked: bigint("invoked", { mode: "number" }).notNull(),
}, t => [
  index("usage_skill_facts_window").on(t.createdAt),
  index("usage_skill_facts_session_window").on(t.sessionId, t.createdAt),
  index("usage_skill_facts_invocation").on(t.invocationId)
]);

export const usageSkillHourly = pgTable("usage_skill_hourly", {
  dimensionKey: text("dimension_key").notNull(),
  hourMs: bigint("hour_ms", { mode: "number" }).notNull(),
  sessionId: text("session_id").notNull(),
  skillKey: text("skill_key").notNull(),
  skillName: text("skill_name").notNull(),
  origin: text("origin").notNull(),
  pluginName: text("plugin_name"),
  invokerUserId: text("invoker_user_id"),
  tokens: bigint("tokens", { mode: "number" }).notNull(),
  invocations: bigint("invocations", { mode: "number" }).notNull(),
  carryingCalls: bigint("carrying_calls", { mode: "number" }).notNull(),
  facts: bigint("facts", { mode: "number" }).notNull(),
}, t => [
  primaryKey({ columns: [t.dimensionKey, t.hourMs] }),
  index("usage_skill_hourly_window").on(t.hourMs, t.sessionId),
  index("usage_skill_hourly_session_window").on(t.sessionId, t.hourMs)
]);

export const usageSkillRequestMemberships = pgTable("usage_skill_request_memberships", {
  dimensionKey: text("dimension_key").notNull(),
  hourMs: bigint("hour_ms", { mode: "number" }).notNull(),
  requestKey: text("request_key").notNull(),
  requestId: text("request_id").notNull(),
  refs: bigint("refs", { mode: "number" }).notNull(),
}, t => [
  primaryKey({ columns: [t.dimensionKey, t.hourMs, t.requestKey] }),
  index("usage_skill_membership_request").on(t.requestKey)
]);

export const usageSkillRequests = pgTable("usage_skill_requests", {
  requestKey: text("request_key").primaryKey(),
  memberships: bigint("memberships", { mode: "number" }).notNull(),
}, t => [
  index("usage_skill_requests_duplicates").on(t.requestKey).where(sql`memberships > 1`)
]);

/** Positive usage entry attribution for exact partial-hour member activity. */
export const usageMemberFacts = pgTable('usage_member_facts', {
  entryId: text('entry_id').primaryKey(),
  sessionId: text('session_id').notNull(),
  queueItemId: text('queue_item_id'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  actorId: text('actor_id').notNull(),
}, (t) => [
  index('usage_member_facts_queue').on(t.queueItemId, t.sessionId),
  index('usage_member_facts_window').on(t.createdAt, t.sessionId),
  index('usage_member_facts_session_window').on(t.sessionId, t.createdAt),
]);

/** Per-session and queue-actor hourly positive usage counts. */
export const usageMemberHourly = pgTable('usage_member_hourly', {
  sessionId: text('session_id').notNull(),
  actorId: text('actor_id').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  positiveTurns: bigint('positive_turns', { mode: 'number' }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.sessionId, t.actorId, t.createdAt] }),
  index('usage_member_hourly_window').on(t.createdAt, t.sessionId),
  index('usage_member_hourly_empty').on(t.createdAt).where(sql`${t.positiveTurns}=0`),
]);

export const usageHourlyProgress=pgTable("usage_hourly_progress", {
 sourceKind:text("source_kind").primaryKey(),watermark:text("watermark").notNull(),
});

export const usageDaily = pgTable("usage_daily", {
 dimensions: jsonb("dimensions").notNull(), sourceKind: text("source_kind").notNull(),
 sessionId:text("session_id"),orgId:text("org_id"),userId:text("user_id"),teamId:text("team_id"),
 model:text("model"),provider:text("provider"),createdAt:bigint("created_at",{mode:"number"}).notNull(),
 turns:bigint("turns",{mode:"number"}).notNull(),
 unpricedTurns:bigint("unpriced_turns",{mode:"number"}).notNull(),
 positiveTurns:bigint("positive_turns",{mode:"number"}).notNull(),
 inputTokens:bigint("input_tokens",{mode:"number"}).notNull(),
 outputTokens:bigint("output_tokens",{mode:"number"}).notNull(),
 cacheReadTokens:bigint("cache_read_tokens",{mode:"number"}).notNull(),
 cacheWriteTokens:bigint("cache_write_tokens",{mode:"number"}).notNull(),
 totalTokens:bigint("total_tokens",{mode:"number"}).notNull(),
 toolCalls:bigint("tool_calls",{mode:"number"}).notNull(),
 pullRequests:bigint("pull_requests",{mode:"number"}).notNull(),
 reviews:bigint("reviews",{mode:"number"}).notNull(),
 costTotal:numeric("cost_total").notNull(),
},t=>[primaryKey({columns:[t.dimensions,t.createdAt]}),
 index("usage_daily_window").on(t.createdAt,t.sessionId),
 index("usage_daily_session_window").on(t.sessionId,t.createdAt),
 index("usage_daily_org_window").on(t.orgId,t.createdAt),
 index("usage_daily_outcomes").on(t.createdAt,t.sessionId).where(sql`${t.pullRequests}>0 OR ${t.reviews}>0`),
 index("usage_daily_empty").on(t.createdAt).where(sql`${t.turns}=0 AND ${t.toolCalls}=0 AND ${t.pullRequests}=0 AND ${t.reviews}=0`)]);

/** One durable, fenced briefing snapshot per workspace. */
export const workspaceBriefingCache = pgTable("workspace_briefing_cache", {
  orgId: text("org_id").notNull(),
  ownerType: text("owner_type").notNull(),
  ownerId: text("owner_id").notNull(),
  version: text("version").notNull(),
  evidenceHash: text("evidence_hash"),
  response: jsonb("response").$type<import("../wire/types.js").WorkspaceBriefingsResponse>(),
  checkedAt: bigint("checked_at", { mode: "number" }),
  nextCheckAt: bigint("next_check_at", { mode: "number" }).notNull().default(0),
  leaseToken: text("lease_token"),
  leaseUntil: bigint("lease_until", { mode: "number" }).notNull().default(0),
}, t => [primaryKey({ columns: [t.orgId,t.ownerType,t.ownerId] })]);

/** Durable permissions confined to a workflow and its current owner. */
export const workflowActionGrants = pgTable("workflow_action_grants", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  workflowId: text("workflow_id").notNull(),
  ownerType: text("owner_type").notNull(),
  ownerId: text("owner_id").notNull(),
  actionId: text("action_id").notNull(),
  grantedBy: text("granted_by").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (t) => [index("workflow_action_grants_workflow").on(t.orgId, t.workflowId)]);

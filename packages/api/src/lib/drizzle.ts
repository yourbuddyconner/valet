/**
 * Application Drizzle handle, backed by either `drizzle-orm/node-postgres`
 * or `drizzle-orm/pglite` — both are structurally assignable to
 * `PgDatabase<PgQueryResultHKT, typeof schema>` in the installed
 * drizzle-orm 0.45.2 (their `NodePgQueryResultHKT`/`PgliteQueryResultHKT`
 * both extend the shared `PgQueryResultHKT`), so `AppDb` uses the real
 * common base rather than `PgDatabase<any, any, any>` (forbidden by the
 * no-`any` rule — decision 8 of docs/specs/2026-07-15-postgres-backend-design.md).
 *
 * Mirrors `packages/store-postgres/src/migrate.ts`'s conventions
 * (`information_schema` probe, `__valet_*_migrations` tracker, one
 * transaction per migration file, `import.meta.url` dir resolution): async
 * throughout, `--> statement-breakpoint`-delimited multi-statement files, no
 * sqlite-style backfill path (decision 10: no pg database predates the
 * tracker).
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import { applyEngineMigrations, isPgLockTimeout, pgDbFromPglite, pgDbFromPool, type PgDb } from "@valet/store-postgres";
import { readFileSync } from "node:fs";
import { prepareMemberActivity, MEMBER_ACTIVITY_PUBLISH_SQL } from "./usage-member-activity.js";
import { prepareAuxUsageRollups, AUX_USAGE_PUBLISH_SQL } from "./usage-aux-rollups.js";
import { prepareUsageDaily, prepareUsageHourly, usageHourlyPublishSql } from "./usage-hourly-migration.js";
import { prepareUsageAnalytics, usageAnalyticsPublishSql, projectedCostViewSql } from "./usage-analytics-migration.js";
import * as schema from "../schema/index.js";

/** Application Drizzle handle. The engine's session store has its own
 * Drizzle handle over the same connection source — both reach the same
 * pg database. */
export type AppDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * The transaction handle Drizzle's pg drivers pass to
 * `db.transaction(tx => ...)` callbacks. Derived from `AppDb["transaction"]`
 * (rather than importing internal driver-specific transaction class names)
 * so services that need to run reads + writes atomically can type their
 * helpers to accept either `AppDb` or this transaction handle without a
 * type assertion.
 */
export type AppTx = Parameters<AppDb["transaction"]>[0] extends (tx: infer T) => unknown ? T : never;

/** Either a top-level `AppDb` handle or an in-flight transaction on one. */
export type AppQueryable = AppDb | AppTx;

/**
 * Builds the app Drizzle instance over either connection source. `source`
 * is the raw driver object (a `pg.Pool` or an `@electric-sql/pglite`
 * `PGlite` instance) — NOT the `PgDb` query wrapper, since each drizzle
 * driver needs its own native client, not the normalized `PgQueryable`
 * surface `PgDb` exposes (`buildAppQueryable` below wraps the SAME
 * underlying object separately, for the raw-SQL stores that share a
 * connection source with this Drizzle instance).
 */
export function buildAppDb(source: Pool | PGlite): AppDb {
  if (source instanceof PGlite) {
    return drizzlePglite(source, { schema, casing: "snake_case" });
  }
  return drizzleNodePg(source, { schema, casing: "snake_case" });
}

/** Wraps a raw connection source in the shared `PgDb` query interface
 * (decision 4) — the same source `buildAppDb` above builds a Drizzle
 * instance over, so raw-SQL call sites (migrations, the memory service's
 * tsvector queries) and Drizzle call sites share one physical connection. */
export function buildAppQueryable(source: Pool | PGlite): PgDb {
  return source instanceof PGlite ? pgDbFromPglite(source) : pgDbFromPool(source);
}

/**
 * The one pre-1.0 app migration. CLAUDE.md rule: we edit `0000` in place,
 * never add `0001`/`0002`, so this is an explicit single-file read rather than
 * a directory scan. Read via `new URL(..., import.meta.url)` so the asset
 * resolves relative to this module (the seam a later bundling step relies on).
 */
const APP_MIGRATION_FILES = ["0000_app.sql"] as const;

const migrationSql: Record<(typeof APP_MIGRATION_FILES)[number], () => string> = {
  "0000_app.sql": () =>
    readFileSync(new URL("../../migrations/pg/0000_app.sql", import.meta.url), "utf8"),
};

/**
 * Apply this package's postgres migrations to an open `PgDb`.
 *
 * Tracks applied migrations in `__valet_app_migrations` (filename + timestamp)
 * so re-runs across server restarts are no-ops. Each migration runs in a
 * transaction — partial application leaves the tracker untouched.
 *
 * The app schema now spans both migration sets: the `cost_entries` view reads
 * `engine_entries` (engine schema) alongside `agent_sessions`/`workflow_runs`/
 * `workflow_definitions`. So this function applies the engine schema FIRST.
 * `applyEngineMigrations` is idempotent and tracks itself separately, so a
 * caller that also applies it explicitly (`providers/node.ts`) is unaffected.
 * The dependency only runs this way: the engine schema never reads app tables.
 */
export async function applyAppMigrations(db: PgDb, pgDataDir?: string): Promise<void> {
  await applyEngineMigrations(db, pgDataDir);

  await db.query(`
    CREATE TABLE IF NOT EXISTS __valet_app_migrations (
      filename text PRIMARY KEY,
      applied_at bigint NOT NULL
    )
  `);

  for (const file of APP_MIGRATION_FILES) {
    const applied = await db.query("SELECT 1 FROM __valet_app_migrations WHERE filename = $1", [file]);
    if (applied.rows.length > 0) continue;

    const sql = migrationSql[file]();
    const statements = sql
      .split(/-->\s*statement-breakpoint/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    await db.transaction(async (tx) => {
      for (const stmt of statements) {
        await tx.query(stmt);
      }
      await tx.query("INSERT INTO __valet_app_migrations (filename, applied_at) VALUES ($1, $2)", [
        file,
        Date.now(),
      ]);
    });
  }

  await addColumnsMissingFromAppliedMigrations(db);
  await expandLegacySlackWildcards(db);
}

const LEGACY_SLACK_EVENT_KEYS = [
  "slack.app_mention", "slack.message", "slack.reaction_added", "slack.reaction_removed", "slack.member_joined_channel", "slack.member_left_channel", "slack.channel_created", "slack.channel_rename", "slack.channel_archive", "slack.channel_unarchive", "slack.file_shared", "slack.team_join",
];

/** Preserve the meaning of rows created before slack.bot_message existed. */
export async function expandLegacySlackWildcards(db: PgDb): Promise<void> {
  await db.query(
    `UPDATE event_subscriptions SET event_keys = (SELECT jsonb_agg(DISTINCT key) FROM (SELECT value AS key FROM jsonb_array_elements_text(event_keys) WHERE value <> 'slack.*' UNION ALL SELECT unnest($1::text[])) keys), updated_at = $2 WHERE event_keys ? 'slack.*'`,
    [LEGACY_SLACK_EVENT_KEYS, Date.now()],
  );
}

/**
 * One schema element that a pre-1.0 in-place edit added to an
 * ALREADY-APPLIED `0000_app.sql`, plus the catalog probe that tells whether
 * this database still lacks it. The probe is the point (TKAI-244): a no-op
 * `ALTER TABLE ... IF NOT EXISTS` still takes an ACCESS EXCLUSIVE lock, and
 * during a rolling update that lock queues behind the old api pod's open
 * transactions — the new pod hangs, the queued lock blocks the old pod's
 * reads, and the deploy deadlocks. Probing the catalog first means a boot
 * where nothing is missing issues no DDL at all.
 */
interface SchemaRepair {
  /** Optional resumable preparation, outside the final DDL transaction. */
  prepare?: (db: PgDb) => Promise<void>;
  /** Names the element in logs and errors, e.g. "orgs.sso_team_groups column". */
  describe: string;
  probe:
    | { kind: "column"; table: string; column: string }
    | { kind: "removed-column"; table: string; column: string }
    | { kind: "table"; table: string }
    | { kind: "index"; index: string };
  sql: string;
  /**
   * A one-shot data statement run in the same transaction, right after
   * `sql`, only when this repair runs. For a column whose meaning depends on
   * whether a row predates it: the rows present at repair time get their
   * value here, once, and a later row that omits the column keeps the
   * column's documented default reading instead of being rewritten on a
   * later boot. Must end in `RETURNING` a column so the log can count rows.
   */
  backfill?: string;
}

const LEGACY_COST_ENTRIES_VIEW_SQL = `CREATE OR REPLACE VIEW "cost_entries" AS
      SELECT
        e."id"                                                     AS "entry_id",
        e."session_id"                                             AS "session_id",
        e."created_at"                                             AS "created_at",
        e."model"                                                  AS "model",
        COALESCE(s."org_id", d."org_id")                           AS "org_id",
        CASE
          WHEN s."id" IS NOT NULL THEN s."user_id"
          WHEN r."owner_type" = 'user' THEN NULLIF(r."owner_id", '')
        END                                                        AS "user_id",
        COALESCE(s."owner_type", r."owner_type")                   AS "owner_type",
        NULLIF(COALESCE(s."owner_id", r."owner_id"), '')           AS "owner_id",
        r."workflow_id"                                            AS "workflow_id",
        r."id"                                                     AS "workflow_run_id",
        COALESCE((e."usage"::jsonb->>'input')::bigint, 0)          AS "input_tokens",
        COALESCE((e."usage"::jsonb->>'output')::bigint, 0)         AS "output_tokens",
        COALESCE((e."usage"::jsonb->>'cacheRead')::bigint, 0)      AS "cache_read_tokens",
        COALESCE((e."usage"::jsonb->>'cacheWrite')::bigint, 0)     AS "cache_write_tokens",
        COALESCE((e."usage"::jsonb->>'total')::bigint, 0)          AS "total_tokens",
        (e."cost"::jsonb->>'total')::float8                        AS "cost_total",
        ((e."cost"::jsonb->>'total') IS NOT NULL)                  AS "priced",
        CASE
          WHEN e."session_id" LIKE 'orchestrator:%' THEN 'orchestrator'
          WHEN e."session_id" LIKE 'wf:%'           THEN 'workflow'
          ELSE 'session'
        END                                                        AS "use_case",
        NULL::text                                                  AS "provider"
      FROM "engine_entries" e
      LEFT JOIN "agent_sessions" s
        ON s."id" = e."session_id"
      LEFT JOIN "workflow_runs" r
        ON e."session_id" LIKE 'wf:%'
        AND r."id" = split_part(e."session_id", ':', 2)
      LEFT JOIN "workflow_definitions" d
        ON d."id" = r."workflow_id"
      WHERE e."usage" IS NOT NULL
        AND COALESCE(s."org_id", d."org_id") IS NOT NULL
      UNION ALL
      SELECT
        p."id" AS "entry_id", NULL AS "session_id", p."created_at" AS "created_at", p."model" AS "model",
        p."org_id" AS "org_id", p."user_id" AS "user_id",
        CASE WHEN p."team_id" IS NOT NULL THEN 'team' ELSE 'user' END AS "owner_type",
        COALESCE(p."team_id", p."user_id") AS "owner_id",
        NULL AS "workflow_id", NULL AS "workflow_run_id",
        p."input_tokens", p."output_tokens", p."cache_read_tokens", p."cache_write_tokens", p."total_tokens",
        p."cost_usd" AS "cost_total", (p."cost_usd" IS NOT NULL) AS "priced", 'proxy' AS "use_case", p."provider_kind" AS "provider"
      FROM "llm_proxy_requests" p
      WHERE p."total_tokens" > 0`;

// Older repairs must not restore the expensive ledger after projection rollout.
const COST_ENTRIES_VIEW_SQL = `DO $cost_view$ BEGIN
  IF to_regclass('usage_entries') IS NULL THEN
    ${LEGACY_COST_ENTRIES_VIEW_SQL};
  ELSE
    ${projectedCostViewSql}
  END IF;
END $cost_view$`;

/**
 * The pre-1.0 in-place-edit repair list. Add an entry when an edit to
 * `0000_app.sql` adds a NULLABLE (or DEFAULT-backfilled) column, a table,
 * or an index; a column that needs a computed value cannot be repaired this
 * way and does need a real migration. Keep each `sql` in lockstep with
 * `0000_app.sql`. Delete this list at 1.0, when numbered migrations take
 * over.
 *
 * Except for the explicit development singleton cutover below, each entry
 * must also be safe to ROLL BACK: the previous release may boot
 * this database again. Adding a column or a table is safe; renaming or
 * dropping is not, because the older release repairs the OLD name and its
 * statement then stops its boot. Do not rename or drop here.
 */

const SCHEMA_REPAIRS: SchemaRepair[] = [
  { describe: "event receipts table", probe: { kind: "table", table: "event_receipts" }, sql: `CREATE TABLE IF NOT EXISTS "event_receipts" (
  "id" text PRIMARY KEY, "org_id" text NOT NULL, "service" text NOT NULL,
  "external_id" text, "metadata" jsonb NOT NULL DEFAULT '{}',
  "stages" jsonb NOT NULL DEFAULT '[]', "event_key" text, "event_id" text,
  "subscriptions" jsonb NOT NULL DEFAULT '[]',
  "created_at" bigint NOT NULL, "updated_at" bigint NOT NULL
)` },
  { describe: "event receipts page index", probe: { kind: "index", index: "event_receipts_page" }, sql: 'CREATE INDEX IF NOT EXISTS "event_receipts_page" ON "event_receipts" ("org_id", "created_at", "id")' },
  // Development cutover: workspace configuration replaces retired profile fields.
  ...["name", "avatar_url", "personality", "behavior", "model", "reasoning"].map((column): SchemaRepair => ({
    describe: `remove assistants.${column}`,
    probe: { kind: "removed-column", table: "assistants", column },
    sql: `ALTER TABLE "assistants" DROP COLUMN IF EXISTS "${column}"`,
  })),
  {
    describe: "workspace assistant singleton cutover",
    probe: { kind: "index", index: "assistants_workspace" },
    // Dev-only cutover: older builds are not supported after this change.
    // Existing duplicate profiles require a dev database reset, never silent history deletion.
    sql: `DO $$ BEGIN
      DROP INDEX IF EXISTS assistants_default_owner;
      ALTER TABLE assistants DROP COLUMN IF EXISTS is_default;
      ALTER TABLE followed_threads DROP COLUMN IF EXISTS assistant_id;
      ALTER TABLE workflow_schedules DROP COLUMN IF EXISTS assistant_id;
      CREATE UNIQUE INDEX assistants_workspace ON assistants(org_id, owner_type, owner_id);
    END $$`,
  },
  { describe: "teams.slack_home_channel_id column", probe: { kind: "column", table: "teams", column: "slack_home_channel_id" }, sql: 'ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "slack_home_channel_id" text' },
  { describe: "user_notification_preferences.team_dm column", probe: { kind: "column", table: "user_notification_preferences", column: "team_dm" }, sql: 'ALTER TABLE "user_notification_preferences" ADD COLUMN IF NOT EXISTS "team_dm" boolean DEFAULT false NOT NULL' },

  {
    describe: "session_threads.last_user_activity_at column",
    probe: { kind: "column", table: "session_threads", column: "last_user_activity_at" },
    sql: 'ALTER TABLE "session_threads" ADD COLUMN IF NOT EXISTS "last_user_activity_at" bigint',
  },
  {
    describe: "session_repos.resolved_ref column",
    probe: { kind: "column", table: "session_repos", column: "resolved_ref" },
    sql: 'ALTER TABLE "session_repos" ADD COLUMN IF NOT EXISTS "resolved_ref" text',
  },
  {
    describe: "agent_sessions.kubernetes column",
    probe: { kind: "column", table: "agent_sessions", column: "kubernetes" },
    sql: 'ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "kubernetes" boolean DEFAULT false NOT NULL',
  },
  { describe: "team deletion requests", probe: { kind: "table", table: "team_deletion_requests" }, sql: `CREATE TABLE IF NOT EXISTS "team_deletion_requests" (
  "id" text PRIMARY KEY NOT NULL, "org_id" text NOT NULL, "team_id" text NOT NULL,
  "resource_type" text NOT NULL, "resource_id" text NOT NULL, "resource_label" text NOT NULL,
  "requested_by" text NOT NULL, "reason" text, "requested_at" bigint NOT NULL,
  "expires_at" bigint NOT NULL, "status" text NOT NULL DEFAULT 'pending',
  "decided_by" text, "decided_at" bigint, "decision_note" text, "last_refusal" text
);` },
  { describe: "team_deletion_requests_pending", probe: { kind: "index", index: "team_deletion_requests_pending" }, sql: `CREATE UNIQUE INDEX IF NOT EXISTS "team_deletion_requests_pending" ON "team_deletion_requests" ("team_id", "resource_type", "resource_id") WHERE "status" = 'pending';` },
  { describe: "team_deletion_requests_team_status", probe: { kind: "index", index: "team_deletion_requests_team_status" }, sql: `CREATE INDEX IF NOT EXISTS "team_deletion_requests_team_status" ON "team_deletion_requests" ("team_id", "status");` },

  {
    describe: "event_subscriptions.audience column",
    probe: { kind: "column", table: "event_subscriptions", column: "audience" },
    sql: 'ALTER TABLE "event_subscriptions" ADD COLUMN IF NOT EXISTS "audience" text',
  },
  {
    describe: "followed_threads.subscription_id column",
    probe: { kind: "column", table: "followed_threads", column: "subscription_id" },
    sql: 'ALTER TABLE "followed_threads" ADD COLUMN IF NOT EXISTS "subscription_id" text',
  },
  {
    describe: "skill_sources.sync_revision column",
    probe: { kind: "column", table: "skill_sources", column: "sync_revision" },
    sql: 'ALTER TABLE "skill_sources" ADD COLUMN IF NOT EXISTS "sync_revision" bigint DEFAULT 0 NOT NULL',
  },
  {
    describe: "team_join_eligibilities table",
    probe: { kind: "table", table: "team_join_eligibilities" },
    sql: `CREATE TABLE IF NOT EXISTS "team_join_eligibilities" (
      "team_id" text NOT NULL,
      "user_id" text NOT NULL,
      "observed_at" bigint NOT NULL,
      PRIMARY KEY("team_id", "user_id")
    )`,
  },
  {
    describe: "team_join_eligibilities_user index",
    probe: { kind: "index", index: "team_join_eligibilities_user" },
    sql: 'CREATE INDEX IF NOT EXISTS "team_join_eligibilities_user" ON "team_join_eligibilities" ("user_id")',
  },
  {
    describe: "skill_invocations table",
    probe: { kind: "table", table: "skill_invocations" },
    sql: `CREATE TABLE IF NOT EXISTS "skill_invocations" (
      "id" text PRIMARY KEY NOT NULL, "created_at" bigint NOT NULL,
      "org_id" text NOT NULL, "session_id" text NOT NULL, "thread_id" text NOT NULL,
      "invoker_user_id" text, "invocation_entry_id" text, "path" text NOT NULL,
      "skill_key" text NOT NULL, "skill_name" text NOT NULL, "stored_skill_id" text,
      "plugin_name" text, "origin" text NOT NULL, "content_sha" text NOT NULL,
      "injected_characters" integer NOT NULL, "estimated_body_tokens" integer NOT NULL
    )`,
  },
  {
    describe: "skill_invocations_org_created index",
    probe: { kind: "index", index: "skill_invocations_org_created" },
    sql: 'CREATE INDEX IF NOT EXISTS "skill_invocations_org_created" ON "skill_invocations" ("org_id","created_at")',
  },
  {
    describe: "skill_invocations_session_thread_created index",
    probe: { kind: "index", index: "skill_invocations_session_thread_created" },
    sql: 'CREATE INDEX IF NOT EXISTS "skill_invocations_session_thread_created" ON "skill_invocations" ("session_id","thread_id","created_at")',
  },
  {
    describe: "skill_invocations_skill_created index",
    probe: { kind: "index", index: "skill_invocations_skill_created" },
    sql: 'CREATE INDEX IF NOT EXISTS "skill_invocations_skill_created" ON "skill_invocations" ("skill_key","created_at")',
  },
  {
    describe: "skill_context_attributions table",
    probe: { kind: "table", table: "skill_context_attributions" },
    sql: `CREATE TABLE IF NOT EXISTS "skill_context_attributions" (
      "skill_invocation_id" text NOT NULL, "llm_request_id" text NOT NULL,
      "session_id" text NOT NULL, "thread_id" text NOT NULL, "created_at" bigint NOT NULL,
      "estimated_skill_tokens" integer NOT NULL,
      PRIMARY KEY("skill_invocation_id","llm_request_id")
    )`,
  },
  {
    describe: "orgs.allow_personal_installations column",
    probe: { kind: "column", table: "orgs", column: "allow_personal_installations" },
    sql: 'ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "allow_personal_installations" boolean NOT NULL DEFAULT true',
  },
  {
    describe: "image_sources.sandbox_resources column",
    probe: { kind: "column", table: "image_sources", column: "sandbox_resources" },
    sql: 'ALTER TABLE "image_sources" ADD COLUMN IF NOT EXISTS "sandbox_resources" jsonb',
  },
  {
    // Repository mirror columns on workflow_definitions. A deployed database
    // predating them holds only `local` rows, which is what the default
    // encodes, so the backfill is the default and nothing else is needed.
    describe: "workflow_definitions.origin column",
    probe: { kind: "column", table: "workflow_definitions", column: "origin" },
    sql: `ALTER TABLE "workflow_definitions" ADD COLUMN IF NOT EXISTS "origin" text NOT NULL DEFAULT 'local'`,
  },
  {
    describe: "workflow_definitions.source_id column",
    probe: { kind: "column", table: "workflow_definitions", column: "source_id" },
    sql: 'ALTER TABLE "workflow_definitions" ADD COLUMN IF NOT EXISTS "source_id" text',
  },
  {
    describe: "workflow_definitions.upstream_path column",
    probe: { kind: "column", table: "workflow_definitions", column: "upstream_path" },
    sql: 'ALTER TABLE "workflow_definitions" ADD COLUMN IF NOT EXISTS "upstream_path" text',
  },
  {
    describe: "workflow_definitions.content_sha column",
    probe: { kind: "column", table: "workflow_definitions", column: "content_sha" },
    sql: 'ALTER TABLE "workflow_definitions" ADD COLUMN IF NOT EXISTS "content_sha" text',
  },
  {
    // Partial, matching the migration: a `local` row carries no source and no
    // path, and those NULLs would not collide in any case.
    describe: "workflow_definitions_source_path unique index",
    probe: { kind: "index", index: "workflow_definitions_source_path" },
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "workflow_definitions_source_path" ON "workflow_definitions" ("source_id","upstream_path") WHERE "source_id" IS NOT NULL',
  },
  {
    // The mirrored template table and its two unique indexes. Additive, so a
    // rollback to a release that does not know them is safe.
    describe: "workflow_templates table",
    probe: { kind: "table", table: "workflow_templates" },
    sql: `CREATE TABLE IF NOT EXISTS "workflow_templates" (
      "id" text PRIMARY KEY NOT NULL,
      "org_id" text NOT NULL,
      "owner_type" text NOT NULL,
      "owner_id" text NOT NULL,
      "template_id" text NOT NULL,
      "origin" text DEFAULT 'local' NOT NULL,
      "source_id" text,
      "upstream_path" text NOT NULL,
      "content_sha" text,
      "template" jsonb NOT NULL,
      "created_at" bigint NOT NULL,
      "updated_at" bigint NOT NULL
    )`,
  },
  {
    describe: "workflow_templates_owner_template unique index",
    probe: { kind: "index", index: "workflow_templates_owner_template" },
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "workflow_templates_owner_template" ON "workflow_templates" ("org_id","owner_type","owner_id","template_id")',
  },
  {
    describe: "workflow_templates_source_path unique index",
    probe: { kind: "index", index: "workflow_templates_source_path" },
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "workflow_templates_source_path" ON "workflow_templates" ("source_id","upstream_path") WHERE "source_id" IS NOT NULL',
  },
  {
    // Provenance on a version row. Both nullable: every version a product
    // edit wrote carries neither, and so does every row an upgrade brings.
    describe: "workflow_versions.origin column",
    probe: { kind: "column", table: "workflow_versions", column: "origin" },
    sql: 'ALTER TABLE "workflow_versions" ADD COLUMN IF NOT EXISTS "origin" text',
  },
  {
    describe: "workflow_versions.source_commit column",
    probe: { kind: "column", table: "workflow_versions", column: "source_commit" },
    sql: 'ALTER TABLE "workflow_versions" ADD COLUMN IF NOT EXISTS "source_commit" text',
  },
  {
    // The spawning submission's channel origin, inherited by child.settled
    // signals. Null on rows from before the column: those settlements just
    // keep the old no-origin behavior.
    describe: "child_watches.origin_json column",
    probe: { kind: "column", table: "child_watches", column: "origin_json" },
    sql: 'ALTER TABLE "child_watches" ADD COLUMN IF NOT EXISTS "origin_json" text',
  },
  {
    // The last delivered message ts on a followed thread, read by the
    // follow-router's gap re-hydration. Null on rows from before the column:
    // the next delivery starts tracking, with no back-hydration.
    describe: "followed_threads.last_seen_ts column",
    probe: { kind: "column", table: "followed_threads", column: "last_seen_ts" },
    sql: 'ALTER TABLE "followed_threads" ADD COLUMN IF NOT EXISTS "last_seen_ts" text',
  },
  {
    // Memory mirror bookkeeping. A deployed database holds only rows the
    // product wrote, which carry no source, so NULL is the backfill.
    describe: "memory_files.source_id column",
    probe: { kind: "column", table: "memory_files", column: "source_id" },
    sql: 'ALTER TABLE "memory_files" ADD COLUMN IF NOT EXISTS "source_id" text',
  },
  {
    describe: "memory_files.upstream_path column",
    probe: { kind: "column", table: "memory_files", column: "upstream_path" },
    sql: 'ALTER TABLE "memory_files" ADD COLUMN IF NOT EXISTS "upstream_path" text',
  },
  {
    describe: "memory_files.content_sha column",
    probe: { kind: "column", table: "memory_files", column: "content_sha" },
    sql: 'ALTER TABLE "memory_files" ADD COLUMN IF NOT EXISTS "content_sha" text',
  },
  {
    // Trigger provenance. A deployed database holds only person-armed rows,
    // which is what the default encodes, so the default IS the backfill.
    describe: "workflow_schedules.origin column",
    probe: { kind: "column", table: "workflow_schedules", column: "origin" },
    sql: `ALTER TABLE "workflow_schedules" ADD COLUMN IF NOT EXISTS "origin" text NOT NULL DEFAULT 'local'`,
  },
  {
    describe: "event_subscriptions.origin column",
    probe: { kind: "column", table: "event_subscriptions", column: "origin" },
    sql: `ALTER TABLE "event_subscriptions" ADD COLUMN IF NOT EXISTS "origin" text NOT NULL DEFAULT 'local'`,
  },


  {
    // Records which person's GitHub credential a team source may use.
    // Null on every row written before the column existed, which the sync
    // reads as "no credential" rather than climbing to the org's App.
    describe: "skill_sources.created_by column",
    probe: { kind: "column", table: "skill_sources", column: "created_by" },
    sql: 'ALTER TABLE "skill_sources" ADD COLUMN IF NOT EXISTS "created_by" text',
  },
  {
    // The DEFAULT backfills every pre-existing row to skills only, so a
    // repository tracked before workflow sync existed keeps mirroring what it
    // mirrored.
    describe: "skill_sources.kinds column",
    probe: { kind: "column", table: "skill_sources", column: "kinds" },
    sql: `ALTER TABLE "skill_sources" ADD COLUMN IF NOT EXISTS "kinds" jsonb DEFAULT '["skills"]'::jsonb NOT NULL`,
  },
  {
    // The discovery-rules version and the commit read under it. Null on
    // every row written before the column existed, and on every row an older
    // release has advanced since; both make that source re-scan once.
    describe: "skill_sources.discovery_scan column",
    probe: { kind: "column", table: "skill_sources", column: "discovery_scan" },
    sql: 'ALTER TABLE "skill_sources" ADD COLUMN IF NOT EXISTS "discovery_scan" text',
  },
  {
    // The per-group team-sync allowlist. Null on every row written before
    // the column existed, which the sync and Settings read as "never set" —
    // fail-closed, same as an empty list.
    describe: "orgs.sso_team_groups column",
    probe: { kind: "column", table: "orgs", column: "sso_team_groups" },
    sql: 'ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "sso_team_groups" jsonb',
  },
  {
    // Team default model (TKAI-255). Null on rows from before the column:
    // those teams keep the old behavior — resolution falls through to the
    // cascade's next tier.
    describe: "teams.default_model column",
    probe: { kind: "column", table: "teams", column: "default_model" },
    sql: 'ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "default_model" text',
  },
  {
    describe: "orgs.allow_anonymous_image_bakes column",
    probe: { kind: "column", table: "orgs", column: "allow_anonymous_image_bakes" },
    sql: 'ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "allow_anonymous_image_bakes" boolean NOT NULL DEFAULT false',
  },
  {
    // Artifact-sharing opt-in (artifacts design). The DEFAULT backfills
    // every pre-existing org row to `false` — anonymous sharing stays off
    // until an admin opts in, the same answer a fresh database gets.
    describe: "orgs.allow_public_artifacts column",
    probe: { kind: "column", table: "orgs", column: "allow_public_artifacts" },
    sql: 'ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "allow_public_artifacts" boolean NOT NULL DEFAULT false',
  },
  {
    // Thumbs up/down feedback (TKAI-334) — the eval-seeding signal.
    describe: "ratings table",
    probe: { kind: "table", table: "ratings" },
    sql: `CREATE TABLE IF NOT EXISTS "ratings" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL,
      "target_type" text NOT NULL,
      "target_id" text NOT NULL,
      "session_id" text NOT NULL,
      "thread_id" text,
      "rating" text NOT NULL,
      "created_at" bigint NOT NULL,
      "updated_at" bigint NOT NULL
    )`,
  },
  {
    describe: "ratings_user_target index",
    probe: { kind: "index", index: "ratings_user_target" },
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "ratings_user_target" ON "ratings" ("user_id","target_type","target_id")',
  },
  {
    describe: "ratings_session index",
    probe: { kind: "index", index: "ratings_session" },
    sql: 'CREATE INDEX IF NOT EXISTS "ratings_session" ON "ratings" ("session_id")',
  },
  {
    describe: "ratings_type_rating index",
    probe: { kind: "index", index: "ratings_type_rating" },
    sql: 'CREATE INDEX IF NOT EXISTS "ratings_type_rating" ON "ratings" ("target_type","rating")',
  },
  {
    // The artifacts table itself (artifacts design) — a whole-table sibling
    // of the column repairs, for the same reason. Carries the artifact-pages
    // columns too; databases that already have the table get those from the
    // per-column repairs below.
    describe: "artifacts table",
    probe: { kind: "table", table: "artifacts" },
    sql: `CREATE TABLE IF NOT EXISTS "artifacts" (
      "id" text PRIMARY KEY NOT NULL,
      "token" text NOT NULL,
      "owner_type" text NOT NULL,
      "owner_id" text NOT NULL,
      "org_id" text NOT NULL,
      "actor_user_id" text NOT NULL,
      "source_session_id" text DEFAULT '' NOT NULL,
      "source_memory_path" text NOT NULL,
      "title" text DEFAULT '' NOT NULL,
      "content" text NOT NULL,
      "format" text DEFAULT 'markdown' NOT NULL,
      "rendered" text DEFAULT '' NOT NULL,
      "description" text DEFAULT '' NOT NULL,
      "icon" text DEFAULT '' NOT NULL,
      "version" bigint DEFAULT 1 NOT NULL,
      "shared_version" bigint,
      "visibility" text DEFAULT 'org' NOT NULL,
      "public_by" text,
      "created_at" bigint NOT NULL,
      "updated_at" bigint NOT NULL,
      "revoked_at" bigint
    )`,
  },
  {
    describe: "artifacts.source_thread_id column",
    probe: { kind: "column", table: "artifacts", column: "source_thread_id" },
    sql: 'ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "source_thread_id" text',
  },
  {
    describe: "artifacts_token_unique index",
    probe: { kind: "index", index: "artifacts_token_unique" },
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "artifacts_token_unique" ON "artifacts" ("token")',
  },
  {
    describe: "artifacts_owner_path_unique index",
    probe: { kind: "index", index: "artifacts_owner_path_unique" },
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "artifacts_owner_path_unique" ON "artifacts" ("owner_type","owner_id","source_memory_path")',
  },
  {
    // Model size tiers (TKAI-285). Nullable — null means "use built-in
    // defaults". Null backfills every pre-existing org row, which reads as
    // "defaults" in getOrgTierMap, no change in behavior.
    describe: "orgs.model_tiers column",
    probe: { kind: "column", table: "orgs", column: "model_tiers" },
    sql: 'ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "model_tiers" jsonb',
  },
  {
    // Which compiler produced `rendered` (artifact-pages design). 'markdown'
    // matches every pre-pages row, whose content was always markdown.
    describe: "artifacts.format column",
    probe: { kind: "column", table: "artifacts", column: "format" },
    sql: `ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "format" text DEFAULT 'markdown' NOT NULL`,
  },
  {
    // The compiled page body. '' on a pre-pages row means "compile `content`
    // on read" — the read path falls back, so no backfill is needed.
    describe: "artifacts.rendered column",
    probe: { kind: "column", table: "artifacts", column: "rendered" },
    sql: `ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "rendered" text DEFAULT '' NOT NULL`,
  },
  {
    describe: "artifacts.description column",
    probe: { kind: "column", table: "artifacts", column: "description" },
    sql: `ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "description" text DEFAULT '' NOT NULL`,
  },
  {
    describe: "artifacts.icon column",
    probe: { kind: "column", table: "artifacts", column: "icon" },
    sql: `ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "icon" text DEFAULT '' NOT NULL`,
  },
  {
    // Publish counter. 1 on pre-pages rows: their one snapshot is version 1.
    describe: "artifacts.version column",
    probe: { kind: "column", table: "artifacts", column: "version" },
    sql: `ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "version" bigint DEFAULT 1 NOT NULL`,
  },
  {
    // Pin viewers to one version; null = latest, which matches pre-pages
    // behavior exactly.
    describe: "artifacts.shared_version column",
    probe: { kind: "column", table: "artifacts", column: "shared_version" },
    sql: `ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "shared_version" bigint`,
  },
  {
    // Version history (artifact-pages design). Pre-pages rows have no
    // version rows; the first re-publish appends one, and reads of an
    // unpinned artifact never join this table.
    describe: "artifact_versions table",
    probe: { kind: "table", table: "artifact_versions" },
    sql: `CREATE TABLE IF NOT EXISTS "artifact_versions" (
      "id" text PRIMARY KEY NOT NULL,
      "artifact_id" text NOT NULL,
      "version" bigint NOT NULL,
      "title" text DEFAULT '' NOT NULL,
      "format" text DEFAULT 'markdown' NOT NULL,
      "content" text NOT NULL,
      "rendered" text DEFAULT '' NOT NULL,
      "actor_user_id" text NOT NULL,
      "created_at" bigint NOT NULL
    )`,
  },
  {
    describe: "artifact_versions_unique index",
    probe: { kind: "index", index: "artifact_versions_unique" },
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "artifact_versions_unique" ON "artifact_versions" ("artifact_id","version")',
  },
  {
    // Element-anchored comments on a published page (artifact-pages design).
    describe: "artifact_comments table",
    probe: { kind: "table", table: "artifact_comments" },
    sql: `CREATE TABLE IF NOT EXISTS "artifact_comments" (
      "id" text PRIMARY KEY NOT NULL,
      "artifact_id" text NOT NULL,
      "version" bigint NOT NULL,
      "vdid" text,
      "parent_id" text,
      "body" text NOT NULL,
      "author_user_id" text NOT NULL,
      "sent_to_session" text,
      "resolved_at" bigint,
      "resolved_by" text,
      "created_at" bigint NOT NULL
    )`,
  },
  {
    describe: "artifact_comments_artifact index",
    probe: { kind: "index", index: "artifact_comments_artifact" },
    sql: 'CREATE INDEX IF NOT EXISTS "artifact_comments_artifact" ON "artifact_comments" ("artifact_id")',
  },
  {
    // The runtime model-registry cache (TKAI-327). An empty table degrades
    // the model catalog to the bundled compile-time list, so a deployment
    // that boots before the repair runs still serves models.
    describe: "model_registry_cache table",
    probe: { kind: "table", table: "model_registry_cache" },
    sql: `CREATE TABLE IF NOT EXISTS "model_registry_cache" (
      "provider_id" text PRIMARY KEY NOT NULL,
      "models" jsonb DEFAULT '[]'::jsonb NOT NULL,
      "etag" text,
      "last_modified" bigint,
      "checked_at" bigint,
      "updated_at" bigint NOT NULL
    )`,
  },
  {
    // Slack thread auto-follow: a thread the assistant follows so later messages
    // route to the bound assistant without a re-mention.
    describe: "followed_threads table",
    probe: { kind: "table", table: "followed_threads" },
    sql: `CREATE TABLE IF NOT EXISTS "followed_threads" (
      "id" text PRIMARY KEY NOT NULL,
      "org_id" text NOT NULL,
      "channel_type" text NOT NULL,
      "channel_id" text NOT NULL,
      "thread_ts" text NOT NULL,
      "owner_type" text NOT NULL,
      "owner_id" text NOT NULL,
      "created_by" text NOT NULL,
      "created_at" bigint NOT NULL,
      "last_activity_at" bigint NOT NULL
    )`,
  },
  {
    describe: "followed_threads_key index",
    probe: { kind: "index", index: "followed_threads_key" },
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "followed_threads_key" ON "followed_threads" ("org_id","channel_type","channel_id","thread_ts")',
  },
  {
    // Hibernated-sandbox reaper bookkeeping. Null on rows hibernated before
    // the columns existed — the reaper falls back to a derived handle for
    // those (engine/hibernation-reaper.ts).
    describe: "agent_sessions.hibernated_sandbox_id column",
    probe: { kind: "column", table: "agent_sessions", column: "hibernated_sandbox_id" },
    sql: 'ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "hibernated_sandbox_id" text',
  },
  {
    describe: "agent_sessions.sandbox_reclaimed_at column",
    probe: { kind: "column", table: "agent_sessions", column: "sandbox_reclaimed_at" },
    sql: 'ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "sandbox_reclaimed_at" bigint',
  },
  {
    // Per-child CPU and memory overrides. Null means the session continues to
    // use repository or deployment defaults.
    describe: "agent_sessions.sandbox_resource_overrides column",
    probe: { kind: "column", table: "agent_sessions", column: "sandbox_resource_overrides" },
    sql: 'ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "sandbox_resource_overrides" jsonb',
  },
  {
    // Settled-run sandbox reclaim bookkeeping (workflows/sandbox-reclaim.ts).
    // Null on every run settled before the column existed — exactly the rows
    // the reclaim sweep must pick up.
    describe: "workflow_runs.sandbox_reclaimed_at column",
    probe: { kind: "column", table: "workflow_runs", column: "sandbox_reclaimed_at" },
    sql: 'ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "sandbox_reclaimed_at" bigint',
  },
  {
    // Who clicked Run. Null on every unattended start, and on every run
    // written before the column existed.
    describe: "workflow_runs.actor_user_id column",
    probe: { kind: "column", table: "workflow_runs", column: "actor_user_id" },
    sql: 'ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "actor_user_id" text',
  },
  {
    // The RFC 7591 scope set an MCP OAuth client was registered with
    // (integration-oauth.ts, TKAI-243). Null on rows registered before
    // scopes support, which the compare reads as "no scopes" — a declared
    // scope set then re-registers the client.
    describe: "mcp_oauth_clients.registered_scopes column",
    probe: { kind: "column", table: "mcp_oauth_clients", column: "registered_scopes" },
    sql: 'ALTER TABLE "mcp_oauth_clients" ADD COLUMN IF NOT EXISTS "registered_scopes" jsonb',
  },
  {
    // The server's advertised scopes_supported, captured at registration or
    // lazily backfilled (integration-oauth.ts). Null on rows from before the
    // column existed — exactly the rows the backfill fills in.
    describe: "mcp_oauth_clients.scopes_supported column",
    probe: { kind: "column", table: "mcp_oauth_clients", column: "scopes_supported" },
    sql: 'ALTER TABLE "mcp_oauth_clients" ADD COLUMN IF NOT EXISTS "scopes_supported" jsonb',
  },
  {
    // The LLM recording gateway's request log (#432). The gateway writes a row
    // here on every recorded call, so an already-migrated DB without it 500s
    // at runtime. Columns are in lockstep with `llm_proxy_requests` in
    // 0000_app.sql.
    describe: "llm_proxy_requests table",
    probe: { kind: "table", table: "llm_proxy_requests" },
    sql: `CREATE TABLE IF NOT EXISTS "llm_proxy_requests" (
      "id" text PRIMARY KEY NOT NULL,
      "created_at" bigint NOT NULL,
      "org_id" text NOT NULL,
      "user_id" text,
      "team_id" text,
      "api_key_id" text NOT NULL,
      "provider_kind" text NOT NULL,
      "model" text,
      "harness" text,
      "endpoint" text NOT NULL,
      "provider_response_id" text,
      "previous_response_id" text,
      "stream" boolean NOT NULL,
      "status_code" integer NOT NULL,
      "request_body" text NOT NULL,
      "response_body" text,
      "input_tokens" bigint NOT NULL DEFAULT 0,
      "output_tokens" bigint NOT NULL DEFAULT 0,
      "cache_read_tokens" bigint NOT NULL DEFAULT 0,
      "cache_write_tokens" bigint NOT NULL DEFAULT 0,
      "total_tokens" bigint NOT NULL DEFAULT 0,
      "cost_usd" double precision,
      "latency_ms" integer,
      "error" text,
      "parsed" jsonb,
      "parse_version" integer,
      "parse_error" text
    )`,
  },
  {
    describe: "llm_proxy_requests.team_id column",
    probe: { kind: "column", table: "llm_proxy_requests", column: "team_id" },
    sql: 'ALTER TABLE "llm_proxy_requests" ADD COLUMN IF NOT EXISTS "team_id" text',
  },
  {
    describe: "llm_proxy_requests_org_created index",
    probe: { kind: "index", index: "llm_proxy_requests_org_created" },
    sql: 'CREATE INDEX IF NOT EXISTS "llm_proxy_requests_org_created" ON "llm_proxy_requests" ("org_id", "created_at")',
  },
  {
    describe: "llm_proxy_requests_user_created index",
    probe: { kind: "index", index: "llm_proxy_requests_user_created" },
    sql: 'CREATE INDEX IF NOT EXISTS "llm_proxy_requests_user_created" ON "llm_proxy_requests" ("user_id", "created_at")',
  },
  {
    // The shared plugin store (docs/specs/2026-08-29-plugin-store-design.md).
    // One core table so a plugin persists data with no per-plugin migration;
    // the entitlement rail is its first consumer under plugin "valet". Columns
    // in lockstep with `plugin_store` in 0000_app.sql.
    describe: "plugin_store table",
    probe: { kind: "table", table: "plugin_store" },
    sql: `CREATE TABLE IF NOT EXISTS "plugin_store" (
      "id" text PRIMARY KEY NOT NULL,
      "plugin" text NOT NULL,
      "scope_type" text NOT NULL,
      "scope_id" text NOT NULL,
      "collection" text NOT NULL,
      "key" text NOT NULL,
      "doc" jsonb NOT NULL,
      "revision" integer NOT NULL DEFAULT 1,
      "created_at" bigint NOT NULL,
      "updated_at" bigint NOT NULL
    )`,
  },
  {
    describe: "plugin_store_identity_unique index",
    probe: { kind: "index", index: "plugin_store_identity_unique" },
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "plugin_store_identity_unique" ON "plugin_store" ("plugin","scope_type","scope_id","collection","key")',
  },
  {
    describe: "plugin_store_list index",
    probe: { kind: "index", index: "plugin_store_list" },
    sql: 'CREATE INDEX IF NOT EXISTS "plugin_store_list" ON "plugin_store" ("plugin","scope_type","scope_id","collection")',
  },
  {
    describe: "plugin_store_doc_gin index",
    probe: { kind: "index", index: "plugin_store_doc_gin" },
    sql: 'CREATE INDEX IF NOT EXISTS "plugin_store_doc_gin" ON "plugin_store" USING gin ("doc")',
  },
  {
    // The cost_entries VIEW was rewritten (#432): it added a `use_case` column
    // and a UNION ALL leg over llm_proxy_requests. A view's output columns
    // appear in information_schema.columns, so the `column` probe on the new
    // use_case column detects the pre-rewrite view; CREATE OR REPLACE swaps the
    // definition in place. The replace is safe because the rewrite appends
    // use_case and provider after `priced` and leaves every prior column identical, so
    // Postgres allows it without a DROP (which would take a heavier lock and
    // fail on any dependent). This entry MUST stay after the table entry above
    // — the UNION leg references llm_proxy_requests. Keep the SELECT in lockstep
    // with the cost_entries view in 0000_app.sql.
    describe: "cost_entries.use_case (view rewrite)",
    probe: { kind: "column", table: "cost_entries", column: "use_case" },
    sql: COST_ENTRIES_VIEW_SQL,
  },
  {
    // The aggregate export exposes provider only where the ledger records it.
    // Engine entries have no provider field, while proxy rows carry provider_kind.
    describe: "cost_entries.provider (view rewrite)",
    probe: { kind: "column", table: "cost_entries", column: "provider" },
    sql: COST_ENTRIES_VIEW_SQL,
  },
  {
    // The index marks completion of this atomic nullable-user and view repair.
    // Keep the block one statement: pg binds tx.query as a prepared statement.
    describe: "llm_proxy_requests team attribution",
    probe: { kind: "index", index: "llm_proxy_requests_team_created" },
    sql: `DO $repair$ BEGIN
      ALTER TABLE "llm_proxy_requests" ALTER COLUMN "user_id" DROP NOT NULL;
      ${COST_ENTRIES_VIEW_SQL};
      CREATE INDEX IF NOT EXISTS "llm_proxy_requests_team_created" ON "llm_proxy_requests" ("team_id", "created_at");
      END $repair$`,
  },
  {
    // Which authoring surface a session drives (Valet Security spec; shared
    // shape with the Valet Design PR #396). DEFAULT backfills every
    // pre-existing row to 'code' — the answer a fresh database gives.
    describe: "agent_sessions.kind column",
    probe: { kind: "column", table: "agent_sessions", column: "kind" },
    sql: 'ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT \'code\'',
  },
  {
    // Valet Security tables (docs/specs/2026-08-27-valet-security-design.md).
    // Whole-table siblings of the column repairs; keep each in lockstep with
    // 0000_app.sql.
    describe: "security_engagements table",
    probe: { kind: "table", table: "security_engagements" },
    sql: `CREATE TABLE IF NOT EXISTS "security_engagements" (
      "id" text PRIMARY KEY NOT NULL,
      "session_id" text NOT NULL,
      "status" text DEFAULT 'planning' NOT NULL,
      "repo_full_name" text NOT NULL,
      "repo_ref" text DEFAULT '' NOT NULL,
      "plan" text DEFAULT '' NOT NULL,
      "parent_engagement_id" text,
      "base_ref" text,
      "changed_paths" text,
      "focus" text,
      "invariants" text,
      "categories" text,
      "config_personas" text,
      "config_persona_markdown" text,
      "config_tools" text,
      "authorized_scope" text,
      "has_repo_config" boolean DEFAULT false NOT NULL,
      "report_markdown" text,
      "report_json" text,
      "report_generated_at" bigint,
      "created_at" bigint NOT NULL,
      "updated_at" bigint NOT NULL
    )`,
  },
  {
    describe: "security_engagements_session_unique index",
    probe: { kind: "index", index: "security_engagements_session_unique" },
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "security_engagements_session_unique" ON "security_engagements" ("session_id")',
  },
  {
    // The re-scan lineage link (re-scan / iterate). Null on every engagement
    // written before the column existed — read as "not a re-scan", the same
    // answer a first review gets. The whole-table CREATE above does not add a
    // column to an already-created table, so this column repair is separate.
    describe: "security_engagements.parent_engagement_id column",
    probe: { kind: "column", table: "security_engagements", column: "parent_engagement_id" },
    sql: 'ALTER TABLE "security_engagements" ADD COLUMN IF NOT EXISTS "parent_engagement_id" text',
  },
  {
    // Diff-scoped re-scan (re-scan / iterate): the parent SHA the diff ran
    // against. Null on a first review, or a full-scan fallback. Separate
    // column repair because the whole-table CREATE does not add a column to an
    // already-created table.
    describe: "security_engagements.base_ref column",
    probe: { kind: "column", table: "security_engagements", column: "base_ref" },
    sql: 'ALTER TABLE "security_engagements" ADD COLUMN IF NOT EXISTS "base_ref" text',
  },
  {
    // Diff-scoped re-scan (re-scan / iterate): the JSON array of changed file
    // paths the sweeps scoped to. Null on a first review or a full-scan
    // fallback.
    describe: "security_engagements.changed_paths column",
    probe: { kind: "column", table: "security_engagements", column: "changed_paths" },
    sql: 'ALTER TABLE "security_engagements" ADD COLUMN IF NOT EXISTS "changed_paths" text',
  },
  {
    // Repo config context (dynamic-config M-F1): parsed from `.valet/security.yml`
    // at create. Null on a preset-seeded engagement. Separate column repairs
    // because the whole-table CREATE does not add a column to an existing table.
    describe: "security_engagements.focus column",
    probe: { kind: "column", table: "security_engagements", column: "focus" },
    sql: 'ALTER TABLE "security_engagements" ADD COLUMN IF NOT EXISTS "focus" text',
  },
  {
    describe: "security_engagements.invariants column",
    probe: { kind: "column", table: "security_engagements", column: "invariants" },
    sql: 'ALTER TABLE "security_engagements" ADD COLUMN IF NOT EXISTS "invariants" text',
  },
  {
    describe: "security_engagements.categories column",
    probe: { kind: "column", table: "security_engagements", column: "categories" },
    sql: 'ALTER TABLE "security_engagements" ADD COLUMN IF NOT EXISTS "categories" text',
  },
  {
    describe: "security_engagements.config_personas column",
    probe: { kind: "column", table: "security_engagements", column: "config_personas" },
    sql: 'ALTER TABLE "security_engagements" ADD COLUMN IF NOT EXISTS "config_personas" text',
  },
  {
    describe: "security_engagements.config_persona_markdown column",
    probe: { kind: "column", table: "security_engagements", column: "config_persona_markdown" },
    sql: 'ALTER TABLE "security_engagements" ADD COLUMN IF NOT EXISTS "config_persona_markdown" text',
  },
  {
    describe: "security_engagements.config_tools column",
    probe: { kind: "column", table: "security_engagements", column: "config_tools" },
    sql: 'ALTER TABLE "security_engagements" ADD COLUMN IF NOT EXISTS "config_tools" text',
  },
  {
    // Authorized live-testing scope (M-P4b): the hosts the live personas may
    // reach. JSON `{ hosts: string[] }`. Null when no live testing is authorized.
    describe: "security_engagements.authorized_scope column",
    probe: { kind: "column", table: "security_engagements", column: "authorized_scope" },
    sql: 'ALTER TABLE "security_engagements" ADD COLUMN IF NOT EXISTS "authorized_scope" text',
  },
  {
    describe: "security_engagements.has_repo_config column",
    probe: { kind: "column", table: "security_engagements", column: "has_repo_config" },
    sql: 'ALTER TABLE "security_engagements" ADD COLUMN IF NOT EXISTS "has_repo_config" boolean DEFAULT false NOT NULL',
  },
  {
    // The report artifact (M-P3): the report cell writes the markdown report and
    // its JSON snapshot; both stay null until it runs. Separate column repairs
    // because the whole-table CREATE does not add a column to an existing table.
    describe: "security_engagements.report_markdown column",
    probe: { kind: "column", table: "security_engagements", column: "report_markdown" },
    sql: 'ALTER TABLE "security_engagements" ADD COLUMN IF NOT EXISTS "report_markdown" text',
  },
  {
    describe: "security_engagements.report_json column",
    probe: { kind: "column", table: "security_engagements", column: "report_json" },
    sql: 'ALTER TABLE "security_engagements" ADD COLUMN IF NOT EXISTS "report_json" text',
  },
  {
    describe: "security_engagements.report_generated_at column",
    probe: { kind: "column", table: "security_engagements", column: "report_generated_at" },
    sql: 'ALTER TABLE "security_engagements" ADD COLUMN IF NOT EXISTS "report_generated_at" bigint',
  },
  {
    describe: "security_engagements_parent index",
    probe: { kind: "index", index: "security_engagements_parent" },
    sql: 'CREATE INDEX IF NOT EXISTS "security_engagements_parent" ON "security_engagements" ("parent_engagement_id")',
  },
  {
    describe: "security_cells table",
    probe: { kind: "table", table: "security_cells" },
    sql: `CREATE TABLE IF NOT EXISTS "security_cells" (
      "id" text PRIMARY KEY NOT NULL,
      "engagement_id" text NOT NULL,
      "ordinal" integer NOT NULL,
      "persona" text NOT NULL,
      "mode" text DEFAULT 'fresh' NOT NULL,
      "goal" text NOT NULL,
      "dir" text NOT NULL,
      "reads" text DEFAULT '[]' NOT NULL,
      "review" boolean DEFAULT false NOT NULL,
      "status" text DEFAULT 'pending' NOT NULL,
      "status_reason" text,
      "attempts" integer DEFAULT 0 NOT NULL,
      "compacted_at" bigint,
      "child_session_id" text,
      "dispatched_at" bigint,
      "settled_at" bigint,
      "created_at" bigint NOT NULL
    )`,
  },
  {
    // Why a cell reached its terminal status (fix 5, attempt-cap failure).
    // Null on every row written before the column existed and on a normally-
    // settled cell — the cell rail reads null as "no explicit reason".
    describe: "security_cells.status_reason column",
    probe: { kind: "column", table: "security_cells", column: "status_reason" },
    sql: 'ALTER TABLE "security_cells" ADD COLUMN IF NOT EXISTS "status_reason" text',
  },
  {
    describe: "security_cells_engagement_ordinal_unique index",
    probe: { kind: "index", index: "security_cells_engagement_ordinal_unique" },
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "security_cells_engagement_ordinal_unique" ON "security_cells" ("engagement_id", "ordinal")',
  },
  {
    describe: "security_cells_child_session index",
    probe: { kind: "index", index: "security_cells_child_session" },
    sql: 'CREATE INDEX IF NOT EXISTS "security_cells_child_session" ON "security_cells" ("child_session_id")',
  },
  {
    describe: "security_files table",
    probe: { kind: "table", table: "security_files" },
    sql: `CREATE TABLE IF NOT EXISTS "security_files" (
      "id" text PRIMARY KEY NOT NULL,
      "engagement_id" text NOT NULL,
      "cell_id" text NOT NULL,
      "path" text NOT NULL,
      "revision" integer NOT NULL,
      "content" text NOT NULL,
      "created_at" bigint NOT NULL
    )`,
  },
  {
    describe: "security_files_path_revision_unique index",
    probe: { kind: "index", index: "security_files_path_revision_unique" },
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "security_files_path_revision_unique" ON "security_files" ("engagement_id", "path", "revision")',
  },
  {
    describe: "security_findings table",
    probe: { kind: "table", table: "security_findings" },
    sql: `CREATE TABLE IF NOT EXISTS "security_findings" (
      "id" text PRIMARY KEY NOT NULL,
      "engagement_id" text NOT NULL,
      "cell_id" text NOT NULL,
      "fingerprint" text NOT NULL,
      "severity" text NOT NULL,
      "title" text NOT NULL,
      "file" text,
      "line" integer,
      "body" text DEFAULT '' NOT NULL,
      "status" text DEFAULT 'open' NOT NULL,
      "status_reason" text,
      "status_actor" text,
      "recurring" boolean DEFAULT false NOT NULL,
      "carried_from_finding_id" text,
      "created_at" bigint NOT NULL
    )`,
  },
  {
    // Re-scan v2 carried-finding flag. DEFAULT backfills every pre-existing
    // row to false — a first review's findings are never recurring.
    describe: "security_findings.recurring column",
    probe: { kind: "column", table: "security_findings", column: "recurring" },
    sql: 'ALTER TABLE "security_findings" ADD COLUMN IF NOT EXISTS "recurring" boolean NOT NULL DEFAULT false',
  },
  {
    // Re-scan v2 carried-finding provenance. Null on rows written before the
    // column existed and on every first-seen finding.
    describe: "security_findings.carried_from_finding_id column",
    probe: { kind: "column", table: "security_findings", column: "carried_from_finding_id" },
    sql: 'ALTER TABLE "security_findings" ADD COLUMN IF NOT EXISTS "carried_from_finding_id" text',
  },
  {
    describe: "security_findings_engagement index",
    probe: { kind: "index", index: "security_findings_engagement" },
    sql: 'CREATE INDEX IF NOT EXISTS "security_findings_engagement" ON "security_findings" ("engagement_id")',
  },
  {
    describe: "security_finding_links table",
    probe: { kind: "table", table: "security_finding_links" },
    sql: `CREATE TABLE IF NOT EXISTS "security_finding_links" (
      "id" text PRIMARY KEY NOT NULL,
      "finding_id" text NOT NULL,
      "engagement_id" text NOT NULL,
      "provider" text NOT NULL,
      "external_id" text NOT NULL,
      "url" text NOT NULL,
      "created_by" text NOT NULL,
      "created_at" bigint NOT NULL
    )`,
  },
  {
    describe: "security_finding_links_provider_unique index",
    probe: { kind: "index", index: "security_finding_links_provider_unique" },
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "security_finding_links_provider_unique" ON "security_finding_links" ("finding_id", "provider")',
  },
  {
    describe: "security_handoffs table",
    probe: { kind: "table", table: "security_handoffs" },
    sql: `CREATE TABLE IF NOT EXISTS "security_handoffs" (
      "id" text PRIMARY KEY NOT NULL,
      "engagement_id" text NOT NULL,
      "finding_id" text NOT NULL,
      "child_session_id" text NOT NULL,
      "title" text NOT NULL,
      "task" text,
      "created_by" text NOT NULL,
      "created_at" bigint NOT NULL
    )`,
  },
  {
    describe: "security_handoffs_engagement index",
    probe: { kind: "index", index: "security_handoffs_engagement" },
    sql: 'CREATE INDEX IF NOT EXISTS "security_handoffs_engagement" ON "security_handoffs" ("engagement_id")',
  },
  {
    describe: "security_handoffs_finding index",
    probe: { kind: "index", index: "security_handoffs_finding" },
    sql: 'CREATE INDEX IF NOT EXISTS "security_handoffs_finding" ON "security_handoffs" ("finding_id")',
  },
  {
    describe: "security_finding_comments table",
    probe: { kind: "table", table: "security_finding_comments" },
    sql: `CREATE TABLE IF NOT EXISTS "security_finding_comments" (
      "id" text PRIMARY KEY NOT NULL,
      "finding_id" text NOT NULL,
      "engagement_id" text NOT NULL,
      "body" text NOT NULL,
      "author_user_id" text NOT NULL,
      "created_at" bigint NOT NULL
    )`,
  },
  {
    describe: "security_finding_comments_finding index",
    probe: { kind: "index", index: "security_finding_comments_finding" },
    sql: 'CREATE INDEX IF NOT EXISTS "security_finding_comments_finding" ON "security_finding_comments" ("finding_id")',
  },
  {
    describe: "security_finding_comments_engagement index",
    probe: { kind: "index", index: "security_finding_comments_engagement" },
    sql: 'CREATE INDEX IF NOT EXISTS "security_finding_comments_engagement" ON "security_finding_comments" ("engagement_id")',
  },
  {
    describe: "security_coverage table",
    probe: { kind: "table", table: "security_coverage" },
    sql: `CREATE TABLE IF NOT EXISTS "security_coverage" (
      "id" text PRIMARY KEY NOT NULL,
      "engagement_id" text NOT NULL,
      "cell_id" text NOT NULL,
      "area" text NOT NULL,
      "status" text NOT NULL,
      "tool" text,
      "reason" text,
      "created_at" bigint NOT NULL
    )`,
  },
  {
    describe: "security_coverage_engagement index",
    probe: { kind: "index", index: "security_coverage_engagement" },
    sql: 'CREATE INDEX IF NOT EXISTS "security_coverage_engagement" ON "security_coverage" ("engagement_id")',
  },
  {
    describe: "security_coverage_cell index",
    probe: { kind: "index", index: "security_coverage_cell" },
    sql: 'CREATE INDEX IF NOT EXISTS "security_coverage_cell" ON "security_coverage" ("cell_id")',
  },
  {
    describe: "security_needs table",
    probe: { kind: "table", table: "security_needs" },
    sql: `CREATE TABLE IF NOT EXISTS "security_needs" (
      "id" text PRIMARY KEY NOT NULL,
      "engagement_id" text NOT NULL,
      "cell_id" text NOT NULL,
      "kind" text NOT NULL,
      "description" text NOT NULL,
      "status" text DEFAULT 'open' NOT NULL,
      "resolution" text,
      "created_at" bigint NOT NULL,
      "resolved_at" bigint
    )`,
  },
  {
    describe: "security_needs_engagement index",
    probe: { kind: "index", index: "security_needs_engagement" },
    sql: 'CREATE INDEX IF NOT EXISTS "security_needs_engagement" ON "security_needs" ("engagement_id")',
  },
  {
    describe: "security_needs_cell index",
    probe: { kind: "index", index: "security_needs_cell" },
    sql: 'CREATE INDEX IF NOT EXISTS "security_needs_cell" ON "security_needs" ("cell_id")',
  },
  {
    // engine_entries.seq — the message-order tiebreaker (TKAI-303). engine_meta
    // tracks the engine schema, but its version check is fail-loud, not
    // self-repairing: bumping ENGINE_SCHEMA_VERSION would make every deployed
    // database refuse to boot and demand a wipe, which would destroy thread
    // history. This additive column does not touch CAS correctness, so it does
    // not need that guard — the version stays put and the column arrives here
    // instead. The IDENTITY backfills existing rows in PHYSICAL (heap) order,
    // which equals insertion order only for rows never updated in place: a row
    // rewritten by an earlier updateEntry sits at a later heap position, so its
    // backfilled seq can fall out of insertion order. So this repair makes an
    // existing thread's order STABLE across reads (no more plan-dependent
    // flicker), but it does not retroactively correct a same-millisecond tie
    // that was already reordered before the ALTER — that true order is the data
    // the bug never recorded. Every entry written after the column exists gets
    // a correct tie order. This is the one repair that rewrites its table
    // (IDENTITY is a volatile default), so it takes an ACCESS EXCLUSIVE lock the
    // first and only time it runs; the probe keeps every later boot lock-free.
    describe: "engine_entries.seq column",
    probe: { kind: "column", table: "engine_entries", column: "seq" },
    sql: 'ALTER TABLE "engine_entries" ADD COLUMN IF NOT EXISTS "seq" bigint GENERATED ALWAYS AS IDENTITY NOT NULL',
  },
  {
    // Epoch ms of the most recent activity in this session (TKAI-341).
    // The session list sorts by this column so a long-lived channel-bound
    // session rises when it receives a message. Null on rows from before
    // the column: queries fall back to `updated_at` via COALESCE.
    describe: "agent_sessions.last_activity_at column",
    probe: { kind: "column", table: "agent_sessions", column: "last_activity_at" },
    sql: 'ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "last_activity_at" bigint',
  },
  {
    // Org allowlist of selectable model ids (model selector overhaul).
    // Null = whole catalog approved. Empty array is rejected at the API.
    // Admins bypass the list.
    describe: "orgs.approved_models column",
    probe: { kind: "column", table: "orgs", column: "approved_models" },
    sql: 'ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "approved_models" jsonb',
  },
  {
    // Org reasoning settings for model selector (model selector overhaul).
    // { default?: ThinkingLevel, max?: ThinkingLevel }. Null = no default,
    // no cap.
    describe: "orgs.reasoning_settings column",
    probe: { kind: "column", table: "orgs", column: "reasoning_settings" },
    sql: 'ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "reasoning_settings" jsonb',
  },
  {
    // Personal default reasoning level (model selector overhaul).
    // Null = inherit.
    describe: "user.default_reasoning column",
    probe: { kind: "column", table: "user", column: "default_reasoning" },
    sql: 'ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "default_reasoning" text',
  },
  {
    // Existing users keep the active thread's settings by default.
    describe: "user.new_thread_behavior column",
    probe: { kind: "column", table: "user", column: "new_thread_behavior" },
    sql: `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "new_thread_behavior" text NOT NULL DEFAULT 'keep_current'`,
  },
  {
    // Team default reasoning level (model selector overhaul).
    // Null = inherit.
    describe: "teams.default_reasoning column",
    probe: { kind: "column", table: "teams", column: "default_reasoning" },
    sql: 'ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "default_reasoning" text',
  },
  {
    // Persisted session-default reasoning level (model selector overhaul).
    // An ENGINE table: the same rule as engine_entries.seq above applies —
    // additive columns arrive through this repair, and ENGINE_SCHEMA_VERSION
    // stays put, because its check is fail-loud and a bump would make every
    // deployed database demand a wipe of thread history.
    describe: "engine_sessions.reasoning column",
    probe: { kind: "column", table: "engine_sessions", column: "reasoning" },
    sql: 'ALTER TABLE "engine_sessions" ADD COLUMN IF NOT EXISTS "reasoning" text',
  },
  {
    // Per-thread reasoning pin (model selector overhaul). Engine table —
    // see the note on engine_sessions.reasoning above.
    describe: "engine_threads.reasoning column",
    probe: { kind: "column", table: "engine_threads", column: "reasoning" },
    sql: 'ALTER TABLE "engine_threads" ADD COLUMN IF NOT EXISTS "reasoning" text',
  },
  {
    // Team `vlt_` key pin (TKAI-396). Nullable: a personal key has none.
    // Pre-1.0 there are no team keys to backfill; the team route writes
    // the column and `metadata.teamId` in one statement from now on.
    describe: "apikey.team_id column",
    probe: { kind: "column", table: "apikey", column: "team_id" },
    sql: 'ALTER TABLE "apikey" ADD COLUMN IF NOT EXISTS "team_id" text',
  },
  {
    describe: "apikey_teamId_idx index",
    probe: { kind: "index", index: "apikey_teamId_idx" },
    sql: 'CREATE INDEX IF NOT EXISTS "apikey_teamId_idx" ON "apikey" ("team_id")',
  },
  {
    describe: "event_drop_log_page index",
    probe: { kind: "index", index: "event_drop_log_page" },
    sql: 'CREATE INDEX IF NOT EXISTS "event_drop_log_page" ON "event_drop_log" ("org_id","created_at","id")',
  },
  {
    describe: "event_drop_log.event_key column",
    probe: { kind: "column", table: "event_drop_log", column: "event_key" },
    sql: 'ALTER TABLE "event_drop_log" ADD COLUMN IF NOT EXISTS "event_key" text',
  },
  {
    describe: "event_drop_log.event_metadata column",
    probe: { kind: "column", table: "event_drop_log", column: "event_metadata" },
    sql: 'ALTER TABLE "event_drop_log" ADD COLUMN IF NOT EXISTS "event_metadata" jsonb',
  },
  {
    describe: "event_drop_log_event_key index",
    probe: { kind: "index", index: "event_drop_log_event_key" },
    sql: 'CREATE INDEX IF NOT EXISTS "event_drop_log_event_key" ON "event_drop_log" ("org_id","event_key","created_at")',
  },
  {
    // Whose credentials a team-owned session reads (team credentials
    // design, deviation 13). Nullable; the backfill below is the one-time stamp.
    describe: "agent_sessions.credential_owner_mode column",
    probe: { kind: "column", table: "agent_sessions", column: "credential_owner_mode" },
    sql: 'ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "credential_owner_mode" text',
    backfill:
      `UPDATE "agent_sessions" SET "credential_owner_mode" = 'actor' ` +
      `WHERE "owner_type" = 'team' AND "credential_owner_mode" IS NULL RETURNING "id"`,
  },
  {
    describe: "usage_entry_facts projection and indexes",
    probe: { kind: "column", table: "usage_entries", column: "entry_id" },
    prepare: prepareUsageAnalytics,
    sql: usageAnalyticsPublishSql,
  },
  { describe: "usage_entry_facts_window", probe: { kind: "index", index: "usage_entry_facts_window" }, sql: `CREATE INDEX IF NOT EXISTS usage_entry_facts_window ON usage_entry_facts(created_at, session_id);` },
  { describe: "usage_entry_facts_session_window", probe: { kind: "index", index: "usage_entry_facts_session_window" }, sql: `CREATE INDEX IF NOT EXISTS usage_entry_facts_session_window ON usage_entry_facts(session_id, created_at);` },
  { describe: "usage_entry_facts_workflow_window", probe: { kind: "index", index: "usage_entry_facts_workflow_window" }, sql: `CREATE INDEX IF NOT EXISTS usage_entry_facts_workflow_window ON usage_entry_facts(workflow_run_id, created_at)
    WHERE workflow_run_id IS NOT NULL;` },
  { describe: "action_invocations_usage_time", probe: { kind: "index", index: "action_invocations_usage_time" }, sql: `CREATE INDEX IF NOT EXISTS action_invocations_usage_time
    ON action_invocations(org_id, (COALESCE(started_at, created_at)))
    WHERE status IN ('completed', 'error') AND duration_ms IS NOT NULL;` },
  { describe: "skill_context_attributions_window", probe: { kind: "index", index: "skill_context_attributions_window" }, sql: `CREATE INDEX IF NOT EXISTS skill_context_attributions_window
    ON skill_context_attributions(created_at, skill_invocation_id);` },
  { describe: "agent_sessions_usage_scope", probe: { kind: "index", index: "agent_sessions_usage_scope" }, sql: `CREATE INDEX IF NOT EXISTS agent_sessions_usage_scope
    ON agent_sessions(org_id, user_id, id);` },
  { describe: "skill_invocations_usage_window", probe: { kind: "index", index: "skill_invocations_usage_window" }, sql: `CREATE INDEX IF NOT EXISTS skill_invocations_usage_window ON skill_invocations(created_at, session_id);` },
  { describe: "action_invocations_outcome_time", probe: { kind: "index", index: "action_invocations_outcome_time" }, sql: `CREATE INDEX IF NOT EXISTS action_invocations_outcome_time
    ON action_invocations(org_id, (COALESCE(started_at, created_at)))
    WHERE status = 'completed' AND duration_ms IS NOT NULL
      AND action_id IN ('github.create_pull_request', 'github.create_review', 'slack.send_message',
        'slack.reply_to_origin', 'slack.dm_owner', 'slack.dm_user');` },
  { describe: "usage_entry_facts_cost_window", probe: { kind: "index", index: "usage_entry_facts_cost_window" }, sql: "CREATE INDEX IF NOT EXISTS usage_entry_facts_cost_window ON usage_entry_facts(created_at, session_id) WHERE usage IS NOT NULL" },
  { describe: "usage_entry_facts_tools_window", probe: { kind: "index", index: "usage_entry_facts_tools_window" }, sql: "CREATE INDEX IF NOT EXISTS usage_entry_facts_tools_window ON usage_entry_facts(created_at, session_id) WHERE tool_calls > 0" },
  { describe: "usage_entry_facts_outcomes_window", probe: { kind: "index", index: "usage_entry_facts_outcomes_window" }, sql: "CREATE INDEX IF NOT EXISTS usage_entry_facts_outcomes_window ON usage_entry_facts(created_at, session_id) WHERE pull_requests > 0 OR reviews > 0" },
  { describe: "usage hourly summaries", probe: { kind: "column", table: "usage_hourly_ready", column: "version" }, prepare: prepareUsageHourly, sql: usageHourlyPublishSql },
  { describe: "usage action and skill summaries", probe: { kind: "column", table: "usage_aux_rollups_ready", column: "version" }, prepare: prepareAuxUsageRollups, sql: AUX_USAGE_PUBLISH_SQL },
  { describe: "usage member activity summaries", probe: { kind: "column", table: "usage_member_activity_ready", column: "version" }, prepare: prepareMemberActivity, sql: MEMBER_ACTIVITY_PUBLISH_SQL },
  { describe: "usage_action_facts_window", probe: { kind: "index", index: "usage_action_facts_window" }, sql: `CREATE INDEX IF NOT EXISTS usage_action_facts_window ON usage_action_facts(org_id, created_at);` },
  { describe: "usage_action_hourly_window", probe: { kind: "index", index: "usage_action_hourly_window" }, sql: `CREATE INDEX IF NOT EXISTS usage_action_hourly_window ON usage_action_hourly(org_id, hour_ms);` },
  { describe: "usage_skill_facts_window", probe: { kind: "index", index: "usage_skill_facts_window" }, sql: `CREATE INDEX IF NOT EXISTS usage_skill_facts_window ON usage_skill_facts(created_at);` },
  { describe: "usage_skill_facts_session_window", probe: { kind: "index", index: "usage_skill_facts_session_window" }, sql: `CREATE INDEX IF NOT EXISTS usage_skill_facts_session_window ON usage_skill_facts(session_id,created_at);` },
  { describe: "usage_skill_facts_invocation", probe: { kind: "index", index: "usage_skill_facts_invocation" }, sql: `CREATE INDEX IF NOT EXISTS usage_skill_facts_invocation ON usage_skill_facts(invocation_id);` },
  { describe: "usage_skill_hourly_window", probe: { kind: "index", index: "usage_skill_hourly_window" }, sql: `CREATE INDEX IF NOT EXISTS usage_skill_hourly_window ON usage_skill_hourly(hour_ms,session_id);` },
  { describe: "usage_skill_hourly_session_window", probe: { kind: "index", index: "usage_skill_hourly_session_window" }, sql: `CREATE INDEX IF NOT EXISTS usage_skill_hourly_session_window ON usage_skill_hourly(session_id,hour_ms);` },
  { describe: "usage_skill_membership_request", probe: { kind: "index", index: "usage_skill_membership_request" }, sql: `CREATE INDEX IF NOT EXISTS usage_skill_membership_request ON usage_skill_request_memberships(request_key);` },
  { describe: "usage_skill_requests_duplicates", probe: { kind: "index", index: "usage_skill_requests_duplicates" }, sql: `CREATE INDEX IF NOT EXISTS usage_skill_requests_duplicates ON usage_skill_requests(request_key) WHERE memberships > 1;` },
{ describe: "usage_member_facts_queue", probe: { kind: "index", index: "usage_member_facts_queue" }, sql: "CREATE INDEX IF NOT EXISTS usage_member_facts_queue ON usage_member_facts(queue_item_id,session_id)" },
{ describe: "usage_member_facts_window", probe: { kind: "index", index: "usage_member_facts_window" }, sql: "CREATE INDEX IF NOT EXISTS usage_member_facts_window ON usage_member_facts(created_at,session_id)" },
{ describe: "usage_member_facts_session_window", probe: { kind: "index", index: "usage_member_facts_session_window" }, sql: "CREATE INDEX IF NOT EXISTS usage_member_facts_session_window ON usage_member_facts(session_id,created_at)" },
{ describe: "usage_member_hourly_window", probe: { kind: "index", index: "usage_member_hourly_window" }, sql: "CREATE INDEX IF NOT EXISTS usage_member_hourly_window ON usage_member_hourly(created_at,session_id)" },
{ describe: "usage_member_hourly_empty", probe: { kind: "index", index: "usage_member_hourly_empty" }, sql: "CREATE INDEX IF NOT EXISTS usage_member_hourly_empty ON usage_member_hourly(created_at) WHERE positive_turns=0" },
  {describe:"usage_hourly_window",probe:{kind:"index",index:"usage_hourly_window"},sql:"CREATE INDEX IF NOT EXISTS usage_hourly_window ON usage_hourly(created_at,session_id)"},
  {describe:"usage_hourly_session_window",probe:{kind:"index",index:"usage_hourly_session_window"},sql:"CREATE INDEX IF NOT EXISTS usage_hourly_session_window ON usage_hourly(session_id,created_at)"},
  {describe:"usage_hourly_org_window",probe:{kind:"index",index:"usage_hourly_org_window"},sql:"CREATE INDEX IF NOT EXISTS usage_hourly_org_window ON usage_hourly(org_id,created_at)"},
  {describe:"usage_hourly_empty",probe:{kind:"index",index:"usage_hourly_empty"},sql:"CREATE INDEX IF NOT EXISTS usage_hourly_empty ON usage_hourly(created_at) WHERE turns=0 AND tool_calls=0 AND pull_requests=0 AND reviews=0"},
  {describe:"usage_hourly_outcomes",probe:{kind:"index",index:"usage_hourly_outcomes"},sql:"CREATE INDEX IF NOT EXISTS usage_hourly_outcomes ON usage_hourly(created_at,session_id) WHERE pull_requests>0 OR reviews>0"},

  {describe:"usage daily summaries",probe:{kind:"column",table:"usage_daily_ready",column:"version"},prepare:prepareUsageDaily,sql:"SELECT 1"},
  {describe:"usage_daily_window",probe:{kind:"index",index:"usage_daily_window"},sql:"CREATE INDEX IF NOT EXISTS usage_daily_window ON usage_daily(created_at,session_id)"},
  {describe:"usage_daily_session_window",probe:{kind:"index",index:"usage_daily_session_window"},sql:"CREATE INDEX IF NOT EXISTS usage_daily_session_window ON usage_daily(session_id,created_at)"},
  {describe:"usage_daily_org_window",probe:{kind:"index",index:"usage_daily_org_window"},sql:"CREATE INDEX IF NOT EXISTS usage_daily_org_window ON usage_daily(org_id,created_at)"},
  {describe:"usage_daily_empty",probe:{kind:"index",index:"usage_daily_empty"},sql:"CREATE INDEX IF NOT EXISTS usage_daily_empty ON usage_daily(created_at) WHERE turns=0 AND tool_calls=0 AND pull_requests=0 AND reviews=0"},
  {describe:"usage_daily_outcomes",probe:{kind:"index",index:"usage_daily_outcomes"},sql:"CREATE INDEX IF NOT EXISTS usage_daily_outcomes ON usage_daily(created_at,session_id) WHERE pull_requests>0 OR reviews>0"},

];

/** The repairs this database still lacks, by catalog probe — one query per
 * probe kind (3 round-trips), not one per repair. Exported for the schema
 * tests: steady state must return [] — that is the no-locks contract.
 * The probe lists ride as JSON strings so both drivers (node-postgres,
 * PGlite) bind them identically. */
export async function missingSchemaRepairs(db: PgDb): Promise<SchemaRepair[]> {
  const columnTables = new Set<string>();
  const tableNames: string[] = [];
  const indexNames: string[] = [];
  for (const { probe } of SCHEMA_REPAIRS) {
    if (probe.kind === "column" || probe.kind === "removed-column") columnTables.add(probe.table);
    else if (probe.kind === "table") tableNames.push(probe.table);
    else indexNames.push(probe.index);
  }

  const present = new Set<string>();
  const collect = async (sql: string, names: string[], toKey: (row: Record<string, unknown>) => string) => {
    if (names.length === 0) return;
    const result = await db.query(sql, [JSON.stringify(names)]);
    for (const row of result.rows) present.add(toKey(row));
  };
  await collect(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name IN (SELECT jsonb_array_elements_text($1::jsonb))`,
    [...columnTables],
    (row) => `column:${String(row["table_name"])}.${String(row["column_name"])}`,
  );
  await collect(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name IN (SELECT jsonb_array_elements_text($1::jsonb))`,
    tableNames,
    (row) => `table:${String(row["table_name"])}`,
  );
  await collect(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = current_schema()
       AND indexname IN (SELECT jsonb_array_elements_text($1::jsonb))`,
    indexNames,
    (row) => `index:${String(row["indexname"])}`,
  );

  const pending = SCHEMA_REPAIRS.filter(({ probe: p }) => {
    if (p.kind === "removed-column") return present.has(`column:${p.table}.${p.column}`);
    const key = p.kind === "column" ? `column:${p.table}.${p.column}` : p.kind === "table" ? `table:${p.table}` : `index:${p.index}`;
    return !present.has(key);
  });
  return tablesBeforeTheirColumns(pending);
}

/**
 * List order is apply order, and a column repair may sit ahead of the
 * repair that creates its table (the table arrived later than the column
 * entries that were written against it). On a database that has neither,
 * the ALTER would run against a table that does not exist yet and the boot
 * would fail. Hoist each pending table repair ahead of the first pending
 * column repair on that table; everything else keeps its place.
 */
function tablesBeforeTheirColumns(pending: SchemaRepair[]): SchemaRepair[] {
  const creates = new Map<string, SchemaRepair>();
  for (const repair of pending) {
    if (repair.probe.kind === "table") creates.set(repair.probe.table, repair);
  }
  const ordered: SchemaRepair[] = [];
  const placed = new Set<SchemaRepair>();
  for (const repair of pending) {
    if (repair.probe.kind === "column") {
      const create = creates.get(repair.probe.table);
      if (create && !placed.has(create)) {
        ordered.push(create);
        placed.add(create);
      }
    }
    if (!placed.has(repair)) {
      ordered.push(repair);
      placed.add(repair);
    }
  }
  return ordered;
}

const REPAIR_LOCK_TIMEOUT = "5s";
const REPAIR_ATTEMPTS = 3;

/**
 * Repair the schema gaps that in-place `0000_app.sql` edits leave in an
 * already-migrated database. Steady state (nothing missing) runs catalog
 * probes only — no DDL, no exclusive locks (TKAI-244). A repair that must
 * run does so under `lock_timeout`, retries briefly, and then fails naming
 * the wait — a hung boot with nothing in the log is the failure mode this
 * replaces.
 */
async function addColumnsMissingFromAppliedMigrations(db: PgDb): Promise<void> {
  for (const repair of await missingSchemaRepairs(db)) {
    await runSchemaRepair(db, repair);
  }
}

async function runSchemaRepair(db: PgDb, repair: SchemaRepair): Promise<void> {
  for (let attempt = 1; attempt <= REPAIR_ATTEMPTS; attempt++) {
    try {
      await repair.prepare?.(db);
      const backfilled = await db.transaction(async (tx) => {
        // SET LOCAL scopes the timeout to this transaction. Without it the
        // ALTER waits forever behind any open transaction on the table —
        // during a rolling update, the previous api pod's.
        await tx.query(`SET LOCAL lock_timeout = '${REPAIR_LOCK_TIMEOUT}'`);
        await tx.query(repair.sql);
        if (!repair.backfill) return 0;
        const result = await tx.query(repair.backfill);
        return result.rows.length;
      });
      console.log(
        `schema repair: added ${repair.describe}` + (repair.backfill ? ` (backfilled ${backfilled} row(s))` : ""),
      );
      return;
    } catch (err) {
      if (!isPgLockTimeout(err)) throw err;
      if (attempt < REPAIR_ATTEMPTS) {
        console.warn(
          `schema repair: ${repair.describe} waited ${REPAIR_LOCK_TIMEOUT} for a table lock (attempt ${attempt}/${REPAIR_ATTEMPTS}); retrying`,
        );
        await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
        continue;
      }
      throw new Error(
        `schema repair: ${repair.describe} could not get a table lock after ${REPAIR_ATTEMPTS} attempts of ${REPAIR_LOCK_TIMEOUT}. ` +
          `Another connection holds a conflicting lock — usually an open transaction from a previous api process. ` +
          `End that process (or its transaction in pg_stat_activity), then restart the api.`,
      );
    }
  }
}

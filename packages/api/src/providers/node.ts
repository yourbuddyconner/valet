import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildReader, ChildSender, ChildSpawner, ChildStatusReader, ValetPlugin } from "@valet/engine";
import { PgSessionStore, PgEventStream, applyEngineMigrations } from "@valet/store-postgres";
import { eq } from "drizzle-orm";
import { tracedSessionStore, tracedWorkflowStore } from "../observability/traced-store.js";
import {
  createDefaultNodeExecutors,
  LocalRunHost,
  type OnApprovalGrant,
  type OnApprovalPending,
  type OnGateResolved,
} from "@valet/workflow";
import { preserveLegacySandboxTokens } from "../auth/sandbox-tokens.js";
import { applyAppMigrations, buildAppDb, buildAppQueryable } from "../lib/drizzle.js";
import { orgMembers, orgs, users, workflowDefinitions } from "../schema/index.js";
import { writeExecutionGrant, updateInvocationOutcome } from "../policies/service.js";
import { EngineHost } from "../engine/host.js";
import { buildHibernationHooks } from "../engine/hibernation-hooks.js";
import {
  buildChildReader,
  buildChildSender,
  buildChildSpawner,
  buildChildStatusReader,
  ChildWatcher,
} from "../orchestrator/children.js";
import { HibernationReaper } from "../engine/hibernation-reaper.js";
import { SandboxReconcileSweep } from "../engine/sandbox-reconcile-sweep.js";
import { IdleHibernationSweep } from "../engine/idle-hibernation-sweep.js";
import { SecurityRunnerDriver } from "../orchestrator/security-runner-driver.js";
import { submitSessionPrompt } from "../routes/messages.js";
import { resolveSecurityNudgeIntervalMs, resolveSecurityNudgeMaxStalls } from "./security-nudge.js";
import { withSandboxCapacityGate } from "../engine/gated-sandbox-provider.js";
import { principalFromOwner, routeAttention } from "../orchestrator/attention.js";
import { resolveOrgSessionCeiling } from "../orchestrator/limits.js";
import { assemblePlugins } from "../plugins/assemble.js";
import { ensurePluginStoreIndexes } from "../services/plugin-store.js";
import { workflowsActionPlugin } from "../workflows/actions.js";
import { skillsActionPlugin } from "../services/skills-actions.js";
import { eventsActionPlugin } from "../events/actions.js";
import { ContentSyncService } from "../services/content-sync/service.js";
import { SkillCollector } from "../services/content-sync/skill-collector.js";
import { WorkflowCollector } from "../services/content-sync/workflow-collector.js";
import { TemplateCollector } from "../services/content-sync/template-collector.js";
import { MemoryCollector } from "../services/content-sync/memory-collector.js";
import { listCatalogTemplates } from "../workflows/templates.js";
import { buildValidateEnvironment } from "../workflows/validation-env.js";
import { GitHubSkillRepoReader } from "../services/skill-repo-reader.js";
import { skillRepoReaderFactory } from "../services/content-source-credential.js";
import type { WorkflowServiceDeps } from "../workflows/service.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { OAuthRefreshingCredentialStore } from "../plugins/oauth-refreshing-credential-store.js";
import { TeamCredentialStore } from "../plugins/team-credential-store.js";
import { isTeamMember } from "../services/teams.js";
import { createOnePasswordService } from "../services/onepassword.js";
import { DynamicToolCounts } from "../plugins/dynamic-tool-count.js";
import { loadNodeModulesPlugins } from "../plugins/node-modules-loader.js";
import { bundledPlugins } from "../plugins/registry.gen.js";
import { configMcpPlugins } from "../plugins/config-mcp.js";
import { buildWorkflowEngineDeps } from "../workflows/engine-deps.js";
import { PgWorkflowStore } from "../workflows/pg-store.js";
import { buildRunSettledAttention, buildRunThreadArchive, workflowApprovalHref } from "../workflows/run-attention.js";
import { WorkflowSandboxReclaimer } from "../workflows/sandbox-reclaim.js";
import { WorkflowScheduler } from "../workflows/scheduler.js";
import { WorkflowWebhookRateLimiter } from "../workflows/webhook-service.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { resolveOrgId } from "../lib/org.js";
import { ChannelHost, publicUrlFromEnv } from "../channels/host.js";
import { EventDispatcher } from "../events/dispatcher.js";
import { buildOrchestratorTarget } from "../events/orchestrator-target.js";
import { channelThreadContextFetcher } from "../events/channel-thread-context.js";
import { channelOriginResolver, channelMessageNormalizer } from "../events/channel-origin.js";
import { FsBlobStore } from "./blob-fs.js";
import { pgliteWasmOptions } from "../assets/base.js";
import {
  buildSandboxProvider,
  resolveChildRetentionMs,
  resolveDefaultImage,
  resolveHibernatedRetentionMs,
  resolveSandboxAgeReportMs,
  resolveIdleMinutes,
  resolveOrgSandboxCeiling,
  resolveSandboxCapacityWaitMs,
} from "./sandbox-backend.js";
import { resolveImageBuilder, resolvePrebuildPreflight } from "./image-builder.js";
import { SourceService } from "../bakes/source-service.js";
import type { Providers } from "./types.js";
import type { InstanceConfig } from "../config/instance-config.js";
import { InstanceConfigError } from "../config/instance-config.js";
import { createAutoTitleHost } from "../sessions/auto-title-host.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/api/src/providers -> packages/api
const apiPkgRoot = resolve(__dirname, "../..");
// packages/api -> repo root
const repoRoot = resolve(apiPkgRoot, "../..");

/**
 * Parses the `VALET_PLUGINS` env var: `allow:pkg1,pkg2` / `deny:pkg1` /
 * unset (no filtering). Format mirrors what the node_modules loader's
 * `allowlist`/`denylist` options expect.
 */
export function parseValetPluginsEnv(
  value: string | undefined,
): { allowlist?: string[]; denylist?: string[] } {
  if (!value) return {};
  const [mode, rest] = value.split(":", 2);
  const names = (rest ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (mode === "allow") return { allowlist: names };
  if (mode === "deny") return { denylist: names };
  return {};
}

/**
 * True only when the config's `plugins` block actually declares an allow or
 * deny list. An empty `plugins: {}` block (both keys undefined) does NOT count
 * as "config declares plugins": it neither trips the VALET_PLUGINS both-set
 * guard nor suppresses env parsing. `null`/absent config → false.
 */
export function configDeclaresPlugins(
  plugins: InstanceConfig["plugins"] | undefined,
): boolean {
  return plugins !== undefined && (plugins.allow !== undefined || plugins.deny !== undefined);
}

export interface NodeProviderOpts {
  /**
   * Postgres connection string. Set (typically `DATABASE_URL`) → connects
   * via `pg.Pool`. Unset → boots an embedded PGlite instance at `pgDataDir`
   * instead (spec decision 4's dev/test default).
   */
  databaseUrl?: string;
  /**
   * Directory backing the embedded PGlite instance when `databaseUrl` is
   * unset. Ignored when `databaseUrl` is set.
   */
  pgDataDir: string;
  /** Directory root for the filesystem-backed blob store. */
  blobsRoot: string;
  /** Encryption key used by helpers that store sensitive data. */
  encryptionKey: string;
  /**
   * Anthropic API key for the engine's LLM calls. Required for prompts to
   * actually run; leave undefined for read-only routes.
   */
  anthropicApiKey?: string;
  /**
   * This process's own base URL, handed to `EngineHost` for orchestrator
   * sessions' `toolConfig.apiBaseUrl` (Phase 4 decision 15/17). Required
   * for `assistantSessionFor`; regular sessions don't need it.
   */
  apiBaseUrl?: string;
  /**
   * Test-only crash-point hook for `LocalRunHost` (Phase 5 plan decision
   * 20), sourced from `WF_CRASH_AT` in `main.ts`. When `'terminalizing'`,
   * the host calls `process.exit(137)` right after `beginTerminalize`.
   */
  workflowCrashAt?: "terminalizing";
  /**
   * Test-only override for the assembled plugin set. When provided, no
   * node_modules scan runs and `assemblePlugins` is called with only this
   * one source: `assemblePlugins([[...plugins]])`. When absent (the normal
   * boot path), plugins are `assemblePlugins([bundledPlugins,
   * nodeModulesResult.plugins])`.
   */
  plugins?: ValetPlugin[];
  /**
   * Forwarded to `EngineHost.sandboxJwtMaster` (Task 8, auth-v2 plan) —
   * `AuthConfig.sandboxJwtMaster` when real auth is configured, else
   * undefined (the host falls back to `internalToken()`).
   */
  sandboxJwtMaster?: string;
  /**
   * Forwarded to `EngineHost.sandboxApiUrl` (Task 8, auth-v2 plan) —
   * `AuthConfig.baseUrl` when real auth is configured, else undefined (the
   * host falls back to the local dev default).
   */
  sandboxApiUrl?: string;
  /**
   * Seed the `local-user`/`local-org` stub identity (default `true`, for
   * backward compat with every existing stub-mode caller/test). Must be
   * `false` whenever real auth is configured (`BETTER_AUTH_SECRET` set):
   * `evaluateAdmission`'s "zero users → first signup becomes admin" rule
   * (`auth/provisioning.ts`) never fires if a local user is pre-seeded, so a
   * fresh real deployment could never mint its first admin and every real
   * signup would land in the seeded "Local Dev" org. The stub identity is an
   * admin, so seeding it next to real auth also leaves an admin row nobody
   * signed up for. `shouldSeedLocalIdentity` encodes this decision;
   * `main.ts` calls it.
   */
  seedLocalIdentity?: boolean;
  /**
   * Parsed instance config (`valet.yaml`). When present:
   * - `plugins` allow/deny feeds `loadNodeModulesPlugins` instead of
   *   `parseValetPluginsEnv`. Both set simultaneously is an error.
   * - `toolPolicies` reconcile into `action_policies` rows (org policies)
   *   by `reconcileInstanceConfig`; the policy engine reads them at runtime.
   */
  instanceConfig?: InstanceConfig;
}

/**
 * Whether boot should seed `local-user`/`local-org`. Real auth configured →
 * never (see `NodeProviderOpts.seedLocalIdentity`).
 */
export function shouldSeedLocalIdentity(authConfigured: boolean): boolean {
  return !authConfigured;
}

/**
 * Pool size for the `DATABASE_URL` path (`VALET_PG_POOL_MAX`, default 30).
 * pg's own default of 10 saturates under the api's background pollers: the
 * agents-dev incident of 2026-09-21 measured a steady ~9,000-deep pool wait
 * queue (~4.6s per checkout), which turned every authenticated request into
 * 15-40s of sequential queue waits. Zero, negative, or non-numeric values
 * fall back to the default — a pool with no capacity cannot serve boot.
 */
export function resolvePgPoolMax(env: NodeJS.ProcessEnv): number {
  const raw = env.VALET_PG_POOL_MAX;
  if (raw === undefined || raw === "") return 30;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 30;
  return Math.floor(n);
}

/**
 * How long a query waits for a free pool client before it errors
 * (`VALET_PG_POOL_CONNECT_TIMEOUT_MS`, default 30s, maps to pg's
 * `connectionTimeoutMillis`). pg's default of 0 waits forever, so pool
 * exhaustion presents as an unbounded silent hang instead of an error that
 * names the cause. Zero, negative, or non-numeric → 0 (no timeout).
 */
export function resolvePgPoolConnectTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.VALET_PG_POOL_CONNECT_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 30_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

export const LOCAL_USER = {
  id: "local-user",
  email: "local@dev",
  name: "Local Dev",
  role: "admin" as const,
};

export const LOCAL_ORG = {
  id: "local-org",
  name: "Local Dev",
};

/**
 * Open the Postgres connection (pool or embedded PGlite), run app + engine
 * migrations, seed the local dev identity, and construct every provider the
 * API + engine need.
 *
 * One connection source backs both schemas — table names don't collide
 * (`engine_*` vs application names) so they coexist in one database.
 */
export async function buildNodeProviders(opts: NodeProviderOpts): Promise<Providers> {
  mkdirSync(opts.blobsRoot, { recursive: true });

  let source: Pool | PGlite;
  if (opts.databaseUrl) {
    source = new Pool({
      connectionString: opts.databaseUrl,
      max: resolvePgPoolMax(process.env),
      connectionTimeoutMillis: resolvePgPoolConnectTimeoutMs(process.env),
    });
  } else {
    mkdirSync(opts.pgDataDir, { recursive: true });
    // Bundled single-binary: PGlite's default `import.meta.url`-relative wasm
    // load resolves to the bundle's own dir, so hand it the sibling
    // wasm/data assets explicitly. `undefined` in dev/tsx → default loading.
    const wasmOpts = await pgliteWasmOptions();
    source = wasmOpts ? new PGlite(opts.pgDataDir, wasmOpts) : new PGlite(opts.pgDataDir);
  }

  // Normalized query interface (decision 4) shared by the app's raw-SQL
  // migration runner and the engine's stores; `db` below is the Drizzle
  // handle over the SAME connection source.
  const pgdb = buildAppQueryable(source);

  // Pass the PGlite dir so a schema-mismatch error names the exact path to
  // delete; on DATABASE_URL there is no dir and the hint stays generic.
  const pgDirHint = opts.databaseUrl ? undefined : opts.pgDataDir;
  await applyAppMigrations(pgdb, pgDirHint);
  await applyEngineMigrations(pgdb, pgDirHint);

  const db = buildAppDb(source);
  await preserveLegacySandboxTokens(db);

  // Seed the local-dev identity. Idempotent. Skipped whenever real auth is
  // configured (`opts.seedLocalIdentity: false`, set by `main.ts` when
  // `authConfig` resolves) — see `NodeProviderOpts.seedLocalIdentity`.
  if (opts.seedLocalIdentity ?? true) {
    const now = Date.now();
    await db.insert(orgs).values({ id: LOCAL_ORG.id, name: LOCAL_ORG.name, createdAt: now }).onConflictDoNothing();
    await db
      .insert(users)
      .values({ id: LOCAL_USER.id, email: LOCAL_USER.email, name: LOCAL_USER.name, role: LOCAL_USER.role })
      .onConflictDoNothing();
    await db
      .insert(orgMembers)
      .values({ orgId: LOCAL_ORG.id, userId: LOCAL_USER.id, role: "admin", createdAt: now })
      .onConflictDoNothing();
  }

  // Store tracing (distributed tracing): only when the OTLP SDK will be
  // registered — the proxy is pure overhead otherwise. `store.*` spans time
  // every Postgres round trip inside the request/submission trees.
  const telemetryEnabled = !!(
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  );
  const rawEngineStore = new PgSessionStore(pgdb);
  const engineStore = telemetryEnabled ? tracedSessionStore(rawEngineStore) : rawEngineStore;
  const blobs = new FsBlobStore(opts.blobsRoot);
  // Backend selection (kubernetes-deployment plan Task 6, spec decision 7):
  // VALET_SANDBOX_BACKEND=docker|kubernetes|local, default docker — the
  // pre-Task-6 unconditional `new DockerSandboxProvider()` behavior.
  //
  // Wrapped in the per-org capacity gate (D.5): a create beyond the org's
  // sandbox ceiling waits for capacity instead of saturating the cluster.
  // The gate reads the EngineHost cache through a late-bound ref (the host
  // is constructed further down, with this provider as a dep). Only
  // slot-FREEING backends are gated: without hibernation (docker/local) a
  // ready attachment never releases its slot short of session deletion,
  // so a long-lived dev stack would wedge every new create at the
  // ceiling — and those backends have no bounded pod budget to protect.
  const gateHostRef: { current: EngineHost | null } = { current: null };
  const rawSandboxProvider = buildSandboxProvider(process.env);
  const sandboxProvider = rawSandboxProvider.capabilities().hibernation
    ? withSandboxCapacityGate(rawSandboxProvider, {
        ceiling: resolveOrgSandboxCeiling(process.env),
        waitMs: resolveSandboxCapacityWaitMs(process.env),
        host: () => gateHostRef.current,
      })
    : rawSandboxProvider;
  const imageBuilder = resolveImageBuilder(process.env);
  const eventStream = new PgEventStream(pgdb);
  const baseCredentials = new PgCredentialStore(pgdb, deriveSecretKey(opts.encryptionKey));

  // Plugin loading (plugin-system-v2 plan Task 4): tests supply `opts.plugins`
  // directly and skip the node_modules scan entirely; the normal boot path
  // assembles the bundled registry with whatever's discovered on disk.
  //
  // The workflows action plugin is host-defined (its actions need the
  // workflow store + run host, which don't exist yet at assembly time), so
  // it enters the catalog through a deferred-deps getter — same one-slot
  // indirection as `childSpawner` below. The ref is filled right after
  // `workflowRunHost` is constructed.
  const workflowsDepsRef: { current: WorkflowServiceDeps | null } = { current: null };
  const workflowsActions: ValetPlugin = {
    name: "workflows-actions",
    version: "0.1.0",
    description: "Agent-facing DAG workflow management actions.",
    actions: [
      workflowsActionPlugin(() => {
        if (!workflowsDepsRef.current) {
          throw new Error("workflows actions invoked before provider wiring completed");
        }
        return workflowsDepsRef.current;
      }),
    ],
  };
  // Skills are the other host-defined action surface. They need only the
  // app Drizzle handle, which already exists here, so they take no deferred
  // getter. This is the in-product authoring path for a skill; the web tab
  // reads only (docs/specs/2026-08-05-agent-skills-design.md).
  const skillsActions: ValetPlugin = {
    name: "skills-actions",
    version: "0.1.0",
    description: "Agent-facing skill authoring actions.",
    actions: [skillsActionPlugin(db)],
  };
  // Assistant-profile actions (the tool mirror of routes/assistants.ts).
  // A persona write must evict the cached session, and the EngineHost does
  // not exist yet — same one-slot indirection as the workflows deps above.
  const evictRef: { current: ((sessionId: string) => void) | null } = { current: null };
  const eventsActions: ValetPlugin = {
    name: "events-actions",
    version: "0.1.0",
    description: "Agent-facing received event diagnostics.",
    actions: [eventsActionPlugin(db)],
  };

  // Plugin filter: config file `plugins` block takes precedence over
  // VALET_PLUGINS env var. Both set simultaneously is a configuration error —
  // the operator must remove one to avoid ambiguity.
  const configPlugins = opts.instanceConfig?.plugins;
  const configHasPlugins = configDeclaresPlugins(configPlugins);
  if (configHasPlugins && process.env.VALET_PLUGINS) {
    throw new InstanceConfigError(
      "VALET_PLUGINS is set and the config file declares plugins. Remove one.",
    );
  }
  const { allowlist, denylist } = configHasPlugins
    ? { allowlist: configPlugins!.allow, denylist: configPlugins!.deny }
    : parseValetPluginsEnv(process.env.VALET_PLUGINS);
  const nodeModulesResult = opts.plugins
    ? { plugins: [], quarantined: [] }
    : await loadNodeModulesPlugins({
        searchPaths: [resolve(apiPkgRoot, "node_modules"), resolve(repoRoot, "node_modules")],
        allowlist,
        denylist,
      });
  const { plugins, actionPluginByService } = opts.plugins
    ? assemblePlugins([[...opts.plugins]])
    : assemblePlugins([
        bundledPlugins,
        nodeModulesResult.plugins,
        // Config-declared MCP servers (instance config `mcpServers`). A
        // service collision with a bundled plugin throws in assemblePlugins.
        configMcpPlugins(opts.instanceConfig?.mcpServers, process.env),
        [workflowsActions, skillsActions, eventsActions],
      ]);
  const pluginLoadFailures = nodeModulesResult.quarantined.map(({ pkg, reason }) => ({
    service: pkg.replace(/^@valet\/plugin-/, "").replace(/^plugin-/, ""),
    state: "load_failed" as const,
    reason,
    fix: "Ask an admin to repair or remove the plugin package.",
  }));

  // Declared plugin-store expression indexes (plugin-store design). Idempotent
  // `CREATE INDEX IF NOT EXISTS`, run once per boot after the plugin set is
  // known — no plugin declares one yet, so this is a no-op today.
  await ensurePluginStoreIndexes(pgdb, plugins);

  // Refresh-on-read decorator (integration-OAuth design): wraps the raw
  // credential store so any `engineCredentials.get()` call transparently
  // refreshes near-expiry oauth2 tokens using the plugins' oauth
  // declarations. Constructed after plugin assembly since it needs `plugins`.
  const refreshingCredentials = new OAuthRefreshingCredentialStore(baseCredentials, {
    db,
    plugins,
    env: process.env,
  });
  // Team references wrap outside refresh: a followed user row refreshes
  // under that user, a direct team row refreshes under the team.
  const engineCredentials = new TeamCredentialStore(refreshingCredentials, {
    isMember: (teamId, userId) => isTeamMember(db, teamId, userId),
  });

  // 1Password reference-credential service (1Password credential provider
  // plan, Task 1/2) — the same instance is threaded into `EngineHost`'s
  // `onePassword` opt below and exposed on `Providers` for the (Task 3)
  // `/api/onepassword` routes.
  const onePassword = createOnePasswordService({
    credentials: engineCredentials,
  });

  // Circular construction: EngineHost needs the ChildSpawner at construction
  // time (it's baked into every orchestrator session's toolConfig), but the
  // spawner itself needs the EngineHost (to create the child session) and
  // the ChildWatcher (to arm settlement watching). Break the cycle with a
  // one-slot indirection — `spawnerRef` is filled in immediately after
  // `engineHost` exists, before any orchestrator session can actually wake
  // and try to call `task`.
  let spawnerRef: ChildSpawner | undefined;
  let readerRef: ChildReader | undefined;
  let senderRef: ChildSender | undefined;
  let statusRef: ChildStatusReader | undefined;
  const engineHost = new EngineHost({
    engineStore,
    sandboxProvider,
    eventStream,
    engineCredentials,
    blobs,
    anthropicApiKey: opts.anthropicApiKey,
    defaultImage: resolveDefaultImage(process.env),
    // Single image lineage: one stock image for every session shape.
    defaultImages: {
      full: process.env.VALET_FULL_BASE_IMAGE ?? resolveDefaultImage(process.env),
    },
    idleMinutes: resolveIdleMinutes(process.env),
    ...(resolvePrebuildPreflight(process.env) ? { prebuildPreflight: resolvePrebuildPreflight(process.env) } : {}),
    ...buildHibernationHooks(db),
    db,
    apiBaseUrl: opts.apiBaseUrl,
    sandboxJwtMaster: opts.sandboxJwtMaster,
    sandboxTokenMaster: opts.encryptionKey,
    sandboxApiUrl: opts.sandboxApiUrl,
    plugins,
    pluginLoadFailures,
    actionPluginByService,
    // GH-T10 fix: session `github` actions resolve through the token service
    // (same `key` `engineCredentials`/the workflow invoker/the sandbox
    // credential route derive theirs from) instead of a raw credential read.
    githubTokenDeps: { key: deriveSecretKey(opts.encryptionKey) },
    onePassword,
    childSpawner: (req, ctx) => {
      if (!spawnerRef) throw new Error("childSpawner invoked before provider wiring completed");
      return spawnerRef(req, ctx);
    },
    childReader: (req, ctx) => {
      if (!readerRef) throw new Error("childReader invoked before provider wiring completed");
      return readerRef(req, ctx);
    },
    childSender: (req, ctx) => {
      if (!senderRef) throw new Error("childSender invoked before provider wiring completed");
      return senderRef(req, ctx);
    },
    childStatusReader: (req, ctx) => {
      if (!statusRef) throw new Error("childStatusReader invoked before provider wiring completed");
      return statusRef(req, ctx);
    },
  });
  // Arm the capacity gate now that the host exists — creates admitted
  // before this line (none happen during construction) pass ungated.
  gateHostRef.current = engineHost;
  evictRef.current = (sessionId) => engineHost.evictCache(sessionId);

  // Naming listens to the engine's origin-neutral settlement event. Start it
  // in main before boot restore, because restored work can settle there.
  const autoTitleHost = createAutoTitleHost({ db, engineStore, eventStream });

  // Prebuild orchestration (sandbox images v2 plan, Task 3). Same
  // `resolveGitHubToken`-shaped deps every other GitHub-credential consumer
  // in this file builds (`{ db, credentials: engineCredentials, key }`).
  // Constructed before the child spawner, whose zero-config repo binding
  // needs it. `start()`/`stop()` are called from `main.ts`.
  const prebuildService = new SourceService({
    db,
    builder: imageBuilder,
    githubTokenDeps: { db, credentials: engineCredentials, key: deriveSecretKey(opts.encryptionKey) },
  });

  const childrenDeps = {
    sandboxBacked: sandboxProvider.capabilities().isolated === true,
    db,
    engineHost,
    engineStore,
    prebuildService,
    retentionMs: resolveChildRetentionMs(process.env),
    orgSessionCeiling: resolveOrgSessionCeiling(process.env),
  };
  const childWatcher = new ChildWatcher(childrenDeps);
  spawnerRef = buildChildSpawner(childrenDeps, childWatcher);
  readerRef = buildChildReader(childrenDeps);
  senderRef = buildChildSender(childrenDeps, childWatcher);
  statusRef = buildChildStatusReader(childrenDeps);

  // Destroys sandboxes hibernated past the retention window; `start()`/
  // `stop()` are called from `main.ts`, next to the child retention sweep.
  const hibernationReaper = new HibernationReaper({
    db,
    engineHost,
    engineStore,
    retentionMs: resolveHibernatedRetentionMs(process.env),
  });

  // Provider-side reconciler — the backstop under the DB-driven sweeps.
  // Destroys orphans (owning session gone); reports over-age and unowned
  // sandboxes without destroying them (CLAUDE.md: "Invariants: alert,
  // don't auto-repair"). No-op on providers without `list()`
  // (docker/local). `start()`/`stop()` are called from `main.ts`.
  const sandboxReconcileSweep = new SandboxReconcileSweep({
    db,
    provider: sandboxProvider,
    engineHost,
    engineStore,
    ageReportMs: resolveSandboxAgeReportMs(process.env),
  });

  // Hibernates idle ACTIVE sessions an api restart evicted from the host
  // cache — the in-memory idle sweep cannot see them, and the reaper only
  // reaps `hibernated` rows. Same idle window as the cache sweep.
  // `start()`/`stop()` are called from `main.ts`.
  const idleHibernationSweep = new IdleHibernationSweep({
    db,
    engineHost,
    engineStore,
    idleMs: resolveIdleMinutes(process.env) * 60_000,
  });

  // Autonomy nudge sweep (valet-security spec §Autonomy). Re-drives an idle
  // security runner that stopped with work remaining; a stall cap alerts the
  // user after N no-progress nudges instead of looping. Nudges through the
  // same `submitSessionPrompt` path the kickoff uses. `start()`/`stop()` are
  // called from `main.ts`, next to the other sweeps.
  const securityRunnerDriver = new SecurityRunnerDriver({
    db,
    engineStore,
    submit: (row, text) => submitSessionPrompt({ db, engineHost }, row, text, { recordUserActivity: false }),
    sweepIntervalMs: resolveSecurityNudgeIntervalMs(process.env),
    maxStalls: resolveSecurityNudgeMaxStalls(process.env),
  });

  // Backfill default bases for existing orgs (idempotent). Fires once at
  // boot in the background; never blocks startup.
  (async () => {
    const rows = await db.select({ id: orgs.id }).from(orgs);
    for (const { id } of rows) {
      try {
        await prebuildService.seedDefaultBasesIfMissing(id);
      } catch (err) {
        console.error(`seedDefaultBasesIfMissing(${id}) failed:`, err);
      }
    }
  })();

  // Workflow run host (Phase 5 plan Task 10). `workflowStore` is the same
  // `WorkflowStore` port `buildWorkflowEngineDeps`'s session executors and
  // the routes both read/write through — one instance per process, backed
  // by the same connection source as everything else.
  // Traced under the same condition as the engine store: `workflow-store.*`
  // spans nest inside the interpreter's `workflow.drive`/`workflow.node.*`.
  const rawWorkflowStore = new PgWorkflowStore(pgdb);
  const workflowStore = telemetryEnabled ? tracedWorkflowStore(rawWorkflowStore) : rawWorkflowStore;

  const channelHost = new ChannelHost({
    db,
    engineHost,
    engineStore,
    eventStream,
    engineCredentials,
    plugins,
    workflowStore,
    actionPluginByService,
    publicUrl: publicUrlFromEnv(process.env),
    resolveOrgId: () => resolveOrgId(db),
    onePassword,
  });
  const workflowEngineDeps = buildWorkflowEngineDeps({
    host: engineHost,
    store: workflowStore,
    db,
    engineStore,
    actionPluginByService,
    plugins,
    credentials: engineCredentials,
    // GH-T10: lets a `github` workflow tool-node action resolve through
    // `resolveGitHubToken` (same `key` `engineCredentials`/the sandbox
    // credential route derive theirs from) instead of a raw credential read.
    githubTokenDeps: { key: deriveSecretKey(opts.encryptionKey) },
    onePassword,
  });

  // Approval attention (decision 12): the FIRST park on an approval node
  // routes through the Phase 4 notification system. `onApprovalPending`
  // only receives `{runId, nodeId, prompt, summary?, details?}` — no owner
  // — so it re-resolves the run's owner from the store itself.
  const onApprovalPending: OnApprovalPending = async (info) => {
    // Contained: the executor awaits this AFTER persisting the approval
    // intent, so a throw here would abort the drive AND permanently skip the
    // notification on the re-drive (intent already exists). A lost
    // notification must degrade to log-only — the run stays resolvable via
    // the API either way.
    try {
      const run = await workflowStore.getRun(info.runId);
      const owner = principalFromOwner(run?.owner);
      if (!owner) return; // no recorded owner: nothing to notify
      const isPolicyGate = info.kind === "policy_gate";
      await routeAttention(
        { db, channels: [channelHost.attentionDeliverer()] },
        {
          kind: "approval",
          owner,
          title: info.summary ?? info.prompt ?? `Approval needed: ${info.service ?? "?"}.${info.action ?? "?"}`,
          body: isPolicyGate
            ? `Workflow run ${info.runId} is paused on ${info.nodeId}.`
            : info.summary
              ? info.prompt
              : undefined,
          href: workflowApprovalHref(info.runId, info.nodeId),
          dedupeKey: `${info.runId}:${info.nodeId}${info.iteration !== undefined && info.iteration > 0 ? `:${info.iteration}` : ""}`,
        },
      );
    } catch (err) {
      console.error(`workflow approval notification failed for ${info.runId}:${info.nodeId}`, err);
    }
  };

  // "Grant the rest of this run" (action-policies plan, Task 3): an approval
  // resolved with `grantActions` writes one exec-scoped runtime grant per
  // authorized `(service, actionId)` so downstream `tool` nodes stop failing
  // `require_approval`. Best-effort — a failure here must not abort the
  // approved node; `writeExecutionGrant` is idempotent under replay.
  const onApprovalGrant: OnApprovalGrant = async (info) => {
    try {
      const run = await workflowStore.getRun(info.runId);
      if (!run?.params.workflowId) return;
      const defRows = await db
        .select({ orgId: workflowDefinitions.orgId })
        .from(workflowDefinitions)
        .where(eq(workflowDefinitions.id, run.params.workflowId))
        .limit(1);
      const orgId = defRows[0]?.orgId;
      if (!orgId) return;
      const now = Date.now();
      for (const g of info.grants) {
        await writeExecutionGrant(db, info.runId, {
          orgId,
          service: g.service,
          actionId: g.actionId,
          grantedBy: info.resolvedBy,
          now,
        });
      }
    } catch (err) {
      console.error(`workflow approval grant write failed for run ${info.runId}:`, err);
    }
  };

  const onGateResolved: OnGateResolved = async (info) => {
    try {
      const run = await workflowStore.getRun(info.runId);
      if (!run?.params.workflowId) return;
      const defRows = await db
        .select({ orgId: workflowDefinitions.orgId })
        .from(workflowDefinitions)
        .where(eq(workflowDefinitions.id, run.params.workflowId))
        .limit(1);
      const orgId = defRows[0]?.orgId;
      if (!orgId) return;
      const suffix = info.iteration > 0 ? `:${info.iteration}` : "";
      await updateInvocationOutcome(
        db,
        `pol:wf:workflow:${info.runId}:${info.nodeId}${suffix}`,
        orgId,
        { status: info.outcome, resolvedBy: info.resolvedBy },
      );
    } catch (err) {
      console.error(`workflow gate resolved callback failed for ${info.runId}:${info.nodeId}`, err);
    }
  };

  // Settled-run sandbox reclaim: destroys the sandboxes a run's `session`
  // nodes provisioned, immediately on settle and via a retry sweep
  // (`start()`/`stop()` from main.ts, next to the other sweeps).
  const workflowSandboxReclaimer = new WorkflowSandboxReclaimer({
    db,
    engineHost,
    engineStore,
    store: workflowStore,
  });
  const runSettledAttention = buildRunSettledAttention({ db, store: workflowStore, channels: [channelHost.attentionDeliverer()] });
  const runThreadArchive = buildRunThreadArchive({ db, store: workflowStore, engineStore });

  const workflowRunHost = new LocalRunHost({
    store: workflowStore,
    engine: workflowEngineDeps,
    executors: createDefaultNodeExecutors(),
    onApprovalPending,
    onApprovalGrant,
    onGateResolved,
    // Settle attention (batch-fanout design decision 4): a failed top-level
    // run raises a notification through the same router the approval park
    // above uses. See `run-attention.ts` for why child runs stay silent.
    // Then the sandbox reclaim — both are contained by contract, so a
    // failure in either never abandons the drive lease.
    onRunSettled: async (info) => {
      await runSettledAttention(info);
      // The run's own assistant thread leaves the sidebar here, and only
      // here: no sweep archives it later (`run-attention.ts`).
      await runThreadArchive(info);
      await workflowSandboxReclaimer.reclaimRun(info.runId);
    },
    crashAt: opts.workflowCrashAt,
  });
  workflowsDepsRef.current = {
    db,
    onePassword,
    workflowStore,
    workflowRunHost,
    actionPluginByService,
    plugins,
    credentials: engineCredentials,
    // Run-origin validation probes the engine store for the origin thread
    // (`activeWorkflowOrigin`).
    engineStore,
  };

  // Workflow schedule loop — cron-driven run starts (time-based counterpart
  // of the event dispatcher's workflow targets). `start()`/`stop()` from
  // main.ts alongside the dispatcher.
  const deliverToOrchestrator = buildOrchestratorTarget({
    db,
    engineHost,
    fetchThreadContext: channelThreadContextFetcher(channelHost),
  });
  const workflowScheduler = new WorkflowScheduler({ db, workflowStore, workflowRunHost, deliverToOrchestrator });

  // Coarse per-workflow cap for the public webhook-trigger route — bounds
  // what an unauthenticated caller holding a leaked/guessed URL can force
  // us to start, without needing a shared rate-limit store.
  const webhookRateLimiter = new WorkflowWebhookRateLimiter({ limit: 30, windowMs: 60_000 });

  // Event dispatcher (event-system plan Task 6): drains event_deliveries
  // into workflow/orchestrator/signal targets. `start()`/`stop()` are called
  // from main.ts; ingest routes pass `eventDispatcher.nudge` as `onIngest`.
  const eventDispatcher = new EventDispatcher({
    db,
    workflowRunHost,
    workflowStore,
    deliverToOrchestrator,
    resolveChannelOrigin: channelOriginResolver(channelHost),
    normalizeChannelMessage: channelMessageNormalizer(channelHost),
    // The catalog a subscription's `{{payload.<field>}}` variable resolves
    // through. It is the same merged catalog the write validator uses.
    plugins,
  });

  // Repository content sync. `readerFor` gives each source the GitHub
  // credential its OWNER holds, so a source cannot borrow reach it does not
  // have; the rule is in `services/content-source-credential.ts`. With no
  // resolvable credential it falls back to the anonymous `reader`.
  const contentSync = new ContentSyncService({
    db,
    // One collector per content kind; a source runs the subset its `kinds`
    // enables. The workflow collector validates a mirrored definition against
    // the same plugin catalog the editor saves against, so a file naming an
    // unknown model or tool service fails at sync with the validator's own
    // message instead of at run time inside a node.
    collectors: [
      new SkillCollector(),
      new WorkflowCollector({
        env: buildValidateEnvironment(actionPluginByService),
        // The event catalog `validateSubscription` reads, so an `events`
        // block naming an unknown key or an undeclared filter field fails
        // its file at sync instead of arming a subscription nothing can
        // deliver.
        plugins,
        // A team file's triggers arm only when the team can act as every
        // service its tool nodes name (`teamServiceReadiness`), including
        // through an org-vault item the run would resolve.
        credentials: engineCredentials,
        onePassword,
      }),
      // Memories collect for every owner type, including a personal source:
      // a mirrored memory runs nothing and resolves no credential, so
      // decision 10's authority argument does not reach it.
      new MemoryCollector(),
      new TemplateCollector({
        env: buildValidateEnvironment(actionPluginByService),
        // Resolved per pass, not per file: a mirrored id that collides with
        // one this deployment ships is refused with both names.
        reserved: () =>
          new Map(listCatalogTemplates(plugins).map((owned) => [owned.template.id, owned.pluginName])),
      }),
    ],
    reader: new GitHubSkillRepoReader(),
    readerFor: skillRepoReaderFactory({
      db,
      credentials: engineCredentials,
      key: deriveSecretKey(opts.encryptionKey),
    }),
    orgWebhookLive: () => Boolean(publicUrlFromEnv(process.env)),
  });

  return {
    db,
    blobs,
    encryptionKey: opts.encryptionKey,
    engineStore,
    sandboxProvider,
    imageBuilder,
    eventStream,
    engineCredentials,
    onePassword,
    engineHost,
    autoTitleHost,
    childWatcher,
    childSpawner: (req, ctx) => {
      // Same one-slot indirection as the EngineHost wiring above; by the
      // time any route runs, `spawnerRef` is long assigned.
      if (!spawnerRef) throw new Error("childSpawner invoked before provider wiring completed");
      return spawnerRef(req, ctx);
    },
    hibernationReaper,
    workflowSandboxReclaimer,
    sandboxReconcileSweep,
    idleHibernationSweep,
    securityRunnerDriver,
    channelHost,
    workflowStore,
    workflowRunHost,
    workflowScheduler,
    webhookRateLimiter,
    eventDispatcher,
    contentSync,
    plugins,
    actionPluginByService,
    dynamicToolCounts: new DynamicToolCounts({ credentials: engineCredentials }),
    prebuildService,
  };
}

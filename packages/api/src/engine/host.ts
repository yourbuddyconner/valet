import { workspaceSenderIdentity } from "../services/workspace-sender.js";
import { workflowEditorThreadContext } from "../workflows/editor-thread-context.js";
import type { Model } from "@earendil-works/pi-ai/compat";
import { and, eq } from "drizzle-orm";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  builtinTools,
  assistantSessionId,
  parseAssistantSessionId,
  NoCredentialsError,
  isReasoningLevel,
  type BlobStore,
  type ChildReader,
  type ChildSender,
  type ChildSpawner,
  type ChildStatusReader,
  type CredentialStore,
  type EventStream,
  type Principal,
  type CredentialOwner,
  type SandboxProvider,
  type Session,
  type SessionData,
  type SessionStartRef,
  type SessionStore,
  type ServiceAvailability,
  type Thread,
  type StoredCredential,
  type ResolvedModel,
  type PolicyResolver,
  type PluginStore,
} from "@valet/engine";
import type { ValetPlugin } from "@valet/engine";
import { pluginStore } from "../services/plugin-store.js";
import { createBrowserPolicy, browserSessionHooks, prepareBrowserSandboxStop } from "../services/browser-host.js";
import { extractDocumentText } from "../services/pdf-extract.js";
import {
  loadRoleFromMarkdown,
  type ActionPlugin,
  type CommandContext,
  type CommandDef,
  type PinnedActionSpec,
  type PluginCatalog,
  type RepoInstructions,
  type Sandbox,
  type SandboxStatus,
  type SkillSource,
} from "@valet/engine";
import { buildPolicyResolver, revokeSessionGrants } from "../policies/service.js";
import { withSlackOwnerMetadata } from "../channels/identity-links.js";
import type { RepoBinding } from "../wire/types.js";
import { makeCommandContext, makeWorkspaceSkillsProvider } from "./command-providers.js";
import { makeRepoInstructionsProvider } from "./repo-instructions.js";
import {
  GITHUB_INSTALLATION_CREDENTIAL_SERVICE,
  GitHubAuthError,
  resolveInstallationApiToken,
} from "../services/github-tokens.js";
import {
  githubTokenArgsForOwner,
  primaryRepoBinding,
  resolveSessionGitHubToken,
  usableTeamGithubRow,
} from "../services/session-github-token.js";
import {
  repoCredentialCommands,
  resolvedRepoPrebuildFlags,
  type RepoPrebuildFlags,
} from "../bakes/source-service.js";
import { recordPrebuildFlagsResolved } from "../observability/prebuild-metrics.js";
import { loadSessionMeta } from "./session-meta.js";
import { resolveSnapshot } from "./resolve-snapshot.js";
import { imageAwareWorkspaceFloor, liftWorkspaceStorageToImageFloor } from "@valet/sandbox-kubernetes";
import {
  applySandboxResourceOverrides,
  resolveRepoResources,
  type ResolvedRepoPrebuildFlags,
} from "./resolve-repo-resources.js";
import { computeSpec, specHash } from "./sandbox-spec.js";
import { buildPrepSteps } from "./prep-steps.js";
import { securityToolPrepSteps } from "./security-bootstrap.js";
import type { OnePasswordService } from "../services/onepassword.js";
import {
  orgFallbackPolicy,
  resolveOrgCredentialRead,
  resolveTeamCredentialRead,
  resolveUserCredentialRead,
  onePasswordScopesFor,
} from "../services/credential-resolution.js";
import type { PrebuildPreflightOpts } from "../prebuilds/registry.js";
import type { PrebuildResources } from "../prebuilds/recipe.js";
import { resolveModelSpec } from "../services/model-resolution.js";
import { resolveOpenAiCredential } from "../services/openai-key.js";
import { hasOrgKey } from "../services/model-catalog.js";
import { clampToMax, getOrgReasoningSettings, type ReasoningLevel } from "../services/reasoning.js";
import { listLlmProviders, parseModelId, providerNamespace } from "../services/llm-providers.js";
import { TIER_SET } from "../services/model-tiers.js";
import type { AppDb } from "../lib/drizzle.js";
import {
  agentSessions,
  childWatches,
  orgs,
  securityCells,
  securityEngagements,
  sessionRepos,
  teams,
  users,
  type SecurityCellRow,
} from "../schema/index.js";
import {
  ArchivedAssistantError,
  loadAssistant,
  loadAssistantBySessionId,
} from "../assistants/service.js";
import { personaPrefixText } from "../assistants/persona.js";
import { internalToken } from "../lib/internal-auth.js";
import {
  deriveSandboxJwtSecret,
  getOrCreateSandboxToken,
  mintSandboxJwt,
  revokeSandboxTokens,
} from "../auth/sandbox-tokens.js";
import securityPlugin from "@valet/plugin-security/plugin";
import { codingSystemPrompt } from "./prompt-rules.js";
import { orchestratorPersona } from "../orchestrator/persona.js";
import { buildMemoryTools } from "../orchestrator/memory-tools.js";
import { buildSecurityPersonaTools, buildSecurityRunnerTools } from "./security-tools.js";
import { securityCompactionHook } from "./security-compaction.js";
import {
  authorizedScopeEnv,
  egressViolations,
  parseAuthorizedScopeHosts,
  parseConfigToolDecls,
  securityDeclaredMcpPlugins,
} from "./security-provisioning.js";
import { egressHostInScope } from "@valet/plugin-security";
import { assembleMemorySnapshot } from "../orchestrator/snapshot.js";
import { ensureTodayJournal } from "../orchestrator/bootstrap.js";
import { journalCompactionHook } from "../orchestrator/compaction.js";
import { readOwnFile, type MemoryScope } from "../services/memory.js";
import { listSkillSourcesFor } from "../services/skills.js";
import { skillTelemetrySink } from "../services/skill-telemetry.js";
import { mergedSkillSources, pluginSessionExtras, type PluginSessionExtras } from "../plugins/assemble.js";
import { unavailableServiceInventory } from "../services/integration-availability.js";
import { orgAllowsPluginForUser } from "../services/plugin-entitlements.js";
import { isTeamMember } from "../services/teams.js";
import { PINNED_ACTIONS } from "../plugins/pinned-actions.js";


/**
 * The security roles to attach for a claimed cell's persona (dynamic-config
 * M-F1, repo-persona roles M-P2c). Returns the ONE role that matches the cell's
 * persona, so a `code-review` cell gets only the code-review role, not every
 * security role.
 *
 * Resolution order (repo wins):
 *   1. A bundled persona id (`code-review`, `architect`, `verifier`,
 *      `threat-model`, `attack-tree`, `sast`) → its bundled role.
 *   2. A repo-defined persona (a key in `.valet/security.yml`'s `personas` map)
 *      → a RoleSpec built from `repoRoleMarkdown`, the markdown fetched from the
 *      clone at create and stashed on the engagement. The RoleSpec's `name` is
 *      forced to the cell's persona id so the dispatch prompt's `role` overlay
 *      resolves, regardless of the markdown's own frontmatter name.
 *   3. No bundled role and no repo markdown → the code-review role, with a
 *      logged corrective note.
 *
 * `repoRoleMarkdown` is the resolved markdown for THIS persona (the caller looks
 * it up in the engagement's `config_persona_markdown` map). Absent means no repo
 * role was stashed for this persona; the function then falls back.
 */
function actionServices(plugins: readonly ValetPlugin[]): Set<string> {
  return new Set(plugins.flatMap((plugin) => (plugin.actions ?? []).map((action) => action.service)));
}

function removedActionServices(
  before: readonly ValetPlugin[],
  after: readonly ValetPlugin[],
): string[] {
  const afterServices = actionServices(after);
  return [...actionServices(before)].filter((service) => !afterServices.has(service)).sort();
}

function unavailableActionServices(
  plugins: readonly ValetPlugin[],
  unavailableCredentials: ReadonlySet<string>,
): string[] {
  return [
    ...new Set(
      plugins.flatMap((plugin) =>
        (plugin.actions ?? [])
          .filter((action) =>
            unavailableCredentials.has(action.credentialService ?? action.service),
          )
          .map((action) => action.service),
      ),
    ),
  ].sort();
}

function mergeServiceAvailability(
  ...groups: readonly ServiceAvailability[][]
): ServiceAvailability[] {
  const merged = new Map<string, ServiceAvailability>();
  for (const group of groups) {
    for (const item of group) {
      if (!merged.has(item.service)) merged.set(item.service, item);
    }
  }
  return [...merged.values()].sort((a, b) => a.service.localeCompare(b.service));
}

export function securityRolesForCell(
  persona: string,
  repoRoleMarkdown?: string,
): NonNullable<typeof securityPlugin.roles> {
  const roles = securityPlugin.roles ?? [];
  const match = roles.find((r) => r.name === persona);
  if (match) return [match];

  if (repoRoleMarkdown && repoRoleMarkdown.trim() !== "") {
    try {
      const role = loadRoleFromMarkdown(repoRoleMarkdown, "session", persona);
      // Force the role name to the persona id: the dispatch prompt sets
      // `role: cell.persona`, so the overlay resolves by the config key, not by
      // whatever frontmatter name the repo file carries.
      return [{ ...role, name: persona }];
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(
        `security: repo persona "${persona}" role markdown failed to load (${detail}); ` +
          "attaching the code-review role. Fix the persona markdown in the repo.",
      );
    }
  }

  const fallback = roles.find((r) => r.name === "code-review");
  console.warn(
    `security: persona "${persona}" has no bundled role and no readable repo role; ` +
      "attaching the code-review role. Define the persona in .valet/security.yml's " +
      "personas map with a readable markdown path to run it under its own role.",
  );
  return fallback ? [fallback] : [];
}

export interface EngineHostOpts {
  engineStore: SessionStore;
  sandboxProvider: SandboxProvider;
  eventStream: EventStream;
  engineCredentials: CredentialStore;
  blobs?: BlobStore;
  /** Anthropic API key required for prompts. Without it, prompts fail. */
  anthropicApiKey?: string;
  /** pi-ai model id or tier token; defaults to tier "s" when unset. */
  defaultModelId?: string;
  /** Default Docker image for new sandboxes. */
  defaultImage?: string;
  /**
   * Optional stock-image override. Single image lineage (2026-08-16
   * design): every session boots `defaultImages.full ?? defaultImage`
   * regardless of profile/docker shape. The `headless` key is legacy and
   * ignored — kept in the type so older callers/tests type-check and so
   * tests can prove it is NOT consulted.
   */
  defaultImages?: Partial<Record<"headless" | "full", string>>;
  /**
   * The app db handle — required by `assistantSessionFor` (the assistant
   * row lookup, memory snapshot assembly, journal bootstrap, and the
   * compaction hook). Every session builder also uses it
   * (when present) to mint/revoke the session's sandbox token (Task 8,
   * auth-v2 plan) — absent only in tests that don't wire one up, which
   * degrade gracefully to no sandbox env injection.
   */
  db?: AppDb;
  /**
   * This process's own base URL (e.g. `http://127.0.0.1:${port}`), handed
   * to orchestrator sessions as `toolConfig.apiBaseUrl` so the `mem_*`
   * tools can reach the memory HTTP routes (decision 15). Required for
   * `assistantSessionFor`.
   */
  apiBaseUrl?: string;
  /**
   * Master key `deriveSandboxJwtSecret`/`mintSandboxJwt` derive per-session
   * secrets from (Task 8, auth-v2 plan). `AuthConfig.sandboxJwtMaster` when
   * real auth is configured; falls back to `internalToken()` in stub mode
   * so dev keeps working without `BETTER_AUTH_SECRET`.
   */
  sandboxJwtMaster?: string;
  /** Stable instance encryption key used to recover sandbox bearers. */
  sandboxTokenMaster?: string;
  /**
   * The API's own externally-reachable base URL, injected into every
   * sandbox's env as `VALET_API_URL` (Task 8, auth-v2 plan) —
   * `AuthConfig.baseUrl` when configured, else the local dev default. NOT
   * the same as `apiBaseUrl` above, which is this process's own
   * `http://127.0.0.1:{port}` used for internal orchestrator tool calls.
   */
  sandboxApiUrl?: string;
  /**
   * Injected into every orchestrator session's `toolConfig.childSpawner`
   * (Phase 4 decision 10/17). Absent in tests that don't need `task` to
   * work; regular (non-orchestrator) sessions never receive it — only
   * orchestrators spawn children, and children themselves never do
   * (depth limit 1, decision 10) since `childSessionFor` never sets it.
   */
  childSpawner?: ChildSpawner;
  /**
   * Injected into every orchestrator session's `toolConfig.childReader`,
   * which is what the engine's `child_read` built-in calls. Paired with
   * `childSpawner`: a session that can spawn children is exactly the
   * session that may read them back.
   */
  childReader?: ChildReader;
  /**
   * Injected into every orchestrator session's `toolConfig.childSender`,
   * which is what the engine's `child_send` built-in calls. Completes the
   * child toolset (`task` spawns, `child_read` reads, `child_send`
   * steers); scoped exactly like the other two — children never get it.
   */
  childSender?: ChildSender;
  /**
   * Injected into every orchestrator session's `toolConfig.childStatusReader`,
   * the backend of the `child_status` built-in. Same authority note as
   * `childReader`: a session that can spawn children is exactly the
   * session that may check on them.
   */
  childStatusReader?: ChildStatusReader;
  /**
   * Assembled plugin set (plugin-system-v2 Task 4's `assemblePlugins`
   * output). Every session builder goes through `sessionExtras`, which
   * builds the extras FRESH per build and never caches them on the host
   * instance.
   */
  plugins?: ValetPlugin[];
  /** Plugins that the host quarantined before assembly. */
  pluginLoadFailures?: ServiceAvailability[];
  /**
   * Assembled service→ActionPlugin index (plugin-system-v2 Task 4's
   * `assemblePlugins` output). Used only to look up a plugin's
   * `defaultApprovalMode` inside the policy resolver (action-policies plan,
   * Task 3) — org policies/grants apply regardless, so an absent map just
   * means the plugin-default rung falls through to the risk default.
   */
  actionPluginByService?: Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>;
  /**
   * Deps for resolving a session's `github` credential through the canonical
   * token service (`services/github-tokens.ts`'s `resolveGitHubToken`, via
   * `resolveSessionGitHubToken`) instead of a raw `CredentialStore` read
   * (GH-T10 fix). When present (with `db`), every session build gets a
   * `credentialResolver` that routes `github` through the token service —
   * honoring the session's primary repo binding auth — and delegates every
   * other service to the raw store (byte-identical). Absent === no resolver
   * at all: sessions read credentials straight from the store as before.
   * Same shape/`key` `ActionInvokerOpts.githubTokenDeps` uses.
   */
  githubTokenDeps?: {
    key: Buffer;
    apiUrl?: string;
    githubUrl?: string;
    fetchImpl?: typeof fetch;
    now?: () => number;
  };
  /**
   * 1Password reference-credential resolver (1Password credential provider
   * plan, Task 2). When present, `buildCredentialResolver` additionally
   * checks every resolved row (github's own `github`-service branch AND the
   * default fall-through raw-store read) for `onePasswordMeta` and — when
   * present — routes it through `onePassword.resolveCredential` instead of
   * returning the reference-only row. Absent === no 1Password branch: rows
   * pass through unchanged, byte-identical to before this task. Unlike
   * `githubTokenDeps`, this alone is enough to make `buildCredentialResolver`
   * return a resolver even with no `db`/`githubTokenDeps` wired.
   */
  onePassword?: OnePasswordService;
  /**
   * Idle window (minutes) before a `ready` sandbox is hibernated (sandbox
   * hibernation plan, Task 3). `resolveIdleMinutes` (sandbox-backend.ts)
   * parses `VALET_SANDBOX_IDLE_MINUTES`; default `30`, `0`/invalid → `0`
   * (disabled). The idle sweep's `setInterval` only starts when this is
   * `> 0` AND `sandboxProvider.capabilities().hibernation === true`.
   */
  idleMinutes?: number;
  /**
   * Best-effort hook (sandbox hibernation plan, Task 3/4 seam): invoked
   * after the idle sweep successfully suspends a session's sandbox. Task 4
   * wires this to stamp `agent_sessions.status = "hibernated"` — this
   * package (Task 3) only exposes the seam. `sandboxId` is the suspended
   * attachment's provider handle, recorded by the hibernated-sandbox reaper
   * as its destroy handle. Errors are caught and logged, never thrown into
   * the sweep loop.
   */
  onHibernate?: (sessionId: string, sandboxId?: string) => Promise<void> | void;
  /**
   * Best-effort hook (sandbox hibernation plan, Task 3/4 seam): invoked the
   * first time a previously-suspended session's attachment reaches `ready`
   * again (a `suspended → provisioning → ready` wake sequence, tracked via
   * the attachment's own `onStatus`). Task 4 wires this to clear the
   * hibernated status back to `"active"`. Errors are caught and logged,
   * never thrown into the attachment's status-listener path.
   */
  onWake?: (sessionId: string) => Promise<void> | void;
  /**
   * Cross-restart hibernation-clear seam (sandbox hibernation plan, Task 4
   * review carry-forward): `onWake` above is gated on an IN-MEMORY
   * `wasSuspended` flag, so it never fires for a session that hibernated,
   * then had this process restart, then got rebuilt on its next touch — a
   * rebuilt attachment starts `detached` and goes straight to
   * `provisioning`/`ready` without ever passing through `suspended` in this
   * process's lifetime. `onSessionReady` closes that gap: invoked on EVERY
   * `ready` transition of EVERY session build (`buildSession`,
   * `buildAssistantSession`, `buildChildSession`, `buildWorkflowSession`),
   * regardless of `wasSuspended`. Task 4 wires this to the same
   * "clear `hibernated` -> `active`" write `onWake` performs — the write is
   * conditioned on the row currently being `"hibernated"` (a no-op
   * otherwise), so firing on every ordinary cold-start is harmless. Errors
   * are caught and logged, never thrown into the attachment's status-
   * listener path.
   */
  onSessionReady?: (sessionId: string) => Promise<void> | void;
  /**
   * Test-only injection point for the idle sweep's race rule: a submission
   * admitted between the idleness check and the actual `suspend()` call
   * must win (the sweep must NOT suspend a session a caller just woke).
   * `beforeSuspend` fires after the idle sweep's first idleness check but
   * BEFORE its mandatory re-check of `listUnsettledSubmissions` — a test
   * can use it to admit a submission mid-sweep and assert the re-check
   * catches it. Never set outside tests.
   */
  idleSweepTestHooks?: {
    beforeSuspend?: (sessionId: string) => Promise<void> | void;
  };
  /**
   * Registry pull-preflight config for prebuilt-image resolution (sandbox
   * images v2 final-review Fix 3). When set, `resolvePrebuildImage` HEADs a
   * resolved kubernetes-backend image ref against the registry before booting
   * from it — a down registry / pruned image degrades to a COLD start instead
   * of an `ImagePullBackOff`. Absent (docker/local dev, tests) === no
   * preflight; the resolution proceeds as before. Threaded from
   * `VALET_PREBUILD_REGISTRY_INSECURE`/`VALET_PREBUILD_REGISTRY_PUSH` in
   * `providers/node.ts`, mirroring `resolveImageBuilder`'s own registry env.
   */
  prebuildPreflight?: PrebuildPreflightOpts;
}

/** `agent_sessions.credential_owner_mode`; see {@link SessionMeta.credentialOwnerMode}. */
export type CredentialOwnerMode = "owner" | "actor";

export interface SessionMeta {
  userId: string;
  orgId: string;
  workspace: string;
  /** `agent_sessions.owner_type`. Absent means unknown, which reads as "not
   * a user-owned session" for credential scope decisions. */
  ownerType?: string;
  /** Interactive-service profile (sandbox auth gateway plan, Task 5).
   * Defaults to "headless" when omitted. */
  profile?: "headless" | "full";
  /** Request a rootless docker daemon inside this session's sandbox
   * (docker-in-sandbox). See docs/specs/2026-08-15-sandbox-docker-design.md. */
  docker?: boolean;
  /** Persisted nested Kubernetes request from repository config. */
  kubernetes?: boolean;
  /** Per-child CPU and memory overrides persisted on the app session row. */
  sandboxResourceOverrides?: PrebuildResources;
  /**
   * Repo bindings for this session (GitHub/repo integration plan, Task 9),
   * in position order. When non-empty, `buildSession` wires a `specProvider`
   * that clones them via the credential helper on first cold boot. Absent/empty
   * === credential-only prep: the helper + `gh` shim still install (so ad-hoc
   * git/gh in any sandbox authenticates), but nothing clones.
   *
   * `targetDir` is the workspace-relative clone destination, computed ONCE at
   * bind time and persisted on `session_repos.target_dir` (spec decision 15).
   * `loadSessionMeta` supplies it; callers that build `SessionMeta` directly
   * (tests, orchestrator/child paths) must include it.
   */
  repos?: (RepoBinding & { targetDir: string })[];
  /**
   * Git identity (`user.name`/`user.email`) configured sandbox-global by
   * workspace prep, from the session owner's profile. Only consulted when
   * `repos` is non-empty; falls back to a generic identity when unset.
   */
  userName?: string;
  userEmail?: string;
  /**
   * The owning team when the session lives in a team workspace
   * (`agent_sessions.owner_type = 'team'`), else absent. Feeds the
   * team tier of `resolveModelForBuild`'s preference cascade (TKAI-255).
   * `loadSessionMeta` supplies it from the app row.
   */
  ownerTeamId?: string;
  /**
   * `agent_sessions.credential_owner_mode`. `actor` marks a team session
   * from before team-owner credential resolution shipped: its credentials
   * keep resolving as the prompting member with org fallback, exactly as
   * they did when the session was created. `owner`, NULL, or absent
   * resolves as the owning team. Ignored for user- and org-owned sessions.
   * `loadSessionMeta` supplies it from the app row.
   */
  credentialOwnerMode?: CredentialOwnerMode | null;
}

/**
 * Whether a session's credential reads run as the acting member, the
 * contract every session had before team ownership, instead of as the
 * owner principal. Only a team session stamped `actor` qualifies. The stamp
 * is written once at boot onto rows that predate the column
 * (the column repair in `lib/drizzle.ts` stamps them once); every writer since stamps
 * `owner`.
 */
export function resolvesAsActingMember(
  meta: Pick<SessionMeta, "ownerType" | "credentialOwnerMode">,
): boolean {
  return meta.ownerType === "team" && meta.credentialOwnerMode === "actor";
}

/** The principal a session's GitHub metadata reads (prebuild flags) run as. */
function credentialReadPrincipal(meta: SessionMeta): Principal {
  return resolvesAsActingMember(meta) ? { type: "user", id: meta.userId } : sessionPrincipal(meta);
}

/** The session principal `buildSession` stamps onto `SessionOptions.owner`. */
export function sessionPrincipal(meta: SessionMeta): Principal {
  if (meta.ownerType === "team") {
    if (!meta.ownerTeamId) {
      throw new Error(
        "this team session has no owning team id. Re-open the session from the team workspace.",
      );
    }
    return { type: "team", id: meta.ownerTeamId };
  }
  if (meta.ownerType === "org") return { type: "org", id: meta.orgId };
  return { type: "user", id: meta.userId };
}

/** The primary repo's GitHub coordinates, or why a GitHub read cannot run.
 * Exported with {@link primaryGitHubRepoTarget} for direct guard coverage. */
export type PrimaryGitHubRepoTarget =
  | { ok: true; owner: string; repo: string; ref: string }
  | { ok: false; reason: "no-repo" | "bad-full-name" }
  | { ok: false; reason: "non-github-host"; host: string };

/**
 * Resolves the primary repo binding's GitHub coordinates for prebuild and
 * credentials config reads, or the reason both reads must be skipped.
 * `session_repos.host` stores "github" (the schema default); hand-built metas
 * may carry "github.com". Both values mean GitHub. TKAI-385: a previous
 * version matched only "github.com", which disabled repo config reads for
 * every bound session.
 */
export function primaryGitHubRepoTarget(repos: SessionMeta["repos"]): PrimaryGitHubRepoTarget {
  const primary = repos?.[0];
  if (!primary) return { ok: false, reason: "no-repo" };
  const host = primary.host ?? "github";
  if (host !== "github" && host !== "github.com") return { ok: false, reason: "non-github-host", host };
  const [owner, repo] = primary.fullName.split("/");
  if (!owner || !repo) return { ok: false, reason: "bad-full-name" };
  return { ok: true, owner, repo, ref: primary.resolvedRef ?? primary.ref ?? "HEAD" };
}

/** A session build's model pair: the wire-ready pi-ai model object plus the
 * canonical spec the session persists (`CreateSessionOptions.modelSpec`). */
interface BuildModel {
  model: Model<any>;
  spec: string;
}

interface CacheEntry {
  engine: Engine;
  session: Session;
}

/** Durable events for submissions settled longer ago than this are pruned on restore. */
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Size ceiling for the line-count read in `readSandboxFileMeta` (Valet Security
 * guardrail 4). A file over this size skips the line check — reading megabytes
 * to validate a cited line is not worth it — and reports an infinite line count
 * so no cited line ever reads as "past the end". 2 MB covers ordinary source.
 */
const MAX_LINE_CHECK_BYTES = 2 * 1024 * 1024;

/** True when an error is a filesystem not-found (`code: "ENOENT"`). The docker
 * and local sandboxes surface node `fs` errors; the virtual sandbox stamps the
 * same `code`. A not-found is a CONFIRMED-absent file, not an indeterminate
 * read error. */
function isEnoent(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const code = (err as Record<string, unknown>).code;
    if (code === "ENOENT") return true;
  }
  // Some providers only carry the string in the message.
  return err instanceof Error && /\bENOENT\b/.test(err.message);
}

/**
 * Join a repo-relative finding path onto the primary clone's target dir, both
 * relative to the sandbox workspace root (Valet Security guardrail 4). Returns
 * a WORKSPACE-RELATIVE path (no leading slash) — the one path shape every
 * sandbox backend resolves identically against the workspace root. Returns
 * `null` when the input escapes the clone root (`..` or an absolute file), so a
 * cited path can never read outside the reviewed tree.
 */
function joinRepoRelPath(targetDir: string | null, file: string): string | null {
  const dir = (targetDir ?? ".").replace(/^\.\/?/, "").replace(/\/+$/, "");
  // A finding `file` is repo-relative; reject an absolute or empty path.
  if (file === "" || file.startsWith("/")) return null;

  // Normalize the FILE portion alone and refuse any `..` that would climb above
  // the clone root — the boundary is the repo-relative path itself, so a `..`
  // that escapes it must be rejected before it can pop the clone-root prefix.
  const fileParts: string[] = [];
  for (const part of file.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (fileParts.length === 0) return null; // escapes the clone root
      fileParts.pop();
      continue;
    }
    fileParts.push(part);
  }
  if (fileParts.length === 0) return null;

  const dirParts = dir === "" ? [] : dir.split("/").filter((p) => p !== "" && p !== ".");
  const out = [...dirParts, ...fileParts];
  if (out.length === 0) return null;
  return out.join("/");
}

/** Count the lines in a file's text: the number of `\n` plus one for the final
 * line when it has no trailing newline (so a one-line file with no newline is 1,
 * not 0). An empty file is 0 lines. */
function countLines(content: string): number {
  if (content === "") return 0;
  let newlines = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") newlines += 1;
  }
  // A trailing newline means the last `\n` terminates the final line; no
  // trailing newline means one more line than there are newlines.
  return content.endsWith("\n") ? newlines : newlines + 1;
}

/**
 * The pure sandbox read behind `EngineHost.readSandboxFileMeta` (Valet Security
 * guardrail 4). Exported so a unit test drives it directly with a fake
 * `Sandbox`, without a live host or DB.
 *
 * `targetDir` is the primary clone's dir, relative to the sandbox workspace
 * root; `file` is the repo-relative finding path. The combined path is passed
 * as a WORKSPACE-RELATIVE value to `Sandbox.stat`/`readFile` — never a shell
 * argv, so there is no injection surface.
 *
 * Returns:
 *   - `{ exists: false, lines: 0 }` — the file is confirmed absent (ENOENT), or
 *     the path resolves to a directory, or the path escapes the clone root.
 *   - `{ exists: true, lines }` — the file exists; `lines` is its line count, or
 *     `Infinity` for a file over `MAX_LINE_CHECK_BYTES` (the line check is a
 *     courtesy, so a huge file never rejects any cited line).
 *
 * A `stat`/`readFile` failure that is NOT an ENOENT THROWS — the caller
 * (`readSandboxFileMeta`) catches it and fails open (indeterminate).
 */
export async function verifyFileInSandbox(
  sandbox: Sandbox,
  targetDir: string | null,
  file: string,
): Promise<{ exists: boolean; lines: number }> {
  const rel = joinRepoRelPath(targetDir, file);
  // A path that escapes the clone root is not a valid location in the reviewed
  // tree — treat it as absent (fail closed).
  if (rel === null) return { exists: false, lines: 0 };

  let size: number;
  try {
    const meta = await sandbox.stat(rel);
    // A directory is not a valid finding location — treat it as absent.
    if (!meta.isFile) return { exists: false, lines: 0 };
    size = meta.size;
  } catch (err) {
    // Fail CLOSED only on a CONFIRMED-absent file: an ENOENT means the sandbox
    // answered and the path is not there. Every other `stat` failure
    // (transport/exec error, permission, provider hiccup) is INDETERMINATE —
    // re-throw so the caller returns null (fail open).
    if (isEnoent(err)) return { exists: false, lines: 0 };
    throw err;
  }

  // Line count. Skip the read for a large file (not worth streaming megabytes)
  // — report it exists with an Infinity line count so no cited line is ever
  // "past the end".
  if (size > MAX_LINE_CHECK_BYTES) return { exists: true, lines: Number.POSITIVE_INFINITY };
  const content = await sandbox.readFile(rel);
  return { exists: true, lines: countLines(content) };
}

/**
 * Per-process cache of live `Engine`/`Session` pairs keyed by app session id.
 * One Engine instance per session keeps the engine's internal lifecycle
 * simple. Calling `sessionFor` multiple times for the same id returns the
 * same Session.
 */
export class EngineHost {
  private cache = new Map<string, CacheEntry>();
  /**
   * Single-flight gate for `sessionFor`. Two concurrent requests for the
   * same fresh session id used to each create their own Engine + Session
   * and each call `ensureDefaultThread`, which persisted two distinct
   * `web:default` thread rows into the store. Subsequent rehydrations
   * loaded both, breaking thread identity (DB had duplicates with the
   * same key). De-duping in-flight calls collapses the race.
   */
  private inflight = new Map<string, Promise<Session>>();
  private teardown = new Map<string, Promise<void>>();
  private lifecycleEpoch = new Map<string, number>();

  private assertSessionBuildAllowed(sessionId: string, epoch = this.lifecycleEpoch.get(sessionId) ?? 0): number {
    if (this.teardown.has(sessionId) || epoch !== (this.lifecycleEpoch.get(sessionId) ?? 0)) {
      throw new Error("Session teardown interrupted this request. Start a new session and retry.");
    }
    return epoch;
  }

  private threadCreations = new WeakMap<Session, Map<string, Promise<Thread>>>();
  /** Bumped by `evictCache`. A build captures the epoch when it starts and
   * refuses to cache (rebuilds instead) when it changed mid-build — without
   * this, a PATCH that lands while `buildAssistantSession` is between its
   * row read and its `cache.set` evicts an empty slot, and the stale build
   * then re-populates the cache and serves indefinitely. */
  private buildEpoch = new Map<string, number>();
  /** Repo keys whose conservative resource-withholding warning is active. */
  private resourceWithholdingWarnings = new Set<string>();

  /**
   * Idle-sweep interval handle (sandbox hibernation plan, Task 3), or
   * `null` when disabled (`idleMinutes <= 0` or the provider doesn't
   * report `hibernation` capability). ONE interval for the whole host,
   * 60s cadence, `.unref()`'d so it never keeps the process alive on its
   * own. Cleared in `evictAll()` (the shutdown path).
   */
  private sweepInterval: NodeJS.Timeout | null = null;

  /**
   * In-memory `sessionId -> Date.now()` of the last gateway-proxy touch
   * (final-review fix wave, hibernation arc): interactive Terminal/VS Code
   * traffic through `routes/gateway-proxy.ts` generates zero engine queue
   * activity (no submission is ever admitted), so without this map the idle
   * sweep would suspend a sandbox out from under a live terminal/editor tab.
   * Host-local, matching the sweep's own in-memory scope (`this.cache`) — a
   * gateway touch on process A never counts toward process B's sweep, same
   * limitation the sweep already accepts for its cache. Stamped by
   * `touchGatewayActivity` on every proxied HTTP request and WS open/
   * client-to-backend message; read by `maybeSuspendIdleSession` alongside
   * `latestActivityAt`, taking whichever is more recent.
   */
  private gatewayTouch = new Map<string, number>();

  /**
   * Lazily-built, host-wide policy resolver (action-policies plan, Task 3).
   * ONE instance shared by every session build — all per-invocation context
   * (org/user/session/service/params) rides in on the engine's
   * `PolicyResolveInput`, so the resolver holds no session state. Present
   * whenever an app `db` is wired (org policies/grants/audit all need it);
   * absent in db-less tests, which then get the engine's byte-identical
   * pre-policy approval path.
   */
  private policyResolverInstance: PolicyResolver | null = null;

  constructor(private readonly opts: EngineHostOpts) {
    const idleMinutes = opts.idleMinutes ?? 0;
    if (idleMinutes > 0 && opts.sandboxProvider.capabilities().hibernation) {
      this.sweepInterval = setInterval(() => {
        this.runIdleSweep().catch((err) => console.error("EngineHost: idle sweep failed:", err));
      }, 60_000);
      this.sweepInterval.unref?.();
    }
  }

  /**
   * Idle sweep tick (sandbox hibernation plan, Task 3, decision 3/6):
   * iterates the host's in-memory session cache ONLY. Sessions an api
   * restart evicted (boot-restore only rehydrates unsettled work) are the
   * `IdleHibernationSweep`'s jurisdiction — a DB-driven complement added
   * after 32 stranded active-but-idle assistant pods saturated a node
   * (2026-08-22; the original "hibernates only when next touched" Stage 1
   * limitation proved too expensive). Jurisdiction rule: cached or
   * mid-build sessions belong HERE (this sweep reads the gateway-touch
   * activity signal the DB sweep cannot); everything else belongs there.
   */
  private async runIdleSweep(): Promise<void> {
    const idleMs = (this.opts.idleMinutes ?? 0) * 60_000;
    if (idleMs <= 0) return;
    const now = Date.now();
    for (const [sessionId, entry] of this.cache) {
      try {
        await this.maybeSuspendIdleSession(sessionId, entry.session, now, idleMs);
      } catch (err) {
        console.error(`EngineHost: idle sweep failed for session ${sessionId}:`, err);
      }
    }
  }

  /**
   * Idleness (spec decision 3): no unsettled submissions AND the sandbox
   * has been `ready` with no queue activity for at least `idleMs`, judged
   * against `max(latestActivityAt ?? createdAt, gatewayTouch ?? 0)` — see
   * `touchGatewayActivity`'s doc comment for why the gateway side is
   * needed — AND the attachment is currently `ready` (never touches
   * `detached`/`provisioning`/`suspended`/`error`/`released` attachments).
   *
   * Race rule: `listUnsettledSubmissions` is checked once here, then
   * RE-CHECKED immediately before calling `suspend()` — a submission
   * admitted in between wins and the suspend is skipped.
   * `idleSweepTestHooks.beforeSuspend` fires between the two checks so
   * tests can inject that race deterministically.
   */
  private async maybeSuspendIdleSession(
    sessionId: string,
    session: Session,
    now: number,
    idleMs: number,
  ): Promise<void> {
    if (session.attachment.state !== "ready") return;

    const unsettled = await this.opts.engineStore.listUnsettledSubmissions(sessionId);
    if (unsettled.length > 0) return;

    let sinceMs = await this.opts.engineStore.latestActivityAt(sessionId);
    if (sinceMs == null) {
      const data = await this.opts.engineStore.getSession(sessionId);
      // No queue activity ever recorded and no session row (shouldn't
      // happen for a cached session, but fail safe) — treat as just-active
      // so we never suspend on missing data.
      sinceMs = data?.createdAt ?? now;
    }
    const gatewayTouchMs = this.gatewayTouch.get(sessionId) ?? 0;
    if (gatewayTouchMs > sinceMs) sinceMs = gatewayTouchMs;
    if (sinceMs >= now - idleMs) return;

    await this.opts.idleSweepTestHooks?.beforeSuspend?.(sessionId);

    // Re-check immediately before suspending — a submission admitted since
    // the check above wins.
    const recheck = await this.opts.engineStore.listUnsettledSubmissions(sessionId);
    if (recheck.length > 0) return;
    if (session.attachment.state !== "ready") return;

    await session.attachment.suspend();

    if (this.opts.onHibernate) {
      Promise.resolve(this.opts.onHibernate(sessionId, session.attachment.sandboxId)).catch((err) =>
        console.error(`EngineHost: onHibernate failed for session ${sessionId}:`, err),
      );
    }
  }

  /**
   * Wires the attachment's `onStatus` listener that drives `opts.onWake`
   * (sandbox hibernation plan, Task 3/4 seam): tracks a per-attachment
   * `wasSuspended` flag, firing `onWake` the first time the attachment
   * reaches `ready` after having been `suspended` (a
   * `suspended → provisioning → ready` wake sequence). Called once per
   * cached session build, right after `this.cache.set(...)` — the listener
   * lives as long as that `Session`'s attachment instance does.
   */
  private trackHibernationWake(sessionId: string, session: Session): void {
    let wasSuspended = false;
    session.attachment.onStatus((status) => {
      if (status.state === "suspended") {
        wasSuspended = true;
        return;
      }
      if (status.state === "ready") {
        if (wasSuspended) {
          wasSuspended = false;
          if (this.opts.onWake) {
            Promise.resolve(this.opts.onWake(sessionId)).catch((err) =>
              console.error(`EngineHost: onWake failed for session ${sessionId}:`, err),
            );
          }
        }
        // Unconditional (regardless of wasSuspended) — see
        // `EngineHostOpts.onSessionReady`'s doc comment for why this exists
        // separately from `onWake` above.
        if (this.opts.onSessionReady) {
          Promise.resolve(this.opts.onSessionReady(sessionId)).catch((err) =>
            console.error(`EngineHost: onSessionReady failed for session ${sessionId}:`, err),
          );
        }
        // Prep-completion seam for slash commands (Task 10): repo templates
        // under `/workspace/.valet/prompts` are only readable once workspace
        // prep has run, which happens by the time the attachment reaches
        // `ready`. Refresh the command registry so those templates land. A
        // no-op when the session has no `workspaceSkillsProvider`. Best-effort — a
        // refresh failure never breaks the ready transition.
        Promise.resolve(session.refreshCommandRegistry()).catch((err) =>
          console.error(`EngineHost: refreshCommandRegistry failed for session ${sessionId}:`, err),
        );
        // Repo AGENTS.md instructions (agents-md spec, decision 1): re-read on
        // every ready transition — cold boot, wake, and warm rebuild — so
        // mid-session edits land at natural boundaries. A no-op when the
        // session has no `repoInstructionsProvider`. Best-effort, same as the
        // registry refresh above; a failure leaves the previous value serving.
        Promise.resolve(session.refreshRepoInstructions()).catch((err) =>
          console.error(`EngineHost: refreshRepoInstructions failed for session ${sessionId}:`, err),
        );
      }
    });
  }

  /**
   * Resolve (or lazily create) the Session for an app session id. If the
   * engine store already has a row for this id, restore it. Otherwise create
   * a new engine session and persist it via the store.
   */
  async sessionFor(sessionId: string, meta: SessionMeta): Promise<Session> {
    const lifecycleEpoch = this.assertSessionBuildAllowed(sessionId);
    // Assistant ids must always wake through `assistantSessionFor` so they
    // get persona/memory-snapshot/mem_* tools/queueMode reconstructed from
    // configuration, never the generic `buildSession` path. Every caller of
    // `sessionFor` (messages.ts, ws.ts, sessions.ts, boot restore) can be
    // handed an assistant session id, so this dispatch lives here rather
    // than being duplicated at each call site. Delegating before touching
    // `this.cache`/`this.inflight` is deliberate: `assistantSessionFor`
    // does its own cache/inflight bookkeeping against the *same* maps
    // (keyed by the same `sessionId`), so checking here first would just be
    // a redundant, and potentially stale, read.
    const assistantId = parseAssistantSessionId(sessionId);
    if (assistantId) {
      return this.assistantSessionFor(assistantId, { actorUserId: meta.userId, orgId: meta.orgId });
    }

    const cached = this.cache.get(sessionId);
    if (cached) return cached.session;
    const pending = this.inflight.get(sessionId);
    if (pending) return pending;

    // Cold build only: the prefix parse above cannot recognize rows
    // migrated from orchestrator_identities, whose assistants row keeps a
    // legacy `orchestrator:*` session id — the assistants table is the
    // authority (`assistants_session` unique index). Without this lookup a
    // legacy assistant wakes through the generic build below: no persona,
    // no memory, and no archived-wake refusal. Cache hits above stay
    // query-free — an assistant session cached via `assistantSessionFor`
    // lands in the same maps under the same key.
    if (this.opts.db) {
      const assistant = await loadAssistantBySessionId(this.opts.db, sessionId);
      this.assertSessionBuildAllowed(sessionId, lifecycleEpoch);
      if (assistant) {
        return this.assistantSessionFor(
          assistant.id,
          { actorUserId: meta.userId, orgId: meta.orgId },
          { sessionId: assistant.sessionId },
        );
      }
      // The awaited lookup opened a gap since the cache/inflight checks
      // above — re-check, or two concurrent cold wakes both start a build.
      const cachedAfter = this.cache.get(sessionId);
      if (cachedAfter) return cachedAfter.session;
      const pendingAfter = this.inflight.get(sessionId);
      if (pendingAfter) return pendingAfter;
    }

    const promise = this.buildSession(sessionId, meta).finally(() => {
      this.inflight.delete(sessionId);
    });
    this.inflight.set(sessionId, promise);
    return promise;
  }

  private async buildSession(sessionId: string, meta: SessionMeta): Promise<Session> {
    // Security runner wiring (Valet Security spec §Tools): a session whose
    // app row carries kind='security' gets the sec_* runner tools, the
    // engagement-runner skill, and the child read/send/status seams —
    // deliberately NOT the childSpawner, so the generic `task` tool answers
    // unavailable and every dispatch goes through sec_dispatch (Decision 3).
    // plugin-security is registry-enabled (M9), but `sessionExtras`/
    // `skillsProviderFor` filter it out of the base plugin set — plugin
    // skills attach globally, and the engagement-runner skill must reach
    // ONLY runner builds (spec implementation deviation 20). The directly
    // imported manifest, threaded as an extra plugin for this build only,
    // is the single attach path, so the skill lands exactly once.
    const isSecurityRunner = (await this.storedKind(sessionId)) === "security";
    // Persona child wiring (M4): a session a running security cell claims
    // gets the persona tool set, the persona role, and the tool endpoint
    // config — the post-restart rebuild path for dispatched cell children
    // (the first build goes through `buildChildSession`, same wiring).
    const personaCell = isSecurityRunner ? null : await this.claimedSecurityCell(sessionId);
    // Declared-tool provisioning (M-P4a/M-P4b): a persona child gets its
    // engagement's declared MCP servers as extra plugins and the authorized-
    // scope egress allowlist env. Empty for the runner and non-security builds.
    const securityProvisioning = personaCell
      ? await this.securityProvisioningForCell(personaCell)
      : { mcpPlugins: [], scopeEnv: {} };
    const extraPlugins = isSecurityRunner
      ? [securityPlugin]
      : personaCell
        ? securityProvisioning.mcpPlugins
        : [];
    // Skills follow the session principal. A team-owned session reads that
    // team's skills, not the prompting member's. SessionOptions.owner below
    // uses the same principal.
    const principal = sessionPrincipal(meta);
    const extras = await this.sessionExtras(
      principal,
      meta.orgId,
      [],
      extraPlugins,
      isSecurityRunner ? buildSecurityRunnerTools().map((tool) => tool.name) : [],
    );
    const skillsProvider = this.skillsProviderFor(principal, meta.orgId, extraPlugins);

    const engine = new Engine({
      providers: {
        store: this.opts.engineStore,
        stream: this.opts.eventStream,
        credentials: this.opts.engineCredentials,
        sandboxProvider: this.opts.sandboxProvider,
        blobs: this.opts.blobs,
      },
    });

    const existing = await this.opts.engineStore.getSession(sessionId);
    let sharedTranscript = false;
    if (existing?.parentSessionId !== undefined && this.opts.db) {
      const [watch] = await this.opts.db.select({ originJson: childWatches.originJson }).from(childWatches)
        .where(eq(childWatches.childSessionId, sessionId)).limit(1);
      sharedTranscript = watch?.originJson !== null && watch?.originJson !== undefined;
    }
    // `userId` stays in the cascade even for a team-owned row: this
    // builder makes member-started sessions, and the starting member's
    // personal default wins over the team's for their own session.
    const { model, spec: modelSpec } = await this.resolveModelForBuild(existing, meta.orgId, {
      userId: meta.userId,
      ownerTeamId: meta.ownerTeamId,
    });
    const reasoning = await this.resolveReasoningForBuild(existing, meta.orgId, {
      userId: meta.userId,
      ownerTeamId: meta.ownerTeamId,
    });
    const resolveModel = this.makeResolveModel(meta.orgId);
    const profile = meta.profile ?? "headless";
    const sandboxMint = await this.mintSandboxEnv(sessionId, meta.userId, meta.orgId, profile);
    // Repo-declared session-runtime flags from `.valet/prebuild.yaml`:
    // `docker` (session-create opt ORs over it), `workspaceStorage`, and
    // CPU/memory resources
    // (TKAI-385: a large repo declares its workspace size up front so the
    // claim is provisioned big enough — no reactive resize needed).
    // `resolveRepoPrebuildFlags` is best-effort — any failure resolves the
    // defaults. Single image lineage: the docker flag only shapes
    // SandboxCreateOpts (caps/mounts/exec identity), never which image is
    // resolved.
    const repoFlags = await this.resolveRepoPrebuildFlags(sessionId, meta);
    const dockerFlag = meta.docker === true || repoFlags.docker;
    const kubernetesFlag = repoFlags.kubernetes;
    const initialResources = repoFlags.initialResources;
    // Start-ref sink (engine traces spec, change 2 — host pattern B): the
    // specProvider closure resolves the primary clone's ref inside the sandbox
    // and calls this callback. The callback can fire before create/restore
    // returns (attachment provisioning races the build), so a ref that arrives
    // early is parked and flushed right after the session exists. Best-effort
    // throughout: a session that already carries a start-ref keeps it (start
    // conditions are immutable; a later epoch's re-clone may legitimately sit
    // at a newer SHA and must not overwrite).
    let builtSession: Session | undefined;
    let pendingStartRef: SessionStartRef | undefined;
    const onStartRef = async (ref: SessionStartRef) => {
      const target = builtSession;
      if (!target) {
        pendingStartRef = ref;
        return;
      }
      if (target.options.startRef) return;
      await target.setStartRef(ref).catch((err: unknown) => {
        console.error(
          `EngineHost: recording start-ref for session ${sessionId} failed:`,
          err instanceof Error ? err.message : String(err),
        );
      });
    };
    const specProvider = await this.buildSpecProvider(sessionId, meta, onStartRef, personaCell != null);
    const credentialResolver = this.buildCredentialResolver(
      sessionId,
      meta.userId,
      meta.orgId,
      resolvesAsActingMember(meta),
    );
    // Slash-command options (Task 10). The workspace-skills provider's sandbox
    // accessor closes over `builtSession` — resolved lazily, so it is safe that
    // the session doesn't exist yet at this point. `hasPrep` is true only when
    // a specProvider exists: without prep there is no `/workspace/.valet/prompts`
    // to scan (skills-as-commands plan, Task 4).
    const commandOptions = await this.buildCommandOptions(
      meta.orgId,
      sessionId,
      () => builtSession,
      specProvider !== undefined,
      extras.pluginCatalog,
      principal,
    );
    // Repo AGENTS.md instructions (agents-md spec, decision 5): same lazy
    // `builtSession` accessor as the command options above.
    const repoInstructionsProvider = this.buildRepoInstructionsProvider(
      () => builtSession,
      meta.repos,
      specProvider !== undefined,
    );
    // Initial sandbox image: the single-lineage stock default — every
    // session shape boots the full sandbox image (start scripts + docker
    // toolchain baked in; the profile only decides whether the interactive
    // services START). The specProvider closure may resolve a bake image
    // override at provision time — the engine applies
    // DesiredSandboxSpec.image when the specProvider returns one.
    const image = this.opts.defaultImages?.full ?? this.opts.defaultImage;
    // Authorized-scope egress allowlist env (M-P4b): a live persona child
    // carries VALET_SECURITY_AUTHORIZED_SCOPE so its live tools bound egress to
    // the human-declared scope. Merged over the mint env; empty otherwise, so a
    // non-live build's env is byte-identical to before. See
    // security-provisioning.ts for the enforcement-seam note.
    const sandboxEnv =
      Object.keys(securityProvisioning.scopeEnv).length > 0
        ? { ...(sandboxMint?.env ?? {}), ...securityProvisioning.scopeEnv }
        : sandboxMint?.env;
    const sandboxOpts = {
      browser: { enabled: this.opts.sandboxProvider.capabilities().browserAutomation === true, viewer: true },
      workspace: meta.workspace,
      image,
      env: sandboxEnv,
      profile,
      ...(dockerFlag ? { docker: true } : {}),
      ...(kubernetesFlag ? { nestedKubernetes: true } : {}),
      ...(initialResources ? { resources: initialResources } : {}),
      // Sizes a fresh claim; an adopted (existing) claim converges UP to this
      // through the provider's rate-limited grow at create time (TKAI-402).
      // A claim never shrinks.
      ...(repoFlags.workspaceStorage ? { workspaceStorage: repoFlags.workspaceStorage } : {}),
      ...(sandboxMint ? { credsFiles: sandboxMint.credsFiles } : {}),
    };
    const policyResolver = this.getPolicyResolver();
    const pluginStoreFactory = this.getPluginStoreFactory();
    // Runner tools sit before the plugin tools so the loop surface reads
    // first in the tool list. The toolConfig mirrors the orchestrator's
    // (apiBaseUrl + internal token for the sec_* HTTP seam; child
    // read/send/status seams for steering dispatched personas) minus the
    // childSpawner — see the isSecurityRunner comment above.
    const sessionTools = isSecurityRunner
      ? [...buildSecurityRunnerTools(), ...extras.tools]
      : personaCell
        ? [...buildSecurityPersonaTools({ review: personaCell.review, persona: personaCell.persona }), ...extras.tools]
        : extras.tools;
    const securityToolConfig = isSecurityRunner
      ? {
          toolConfig: {
            ...(this.opts.apiBaseUrl ? { apiBaseUrl: this.opts.apiBaseUrl } : {}),
            internalToken: internalToken(),
            ...(this.opts.childReader ? { childReader: this.opts.childReader } : {}),
            ...(this.opts.childSender ? { childSender: this.opts.childSender } : {}),
            ...(this.opts.childStatusReader ? { childStatusReader: this.opts.childStatusReader } : {}),
          },
        }
      : personaCell
        ? {
            // The persona tools' HTTP seam only — no child seams and no
            // spawner (a persona child steers nothing and spawns nothing).
            toolConfig: {
              ...(this.opts.apiBaseUrl ? { apiBaseUrl: this.opts.apiBaseUrl } : {}),
              internalToken: internalToken(),
            },
            // Compaction is observable, not silent (M5, spec §Context
            // Discipline): stamp + staleness alert on the claiming cell.
            // `claimedSecurityCell` returned a row, so a db handle exists;
            // the guard narrows the type only.
            ...(this.opts.db ? { compactionHooks: [securityCompactionHook(this.opts.db)] } : {}),
          }
        : {};
    // The persona role registers on the session (roles registry) so the
    // dispatch prompt's per-turn `role` overlay resolves. Attach ONLY the role
    // matching the claimed cell's persona (not every security role) — the
    // engagement-runner SKILL stays off persona children. A repo-defined
    // persona loads its role from the engagement's stashed markdown (M-P2c).
    const personaRepoRoleMarkdown = personaCell
      ? await this.repoRoleMarkdownForCell(personaCell)
      : undefined;
    const sessionRoles = personaCell
      ? [...extras.roles, ...securityRolesForCell(personaCell.persona, personaRepoRoleMarkdown)]
      : extras.roles;
    const session = existing
      ? await engine.restoreSession({
          sessionId,
          options: {
            userId: meta.userId,
            orgId: meta.orgId,
            owner: principal,
            workspace: meta.workspace,
            sharedTranscript,
            sandbox: sandboxOpts,
            model,
            modelSpec,
            resolveModel,
            ...(reasoning !== undefined && isReasoningLevel(reasoning) ? { sampling: { reasoning } } : {}),
            systemPrompt: codingSystemPrompt({ secretsCli: specProvider !== undefined }),
            tools: sessionTools.length ? sessionTools : undefined,
            skills: extras.skills.length ? extras.skills : undefined,
            roles: sessionRoles.length ? sessionRoles : undefined,
            ...securityToolConfig,
            ...(skillsProvider ? { skillsProvider } : {}),
            ...(specProvider ? { specProvider } : {}),
            ...(credentialResolver ? { credentialResolver } : {}),
            ...(commandOptions ?? {}),
            ...(repoInstructionsProvider ? { repoInstructionsProvider } : {}),
            ...(policyResolver ? { policyResolver } : {}),
            ...(pluginStoreFactory ? { pluginStoreFactory } : {}),
            ...this.browserOptions(sessionId),
            extractDocument: extractDocumentText,
            ...(this.opts.db ? { skillTelemetry: skillTelemetrySink(this.opts.db, meta.orgId) } : {}),
          },
        })
      : await engine.createSession({
          id: sessionId,
          userId: meta.userId,
          orgId: meta.orgId,
          owner: principal,
          workspace: meta.workspace,
          sharedTranscript,
          sandbox: sandboxOpts,
          model,
          modelSpec,
          resolveModel,
          ...(reasoning !== undefined && isReasoningLevel(reasoning) ? { sampling: { reasoning } } : {}),
          systemPrompt: codingSystemPrompt({ secretsCli: specProvider !== undefined }),
          tools: sessionTools.length ? sessionTools : undefined,
          skills: extras.skills.length ? extras.skills : undefined,
          roles: sessionRoles.length ? sessionRoles : undefined,
          ...securityToolConfig,
          ...(skillsProvider ? { skillsProvider } : {}),
          ...(specProvider ? { specProvider } : {}),
          ...(credentialResolver ? { credentialResolver } : {}),
          ...(commandOptions ?? {}),
          ...(repoInstructionsProvider ? { repoInstructionsProvider } : {}),
          ...(policyResolver ? { policyResolver } : {}),
          ...(pluginStoreFactory ? { pluginStoreFactory } : {}),
          ...this.browserOptions(sessionId),
          extractDocument: extractDocumentText,
            ...(this.opts.db ? { skillTelemetry: skillTelemetrySink(this.opts.db, meta.orgId) } : {}),
        });

    builtSession = session;
    if (pendingStartRef) {
      await onStartRef(pendingStartRef);
      pendingStartRef = undefined;
    }

    this.cache.set(sessionId, { engine, session });
    this.trackHibernationWake(sessionId, session);
    // Retention: after a successful restore of an existing session, prune
    // durable events for submissions that settled outside the retention
    // window. Fire-and-forget — never block or fail the restore.
    if (existing) this.pruneExpiredEvents(sessionId);
    return session;
  }

  /**
   * The tools/skills/roles a session build gets: the plugin set, plus the
   * stored skills the session's `owner` can reach (`skills` table).
   *
   * Built FRESH per session build, never cached on the host: the plugin
   * catalog's dynamic-action-resolution cache lives on the `Catalog`
   * instance `pluginCatalogTools` returns, so it must stay scoped to this
   * one session's credential context — a shared/cached catalog would leak
   * one user's resolved tool list into every other session. The skill read
   * here seeds the session at build; `skillsProviderFor` (below) re-reads it
   * on registry refreshes so later skill edits reach a cached session too.
   *
   * `opts.db` is optional (tests that wire no db), so an absent db means
   * "plugin skills only" — the same graceful degradation `mintSandboxEnv`
   * applies. A stored skill whose name a plugin skill already holds is
   * shadowed inside `pluginSessionExtras`, never thrown: none of the four
   * callers has a try/catch, and a throw here would stop this owner from
   * starting any session.
   *
   * `pins` defaults to none, and each caller decides. This method is the one
   * funnel for FOUR session builders — `buildSession`, `buildAssistantSession`,
   * `buildChildSession` and `buildWorkflowSession` — so a pin list hard-coded
   * here would reach unattended, trigger-driven sessions. A pinned tool is
   * high-salience: it sits in the tool list with host guidance that tells the
   * model to call it in the same turn. Text that a webhook or an email put in
   * a workflow run's prompt must not meet that. Only the caller knows whether
   * a human is watching, so only the caller passes pins.
   */
  /**
   * The registry plugin set every session build starts from, with
   * plugin-security filtered OUT (spec implementation deviation 20).
   * Plugin skills have no scoping mechanism — `pluginSessionExtras`
   * attaches every plugin's skills to every session — and the
   * engagement-runner skill instructs a loop only `kind='security'`
   * runners have the sec_* tools for. The plugin stays registry-enabled
   * for discovery; the kind-gated build paths re-add the directly
   * imported manifest (`extraPlugins` for the runner skill, the
   * persona-cell `roles` concat for the code-review role), each exactly
   * once.
   */
  private basePlugins(): ValetPlugin[] {
    return (this.opts.plugins ?? []).filter((p) => p.name !== securityPlugin.name);
  }

  /**
   * Whether `name` is in the deployment's loaded plugin set — the instance
   * (operator) switch half of the plugin entitlement rail (plugin-entitlements
   * design). Reads `this.opts.plugins`, the full assembled set, so a plugin
   * that `basePlugins`/`sessionExtras` filter out of normal sessions (security)
   * still reads as loaded. Off here means off for every org, regardless of the
   * org entitlement mode.
   */
  isPluginLoaded(name: string): boolean {
    return (this.opts.plugins ?? []).some((p) => p.name === name);
  }

  /**
   * The loaded plugins that opted into org gating (a `gate` manifest field).
   * Drives the admin API and the `GET /api/org` visibility block, and
   * validates admin writes. A plugin with no `gate` rides the instance switch
   * only and never appears here.
   */
  gateablePlugins(): { name: string; label: string; description: string }[] {
    return (this.opts.plugins ?? [])
      .filter((p): p is ValetPlugin & { gate: NonNullable<ValetPlugin["gate"]> } => p.gate !== undefined)
      .map((p) => ({ name: p.name, label: p.gate.label, description: p.gate.description }));
  }

  /**
   * Drops every GATEABLE plugin the owner's org disables for the owner. A
   * plugin with no `gate` is never touched. Only a USER-principal owner is
   * checked: a team-owned session has no single member to resolve the `teams`
   * mode against, so it keeps every gateable plugin (the create-route gate
   * still refuses a team member who cannot use a plugin-backed kind).
   *
   * Best-effort: with no db, or when the entitlement read throws, the plugin
   * stays in the set (default to allowed) and the failure is logged — an
   * entitlement lookup must never break a session build.
   */
  private async filterEntitledPlugins(
    plugins: ValetPlugin[],
    owner: Principal,
    orgId: string,
  ): Promise<ValetPlugin[]> {
    const db = this.opts.db;
    if (!db || owner.type !== "user") return plugins;
    const gateable = new Set(this.gateablePlugins().map((g) => g.name));
    if (gateable.size === 0) return plugins;
    const kept: ValetPlugin[] = [];
    for (const plugin of plugins) {
      if (!gateable.has(plugin.name)) {
        kept.push(plugin);
        continue;
      }
      try {
        if (await orgAllowsPluginForUser(db, orgId, owner.id, plugin.name)) kept.push(plugin);
      } catch (err) {
        console.error(
          `EngineHost: plugin entitlement check for '${plugin.name}' (org ${orgId}) failed; keeping plugin:`,
          err instanceof Error ? err.message : String(err),
        );
        kept.push(plugin);
      }
    }
    return kept;
  }

  private async sessionExtras(
    owner: Principal,
    orgId: string,
    pins: readonly PinnedActionSpec[] = [],
    // Build-scoped plugin additions (the security runner's disabled-in-
    // registry manifest) — appended after the registry set so registry
    // plugins keep shadow priority.
    extraPlugins: readonly ValetPlugin[] = [],
    appendedNativeToolNames: readonly string[] = [],
  ): Promise<PluginSessionExtras> {
    const assembled = [...this.basePlugins(), ...extraPlugins];
    const assembledServices = actionServices(assembled);
    const loadFailures = (this.opts.pluginLoadFailures ?? []).filter(
      (item) => !assembledServices.has(item.service),
    );
    const entitled = await this.filterEntitledPlugins(assembled, owner, orgId);
    const plugins = entitled;

    const disabledServices = removedActionServices(assembled, entitled).map((service) => ({
      service,
      state: "disabled_by_org" as const,
      reason: "the organization disabled this plugin",
      fix: `An org admin must enable the ${service} plugin.`,
    }));
    const resolveServiceAvailability = async (actionService?: string): Promise<ServiceAvailability[]> => {
      const inventory = await unavailableServiceInventory({
        plugins: entitled,
        orgId,
        credentials: this.opts.engineCredentials,
        env: process.env,
        owner,
        actionService,
      });
      const unavailable = inventory.unavailable;
      const availabilityFailures = inventory.failures.map(({ service, reason }) => ({
        service,
        state: "load_failed" as const,
        reason: `availability check failed: ${reason}`,
      }));
      const deploymentServices = unavailableActionServices(plugins, unavailable).map((service) => ({
        service,
        state: "deployment_unconfigured" as const,
        reason: "the deployment or organization credential is not configured",
        fix: `An org admin must configure ${service} (org settings → /settings/organization). After configuration, call list_tools (service: "${service}") to confirm — actions appear when the configuration worked; otherwise this warning returns with the reason.`,
      }));
      return mergeServiceAvailability(
        loadFailures,
        availabilityFailures,
        disabledServices,
        deploymentServices,
      );
    };
    const serviceAvailability = await resolveServiceAvailability();
    const catalogOptions = {
      nativeToolNames: [...builtinTools.map((tool) => tool.name), "skill", ...appendedNativeToolNames],
      serviceAvailability,
      resolveServiceAvailability,
    };
    const browserPins = this.opts.sandboxProvider.capabilities().browserAutomation && plugins.some((plugin) => plugin.name === 'browser')
      ? ['browser.describe', 'browser.execute', 'browser.reset'].map((actionId) => ({ actionId })) : [];
    const effectivePins = [...pins, ...browserPins];
    if (!this.opts.db) return pluginSessionExtras(plugins, [], effectivePins, catalogOptions);
    return pluginSessionExtras(
      plugins,
      await listSkillSourcesFor(this.opts.db, owner, orgId),
      effectivePins,
      catalogOptions,
    );
  }

  /**
   * The engine `skillsProvider` for a session owned by `owner`: re-reads the
   * stored skills that owner can reach and merges them under the plugin set
   * with the same shadow rule `sessionExtras` applies
   * (`mergedSkillSources`). `Session.refreshCommandRegistry()` invokes it —
   * on every `GET /:id/commands` and on each attachment `ready` transition —
   * so a skill created, edited, or deleted after the session was built
   * reaches a long-lived cached session (the orchestrator especially: it
   * lives in the host cache indefinitely, so without this it would only ever
   * see the skills that existed at its first build).
   *
   * `undefined` without a db — the session then keeps its construction-time
   * skill set, the same graceful degradation `sessionExtras` applies.
   */
  private skillsProviderFor(
    owner: Principal,
    orgId: string,
    // Must match the `extraPlugins` the build's `sessionExtras` got, or a
    // registry refresh silently DROPS the extras' skills (the refresh
    // replaces the session's whole skill map from this provider).
    extraPlugins: readonly ValetPlugin[] = [],
  ): (() => Promise<SkillSource[]>) | undefined {
    const db = this.opts.db;
    if (!db) return undefined;
    return async () => {
      const plugins = await this.filterEntitledPlugins([...this.basePlugins(), ...extraPlugins], owner, orgId);
      return mergedSkillSources(plugins, await listSkillSourcesFor(db, owner, orgId)).skills;
    };
  }

  /**
   * Master key `deriveSandboxJwtSecret`/`mintSandboxJwt` derive per-session
   * secrets from (Task 8, auth-v2 plan): `opts.sandboxJwtMaster` (from
   * `AuthConfig.sandboxJwtMaster`) when real auth is configured, else
   * `internalToken()` so stub-only dev keeps working.
   */
  private resolveSandboxJwtMaster(): string {
    return this.opts.sandboxJwtMaster ?? internalToken();
  }

  /**
   * Adopts this session's durable sandbox bearer and derives its JWT secret.
   * The instance encryption key recovers the same bearer after API restart.
   * Returns the five env vars every sandbox
   * gets at provision time: `VALET_SANDBOX_TOKEN`, `VALET_API_URL`,
   * `VALET_SANDBOX_JWT_SECRET` (Task 8, auth-v2 plan), plus `VALET_SESSION_ID`
   * and `VALET_SANDBOX_PROFILE` (sandbox auth gateway plan, Task 5).
   * `VALET_SESSION_ID` must equal `sessionId` — it's the same id
   * `mintSandboxJwt` puts in the JWT's `sid` claim, and the gateway daemon
   * inside "full"-profile sandboxes enforces `sid === VALET_SESSION_ID`.
   * Called once per session BUILD (create or restore) — not per sandbox
   * re-provision within a build's lifetime, since the `SandboxCreateOpts`
   * object handed to `engine.createSession`/`restoreSession` is captured
   * once and reused by the attachment for every (re-)provision until the
   * next build.
   *
   * Returns `undefined` when `opts.db` is absent (tests that don't wire a
   * db up) — sandboxes then provision with no extra env, same as before
   * this wiring existed.
   */
  private async mintSandboxEnv(
    sessionId: string,
    userId: string,
    orgId: string,
    profile: "headless" | "full",
  ): Promise<{ env: Record<string, string>; credsFiles: Record<string, string> } | undefined> {
    if (!this.opts.db) return undefined;
    const { token } = await getOrCreateSandboxToken(
      this.opts.db, { sessionId, userId, orgId },
      this.opts.sandboxTokenMaster ?? this.resolveSandboxJwtMaster(),
    );
    const secret = deriveSandboxJwtSecret(this.resolveSandboxJwtMaster(), sessionId);
    return {
      env: {
        // Keep env var for fallback: old sandboxes and non-credsMount providers
        // read VALET_SANDBOX_TOKEN from the process environment.
        VALET_SANDBOX_TOKEN: token,
        VALET_API_URL: this.opts.sandboxApiUrl ?? "http://localhost:8788",
        VALET_SANDBOX_JWT_SECRET: secret,
        VALET_SESSION_ID: sessionId,
        VALET_SANDBOX_PROFILE: profile,
      },
      credsFiles: { token },
    };
  }

  /**
   * Builds the `SpecProvider` closure for a session (sandbox-reconciliation
   * plan, Task 6). Returns `undefined` when the sandbox provider is not
   * isolated — local/virtual sandboxes exec against the host process, so
   * credential-only prep would rewrite the developer's real git config.
   *
   * The returned closure: calls `resolveSnapshot` (Task 2) + `computeSpec`
   * (Task 1) on every invocation (lazy staleness read), pairs the resulting
   * `StepSpec[]` with apply closures via `buildPrepSteps` (Task 6 prep-steps),
   * and returns the fully populated `DesiredSandboxSpec`. The image field
   * overrides the initial stock image the sandbox was provisioned with when a
   * fresh prebuild is available; the engine applies it at provision time.
   *
   * Prebuild recording (`agent_sessions.prebuild_id`) is best-effort: the
   * closure records the bake id whenever the snapshot resolves a fresh
   * repoBake, mirroring the old eager-recording behavior.
   */
  private async buildSpecProvider(
    sessionId: string,
    meta: SessionMeta,
    onStartRef?: (ref: SessionStartRef) => void | Promise<void>,
    installSecurityTools = false,
  ): Promise<import("@valet/engine").SpecProvider | undefined> {
    const hasRepos = meta.repos && meta.repos.length > 0;
    // Non-isolated providers (local/virtual) exec against the host process.
    // Credential-only prep (unbound sessions) would rewrite the developer's
    // real git config and drop a `gh` shim into the host's /usr/local/bin —
    // so skip it when not isolated. Repo-bound sessions always get prep
    // regardless of isolation, same as the old `buildWorkspacePrep` behavior.
    if (!hasRepos && this.opts.sandboxProvider.capabilities().isolated !== true) return undefined;

    const host = this;
    const apiUrl = this.opts.sandboxApiUrl ?? "http://localhost:8788";
    // Single image lineage: one stock image for every session shape. Must
    // agree with the create-opts image in `buildSession`/`buildChild` or the
    // `spec.image !== stockImage` comparison below misreports the stock
    // case as an override.
    const stockImage =
      this.opts.defaultImages?.full ??
      this.opts.defaultImage ??
      "";

    return async () => {
      const snap = await resolveSnapshot({
        db: host.opts.db,
        provider: host.opts.sandboxProvider,
        meta,
        apiUrl,
        stockImage,
        preflight: host.opts.prebuildPreflight,
      });
      // The repo's own command-to-credential declarations, resolved on the
      // same best-effort footing as the docker flag: read failures yield no
      // wrappers rather than blocking the sandbox. Read inside the closure so
      // an edit is picked up on the next reconcile, like every other part of
      // the spec.
      snap.credentialCommands = await host.resolveRepoCredentialCommands(meta);
      // Use the same cached runtime-config resolver as initial creation. A
      // declared or absent repository answer is authoritative. An error has
      // no resource opinion, so reconciliation preserves recorded overrides.
      const repoFlags = await host.resolveRepoPrebuildFlags(sessionId, meta);
      const resources = repoFlags.resources;

      // Best-effort prebuild-id recording — same as the old eager path.
      if (snap.repoBake) {
        await host.recordPrebuildId(sessionId, snap.repoBake.bakeId);
      }

      const spec = computeSpec(snap);
      // Workspace floor for the resolved image (TKAI-538). `valet-home-init`
      // seeds the baked home (`/root/.local` and siblings) into the claim
      // before any clone, so a claim smaller than the image crashloops on
      // ENOSPC in the init container, which the runtime grow path never sees
      // (it runs only once the sandbox is Running). Derive the floor from the
      // SAME resolved bake that selected `spec.image`, so size and image can
      // never diverge. Surface a desired `workspaceStorage` ONLY when the floor
      // raises the claim above the repo-declared size; otherwise leave the
      // create-opts value (repo-declared, or the deploy default) as the sole
      // authority, which preserves the create-time flag semantics including
      // withhold-on-read-failure. The provider still clamps to its max.
      const imageFloor =
        spec.imageSizeBytes != null ? imageAwareWorkspaceFloor(spec.imageSizeBytes) : null;
      let workspaceStorage: string | undefined;
      if (imageFloor) {
        const lifted = liftWorkspaceStorageToImageFloor(repoFlags.workspaceStorage, imageFloor);
        if (lifted !== repoFlags.workspaceStorage) workspaceStorage = lifted;
      }
      const steps = buildPrepSteps(snap, spec.steps, onStartRef);
      // Scanner bootstrap (Valet Security): a security persona cell installs
      // gitleaks + semgrep + sec-preflight AFTER the clone/bind steps, so the
      // tools land in the ready, cloned sandbox. Best-effort (critical: false)
      // — a blocked-egress install fails without aborting the sandbox, and
      // sec-preflight then reports the tool absent. Every security cell gets
      // the same steps; non-security sessions get none.
      if (installSecurityTools) {
        steps.push(...securityToolPrepSteps());
      }

      return {
        image: spec.image !== stockImage ? spec.image : undefined,
        specHash: specHash(spec, resources, repoFlags.preserveResourceFields),
        steps,
        ...(resources !== undefined ? { resources } : {}),
        ...(repoFlags.preserveResourceFields !== undefined
          ? { preserveResourceFields: repoFlags.preserveResourceFields }
          : {}),
        ...(workspaceStorage !== undefined ? { workspaceStorage } : {}),
      };
    };
  }

  /**
   * Persist `agent_sessions.bake_id` for a session that resolved to a
   * prebuilt image (sandbox images v2, Task 4). Best-effort: a write failure
   * is logged, never thrown — the sandbox already points at the right image
   * regardless of whether the bookkeeping row updates, and session build must
   * never fail on prebuild resolution. Skipped when no app db is wired.
   */
  private async recordPrebuildId(sessionId: string, bakeId: string): Promise<void> {
    if (!this.opts.db) return;
    try {
      await this.opts.db
        .update(agentSessions)
        .set({ bakeId })
        .where(eq(agentSessions.id, sessionId));
    } catch (err) {
      console.error(`EngineHost: recording bake_id for session ${sessionId} failed:`, err);
    }
  }

  /**
   * Builds the `credentialResolver` (engine `CreateSessionOptions` seam,
   * GH-T10 fix) for a session, or `undefined` when neither `githubTokenDeps`+`db`
   * nor `onePassword` are wired — callers must conditionally spread the result
   * so an unresolved session's options stay byte-identical to before this fix
   * (no `credentialResolver` key at all → the engine reads the raw store).
   *
   * The resolver is the SINGLE decision point for this session's credentials.
   * The engine passes the session principal as `owner` (user, team, or org).
   * The resolver trusts that argument. It does not read a separate ownerType.
   *
   *  - `github` (when `githubTokenDeps`+`db` are wired) → for a team owner,
   *    the team's own `github` row first (`resolveTeamCredentialRead`,
   *    health-checked by `isUsableGithubRow`), then `resolveSessionGitHubToken`
   *    (`purpose: "api"`). A user owner keeps `userId` so their PAT or
   *    App-OAuth can win. A team or org owner omits `userId` and always
   *    selects `auth: "app"`: the primary `session_repos` binding names the
   *    installation, else the org's sole installation. A member credential
   *    or the org PAT never backs a team session. A `GitHubAuthError`
   *    propagates unchanged — the engine surfaces it as the tool's error
   *    result, hint text intact.
   *    Synthesizes a `StoredCredential` the engine's `credentialProvider`
   *    maps to `{ accessToken }`.
   *  - `github:installation` → `resolveInstallationApiToken`, the explicit
   *    installation-tier request (the binding's owner, else the org's sole
   *    installation). `null` when no installation resolves, or when `db`/
   *    `githubTokenDeps` are not wired.
   *  - `openai` → `resolveOpenAiCredential` when `db` is wired (org OpenAI
   *    LLM-provider key → team row for a team owner under
   *    `orgFallbackPolicy(plugins, "openai")`, or
   *    `resolveUserCredentialRead` for a user owner → OPENAI_API_KEY env).
   *    A team or org owner never reads the prompting member's user row.
   *  - `slack` → owner-precedence read (user, team, or org), then
   *    `withSlackOwnerMetadata` only for a user owner when `db` is wired.
   *    The identity link injects `metadata.owner_slack_user_id` for
   *    plugin-slack's private-channel check.
   *  - every OTHER service (and `github` itself when `githubTokenDeps`/`db`
   *    aren't wired) → `resolveUserCredentialRead` for a user owner,
   *    `resolveTeamCredentialRead` for a team owner (org fallback only when
   *    a plugin declares the service org-provided), or
   *    `resolveOrgCredentialRead` for an org owner. When `onePassword` is
   *    wired and the winning row carries `metadata.onepassword`
   *    (`onePasswordMeta`), `onePassword.resolveCredential` fills in the
   *    secret. An `OnePasswordAuthError` propagates unchanged, mirroring
   *    `GitHubAuthError`. Rows without 1Password reference metadata (or
   *    with no `onePassword` wired) pass through unchanged.
   *
   *    On a user-row miss the org row is read only as far as
   *    `orgFallbackPolicy(plugins, service)` allows: `org-provided` when a
   *    plugin declares `requires.orgCredential` (the row is the configured
   *    credential for everyone), otherwise `reference-only` (an admin's
   *    1Password pointer is a deliberate act of sharing; a plain org row
   *    stays invisible to member sessions).
   *
   *  - `actingMember` (a team session whose row is stamped
   *    `credential_owner_mode = 'actor'`, see `resolvesAsActingMember`)
   *    reads every service as `{ type: "user", id: userId }` with the org
   *    fallback above and the team's 1Password scope, which is the contract
   *    every session had before team-owner resolution. The principal the
   *    engine hands over is ignored for the read; it still owns the session.
   *    This holds only while that actor is a current member of the owning
   *    team: a nonmember actor (an organization-audience Slack mention)
   *    reads as the team, never as their own vault.
   *
   * DEVIATION (for T12): workflow tool-node invocations
   * (`workflows/engine-deps.ts`'s `invokeAction`) carry no `sessionId`, so
   * their `github` actions resolve repo-less `auto` — the session-bound
   * branch of `resolveSessionGitHubToken` is exercised only from a real
   * session build (this resolver) today, not from the shipped workflow
   * engine, until workflow runs gain session context.
   *
   * PROBE COST (for T12): `plugin-catalog.ts`'s `list_tools` discovery calls
   * `credentials.get("github")` once per listing to emit a "not connected"
   * warning — and for `github` that `.get` is THIS resolver, so a cold-cache
   * tool listing can trigger a token mint/refresh over the network. It's the
   * `purpose: "api"` path, bounded by the token service's 5-minute mint cache
   * and single-flight refresh (a warm cache re-listing pays nothing), so the
   * cost is accepted/documented rather than engineered around here. A cheaper
   * probe would use `CredentialProvider.list` (a raw store read, no mint) to
   * answer the "is github connected" question discovery actually asks; that's
   * a follow-up seam, not new surface built in this wave.
   */
  /**
   * The host-wide `PolicyResolver` (action-policies plan, Task 3), or
   * `undefined` when no app `db` is wired (db-less tests keep the engine's
   * built-in risk→approval fallback, byte-identical to pre-policy behavior).
   * Built once and memoized — the resolver is session-agnostic.
   */
  /**
   * The plugin-store factory threaded onto every session's
   * `CreateSessionOptions.pluginStoreFactory` (plugin-store design). `call_tool`
   * calls it with a plugin action's `service` and binds the result to that
   * action's `PluginActionContext.pluginStore`, so an action reads and writes
   * only its own rows. Returns `undefined` without an app db (db-less tests),
   * so plugin actions then see no `pluginStore` — the pre-store behavior.
   */
  private getPluginStoreFactory(): ((pluginName: string) => PluginStore) | undefined {
    const db = this.opts.db;
    if (!db) return undefined;
    return (pluginName: string) => pluginStore(db, pluginName);
  }

  browserPolicy() {
    return this.opts.db ? createBrowserPolicy(this.opts.db, this.opts.engineStore, this.opts.blobs) : undefined;
  }

  private browserOptions(sessionId: string) {
    if (!this.opts.sandboxProvider.capabilities().browserAutomation || !this.opts.db) return {};
    return { browserPolicy: this.browserPolicy(), ...browserSessionHooks(sessionId, this.opts.engineStore, this.opts.blobs, pluginStore(this.opts.db, 'browser'), this.opts.sandboxProvider) };
  }

  private getPolicyResolver(): PolicyResolver | undefined {
    if (!this.opts.db) return undefined;
    if (!this.policyResolverInstance) {
      this.policyResolverInstance = buildPolicyResolver({
        db: this.opts.db,
        actionPluginByService: this.opts.actionPluginByService ?? new Map(),
      });
    }
    return this.policyResolverInstance;
  }

  private buildCredentialResolver(
    sessionId: string,
    userId: string,
    orgId: string,
    actingMember: boolean,
  ): ((owner: CredentialOwner, service: string) => Promise<StoredCredential | null>) | undefined {
    const tokenDeps = this.opts.githubTokenDeps;
    const db = this.opts.db;
    const credentials = this.opts.engineCredentials;
    const onePassword = this.opts.onePassword;
    if ((!tokenDeps || !db) && !onePassword) return undefined;
    return async (sessionOwner, service) => {
      // A legacy team session reads as the member prompting it; every other
      // session reads as the principal the engine hands over. The scope
      // follows the OWNER either way: a shared session never reaches the
      // frozen actor's personal vault.
      //
      // "The member prompting it" must still be a member. An
      // organization-audience Slack mention can make a person who is on no
      // team the actor of a team assistant turn
      // (`events/team-slack-gate.ts`), and their personal vault would then
      // back the team's tool calls for everyone in the channel. Such an
      // actor reads as the owning team instead. Checked live, per read, the
      // same contract `isTeamMember` holds everywhere else.
      let actsAsMember = actingMember;
      if (actsAsMember && sessionOwner.type === "team") {
        actsAsMember = db ? await isTeamMember(db, sessionOwner.id, userId) : false;
      }
      const owner: CredentialOwner = actsAsMember ? { type: "user", id: userId } : sessionOwner;
      const scopes = onePasswordScopesFor(actsAsMember ? undefined : owner.type, owner.type === "team" ? owner.id : undefined);
      if (service === GITHUB_INSTALLATION_CREDENTIAL_SERVICE) {
        // Explicit installation-tier request (github.list_repos with
        // `scope: "installation"`): mint the App installation token directly
        // instead of reusing whatever tier default `github` resolution
        // picked — a user token 403s on `GET /installation/repositories`.
        // `null` (no installation) stays `null`; the action names the
        // corrective step in its own error.
        if (!db || !tokenDeps) return null;
        const binding = await primaryRepoBinding(db, sessionId);
        const token = await resolveInstallationApiToken(
          {
            db,
            credentials,
            key: tokenDeps.key,
            apiUrl: tokenDeps.apiUrl,
            githubUrl: tokenDeps.githubUrl,
            fetchImpl: tokenDeps.fetchImpl,
            now: tokenDeps.now,
          },
          orgId,
          binding?.repo.owner,
        );
        return token === null ? null : { type: "app_install", accessToken: token };
      }
      if (service === "openai" && db) {
        // plugin-openai's key probe: org OpenAI LLM-provider key → stored
        // "openai" credential (owner-precedence + 1Password) → OPENAI_API_KEY
        // env. `null` keeps the openai tools hidden in list_tools
        // (requiresCredential gating). Without a db the generic read below
        // is the same call this branch used to make.
        return resolveOpenAiCredential(
          db,
          credentials,
          {
            orgId,
            owner,
            ...(owner.type === "user" ? { userId: owner.id } : {}),
            scopes,
            // The team read runs under the same policy a team workflow's
            // openai node reads with, so both reach the org-scoped item.
            orgFallback: orgFallbackPolicy(this.opts.plugins, "openai"),
          },
          process.env,
          onePassword,
        );
      }
      if (service === "github" && tokenDeps && db) {
        if (owner.type === "team") {
          // The team's own row first, direct or delegated, the way a
          // workflow tool node reads it (`plugins/action-invoker.ts`); the
          // App installation is the fallback behind it. `github` declares no
          // org credential, so the policy stops at the team row and the
          // org-scoped 1Password lookup. The sandbox git credential route
          // reads a team-owned workflow sandbox's row through the same
          // helper, so git and these tools agree.
          const teamRow = await usableTeamGithubRow(
            { credentials, onePassword },
            { orgId, teamId: owner.id, userId, scopes },
            orgFallbackPolicy(this.opts.plugins, "github"),
          );
          if (teamRow) return teamRow;
        }
        const binding = await primaryRepoBinding(db, sessionId);
        const resolved = await resolveSessionGitHubToken(
          {
            db,
            credentials,
            key: tokenDeps.key,
            apiUrl: tokenDeps.apiUrl,
            githubUrl: tokenDeps.githubUrl,
            fetchImpl: tokenDeps.fetchImpl,
            now: tokenDeps.now,
          },
          githubTokenArgsForOwner(owner, orgId, sessionId, binding?.repo),
        );
        // `purpose: "api"` throws (`GitHubAuthError`, with the connect hint)
        // rather than returning a null token; a null here would be a contract
        // violation upstream, so surface it as the same unconnected gap.
        if (resolved.token === null) {
          throw new GitHubAuthError(
            "no GitHub credential is available; connect your GitHub account or install the GitHub App for this organization",
          );
        }
        return { type: "oauth2", accessToken: resolved.token };
      }
      // Slack is not special-cased for ESCALATION any more: `plugin-slack`
      // declares `requires.orgCredential`, so `orgFallbackPolicy` reaches the
      // org row for it and for nothing that has not asked. What stays special
      // is the identity link, which the private-channel check needs — and
      // only a user-owned session has one person whose link can authorize it.
      const fallback = orgFallbackPolicy(this.opts.plugins, service);
      if (owner.type === "team") {
        return resolveTeamCredentialRead(
          { credentials, onePassword },
          { orgId, teamId: owner.id, userId, scopes },
          service,
          // The raw policy, not a clamp: "reference-only" lets the read
          // reach an org-scoped 1Password item by service name while still
          // refusing the org credential row (decision 5).
          fallback,
        );
      }
      if (owner.type === "org") {
        return resolveOrgCredentialRead(
          { credentials, onePassword },
          { orgId, userId, scopes },
          service,
        );
      }
      const stored = await resolveUserCredentialRead(
        { credentials, onePassword },
        { orgId, userId: owner.id, scopes },
        service,
        fallback,
      );
      if (service === "slack" && stored && db) return withSlackOwnerMetadata(db, owner.id, stored);
      return stored;
    };
  }

  /**
   * The primary repo's `.valet/credentials.yaml` declarations, or `[]`.
   *
   * Best-effort throughout, mirroring `resolveRepoPrebuildFlags`: no repo, no
   * token, a non-GitHub host or an unreadable file all yield no wrappers.
   * A session that cannot read a declaration still starts; it just leaves
   * the agent to name references itself, which is where it started.
   */
  private async resolveRepoCredentialCommands(
    meta: SessionMeta,
  ): Promise<import("./credential-commands.js").CredentialCommand[]> {
    const tokenDeps = this.opts.githubTokenDeps;
    const db = this.opts.db;
    if (!tokenDeps || !db) return [];
    try {
      // The shared target guard accepts both stored GitHub host spellings
      // (TKAI-385). A local copy once disabled credentials.yaml wrappers for
      // every DB-loaded session because it accepted only "github.com".
      const target = primaryGitHubRepoTarget(meta.repos);
      if (!target.ok) return [];
      const { owner, repo: repoName, ref } = target;
      const resolved = await resolveSessionGitHubToken(
        {
          db,
          credentials: this.opts.engineCredentials,
          key: tokenDeps.key,
          apiUrl: tokenDeps.apiUrl,
          githubUrl: tokenDeps.githubUrl,
          fetchImpl: tokenDeps.fetchImpl,
          now: tokenDeps.now,
        },
        { orgId: meta.orgId, purpose: "api" },
      );
      return await repoCredentialCommands(
        {
          db,
          credentials: this.opts.engineCredentials,
          key: tokenDeps.key,
          apiUrl: tokenDeps.apiUrl,
          githubUrl: tokenDeps.githubUrl,
          fetchImpl: tokenDeps.fetchImpl,
          now: tokenDeps.now,
        },
        resolved.token,
        owner,
        repoName,
        ref,
      );
    } catch (err) {
      console.error("EngineHost: reading .valet/credentials.yaml failed:", err);
      return [];
    }
  }

  /**
   * Resolve primary-repository runtime flags and saved resource defaults.
   * Failed reads leave existing resources unchanged. Fresh compute can use
   * available defaults; Docker and workspace storage remain YAML-only flags.
   */
  private async resolveRepoPrebuildFlags(sessionId: string, meta: SessionMeta): Promise<ResolvedRepoPrebuildFlags> {
    const primary = meta.repos?.[0];
    const resolved = await resolveRepoResources(this.opts.db, meta.orgId, primary, () => this.resolveRepoYamlFlags(sessionId, meta));
    // Only a repository declares the flag. With no primary binding there is
    // nothing to persist, and a workflow session has no row to write.
    if (primary && resolved.outcome !== "error" && this.opts.db) {
      await this.opts.db.update(agentSessions)
        .set({ kubernetes: resolved.kubernetes === true })
        .where(eq(agentSessions.id, sessionId));
    }
    const effective = resolved.outcome === "error"
      ? { ...resolved, kubernetes: meta.kubernetes === true }
      : resolved;
    const result = applySandboxResourceOverrides(effective, meta.sandboxResourceOverrides);
    if (primary) {
      const warningKey = `${meta.orgId}/${primary.host ?? "github"}/${primary.fullName}`;
      if (result.resourcesWithheld) {
        if (!this.resourceWithholdingWarnings.has(warningKey)) {
          console.warn(
            `EngineHost: sandbox resource settings for ${primary.fullName} are withheld from existing compute because YAML authority is unavailable. ` +
              "Valet will preserve live resources. Restore database and GitHub access, then retry reconciliation.",
          );
          this.resourceWithholdingWarnings.add(warningKey);
        }
      } else {
        this.resourceWithholdingWarnings.delete(warningKey);
      }
    }
    return result;
  }

  private async resolveRepoYamlFlags(sessionId: string, meta: SessionMeta): Promise<RepoPrebuildFlags> {
    const defaults: RepoPrebuildFlags = { docker: false, kubernetes: meta.kubernetes === true, outcome: "error" };
    const tokenDeps = this.opts.githubTokenDeps;
    const db = this.opts.db;
    if (!tokenDeps || !db) return defaults;
    try {
      const target = primaryGitHubRepoTarget(meta.repos);
      if (!target.ok) {
        if (target.reason === "non-github-host") {
          console.warn(
            `EngineHost: resolveRepoPrebuildFlags: session ${sessionId} primary repo host "${target.host}" is not GitHub — using default flags`,
          );
        }
        return { docker: false, kubernetes: false, outcome: "absent" };
      }
      const { owner, repo: repoName, ref } = target;
      const fullDeps = {
        db,
        credentials: this.opts.engineCredentials,
        key: tokenDeps.key,
        apiUrl: tokenDeps.apiUrl,
        githubUrl: tokenDeps.githubUrl,
        fetchImpl: tokenDeps.fetchImpl,
        now: tokenDeps.now,
      };
      const TIMEOUT_MS = 5_000;
      const timedOut = Symbol("timedOut");
      const controller = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<typeof timedOut>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve(timedOut);
          // Resolve the deadline first. Then abort and synchronously evict the
          // shared read before the next session can join it.
          controller.abort();
        }, TIMEOUT_MS);
        // Unref so the timer does not keep the process alive after all real work ends.
        if (timeoutId && typeof (timeoutId as NodeJS.Timeout).unref === "function") {
          (timeoutId as NodeJS.Timeout).unref();
        }
      });
      // Token resolution runs INSIDE the race: the installation-token mint is
      // a GitHub round trip too, and outside the race a blackholed GitHub
      // hung every session build unboundedly (TKAI-401).
      const work = (async (): Promise<RepoPrebuildFlags> => {
        let token: string | null = null;
        let degradedTokenless = false;
        try {
          const resolved = await resolveSessionGitHubToken(
            fullDeps,
            githubTokenArgsForOwner(
              credentialReadPrincipal(meta),
              meta.orgId,
              sessionId,
              { owner, name: repoName },
            ),
          );
          token = resolved.token;
        } catch (err) {
          // Only an AUTH failure degrades to a tokenless read (mirroring
          // `resolveApiTokenOrNull`): the contents read works unauthenticated
          // on a public repo. Anything else (DB fault, decrypt failure) is
          // not "no credential configured" — rethrow so the outer catch
          // records an uncached `error`.
          if (!(err instanceof GitHubAuthError)) throw err;
          degradedTokenless = true;
          console.warn(
            `EngineHost: resolveRepoPrebuildFlags: no GitHub token for session ${sessionId} (${err.message}) — attempting a tokenless read`,
          );
        }
        const { sha, flags } = await resolvedRepoPrebuildFlags(
          fullDeps, token, owner, repoName, ref, controller.signal,
        );
        const primary = meta.repos?.[0];
        if (primary && primary.resolvedRef !== sha) {
          const rows = await db.update(sessionRepos)
            .set({ resolvedRef: sha })
            .where(and(eq(sessionRepos.sessionId, sessionId), eq(sessionRepos.position, 0)))
            .returning({ resolvedRef: sessionRepos.resolvedRef });
          if (rows[0]?.resolvedRef !== sha) throw new Error("primary repo snapshot was not persisted");
          primary.resolvedRef = sha;
        }
        // A tokenless 404 on a PRIVATE repo reads as "absent" — but under a
        // degrade that is not a trustworthy repo answer (the authenticated
        // read may have found the file). Relabel it so the log/metric show a
        // failed resolution, not a missing file.
        if (degradedTokenless && flags.outcome === "absent") {
          return {
            docker: flags.docker,
            kubernetes: flags.kubernetes,
            ...(flags.workspaceStorage ? { workspaceStorage: flags.workspaceStorage } : {}),
            outcome: "error",
          };
        }
        return flags;
      })();
      const result = await Promise.race([work, timeoutPromise]).finally(() => clearTimeout(timeoutId));
      if (result === timedOut) {
        // Do not cache — a timeout is not a repo answer.
        console.error(
          `EngineHost: resolveRepoPrebuildFlags timed out for session ${sessionId}`,
        );
        recordPrebuildFlagsResolved("timeout");
        return defaults;
      }
      recordPrebuildFlagsResolved(result.outcome);
      return result;
    } catch (err) {
      console.error(
        `EngineHost: resolveRepoPrebuildFlags failed for session ${sessionId}:`,
        err instanceof Error ? err.message : String(err),
      );
      recordPrebuildFlagsResolved("error");
      return defaults;
    }
  }

  /**
   * Assembles the slash-command options for a session build (slash-commands
   * plan, Task 10; skills-as-commands plan, Task 4): `workspaceSkillsProvider`,
   * `commandContext`, `bareSkillNames`, and the plugin-command pair
   * (`pluginCommands` + `pluginCatalog`).
   *
   * `getSession` returns the built `Session` once it exists (parked in a local
   * by the caller, same pattern as `onStartRef`). The workspace-skills
   * provider's sandbox accessor uses it to reach `session.sandbox` — but ONLY
   * when the attachment is already `ready`, so listing commands never
   * provisions a sandbox. Repo prompt skills become readable once workspace
   * prep finishes; the host calls `session.refreshCommandRegistry()` on each
   * `ready` transition (see `trackHibernationWake`) so the registry picks them
   * up then.
   *
   * `hasPrep` (skills-as-commands plan, Task 4): the workspace-skills provider
   * is wired ONLY when the session has a prepared workspace (a `specProvider`
   * exists). Without prep, `/workspace/.valet/prompts` is meaningless — a
   * non-isolated, repo-less session (and every sandbox-less orchestrator) execs
   * against a workspace that no prep ever created — so the provider, and its
   * `===VALET-TMPL` scan on the `ready` refresh, must not fire. When `hasPrep`
   * is false, `workspaceSkillsProvider` is omitted and `refreshCommandRegistry`
   * runs an empty scan. DB-stored prompt skills still reach the session through
   * `sessionExtras` regardless of prep.
   *
   * `bareSkillNames` reads `orgs.bareSkillCommands` (Task 3): when the org sets
   * it, stored/repo skills also register under their bare name in addition to
   * the always-present `skill:<name>` entry.
   *
   * `pluginCommands` and `pluginCatalog` are wired TOGETHER from the SAME
   * `ActionPlugin[]` that backs the LLM `call_tool` tool (via
   * `pluginSessionExtras`) — a command entry resolves through the registry, and
   * its backing action runs against this catalog, so approval policy and arg
   * validation stay identical to the tool path. Wiring one without the other
   * makes every plugin command fail with "no plugin catalog is configured".
   *
   * No `commandRequestDecision` is supplied: a slash command is not a claimed
   * turn, so it cannot suspend one on a decision gate, and the host has no
   * synchronous approve path (approvals resolve asynchronously over REST).
   * An approval-requiring plugin command therefore denies by default (Task 7
   * behavior), which is the safe outcome until a command-scoped async approval
   * flow exists.
   *
   * Returns `undefined` when the host has no `db` (tests that don't wire one) —
   * the session then builds with no command providers, same as before.
   */
  /**
   * `hasPrep` gates the workspace-skills provider — see the doc block above.
   * Pass `true` only when the caller wired a `specProvider` for this build.
   */
  private async buildCommandOptions(
    orgId: string,
    sessionId: string,
    getSession: () => Session | undefined,
    hasPrep: boolean,
    pluginCatalog: PluginCatalog,
    owner: Principal,
  ): Promise<
    | {
        workspaceSkillsProvider?: () => Promise<SkillSource[]>;
        commandContext: CommandContext;
        bareSkillNames: boolean;
        pluginCommands: Array<{ pluginName: string; def: CommandDef }>;
        pluginCatalog: PluginCatalog;
      }
    | undefined
  > {
    const db = this.opts.db;
    if (!db) return undefined;

    // Task 3: moved bareSkillCommands to org level; read from orgs table.
    // (Was per-user users.bareSkillCommands — column removed in that task.)
    const bareRows = await db
      .select({ bareSkillCommands: orgs.bareSkillCommands })
      .from(orgs)
      .where(eq(orgs.id, orgId))
      .limit(1);
    const bareSkillNames = bareRows[0]?.bareSkillCommands ?? false;

    // Only a prepared workspace has a `/workspace/.valet/prompts` to scan; a
    // non-isolated repo-less session and every sandbox-less orchestrator have
    // none, so omit the provider (and its `===VALET-TMPL` exec) for them.
    const workspaceSkillsProvider = hasPrep
      ? makeWorkspaceSkillsProvider(() => {
          const session = getSession();
          // Only reach for the sandbox once it is provisioned — listing
          // commands must never trigger a cold start just to read repo prompts.
          if (!session || session.attachment.state !== "ready") return undefined;
          return session.sandbox as Sandbox;
        })
      : undefined;
    const commandContext = makeCommandContext(db, this.opts.engineCredentials, orgId, sessionId);

    const plugins = await this.filterEntitledPlugins(this.opts.plugins ?? [], owner, orgId);
    const pluginCommands = plugins.flatMap((p) =>
      (p.commands ?? []).map((def) => ({ pluginName: p.name, def })),
    );

    return {
      ...(workspaceSkillsProvider ? { workspaceSkillsProvider } : {}),
      commandContext,
      bareSkillNames,
      pluginCommands,
      pluginCatalog,
    };
  }

  /**
   * Builds the `repoInstructionsProvider` for a session build (agents-md
   * spec, decision 5). Wired only when the session has BOTH a prepared
   * workspace (`hasPrep`, same gate as `workspaceSkillsProvider`) and at
   * least one repo binding — a credential-only prep clones nothing, so
   * there is no AGENTS.md to scan. The sandbox accessor mirrors
   * `buildCommandOptions`: it reaches for the sandbox only once the
   * attachment is `ready`, so a refresh never provisions one.
   */
  private buildRepoInstructionsProvider(
    getSession: () => Session | undefined,
    repos: SessionMeta["repos"],
    hasPrep: boolean,
  ): (() => Promise<RepoInstructions | null>) | undefined {
    if (!hasPrep || !repos || repos.length === 0) return undefined;
    return makeRepoInstructionsProvider(() => {
      const session = getSession();
      if (!session || session.attachment.state !== "ready") return undefined;
      return session.sandbox as Sandbox;
    }, repos[0].targetDir);
  }

  /**
   * Mints a short-lived service JWT (`{ sub: userId, sid: sessionId }`) for
   * `POST /api/sessions/:id/sandbox-jwt` (Task 8, auth-v2 plan) — the same
   * master/derivation the sandbox's own `VALET_SANDBOX_JWT_SECRET` uses, so
   * a route-minted JWT and a sandbox-minted one verify against the same
   * secret.
   */
  mintSandboxJwtFor(sessionId: string, userId: string, ttlMs?: number): { token: string; expiresAt: number } {
    return mintSandboxJwt(this.resolveSandboxJwtMaster(), { sessionId, userId, ttlMs });
  }

  /**
   * The session kind stored on the app session row. Answers `"code"` (the
   * column default) when the host has no db handle or no row exists —
   * db-less builds never get the security wiring.
   */
  private async storedKind(sessionId: string): Promise<string> {
    const db = this.opts.db;
    if (!db) return "code";
    const rows = await db
      .select({ kind: agentSessions.kind })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1);
    return rows[0]?.kind ?? "code";
  }

  /**
   * The running security cell (if any) that claims this session id as its
   * dispatched child (Valet Security M4). The claim exists BEFORE the child
   * session is built — `dispatchCell` stamps `child_session_id` pre-spawn —
   * so both first builds and post-restart rebuilds see it. One indexed
   * query (`security_cells_child_session`); non-security sessions pay a
   * single miss. `null` without a db, the usual graceful degradation.
   */
  private async claimedSecurityCell(sessionId: string): Promise<SecurityCellRow | null> {
    const db = this.opts.db;
    if (!db) return null;
    const rows = await db
      .select()
      .from(securityCells)
      .where(and(eq(securityCells.childSessionId, sessionId), eq(securityCells.status, "running")))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The repo-defined role markdown for a claimed cell's persona (M-P2c). Reads
   * the cell's engagement `config_persona_markdown` map (id → markdown, stashed
   * at create from the clone) and returns the entry for the cell's persona.
   * Returns undefined for a bundled persona (no repo markdown), a preset-seeded
   * engagement (no map), or a persona the map does not name. `securityRolesForCell`
   * uses the result to attach a repo persona's own role, repo wins.
   */
  private async repoRoleMarkdownForCell(cell: SecurityCellRow): Promise<string | undefined> {
    const db = this.opts.db;
    if (!db) return undefined;
    const rows = await db
      .select({ md: securityEngagements.configPersonaMarkdown })
      .from(securityEngagements)
      .where(eq(securityEngagements.id, cell.engagementId))
      .limit(1);
    const raw = rows[0]?.md;
    if (!raw) return undefined;
    let map: unknown;
    try {
      map = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (typeof map !== "object" || map === null || Array.isArray(map)) return undefined;
    const value = (map as Record<string, unknown>)[cell.persona];
    return typeof value === "string" ? value : undefined;
  }

  /**
   * The declared-tool provisioning for a claimed persona cell (Valet Security
   * M-P4a + M-P4b). Reads the cell's engagement `config_tools` and
   * `authorized_scope`, then returns:
   *
   *   - `mcpPlugins`: a `ValetPlugin` per declared MCP server, added to the
   *     persona child's extra plugins so the child's tool set carries the
   *     server's tools (M-P4a). Reuses the config-connector MCP seam.
   *   - `scopeEnv`: the authorized-scope egress allowlist env
   *     (`VALET_SECURITY_AUTHORIZED_SCOPE`), merged into the child sandbox env.
   *     A live tool reads it to bound egress to the human-declared scope
   *     (M-P4b). Empty when no scope is declared.
   *
   * Egress gate: every declared egress host is re-validated against the
   * authorized scope here (the config parser already refused an out-of-scope
   * egress at create; this guards a stored/hand-edited row). An out-of-scope
   * egress is dropped with a warning — a live tool is never provisioned with
   * egress the human did not authorize.
   *
   * No db, or a non-security cell, yields empty provisioning.
   */
  private async securityProvisioningForCell(
    cell: SecurityCellRow,
  ): Promise<{ mcpPlugins: ValetPlugin[]; scopeEnv: Record<string, string> }> {
    const db = this.opts.db;
    if (!db) return { mcpPlugins: [], scopeEnv: {} };
    const rows = await db
      .select({
        tools: securityEngagements.configTools,
        scope: securityEngagements.authorizedScope,
      })
      .from(securityEngagements)
      .where(eq(securityEngagements.id, cell.engagementId))
      .limit(1);
    const row = rows[0];
    if (!row) return { mcpPlugins: [], scopeEnv: {} };
    const scopeHosts = parseAuthorizedScopeHosts(row.scope);
    const declared = parseConfigToolDecls(row.tools);
    // Egress gate (M-P4b): drop a decl's out-of-scope egress before provisioning.
    const violations = egressViolations(declared, scopeHosts);
    for (const v of violations) {
      console.warn(
        `security: declared tool "${v.toolId}" egress host "${v.host}" is outside the authorized scope ` +
          `for engagement ${cell.engagementId}; not provisioning that egress. Fix .valet/security.yml.`,
      );
    }
    const inScope = declared.map((decl) => {
      if (!decl.egress || decl.egress.length === 0) return decl;
      const kept = decl.egress.filter((host) => egressHostInScope(host, scopeHosts));
      return kept.length === decl.egress.length ? decl : { ...decl, egress: kept };
    });
    return {
      mcpPlugins: securityDeclaredMcpPlugins(inScope),
      scopeEnv: authorizedScopeEnv(scopeHosts),
    };
  }

  /**
   * The sandbox profile stored on the app session row. Answers `"headless"`
   * when the host has no db handle (tests that wire none) and when no row
   * exists yet, which is the column's own default.
   */
  private async storedProfile(sessionId: string): Promise<"headless" | "full"> {
    const db = this.opts.db;
    if (!db) return "headless";
    const rows = await db
      .select({ profile: agentSessions.profile })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1);
    return rows[0]?.profile ?? "headless";
  }

  /**
   * The app row's `credential_owner_mode`, for builds that do not receive
   * a `SessionMeta` (assistant sessions). No row, or no db, reads as
   * `owner`: a session with no row is new, and a new row is stamped
   * `owner` by every writer.
   */
  private async storedCredentialOwnerMode(sessionId: string): Promise<CredentialOwnerMode | null> {
    const db = this.opts.db;
    if (!db) return null;
    const rows = await db
      .select({ mode: agentSessions.credentialOwnerMode })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1);
    return rows[0]?.mode ?? null;
  }

  /**
   * Fire-and-forget prune of durable events belonging to submissions that
   * settled before the retention cutoff. Errors are logged, never thrown.
   */
  private pruneExpiredEvents(sessionId: string): void {
    const cutoff = Date.now() - EVENT_RETENTION_MS;
    void (async () => {
      try {
        const settled = await this.opts.engineStore.listSettledSubmissionsBefore(sessionId, cutoff);
        const ids = settled.map((i) => i.id);
        if (ids.length > 0) await this.opts.eventStream.prune(sessionId, ids);
      } catch (err) {
        console.error(`event retention prune failed for session ${sessionId}:`, err);
      }
    })();
  }

  /**
   * Resolve (or lazily create) the session of one assistant (Phase 4
   * decision 17, retargeted by the assistants design). Wakes instantly and
   * sandbox-less: the sandbox is a `SandboxCreateOpts` template, never a
   * pre-created/warm sandbox — cold attachment is an assistant's steady
   * state.
   *
   * Takes an assistant id, not a principal: a principal owns any number of
   * assistants, so only the id says which session is meant. Callers that
   * hold a principal go through `resolveDefaultAssistant`
   * (`assistants/service.ts`) first, which is the one place a principal
   * becomes an assistant.
   *
   * `CreateSessionOptions` is reconstructed from configuration on every
   * wake (persona, memory snapshot, tools, toolConfig), not from whatever
   * was persisted at creation time, per the orchestrator spec's "instant
   * wake" section — so a restored session gets a freshly-assembled snapshot
   * and today's journal, same as a brand-new one.
   */
  async assistantSessionFor(
    assistantId: string,
    meta: { actorUserId: string; orgId: string },
    opts?: {
      /** The assistant row's stored `session_id`. Callers holding the row
       * pass it so the STORED id stays authoritative — rows migrated from
       * `orchestrator_identities` keep their legacy `orchestrator:*`
       * session (and its history). Fresh rows store
       * `assistantSessionId(id)` at creation, so passing it is a no-op
       * there; omitted, the derived id is the fallback. */
      sessionId?: string;
      /** Explicit model spec for a first build, same `overrideId` cascade
       * slot `childSessionFor`/workflow session builds already expose via
       * their own `modelId` opt (model-selector-overhaul Task 9) — no
       * production caller passes this yet, but the slot stays consistent
       * across every session-build entry point. */
      modelId?: string;
    },
  ): Promise<Session> {
    const sessionId = opts?.sessionId ?? assistantSessionId(assistantId);
    this.assertSessionBuildAllowed(sessionId);
    const cached = this.cache.get(sessionId);
    if (cached) return cached.session;
    const pending = this.inflight.get(sessionId);
    if (pending) return pending;

    const epoch = this.buildEpoch.get(sessionId) ?? 0;
    const promise = this.buildAssistantSession(sessionId, assistantId, meta, epoch, 0, opts?.modelId).finally(() => {
      this.inflight.delete(sessionId);
    });
    this.inflight.set(sessionId, promise);
    return promise;
  }

  /** Team and organization display names are workspace configuration. */
  private outboundSenderResolver(orgId: string, owner: Principal) {
    const db = this.opts.db;
    return db ? () => workspaceSenderIdentity(db, orgId, owner) : undefined;
  }

  private async buildAssistantSession(
    sessionId: string,
    assistantId: string,
    meta: { actorUserId: string; orgId: string },
    epoch: number,
    attempt: number,
    overrideId?: string,
  ): Promise<Session> {
    if (!this.opts.db) {
      throw new Error("EngineHost: assistantSessionFor requires opts.db");
    }
    if (!this.opts.apiBaseUrl) {
      throw new Error("EngineHost: assistantSessionFor requires opts.apiBaseUrl");
    }
    const db = this.opts.db;
    const apiBaseUrl = this.opts.apiBaseUrl;

    const assistant = await loadAssistant(db, assistantId);
    if (!assistant) {
      throw new Error(
        `EngineHost: no workspace assistant ${assistantId}. Resolve its owner with resolveDefaultAssistant before waking its session.`,
      );
    }
    // A retired/archived assistant must not wake (TKAI-296). Every
    // resurrect path funnels through this build — a message POST on the
    // soft-deleted session, a stale channel gate card, a workflow receipt
    // — and a rebuild would run a ghost session in parallel with the
    // owner's next default.
    if (assistant.archivedAt !== null) {
      throw new ArchivedAssistantError();
    }
    // The OWNER, not the assistant: memory, journal and skills belong to the
    // principal. The runtime keeps its own working directory.
    const principal: Principal = { type: assistant.ownerType, id: assistant.ownerId };

    const workspace = join(homedir(), ".valet", "assistants", assistantId);
    await mkdir(workspace, { recursive: true });

    const scope: MemoryScope = { owner: principal, actorUserId: meta.actorUserId };
    await ensureTodayJournal(db, scope);
    const snapshotContent = await assembleMemorySnapshot(db, scope);
    const personaPrefix = await this.resolvePersonaPrefix(db, scope);
    // The owner's human name, so the persona names the team/org instead of its
    // raw id (the "team_<uuid>" leak). A missing row falls back to a neutral
    // phrase inside the persona.
    let ownerDisplayName: string | undefined;
    if (principal.type === "team") {
      const rows = await db.select({ name: teams.name }).from(teams).where(eq(teams.id, principal.id)).limit(1);
      ownerDisplayName = rows[0]?.name;
    } else if (principal.type === "org") {
      const rows = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, principal.id)).limit(1);
      ownerDisplayName = rows[0]?.name;
    }

    const existing = await this.opts.engineStore.getSession(sessionId);
    // A team/org assistant session is SHARED: whoever happens to wake it
    // first is not its owner, so their personal default must not persist
    // onto every other member — only a user-principal assistant reads the
    // actor's own default (TKAI-255 review round).
    const { model, spec: modelSpec } = await this.resolveModelForBuild(existing, meta.orgId, {
      userId: principal.type === "user" ? principal.id : undefined,
      overrideId,
      ownerTeamId: principal.type === "team" ? principal.id : undefined,
    });
    const reasoning = await this.resolveReasoningForBuild(existing, meta.orgId, {
      userId: principal.type === "user" ? principal.id : undefined,
      ownerTeamId: principal.type === "team" ? principal.id : undefined,
    });
    const queueMode: "steer" | "followup" = principal.type === "user" ? "steer" : "followup";
    // `principal`, not `meta.actorUserId`: an assistant session belongs to
    // the principal and is shared by everyone who can reach it, exactly like
    // the memory snapshot this method assembles from `scope.owner`. Scoping
    // to the actor instead would put whoever woke a team assistant's
    // personal skills in front of every other member of that team.
    //
    // Pins go to a USER-owned assistant only. A team assistant's session is
    // cached on the assistant id, and `sessionOptions.userId` below freezes
    // to the FIRST person who woke it. `workflows.patch_workflow` authorizes
    // on that frozen `userId`, which reaches that person's own workflows and
    // every team they belong to. So a pinned save tool in a team assistant
    // would let the second member drive the first member's principal. The
    // team editor uses the scoped workflow action catalog.
    const pins = principal.type === "user" ? PINNED_ACTIONS : [];
    const extras = await this.sessionExtras(
      principal,
      meta.orgId,
      pins,
      [],
      buildMemoryTools().map((tool) => tool.name),
    );

    // The profile comes from the app row, not from the caller's meta. An
    // assistant session is woken by many callers — the web, a channel
    // message, a workflow — and the first one to touch it decides the
    // cached build. Only one of them holds the app row, so reading the row
    // here is what makes "Terminal and VS Code are on for this assistant"
    // survive a wake from Slack. No row (an assistant woken before its
    // first web visit) means headless, the same value the column defaults
    // to. See `PATCH /api/sessions/:id`.
    const profile = await this.storedProfile(sessionId);
    const sandboxMint = await this.mintSandboxEnv(sessionId, meta.actorUserId, meta.orgId, profile);
    // Same row read as the profile: a team assistant from before team-owner
    // resolution keeps reading credentials as the member prompting it.
    const credentialOwnerMode = await this.storedCredentialOwnerMode(sessionId);
    const credentialResolver = this.buildCredentialResolver(
      sessionId,
      meta.actorUserId,
      meta.orgId,
      resolvesAsActingMember({ ownerType: principal.type, credentialOwnerMode }),
    );
    // Slash-command options: same wiring as the interactive path, so the
    // orchestrator answers /model and /sessions instead of the no-context
    // fallback. The getter closes over `builtSession`, assigned below.
    // Orchestrators are sandbox-less (no specProvider), so `hasPrep` is false —
    // no `/workspace/.valet/prompts` scan. `bareSkillNames` comes from the org
    // row; DB-stored skills reach the orchestrator through `sessionExtras`,
    // scoped by the principal (skills-as-commands plan, Task 4).
    let builtSession: Session | undefined;
    const commandOptions = await this.buildCommandOptions(
      meta.orgId,
      sessionId,
      () => builtSession,
      false,
      extras.pluginCatalog,
      principal,
    );
    const policyResolver = this.getPolicyResolver();
    const pluginStoreFactory = this.getPluginStoreFactory();
    const skillsProvider = this.skillsProviderFor(principal, meta.orgId);
    const resolveOutboundSender = this.outboundSenderResolver(meta.orgId, principal);
    const sessionOptions = {
      userId: meta.actorUserId,
      orgId: meta.orgId,
      workspace,
      purpose: "orchestrator" as const,
      ...(credentialResolver ? { credentialResolver } : {}),
      ...(policyResolver ? { policyResolver } : {}),
      ...(pluginStoreFactory ? { pluginStoreFactory } : {}),
      ...this.browserOptions(sessionId),
      extractDocument: extractDocumentText,
            ...(this.opts.db ? { skillTelemetry: skillTelemetrySink(this.opts.db, meta.orgId) } : {}),
      ...(resolveOutboundSender ? { resolveOutboundSender } : {}),
      owner: principal,
      queueMode,
      sandbox: {
        browser: { enabled: this.opts.sandboxProvider.capabilities().browserAutomation === true, viewer: true },
        workspace,
        // Single-lineage stock default, the same fall-through a REST-created
        // session and a child both use. This path pinned `defaultImage`,
        // which is the wrong image for a `full` assistant: `/start-full.sh`
        // is baked into the full lineage only.
        image: this.opts.defaultImages?.full ?? this.opts.defaultImage,
        env: sandboxMint?.env,
        profile,
        ...(sandboxMint ? { credsFiles: sandboxMint.credsFiles } : {}),
      },
      model,
      modelSpec,
      resolveModel: this.makeResolveModel(meta.orgId),
      ...(reasoning !== undefined && isReasoningLevel(reasoning) ? { sampling: { reasoning } } : {}),
      systemPrompt: personaPrefix + orchestratorPersona(principal, ownerDisplayName),
      threadSystemContext: workflowEditorThreadContext,
      tools: [...buildMemoryTools(), ...extras.tools],
      skills: extras.skills.length ? extras.skills : undefined,
      roles: extras.roles.length ? extras.roles : undefined,
      // The orchestrator lives in the host cache indefinitely, so this
      // refresh seam is what lets skills created after its first wake show
      // up in its slash-command list.
      ...(skillsProvider ? { skillsProvider } : {}),
      toolConfig: {
        apiBaseUrl,
        internalToken: internalToken(),
        ...(this.opts.childSpawner ? { childSpawner: this.opts.childSpawner } : {}),
        ...(this.opts.childReader ? { childReader: this.opts.childReader } : {}),
        ...(this.opts.childSender ? { childSender: this.opts.childSender } : {}),
        ...(this.opts.childStatusReader ? { childStatusReader: this.opts.childStatusReader } : {}),
      },
      // Assembled once, here, at wake time — not per-turn. This snapshot is
      // frozen for the cached session's lifetime; the only way to see a
      // fresher snapshot is a cache eviction (session destroy/restart),
      // which forces the next `assistantSessionFor` call back through
      // this method to reassemble it.
      systemContext: [{ name: "memory-snapshot", content: snapshotContent, order: 10 }],
      compactionHooks: [journalCompactionHook(db, scope)],
      // Orchestrator sessions are sandbox-less by default (orchestrator
      // spec, "Sandbox-less by default"): the sandbox must provision only
      // when a turn actually touches the filesystem, via the lazy
      // PolicySandbox attachment's first-touch contract — never a
      // proactive warm-on-claim kick just because a turn was claimed.
      warmSandboxOnClaim: false,
      ...(commandOptions ?? {}),
    };

    const engine = new Engine({
      providers: {
        store: this.opts.engineStore,
        stream: this.opts.eventStream,
        credentials: this.opts.engineCredentials,
        sandboxProvider: this.opts.sandboxProvider,
        blobs: this.opts.blobs,
      },
    });

    const session = existing
      ? await engine.restoreSession({ sessionId, options: sessionOptions })
      : await engine.createSession({ id: sessionId, ...sessionOptions });

    const epochNow = this.buildEpoch.get(sessionId) ?? 0;
    if (epochNow !== epoch && attempt < 2) {
      // A config PATCH evicted the cache while this build was between its
      // row read and here: the instance in hand was assembled from the
      // pre-PATCH row. Suspend its timers (they would root it forever, see
      // evictCache) and rebuild from the current row. CAPPED at two retries:
      // each rebuild replays the session's durable history, so a caller
      // PATCHing faster than one build must not livelock the wake. Past the
      // cap the build in hand is served and cached, and the epoch check
      // below drops it again if writes are still arriving — bounded
      // staleness instead of unbounded rebuild.
      session.suspendTimers();
      return this.buildAssistantSession(sessionId, assistantId, meta, epochNow, attempt + 1, overrideId);
    }
    builtSession = session;

    this.cache.set(sessionId, { engine, session });
    this.trackHibernationWake(sessionId, session);
    if (existing) this.pruneExpiredEvents(sessionId);

    if (epochNow !== epoch) {
      // Retry cap reached with the epoch still moving: serve this wake on
      // the (at most one-PATCH-stale) build, but don't let it outlive the
      // churn — dropping the cache entry makes the NEXT wake rebuild fresh.
      console.warn(
        `EngineHost: assistant ${assistantId} was patched ${attempt + 1}x during one build; ` +
          `serving the last build uncached`,
      );
      this.evictCache(sessionId);
    }

    return session;
  }

  /** Only the owner's memory supplies persona text; team read unions do not apply. */
  private async resolvePersonaPrefix(db: AppDb, scope: MemoryScope): Promise<string> {
    const row = await readOwnFile(db, scope, "assistant/personality.md");
    return personaPrefixText(row?.content ?? "");
  }

  /** The shared per-process EventStream. Engine sessions and WS handlers fan out through this one instance. */
  eventStream(): EventStream {
    return this.opts.eventStream;
  }

  /**
   * Tear down a single session: destroy engine + sandbox, drop the cache
   * entry, and revoke the session's live sandbox tokens (Task 8, auth-v2
   * plan) — a stopped session's sandbox must not be able to keep calling
   * back into the API with a token minted for a build that no longer
   * exists.
   */
  async destroy(sessionId: string): Promise<void> {
    const pending = this.teardown.get(sessionId);
    if (pending) return pending;
    // Invalidate cold wakes that are still doing lookups before registering a
    // build. New requests are blocked until this teardown finishes.
    this.lifecycleEpoch.set(sessionId, (this.lifecycleEpoch.get(sessionId) ?? 0) + 1);
    const promise = this.destroySession(sessionId).finally(() => this.teardown.delete(sessionId));
    this.teardown.set(sessionId, promise);
    return promise;
  }

  private async destroySession(sessionId: string): Promise<void> {
    // A build can still be inserting its token. Settle it before revocation,
    // including failed builds that may have written only part of their state.
    await this.inflight.get(sessionId)?.catch(() => undefined);
    const entry = this.cache.get(sessionId);
    // Existing browser state keeps its audit obligation after allocation is disabled.
    if (entry && !entry.session.options.sandboxLifecycle) {
      const rows = await this.opts.sandboxProvider.list?.() ?? [];
      for (const row of rows.filter((value) => value.sessionId === sessionId && value.browserEnabled)) {
        await this.stopBrowserBefore(row.id, 'destroy');
      }
    }
    if (!entry) {
      await this.destroyRetainedBrowserSandboxes(sessionId);
      // Cold session: nothing cached in this process, but every caller of
      // destroy() means "this session is being deleted", and the durable
      // engine rows and live grants/tokens must not outlive that. The
      // sandbox, if one exists, is reclaimed by the reconcile sweep — its
      // orphan rule keys on the engine session row being gone, which is
      // exactly what this delete produces.
      await this.opts.engineStore.deleteSession(sessionId);
      if (this.opts.db) {
        await revokeSandboxTokens(this.opts.db, sessionId);
        try {
          await revokeSessionGrants(this.opts.db, sessionId);
        } catch (err) {
          console.error(`EngineHost: revoking session grants for ${sessionId} failed:`, err);
        }
      }
      return;
    }
    try {
      // Replacement drops its attachment handle before it releases compute.
      // Final deletion also owns any browser state that remains in inventory.
      await entry.session.destroy(() => this.destroyRetainedBrowserSandboxes(sessionId));
    } finally {
      this.cache.delete(sessionId);
      this.buildEpoch.delete(sessionId);
      if (this.opts.db) {
        await revokeSandboxTokens(this.opts.db, sessionId);
        // Grant expiry (action-policies plan, Task 3): a stopped session's
        // runtime grants must not survive to quiet a future action on a
        // rebuilt session reusing the same id. Idempotent (guarded on
        // `revoked_at IS NULL`); best-effort — a failure here must not mask
        // the destroy, so it's logged, not thrown.
        try {
          await revokeSessionGrants(this.opts.db, sessionId);
        } catch (err) {
          console.error(`EngineHost: revoking session grants for ${sessionId} failed:`, err);
        }
      }
    }
  }

  private async destroyRetainedBrowserSandboxes(sessionId: string): Promise<void> {
    const rows = await this.opts.sandboxProvider.list?.() ?? [];
    for (const row of rows.filter((value) => value.sessionId === sessionId && (value.browserEnabled ?? this.opts.sandboxProvider.capabilities().browserAutomation))) {
      await this.destroySandbox(row.id);
    }
  }

  /**
   * Drop a session's in-process cache entry WITHOUT tearing down engine
   * state — unlike `destroy()`, this never calls `session.destroy()` (which
   * deletes the underlying engine session row via
   * `SessionStore.deleteSession`). Used when an identity/persona change
   * needs picking up on the next wake (PATCH /api/orchestrator/info,
   * decision 4/5): the next `assistantSessionFor` call misses the cache
   * and rebuilds `systemPrompt`/`systemContext` from current configuration,
   * restoring the same durable session (same transcript) rather than
   * creating a new one. Safe to call on an id that isn't cached — no-op.
   *
   * Calls `session.suspendTimers()` before dropping the cache entry: the
   * evicted `Session` would otherwise be rooted forever by its two
   * unref'd intervals (heartbeat 10s, sweep 5s — each interval closure
   * captures `this`), permanently leaking the object and continuing to
   * sweep/heartbeat against the store even though nothing references it
   * through the cache anymore. `unref()` only keeps the *process* from
   * staying alive on these timers; it does nothing to stop them from
   * keeping this *object* alive or from continuing to fire. Suspending
   * them first means the evicted instance is a normal orphan, collected
   * once its last reference (this method's local `entry`) goes away.
   */
  evictCache(sessionId: string): void {
    // Invalidate any in-flight build too: it read the row before this
    // eviction's cause committed, and would otherwise re-populate the cache
    // with the stale config (`buildAssistantSession` checks the epoch before
    // its `cache.set`).
    this.buildEpoch.set(sessionId, (this.buildEpoch.get(sessionId) ?? 0) + 1);
    this.cache.get(sessionId)?.session.suspendTimers();
    this.cache.delete(sessionId);
  }

  /**
   * Evict every cached session WITHOUT touching durable state — the
   * process-shutdown path. `Session.destroy()` calls
   * `store.deleteSession()`, so a shutdown that "destroys" live sessions
   * erases their threads/queue items/history; kill-mid-turn recovery
   * (reconciliation on next boot) is the designed restart story, and it
   * needs those rows. Sandboxes are left as-is — the workspace survives,
   * the sandbox is disposable (Phase 3), and the next boot re-attaches or
   * re-provisions.
   */
  evictAll(): void {
    for (const id of [...this.cache.keys()]) this.evictCache(id);
    this.clearSweepInterval();
  }

  /** Shared by `evictAll()`/`destroyAll()` — both are terminal, whole-host
   * teardown paths and neither should leave the sweep `setInterval` running
   * against an emptied cache. */
  private clearSweepInterval(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
  }

  /**
   * Tear down every live session INCLUDING their durable rows
   * (`store.deleteSession`). NOT for shutdown handlers — that's
   * `evictAll()`. Kept for tests and true delete-everything flows.
   */
  async destroyAll(): Promise<void> {
    const ids = [...this.cache.keys()];
    await Promise.allSettled(ids.map((id) => this.destroy(id)));
    this.clearSweepInterval();
  }

  /** True if a session is currently cached in this process. */
  isLive(sessionId: string): boolean {
    return this.cache.has(sessionId);
  }

  /**
   * Cached OR currently mid-build (`inflight`). The stranded-session
   * sweep's jurisdiction test: a session being restored right now is not
   * yet in the cache, but suspending its sandbox out from under the build
   * would hand the new attachment a scaled-down pod — mid-build counts as
   * live.
   */
  sessionLiveOrBuilding(sessionId: string): boolean {
    return this.cache.has(sessionId) || this.inflight.has(sessionId);
  }

  /**
   * Flip a `hibernated` row back to `active` because the session is about
   * to be USED — a prompt, a channel delivery, a child_send, an explicit
   * open. Callers at those intent points invoke this after materializing
   * the session; read-only paths (GET messages, WS attach, gateway
   * proxying) must NOT — a view of a hibernated session is not a wake,
   * and flipping the row on views would un-park suspended sandboxes from
   * the reaper's retention indefinitely. Chat-only wakes never make a
   * `ready` attachment transition, so neither `onWake` nor
   * `onSessionReady` would fire for them — this is their heal path.
   * Awaited (unlike the attachment-transition hooks) so a caller that
   * immediately re-stamps status — the pause route — cannot be reordered
   * against it. Guarded no-op for rows in any other status.
   */
  async markSessionUsed(sessionId: string): Promise<void> {
    if (!this.opts.onWake) return;
    try {
      await this.opts.onWake(sessionId);
    } catch (err) {
      console.error(`EngineHost: markSessionUsed failed for session ${sessionId}:`, err);
    }
  }

  /** The cached session's org, or null when uncached — the capacity
   * gate's org-resolution seam (`gated-sandbox-provider.ts`). A
   * provisioning attachment always belongs to a cached session, so a null
   * here means the create did not come from a session at all. */
  sessionOrgId(sessionId: string): string | null {
    return this.cache.get(sessionId)?.session.options.orgId ?? null;
  }

  /**
   * How many cached sessions of this org hold (or are building) a live
   * sandbox: attachment `provisioning` or `ready`. The capacity gate
   * subtracts its own waiters from this count — their attachments already
   * read `provisioning` while they hold no pod — so an admitted create
   * stays counted through provider.create AND the post-create prep window
   * (a live pod is never invisible to the gate). `suspended` is excluded
   * because a suspended sandbox holds no pod; `error` frees the slot.
   */
  countLiveSandboxSessions(orgId: string): number {
    let count = 0;
    for (const entry of this.cache.values()) {
      if (entry.session.options.orgId !== orgId) continue;
      const state = entry.session.attachment.state;
      if (state === "provisioning" || state === "ready") count += 1;
    }
    return count;
  }

  /**
   * Stamps `sessionId`'s last-gateway-touch time to `Date.now()` (final-
   * review fix wave, hibernation arc). Called by `routes/gateway-proxy.ts`
   * at the cheapest correct points that prove a human is actively using the
   * "full"-profile Terminal/VS Code tab: HTTP proxy entry (every request),
   * WS `onOpen` (connection established), and WS client-to-backend
   * `onMessage` (keystrokes/input) — deliberately NOT every backend-to-
   * client frame, which would count idle terminal output/heartbeats as
   * activity. A plain `Map.set` — cheap enough to call unconditionally,
   * including per WS message. Never evicted/pruned: a stale entry for a
   * long-gone session is a few bytes in a `Map` and is harmless, since
   * `maybeSuspendIdleSession` only ever reads it for sessions currently in
   * `this.cache`.
   */
  touchGatewayActivity(sessionId: string): void {
    this.gatewayTouch.set(sessionId, Date.now());
  }

  /**
   * The live in-memory Session for an id, or null if not cached. Unlike
   * `sessionFor`, this never builds/restores — callers use it to act on a
   * session's in-process state (GateManager waiters, running items) that only
   * exists while the session is live.
   */
  liveSession(sessionId: string): Session | null {
    return this.cache.get(sessionId)?.session ?? null;
  }

  /**
   * Whether the sandbox backend can suspend/resume (hibernation). The
   * child retention path consults this at settle time: capable backends
   * park a settled child's sandbox for later revival; the rest destroy it
   * eagerly, exactly as before retention existed.
   */
  sandboxHibernationCapable(): boolean {
    return this.opts.sandboxProvider.capabilities().hibernation;
  }

  /**
   * Destroy one sandbox by its provider id, without touching any session
   * state. The child retention sweep uses this for a parked child whose
   * session is no longer cached (an api restart evicted it) — the
   * `child_watches.parkedSandboxId` recorded at park time is the only
   * remaining handle.
   */
  async destroySandbox(sandboxId: string): Promise<void> {
    await this.stopBrowserBefore(sandboxId, 'destroy');
    await this.opts.sandboxProvider.destroy(sandboxId);
  }

  private async stopBrowserBefore(sandboxId: string, reason: 'destroy' | 'suspend'): Promise<void> {
    await prepareBrowserSandboxStop(this.opts.sandboxProvider, sandboxId, reason, this.opts.engineStore, this.opts.blobs, this.opts.db ? pluginStore(this.opts.db, 'browser') : undefined);
  }

  /**
   * Suspend one sandbox by its provider id, without touching any session
   * state. The stranded-session sweep (`idle-hibernation-sweep.ts`) uses
   * this for an idle ACTIVE session an api restart evicted from the cache
   * — there is no live attachment to call `suspend()` on. Throws when the
   * backend has no hibernation seam; callers gate on
   * `sandboxHibernationCapable()` first.
   */
  async suspendSandbox(sandboxId: string): Promise<void> {
    const suspend = this.opts.sandboxProvider.suspend;
    if (!suspend) {
      throw new Error(
        `EngineHost.suspendSandbox: the ${this.opts.sandboxProvider.backend} backend has no suspend seam. ` +
          "Gate callers on sandboxHibernationCapable().",
      );
    }
    await this.stopBrowserBefore(sandboxId, 'suspend');
    await suspend.call(this.opts.sandboxProvider, sandboxId);
  }

  /** The provider's view of one sandbox — `state: "released"` means the
   * backing resource does not exist. */
  async sandboxStatus(sandboxId: string): Promise<SandboxStatus> {
    return this.opts.sandboxProvider.status(sandboxId);
  }

  /** Recompute the sandbox id a workspace would provision under
   * (`SandboxProvider.deriveId`); null for backend-assigned ids. */
  deriveSandboxId(sessionKey: string): string | null {
    return this.opts.sandboxProvider.deriveId?.(sessionKey) ?? null;
  }

  /**
   * Verify a cited `file` against a session's cloned sandbox (Valet Security
   * guardrail 4, finding location verification). The finding-report route calls
   * this BEFORE the service so a persona cell cannot cite a path or line that is
   * not in the reviewed tree.
   *
   * Return shape:
   *   - `null` (INDETERMINATE) → the caller MUST fail OPEN (accept the finding).
   *     Returned when the session is not cached, its attachment is not `ready`,
   *     it has no repo clone (the clone root is unknown), or the sandbox read
   *     throws/times out. A sandbox hiccup must NEVER block a real finding.
   *   - `{ exists, lines }` → the read succeeded. `exists:false` is a CONFIRMED
   *     absent file (fail CLOSED). `lines` is the exact line count of an
   *     existing file, so the caller can reject an out-of-range cited line.
   *
   * This method NEVER throws — every failure path resolves to `null`.
   *
   * It reaches the sandbox WITHOUT waking it: `liveSession` reads the in-memory
   * cache only (never `sessionFor`, which would build/restore), and it acts only
   * when the attachment is already `ready` — the same non-waking discipline the
   * `child_status` liveness path and the command/AGENTS.md providers use.
   *
   * The clone root is the session's primary `session_repos` binding target dir,
   * relative to the sandbox workspace root. A finding `file` is repo-relative, so
   * the in-sandbox path is `<targetDir>/<file>`, passed as a WORKSPACE-RELATIVE
   * path to `Sandbox.stat`/`readFile`. A relative path is the one cross-backend
   * contract (workspace-prep's path-discipline note): it resolves against the
   * sandbox workspace root for docker, local, and virtual alike. The path never
   * enters a shell command, so there is no injection surface — `stat`/`readFile`
   * take the path as a value, not an argv.
   */
  async readSandboxFileMeta(
    sessionId: string,
    repoRelPath: string,
  ): Promise<{ exists: boolean; lines: number } | null> {
    try {
      // Non-waking: cache-only. A session that is not live (evicted, never
      // built) is indeterminate — never force a build just to verify.
      const session = this.liveSession(sessionId);
      if (!session || session.attachment.state !== "ready") return null;
      if (!this.opts.db) return null;

      // Only an ISOLATED provider performs a real clone into a real tree
      // (`buildSpecProvider` gates prep on isolation). A non-isolated provider
      // (local/virtual) execs against the host or an empty in-memory FS, so its
      // tree is not the reviewed clone — indeterminate, fail open. This also
      // keeps the guard off the virtual-sandbox integration harness, whose
      // findings cite files no `git clone` ever materialized.
      if (this.opts.sandboxProvider.capabilities().isolated !== true) return null;

      // Clone root = the primary binding's target dir, relative to the sandbox
      // workspace root. No binding → non-git/virtual workspace, clone root
      // unknown → indeterminate.
      const bindingRows = await this.opts.db
        .select({ targetDir: sessionRepos.targetDir })
        .from(sessionRepos)
        .where(eq(sessionRepos.sessionId, sessionId))
        .orderBy(sessionRepos.position)
        .limit(1);
      const binding = bindingRows[0];
      if (!binding) return null;

      // The pure read (existence + line count). A thrown transport/exec error
      // bubbles to the outer catch and fails open; a CONFIRMED-absent file
      // returns `{exists:false}` and fails closed.
      return await verifyFileInSandbox(session.sandbox, binding.targetDir, repoRelPath);
    } catch {
      // ANY unexpected failure (exec/read transport error, timeout, provider
      // hiccup) → indeterminate → the caller fails OPEN. Never throw.
      return null;
    }
  }

  /**
   * The host `resolveModel` seam (engine `ResolvedModel`, Task 1) bound to one
   * org's provider config — passed into every `createSession`/`restoreSession`
   * options object so the engine resolves the effective model spec + per-turn
   * API key through the org catalog on every turn. Built per session build,
   * capturing `orgId`; keys are read fresh on each call (never cached) so a
   * rotated org credential applies on the next turn.
   */
  private makeResolveModel(orgId: string): (spec: string) => Promise<ResolvedModel | null> {
    return (spec: string) => resolveModelSpec(this.opts.db, this.opts.engineCredentials, orgId, spec);
  }

  /**
   * Resolve a model spec to a concrete `Model` for `options.model` at build
   * time, via the same catalog-aware bridge the per-turn seam uses. A `null`
   * return means the spec names no known model — surfaced as an error so a
   * session never silently boots on the wrong model.
   */
  private async resolveModelObject(orgId: string, spec: string): Promise<BuildModel> {
    // Session builds need the model OBJECT plus the canonical spec the
    // session should persist (`CreateSessionOptions.modelSpec` — the wire
    // `model.id` may differ for namespaced specs). NoCredentialsError means
    // the spec is valid but no key exists yet — accept via the attached
    // model so a keyless org can still open sessions (turns get the
    // engine's bounded credential-release path instead of a failed build).
    let resolved: ResolvedModel | null;
    try {
      resolved = await resolveModelSpec(this.opts.db, this.opts.engineCredentials, orgId, spec);
    } catch (err) {
      if (err instanceof NoCredentialsError) return { model: err.model, spec };
      throw err;
    }
    if (!resolved) {
      // A tier token (xs/s/m/l/xl) failing here means every one of the
      // tier's targets is inactive (`resolveTier` found no active
      // provider) — a distinct, actionable case from a genuinely unknown
      // model id, and one an admin can fix without redeploying anything.
      if (TIER_SET.has(spec.trim().toLowerCase())) {
        throw new Error(
          `EngineHost: no active provider for tier "${spec}" — enable a provider for one of its ` +
            `targets in Settings → Organization → Models.`,
        );
      }
      throw new Error(`EngineHost: unknown model "${spec}" — not in the org catalog or pi-ai registry`);
    }
    return { model: resolved.model, spec: resolved.canonicalId ?? resolved.model.id };
  }

  /**
   * The first entry of `prefs` whose provider is active, or `undefined`.
   * Used by the team tier of the cascade — a team default is imposed on
   * people who did not pick it, so it must fall through past an inactive
   * provider instead of failing every member's build (llm-providers design
   * decision 6). Only the user's own explicit default resolves straight
   * through and fails loudly.
   */
  private async firstActivePreference(orgId: string, prefs: string[]): Promise<string | undefined> {
    if (!this.opts.db || prefs.length === 0) return undefined;
    const rows = await listLlmProviders(this.opts.db, orgId);
    for (const pref of prefs) {
      const { namespace } = parseModelId(pref);
      const row = rows.find((r) => providerNamespace(r) === namespace);
      let active: boolean;
      if (!row) {
        active = namespace === "anthropic" || namespace === "openai" || namespace === "google";
      } else if (row.kind === "openai_compatible") {
        active = row.enabled && (await hasOrgKey(this.opts.engineCredentials, orgId, row.id));
      } else {
        active = row.enabled;
      }
      if (active) return pref;
    }
    return undefined;
  }

  /**
   * `users.default_model` for `userId`, or `undefined` if unset or the host
   * has no `db` (only `assistantSessionFor` requires `db`; the other
   * builders degrade gracefully to the hardcoded default when it's absent,
   * e.g. in tests that don't wire one up). Deliberately uncached — split-
   * settings decision 9 requires a settings change to apply on the very next
   * session build, not after some TTL.
   */
  private async userDefaultModel(userId: string): Promise<string | undefined> {
    if (!this.opts.db) return undefined;
    const rows = await this.opts.db
      .select({ defaultModel: users.defaultModel })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0]?.defaultModel ?? undefined;
  }

  /**
   * `teams.default_model` for the team that owns the session being built,
   * filtered through the same active-provider walk `firstActivePreference`
   * applies elsewhere — a team default whose provider was later disabled
   * falls through to the cascade's next tier (`opts.defaultModelId ?? "s"`)
   * instead of failing every member's session build (members did not pick
   * it and cannot clear it). `undefined` when unset, inactive, or the host
   * has no `db`. Consulted only for team-owned sessions (TKAI-255) — a
   * personal session never reads any team's default, because a user can
   * belong to several teams and none of them owns that session. Uncached,
   * same as `userDefaultModel`.
   */
  private async teamDefaultModel(orgId: string, teamId: string): Promise<string | undefined> {
    if (!this.opts.db) return undefined;
    const rows = await this.opts.db
      .select({ defaultModel: teams.defaultModel })
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1);
    const pref = rows[0]?.defaultModel;
    if (!pref) return undefined;
    return this.firstActivePreference(orgId, [pref]);
  }

  /**
   * Resolve the `Model` to build/restore a session with. Spec-pinned
   * restore-no-clobber constraint: `Session.rehydrate`
   * (`packages/engine/src/session.ts`) always takes `options.model` as
   * handed to it by the caller — it never falls back to the persisted
   * `SessionData.model` on its own. That means if the host passed a fresh
   * "current user default" on every restore, an explicit per-session
   * `session.setModel(...)` override would get silently clobbered the next
   * time the session's cache entry is evicted and rebuilt (e.g.
   * `evictAll()` on shutdown, or an idle sweep). So on restore
   * (`existing` present), the *persisted* model always wins over both
   * `overrideId` and the user default — that persisted value already
   * reflects whatever `setModel` (or the original create-time model) set.
   * Only on create does the preference cascade apply (TKAI-255):
   * `overrideId ?? childDefault ?? userDefault ?? teamDefault ?? opts.defaultModelId ?? "s"`
   * — most-specific wins. Org model preferences are gone (superseded by the
   * per-tier ordered target lists): the final fallback is the tier token
   * `"s"`, which `resolveModelSpec` resolves through the org's tier map
   * (`resolveTier` walks that tier's ordered list for the first active
   * provider), so an org remap of `s` reaches every session that bottoms
   * out at this fallback. The tiers are opt-in via `prefs`:
   *
   * - `userId` names the person whose personal default may apply. Callers
   *   building a SHARED principal-owned session (team/org assistant, a
   *   team-owned workflow or child) must omit it: the first member to
   *   touch a shared session must not freeze their personal preference
   *   onto everyone (the resolved model persists, restore-no-clobber).
   * - `ownerTeamId` opts into the team tier for team-owned sessions.
   */
  private async resolveModelForBuild(
    existing: SessionData | null,
    orgId: string,
    prefs: {
      userId?: string;
      overrideId?: string;
      ownerTeamId?: string;
      childDefault?: string;
    },
  ): Promise<BuildModel> {
    if (existing?.model) return this.resolveModelObject(orgId, existing.model);
    const id =
      prefs.overrideId ??
      prefs.childDefault ??
      (prefs.userId ? await this.userDefaultModel(prefs.userId) : undefined) ??
      (prefs.ownerTeamId ? await this.teamDefaultModel(orgId, prefs.ownerTeamId) : undefined) ??
      this.opts.defaultModelId ??
      "s";
    return this.resolveModelObject(orgId, id);
  }

  /**
   * `users.default_reasoning` for `userId`, or `undefined` if unset or the
   * host has no `db`. Mirrors `userDefaultModel`: deliberately uncached, so
   * a settings change applies on the very next session build.
   */
  private async userDefaultReasoning(userId: string): Promise<string | undefined> {
    if (!this.opts.db) return undefined;
    const rows = await this.opts.db
      .select({ defaultReasoning: users.defaultReasoning })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0]?.defaultReasoning ?? undefined;
  }

  /**
   * `teams.default_reasoning` for the team that owns the session being
   * built. Mirrors `teamDefaultModel`, minus the active-provider walk —
   * reasoning levels aren't provider-scoped, so a plain column read
   * suffices. `undefined` when unset or the host has no `db`.
   */
  private async teamDefaultReasoning(orgId: string, teamId: string): Promise<string | undefined> {
    if (!this.opts.db) return undefined;
    const rows = await this.opts.db
      .select({ defaultReasoning: teams.defaultReasoning })
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1);
    return rows[0]?.defaultReasoning ?? undefined;
  }

  /**
   * Resolve the session-default reasoning level to build/restore with.
   * Same restore-no-clobber constraint as `resolveModelForBuild` above, and
   * for the same reason: `Session.rehydrate` (`packages/engine/src/session.ts`)
   * only preserves the persisted `SessionData.reasoning` when the host
   * passes NO `sampling.reasoning` at all. Once this cascade feeds
   * `sampling.reasoning` into every create/restoreSession call, a host that
   * re-resolved a fresh cascade value on every rebuild would silently
   * clobber an explicit `session.setReasoning(...)` the next time the
   * session's cache entry is evicted and rebuilt (idle sweep, `evictAll()`
   * on shutdown). So on restore (`existing` present), the *persisted* value
   * always wins outright over every cascade tier. Only on create does the
   * preference cascade apply:
   * `userDefault ?? teamDefault ?? orgDefault ?? undefined`
   * — most-specific wins — and the resolved level (if any) is clamped to the
   * org's cap (`clampToMax`). A cascade-resolved value that isn't a known
   * level (a stale/invalid column) is treated as unset rather than thrown.
   *
   * `userId`/`ownerTeamId` follow the exact same opt-in gating each call
   * site already uses for `resolveModelForBuild` — see that method's doc
   * comment for the SHARED-session rationale.
   */
  private async resolveReasoningForBuild(
    existing: SessionData | null,
    orgId: string,
    prefs: { userId?: string; ownerTeamId?: string },
  ): Promise<ReasoningLevel | undefined> {
    if (existing?.reasoning) {
      return isReasoningLevel(existing.reasoning) ? existing.reasoning : undefined;
    }
    const settings = this.opts.db ? await getOrgReasoningSettings(this.opts.db, orgId) : {};
    const level =
      (prefs.userId ? await this.userDefaultReasoning(prefs.userId) : undefined) ??
      (prefs.ownerTeamId ? await this.teamDefaultReasoning(orgId, prefs.ownerTeamId) : undefined) ??
      settings.default;
    if (!isReasoningLevel(level)) return undefined;
    return clampToMax(level, settings.max);
  }

  /**
   * Reuse an existing thread or persist current defaults for a new one.
   * Channel ingress and event delivery share this guard because they can
   * reach the same thread while its first creation awaits persistence.
   */
  async ensureFreshThread(session: Session, key: string, meta: SessionMeta, actorUserId = meta.userId): Promise<Thread> {
    const existing = await session.threadByKey(key);
    if (existing) return existing;
    let pending = this.threadCreations.get(session);
    if (!pending) {
      pending = new Map();
      this.threadCreations.set(session, pending);
    }
    const inflight = pending.get(key);
    if (inflight) return inflight;
    const creation = (async () => {
      const settings = await this.resolveFreshThreadSettings(session.id, meta, actorUserId);
      return session.createThread(key, settings);
    })();
    pending.set(key, creation);
    try {
      return await creation;
    } finally {
      pending.delete(key);
    }
  }

  /**
   * Resolve settings for a new thread without consulting persisted session
   * settings. Tier tokens remain tokens so later turns use the current map.
   */
  async resolveFreshThreadSettings(
    sessionId: string,
    meta: SessionMeta,
    actorUserId = meta.userId,
  ): Promise<{ model: string; reasoning: ReasoningLevel | null }> {
    const assistant = this.opts.db
      ? await loadAssistantBySessionId(this.opts.db, sessionId)
      : undefined;
    const isUserAssistant = assistant?.ownerType === "user";
    const isTeamAssistant = assistant?.ownerType === "team";
    const userId = assistant ? (isUserAssistant ? assistant.ownerId : undefined) : actorUserId;
    const ownerTeamId = assistant
      ? (isTeamAssistant ? assistant.ownerId : undefined)
      : meta.ownerTeamId;
    const { spec } = await this.resolveModelForBuild(null, meta.orgId, {
      userId,
      ownerTeamId,
    });
    const reasoning = await this.resolveReasoningForBuild(null, meta.orgId, {
      userId,
      ownerTeamId,
    });
    return {
      model: spec,
      reasoning: reasoning ?? null,
    };
  }

  /** Resolve an existing startup image before child creation mutates state. */
  async resolveChildStartupImage(meta: SessionMeta): Promise<string | null> {
    const snapshot = await resolveSnapshot({
      db: this.opts.db,
      provider: this.opts.sandboxProvider,
      meta,
      apiUrl: this.opts.sandboxApiUrl ?? "http://localhost:8788",
      stockImage: this.opts.defaultImages?.full ?? this.opts.defaultImage ?? "",
      preflight: this.opts.prebuildPreflight,
    });
    // Use startup's repo -> base -> stock fallback, including its pull preflight.
    // A missing image cannot bypass a failed registry-capacity check.
    return computeSpec(snapshot).image || null;
  }

  /**
   * Resolve (or lazily create) a child session (Phase 4 decision 10/11).
   * Purpose 'child', linked to its parent via `parentSessionId`/
   * `parentThreadId`. Deliberately gets NO `toolConfig.childSpawner` — the
   * `task` tool's absence-of-spawner contract is the engine's depth limit
   * (children can't spawn grandchildren).
   */
  async childSessionFor(
    childSessionId: string,
    opts: {
      parentSessionId: string;
      parentThreadId: string;
      actorUserId: string;
      orgId: string;
      owner: Principal;
      workspace: string;
      modelId?: string;
      /** Interactive-service profile (default "headless"). */
      profile?: "headless" | "full";
      /** Rootless docker daemon in the child's sandbox (docker-in-sandbox). */
      docker?: boolean;
      /** CPU and memory overrides for this child only. */
      resources?: PrebuildResources;
      /** Non-fatal startup warnings returned by the task tool. */
      startupWarnings?: string[];
      /** A channel-originated parent makes every child turn shared. */
      sharedTranscript?: boolean;
      /**
       * The mode the spawner writes on the child's row. A child of a legacy
       * team orchestrator inherits `actor` and must resolve that way from
       * its first build, before its row exists.
       */
      credentialOwnerMode?: CredentialOwnerMode;
    },
  ): Promise<Session> {
    this.assertSessionBuildAllowed(childSessionId);
    const cached = this.cache.get(childSessionId);
    if (cached) return cached.session;
    const pending = this.inflight.get(childSessionId);
    if (pending) return pending;

    const promise = this.buildChildSession(childSessionId, opts).finally(() => {
      this.inflight.delete(childSessionId);
    });
    this.inflight.set(childSessionId, promise);
    return promise;
  }

  private async buildChildSession(
    childSessionId: string,
    opts: {
      parentSessionId: string;
      parentThreadId: string;
      actorUserId: string;
      orgId: string;
      owner: Principal;
      workspace: string;
      modelId?: string;
      /** Interactive-service profile (default "headless"). */
      profile?: "headless" | "full";
      /** Rootless docker daemon in the child's sandbox (docker-in-sandbox). */
      docker?: boolean;
      /** CPU and memory overrides for this child only. */
      resources?: PrebuildResources;
      /** Non-fatal startup warnings returned by the task tool. */
      startupWarnings?: string[];
      /** A channel-originated parent makes every child turn shared. */
      sharedTranscript?: boolean;
      /**
       * The mode the spawner writes on the child's row. A child of a legacy
       * team orchestrator inherits `actor` and must resolve that way from
       * its first build, before its row exists.
       */
      credentialOwnerMode?: CredentialOwnerMode;
    },
  ): Promise<Session> {
    // `opts.owner` is the child's own principal: the `task` tool reads the
    // parent session's principal and hands it to the spawner, which passes
    // it here and on to `createSession` below. A child of a team-owned
    // session gets that team's skills, not the spawning user's.
    const extras = await this.sessionExtras(opts.owner, opts.orgId);
    const skillsProvider = this.skillsProviderFor(opts.owner, opts.orgId);
    // Persona child wiring (Valet Security M4): the security dispatch
    // stamps its cell claim (`child_session_id`) BEFORE the spawn builds
    // this session, so this first build already sees it and attaches the
    // persona tool set, the persona role, and the tool endpoint config.
    // One indexed query; ordinary task children pay a single miss.
    const personaCell = await this.claimedSecurityCell(childSessionId);
    // Declared-tool provisioning (M-P4a/M-P4b): the persona child's declared MCP
    // servers and authorized-scope egress env. `sessionExtras` above ran with no
    // extra plugins; re-run it with the declared MCP plugins so the child's tool
    // set carries them. Empty (byte-identical to before) for a non-persona child.
    const securityProvisioning = personaCell
      ? await this.securityProvisioningForCell(personaCell)
      : { mcpPlugins: [], scopeEnv: {} };
    const provisionedExtras =
      personaCell && securityProvisioning.mcpPlugins.length > 0
        ? await this.sessionExtras(opts.owner, opts.orgId, [], securityProvisioning.mcpPlugins)
        : extras;
    const childTools = personaCell
      ? [...buildSecurityPersonaTools({ review: personaCell.review, persona: personaCell.persona }), ...provisionedExtras.tools]
      : provisionedExtras.tools;
    // The persona role registers on the session (roles registry) so the
    // dispatch prompt's per-turn `role` overlay resolves. Attach ONLY the role
    // matching the claimed cell's persona — the engagement-runner SKILL stays
    // off persona children. A repo-defined persona loads its role from the
    // engagement's stashed markdown (M-P2c).
    const childRepoRoleMarkdown = personaCell
      ? await this.repoRoleMarkdownForCell(personaCell)
      : undefined;
    const childRoles = personaCell
      ? [...provisionedExtras.roles, ...securityRolesForCell(personaCell.persona, childRepoRoleMarkdown)]
      : provisionedExtras.roles;

    const existing = await this.opts.engineStore.getSession(childSessionId);
    // Team- and org-owned builds are shared: omit `userId` so the acting
    // member's personal default cannot freeze onto the shared session.
    const { model, spec: modelSpec } = await this.resolveModelForBuild(existing, opts.orgId, {
      userId: opts.owner.type === "user" ? opts.actorUserId : undefined,
      overrideId: opts.modelId,
      ownerTeamId: opts.owner.type === "team" ? opts.owner.id : undefined,
      // Child sessions default to the "s" tier when no explicit overrideId
      // was passed (TKAI-285). The tier resolves through the org's tier map
      // to a concrete spec; childDefault sits after overrideId but before
      // the user/team defaults and the tier fallback.
      childDefault: opts.modelId ? undefined : "s",
    });
    const reasoning = await this.resolveReasoningForBuild(existing, opts.orgId, {
      userId: opts.owner.type === "user" ? opts.actorUserId : undefined,
      ownerTeamId: opts.owner.type === "team" ? opts.owner.id : undefined,
    });

    const profile = opts.profile ?? "headless";
    const sandboxMint = await this.mintSandboxEnv(childSessionId, opts.actorUserId, opts.orgId, profile);
    // A first child build has no app row yet, so the mode the spawner is
    // about to write travels in the options: a legacy team orchestrator's
    // child keeps acting as the member from its first turn.
    const credentialResolver = this.buildCredentialResolver(
      childSessionId,
      opts.actorUserId,
      opts.orgId,
      resolvesAsActingMember({ ownerType: opts.owner.type, credentialOwnerMode: opts.credentialOwnerMode ?? null }),
    );
    const policyResolver = this.getPolicyResolver();
    const pluginStoreFactory = this.getPluginStoreFactory();
    const resolveOutboundSender = this.outboundSenderResolver(opts.orgId, opts.owner);
    // A child spawned with a repo binding (the spawner inserts the
    // `session_repos` row before calling in here) gets the same declarative
    // clone prep a REST-created session gets. Only this first build decides —
    // later cache hits ignore meta (see `loadSessionMeta`'s module doc). No
    // start-ref sink: a child session records no start-ref today. An absent
    // `opts.db` (tests that wire no db) degrades to empty bindings, same as
    // `sessionExtras`/`mintSandboxEnv`.
    // `profile`/`docker` MUST reach the meta: dropping them once shipped a
    // dev-v2 DinD outage (a full/docker child crash-looped against the wrong
    // bake). Image resolution is single-lineage today (resolve-snapshot pins
    // profile "full"), so they no longer select the image — but the meta is
    // what later consumers and the spec provider see; keep it complete.
    // `ownerId` MUST reach the meta with `ownerType`: the loader sets
    // `ownerTeamId` only from the pair, and `sessionPrincipal` rejects a
    // team meta without it, so a team child with a repo binding silently
    // resolved default prebuild flags.
    // `credentialOwnerMode` MUST reach the meta for the same reason: the
    // tool-time resolver above takes it from `opts`, but the repo
    // prebuild-flag read below runs off this meta through
    // `credentialReadPrincipal`. Dropped, a child of a legacy `actor` team
    // parent reads as the TEAM, finds no App, degrades to a tokenless read
    // and 404s on a private repo — so it provisions without the docker flag
    // and workspace claim its parent honoured, on the same repo.
    // Built once and spread into both branches. Repeating the optional
    // fields per branch is how the two incidents above happened: a field
    // added to one path and forgotten on the other typechecks cleanly.
    const carried = {
      userId: opts.actorUserId,
      orgId: opts.orgId,
      workspace: opts.workspace,
      profile,
      ...(opts.docker !== undefined ? { docker: opts.docker } : {}),
      ...(opts.resources !== undefined ? { sandboxResourceOverrides: opts.resources } : {}),
      ...(opts.credentialOwnerMode !== undefined
        ? { credentialOwnerMode: opts.credentialOwnerMode }
        : {}),
    };
    const meta = this.opts.db
      ? await loadSessionMeta(this.opts.db, {
          id: childSessionId,
          ownerType: opts.owner.type,
          ownerId: opts.owner.id,
          ...carried,
        })
      : carried;
    // Repo-declared session-runtime flags from `.valet/prebuild.yaml`
    // (TKAI-385): the same read `buildSession` does, so a child bound to a
    // repo gets `workspaceStorage`, `docker`, and CPU/memory exactly like a
    // REST-created session. This was MISSING at first ship — child sandboxes
    // (the orchestrator's verify/task sessions) provisioned the 1Gi default
    // claim while REST sessions honored the declaration. Best-effort: any
    // failure resolves the defaults.
    const repoFlags = await this.resolveRepoPrebuildFlags(childSessionId, meta);
    if (repoFlags.outcome === "error") {
      opts.startupWarnings?.push(
        "Valet could not read the repository sandbox settings. Check GitHub access, then retry the task.",
      );
    }
    const dockerFlag = opts.docker === true || repoFlags.docker;
    const kubernetesFlag = repoFlags.kubernetes;
    const initialResources = repoFlags.initialResources;
    const specProvider = await this.buildSpecProvider(childSessionId, meta, undefined, personaCell != null);
    // Repo AGENTS.md instructions (agents-md spec, decision 5): a child
    // spawned with a repo binding reads its AGENTS.md exactly like a
    // REST-created session. `builtSession` is assigned below, after the
    // engine builds the session — the provider resolves it lazily.
    let builtSession: Session | undefined;
    const repoInstructionsProvider = this.buildRepoInstructionsProvider(
      () => builtSession,
      "repos" in meta ? meta.repos : undefined,
      specProvider !== undefined,
    );
    const sessionOptions = {
      userId: opts.actorUserId,
      orgId: opts.orgId,
      workspace: opts.workspace,
      purpose: "child" as const,
      ...(credentialResolver ? { credentialResolver } : {}),
      ...(policyResolver ? { policyResolver } : {}),
      ...(pluginStoreFactory ? { pluginStoreFactory } : {}),
      ...this.browserOptions(childSessionId),
      extractDocument: extractDocumentText,
            ...(this.opts.db ? { skillTelemetry: skillTelemetrySink(this.opts.db, opts.orgId) } : {}),
      ...(resolveOutboundSender ? { resolveOutboundSender } : {}),
      owner: opts.owner,
      parentSessionId: opts.parentSessionId,
      parentThreadId: opts.parentThreadId,
      sharedTranscript: opts.sharedTranscript,
      sandbox: {
        browser: { enabled: this.opts.sandboxProvider.capabilities().browserAutomation === true, viewer: true },
        workspace: opts.workspace,
        // Single-lineage stock default, same fall-through as a REST-created
        // session (`sessionFor`).
        image: this.opts.defaultImages?.full ?? this.opts.defaultImage,
        // Authorized-scope egress allowlist env (M-P4b): a live persona child
        // carries VALET_SECURITY_AUTHORIZED_SCOPE. Empty for a non-live child,
        // so the env stays byte-identical.
        // TODO(M-P4b egress): SandboxCreateOpts has no network-policy field, so
        // this env is the enforcement seam the live tools honor. Full network-
        // level egress lockdown (a k8s NetworkPolicy / egress firewall keyed on
        // this allowlist) is a sandbox-infra follow-up — add it here on the
        // child sandbox spec once SandboxProvider supports an egress policy.
        env:
          Object.keys(securityProvisioning.scopeEnv).length > 0
            ? { ...(sandboxMint?.env ?? {}), ...securityProvisioning.scopeEnv }
            : sandboxMint?.env,
        profile,
        ...(dockerFlag ? { docker: true } : {}),
        ...(kubernetesFlag ? { nestedKubernetes: true } : {}),
        ...(initialResources ? { resources: initialResources } : {}),
        // Sizes a fresh claim; an adopted (existing) claim converges UP to
        // this through the provider's rate-limited grow at create time
        // (TKAI-402). A claim never shrinks.
        ...(repoFlags.workspaceStorage ? { workspaceStorage: repoFlags.workspaceStorage } : {}),
        ...(sandboxMint ? { credsFiles: sandboxMint.credsFiles } : {}),
      },
      model,
      modelSpec,
      resolveModel: this.makeResolveModel(opts.orgId),
      ...(reasoning !== undefined && isReasoningLevel(reasoning) ? { sampling: { reasoning } } : {}),
      systemPrompt: codingSystemPrompt({ secretsCli: specProvider !== undefined }),
      tools: childTools.length ? childTools : undefined,
      skills: provisionedExtras.skills.length ? provisionedExtras.skills : undefined,
      roles: childRoles.length ? childRoles : undefined,
      // The persona tools' HTTP seam only — still NO childSpawner (the
      // depth-limit contract) and no child seams.
      ...(personaCell
        ? {
            toolConfig: {
              ...(this.opts.apiBaseUrl ? { apiBaseUrl: this.opts.apiBaseUrl } : {}),
              internalToken: internalToken(),
            },
            // Compaction is observable, not silent (M5, spec §Context
            // Discipline) — same hook as the post-restart rebuild path in
            // `buildSession`. Db guard narrows the type only (the claim
            // lookup already required one).
            ...(this.opts.db ? { compactionHooks: [securityCompactionHook(this.opts.db)] } : {}),
          }
        : {}),
      ...(skillsProvider ? { skillsProvider } : {}),
      ...(specProvider ? { specProvider } : {}),
      ...(repoInstructionsProvider ? { repoInstructionsProvider } : {}),
    };

    const engine = new Engine({
      providers: {
        store: this.opts.engineStore,
        stream: this.opts.eventStream,
        credentials: this.opts.engineCredentials,
        sandboxProvider: this.opts.sandboxProvider,
        blobs: this.opts.blobs,
      },
    });

    const session = existing
      ? await engine.restoreSession({ sessionId: childSessionId, options: sessionOptions })
      : await engine.createSession({ id: childSessionId, ...sessionOptions });

    builtSession = session;
    this.cache.set(childSessionId, { engine, session });
    this.trackHibernationWake(childSessionId, session);
    if (existing) this.pruneExpiredEvents(childSessionId);
    return session;
  }

  /**
   * Resolve (or lazily create) a workflow-owned session (Phase 5 plan
   * decision 15) for a `session` node's `wf:{runId}:{nodeId}` id. Mirrors
   * `childSessionFor`/`buildChildSession`: Docker sandbox template, `owner`
   * passed straight through by the caller (the run's principal owner, per
   * `WorkflowRun.owner`), NO `toolConfig.childSpawner` — a workflow session
   * can't spawn children, same depth-limit contract as a child session.
   * Unlike a child session it has no `parentSessionId`/`parentThreadId`
   * (workflow runs aren't a parent/child engine relationship).
   */
  async workflowSessionFor(
    sessionId: string,
    opts: {
      actorUserId: string;
      orgId: string;
      owner: Principal;
      workspace: string;
      title?: string;
      modelId?: string;
    },
  ): Promise<Session> {
    this.assertSessionBuildAllowed(sessionId);
    const cached = this.cache.get(sessionId);
    if (cached) return cached.session;
    const pending = this.inflight.get(sessionId);
    if (pending) return pending;

    const promise = this.buildWorkflowSession(sessionId, opts).finally(() => {
      this.inflight.delete(sessionId);
    });
    this.inflight.set(sessionId, promise);
    return promise;
  }

  private async buildWorkflowSession(
    sessionId: string,
    opts: {
      actorUserId: string;
      orgId: string;
      owner: Principal;
      workspace: string;
      title?: string;
      modelId?: string;
    },
  ): Promise<Session> {
    // `opts.owner` is the run's own principal (`WorkflowRun.owner`, which
    // the scheduler and the event dispatcher copy from the definition row).
    // A run started from a team-owned workflow therefore reads the team's
    // skills, not those of whoever last edited the workflow.
    const extras = await this.sessionExtras(opts.owner, opts.orgId);
    const skillsProvider = this.skillsProviderFor(opts.owner, opts.orgId);

    const existing = await this.opts.engineStore.getSession(sessionId);
    // Team- and org-owned builds are shared: omit `userId` so the acting
    // member's personal default cannot freeze onto the shared session.
    const { model, spec: modelSpec } = await this.resolveModelForBuild(existing, opts.orgId, {
      userId: opts.owner.type === "user" ? opts.actorUserId : undefined,
      overrideId: opts.modelId,
      ownerTeamId: opts.owner.type === "team" ? opts.owner.id : undefined,
    });
    const reasoning = await this.resolveReasoningForBuild(existing, opts.orgId, {
      userId: opts.owner.type === "user" ? opts.actorUserId : undefined,
      ownerTeamId: opts.owner.type === "team" ? opts.owner.id : undefined,
    });

    const sandboxMint = await this.mintSandboxEnv(sessionId, opts.actorUserId, opts.orgId, "headless");
    const credentialResolver = this.buildCredentialResolver(sessionId, opts.actorUserId, opts.orgId, false);
    // Workspace prep for the session's sandbox: the git credential helper,
    // the `gh` shim, `valet-secrets` and a git identity. Until 2026-09-22
    // this build wired no `specProvider`, so a workflow sandbox never ran
    // prep. The `github.*` tools worked through `credentialResolver`, but
    // `git push` had no credential helper and failed anonymously.
    //
    // A workflow session has no `agent_sessions` row and no repo bindings,
    // so the meta is assembled from the build opts, as `buildChildSession`
    // does. The identity follows the OWNER, like credential resolution
    // (`workflow_runs.actor_user_id` is display and audit only): a
    // user-owned run commits as that user, and a team- or org-owned run
    // commits under the generic identity even when a member clicked Run.
    // `loadSessionMeta` finds no user for `team:{id}`/`org:{id}`, so prep
    // falls back to the generic name and email.
    const metaSource = {
      id: sessionId,
      userId: opts.owner.type === "user" ? opts.owner.id : `${opts.owner.type}:${opts.owner.id}`,
      orgId: opts.orgId,
      workspace: opts.workspace,
      profile: "headless" as const,
      ownerType: opts.owner.type,
      ownerId: opts.owner.id,
    };
    const meta: SessionMeta = this.opts.db ? await loadSessionMeta(this.opts.db, metaSource) : metaSource;
    const specProvider = await this.buildSpecProvider(sessionId, meta);
    const policyResolver = this.getPolicyResolver();
    const pluginStoreFactory = this.getPluginStoreFactory();
    const resolveOutboundSender = this.outboundSenderResolver(opts.orgId, opts.owner);
    const sessionOptions = {
      userId: opts.actorUserId,
      orgId: opts.orgId,
      workspace: opts.workspace,
      purpose: "workflow" as const,
      ...(credentialResolver ? { credentialResolver } : {}),
      ...(specProvider ? { specProvider } : {}),
      ...(policyResolver ? { policyResolver } : {}),
      ...(pluginStoreFactory ? { pluginStoreFactory } : {}),
      ...this.browserOptions(sessionId),
      extractDocument: extractDocumentText,
            ...(this.opts.db ? { skillTelemetry: skillTelemetrySink(this.opts.db, opts.orgId) } : {}),
      ...(resolveOutboundSender ? { resolveOutboundSender } : {}),
      owner: opts.owner,
      // Tier 0 (sandbox-tiering spec, 2026-08-22): workflow sessions are
      // sandbox-less by default, like orchestrators. A session-node turn
      // that only calls the LLM and api-side plugin actions never
      // provisions a pod; the lazy PolicySandbox attachment provisions on
      // the first tool that actually touches the filesystem. The
      // saturation incident's triage workflow (slack read + LLM, 11-way
      // foreach, every 10 minutes) would have provisioned ZERO sandboxes
      // under this flag.
      warmSandboxOnClaim: false,
      sandbox: {
        browser: { enabled: this.opts.sandboxProvider.capabilities().browserAutomation === true, viewer: true },
        workspace: opts.workspace,
        image: this.opts.defaultImage,
        env: sandboxMint?.env,
        profile: "headless" as const,
        ...(sandboxMint ? { credsFiles: sandboxMint.credsFiles } : {}),
      },
      model,
      modelSpec,
      resolveModel: this.makeResolveModel(opts.orgId),
      ...(reasoning !== undefined && isReasoningLevel(reasoning) ? { sampling: { reasoning } } : {}),
      systemPrompt: codingSystemPrompt({ secretsCli: specProvider !== undefined }),
      tools: extras.tools.length ? extras.tools : undefined,
      skills: extras.skills.length ? extras.skills : undefined,
      roles: extras.roles.length ? extras.roles : undefined,
      ...(skillsProvider ? { skillsProvider } : {}),
      ...(opts.title ? { metadata: { title: opts.title } } : {}),
    };

    const engine = new Engine({
      providers: {
        store: this.opts.engineStore,
        stream: this.opts.eventStream,
        credentials: this.opts.engineCredentials,
        sandboxProvider: this.opts.sandboxProvider,
        blobs: this.opts.blobs,
      },
    });

    const session = existing
      ? await engine.restoreSession({ sessionId, options: sessionOptions })
      : await engine.createSession({ id: sessionId, ...sessionOptions });

    this.cache.set(sessionId, { engine, session });
    this.trackHibernationWake(sessionId, session);
    if (existing) this.pruneExpiredEvents(sessionId);
    return session;
  }
}

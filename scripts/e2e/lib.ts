/**
 * Pure library behind `scripts/e2e.ts` (`make e2e`): the step table, probe
 * gating, `.env.e2e` parsing, and scorecard rendering. No child processes and
 * no fs here — everything is unit-testable (`lib.test.ts`).
 *
 * Spec: docs/specs/2026-07-25-e2e-runner-design.md
 */

export type Need =
  | "key"
  | "docker"
  | "helm"
  | "k8sContext"
  | "e2eK8sOptIn"
  | "telegram"
  | "githubLive"
  | "openai"
  | "onepassword";

export interface StepDef {
  id: string;
  group: "static" | "integration" | "docker" | "fullstack" | "live";
  title: string;
  /** argv, spawned without a shell. */
  command: string[];
  /** Working directory relative to repo root; default ".". */
  cwd?: string;
  needs: Need[];
  /** Extra env for the child (e.g. VALET_CLI_E2E=1). */
  env?: Record<string, string>;
  /** Remove credential vars from the child env (integration-core: makes the
   * key-gated describe.skip branches skip deterministically). */
  scrubKeys?: boolean;
  /** Runner-side pre-hook id (only "keycloak" today). */
  preHook?: "keycloak";
  /**
   * Safe to run concurrently with other parallelSafe steps: no daemons, no
   * fixed ports, and no writes to files another step reads. Static-group
   * only. typecheck (tsc --build re-emits shared/sdk dist) and
   * registry-drift (temporarily rewrites a tracked file) stay serial.
   */
  parallelSafe?: true;
  timeoutMs: number;
}

export interface Probes {
  key: boolean;
  docker: boolean;
  helm: boolean;
  k8sContext: boolean;
  e2eK8sOptIn: boolean;
  telegram: boolean;
  githubLive: boolean;
  openai: boolean;
  onepassword: boolean;
}

/** Env vars scrubbed from `scrubKeys` steps and probed for cred tiers. */
export const CRED_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "TELEGRAM_TEST_BOT_TOKEN",
  "TELEGRAM_TEST_CHAT_ID",
  "VALET_GITHUB_LIVE_TEST",
  "VALET_GITHUB_LIVE_APP_ID",
  "VALET_GITHUB_LIVE_APP_PRIVATE_KEY_PEM",
] as const;

const MIN = 60_000;

/** Integration files run keyless in `integration-core` (key-gated suites in
 * these files self-skip via describe.skip). Explicit lists keep the two
 * integration rows off the dedicated rows' files (cli, telegram, openai,
 * onepassword, prebuilds, keycloak) — with one deliberate overlap: `github-repo.e2e` is in
 * core (its GitHub-fixture loop is keyless) AND is the `github-live` row's
 * file (the live block self-gates). lib.test.ts asserts the union of these
 * lists + dedicated rows covers the whole integration dir. */
const INTEGRATION_CORE_FILES = [
  "src/integration/artifacts.test.ts",
  "src/integration/assistants.test.ts",
  "src/integration/workspace-assistant.test.ts",
  "src/integration/auth.e2e.test.ts",
  "src/integration/auto-title.test.ts",
  "src/integration/memory-routes.test.ts",
  "src/integration/memory-tree.test.ts",
  "src/integration/sessions-list-filter.test.ts",
  "src/integration/sessions-run-state.test.ts",
  "src/integration/reload-tool-rendering.test.ts",
  "src/integration/workflow-engine-deps.test.ts",
  "src/integration/orchestrator-info.test.ts",
  "src/integration/team-copy.test.ts",
  "src/integration/team-dashboard.test.ts",
  "src/integration/thread-archive.test.ts",
  "src/integration/lazy-session-history.test.ts",
  "src/integration/thread-rename.test.ts",
  "src/integration/thread-create-settings.test.ts",
  "src/integration/child-dismiss.test.ts",
  "src/integration/orchestrator-children-scope.test.ts",
  "src/integration/command-route.test.ts",
  "src/integration/policies.e2e.test.ts",
  "src/integration/github-repo.e2e.test.ts",
  "src/integration/workflow-github-credential.e2e.test.ts",
  "src/integration/usage-summary.test.ts",
  "src/integration/plugin-entitlements.test.ts",
  "src/integration/profile-pictures.test.ts",
  // Valet Security integration suites run keyless: the virtual sandbox
  // provider and abort-based settlement need no model key.
  "src/integration/security-settlement.test.ts",
  "src/integration/security-persona.test.ts",
  "src/integration/security-yield.test.ts",
  "src/integration/security-routes.test.ts",
  "src/integration/security-triage.test.ts",
  "src/integration/security-acceptance.test.ts",
  "src/integration/security-cancel.test.ts",
  "src/integration/security-rescan-diff.test.ts",
  "src/integration/security-plan-edit.test.ts",
  "src/integration/security-config-edit.test.ts",
  "src/integration/security-comments.test.ts",
  "src/integration/security-coverage.test.ts",
  "src/integration/security-finding-location.test.ts",
  "src/integration/security-report.test.ts",
  "src/integration/security-needs.test.ts",
  "src/integration/security-setup.test.ts",
];

const INTEGRATION_AGENT_FILES = [
  "src/integration/orchestrator.test.ts",
  "src/integration/orchestrator-loop.test.ts",
  "src/integration/orchestrator-children.test.ts",
  "src/integration/orchestrator-restart.test.ts",
  "src/integration/cross-thread.test.ts",
  "src/integration/plugins.e2e.test.ts",
  "src/integration/workflow-run.e2e.test.ts",
  "src/integration/workflow-foreach-session.test.ts",
];

/** Integration files owned by dedicated rows (see lists above). */
export const DEDICATED_INTEGRATION_FILES = [
  "src/integration/browser.docker.test.ts",
  "src/integration/cli.e2e.test.ts",
  "src/integration/telegram.e2e.test.ts",
  "src/integration/github-repo.e2e.test.ts",
  "src/integration/llm-providers.e2e.test.ts",
  "src/integration/prebuilds.e2e.test.ts",
  "src/integration/oidc-keycloak.e2e.test.ts",
  "src/integration/onepassword.live.test.ts",
  "src/integration/onepassword.live-server.test.ts",
  "src/integration/onepassword.agent-pull.test.ts",
  "src/integration/onepassword.broker-live.test.ts",
];
export const INTEGRATION_LIST_FILES = { core: INTEGRATION_CORE_FILES, agent: INTEGRATION_AGENT_FILES };

/** Plugin packages that HAVE test files. Content-only plugins ship a bare
 * `vitest run` script with no config/tests, which explodes resolving the
 * ROOT workspace config from the wrong cwd — enumerate instead of globbing.
 * A new plugin gaining tests must be added here (guarded by lib.test.ts). */
const TESTED_PLUGINS = [
  "@valet/plugin-browser",
  "@valet/plugin-github",
  "@valet/plugin-gmail",
  "@valet/plugin-google-calendar",
  "@valet/plugin-google-workspace",
  "@valet/plugin-linear",
  "@valet/plugin-openai",
  "@valet/plugin-security",
  "@valet/plugin-slack",
  "@valet/plugin-slack-user",
  "@valet/plugin-telegram",
];

// No "--" before the file filters: vitest silently drops every argument
// after a bare "--" and runs the FULL suite (guarded by lib.test.ts).
const apiTest = (...files: string[]): string[] => [
  "pnpm",
  "--filter",
  "@valet/api",
  "test",
  ...files,
];

export const STEPS: StepDef[] = [
  // ── static + unit ────────────────────────────────────────────────────────
  { id: "typecheck", group: "static", title: "root typecheck (all packages)", command: ["pnpm", "typecheck"], needs: [], scrubKeys: true, timeoutMs: 10 * MIN },
  // Recurring review rules as executable checks (CLAUDE.md type-safety +
  // ws-types gotchas) — see scripts/e2e/conventions.ts.
  { id: "conventions", group: "static", title: "code conventions (banned casts, ws @types)", command: ["pnpm", "exec", "tsx", "scripts/check-conventions.ts"], needs: [], scrubKeys: true, parallelSafe: true, timeoutMs: 5 * MIN },
  // Advisory STE prose lint over maintained docs (CLAUDE.md "Writing").
  // Soft-skips when python3 is absent rather than failing the scorecard.
  { id: "docs-lint", group: "static", title: "STE prose lint (maintained docs)", command: ["bash", "-c", "command -v python3 >/dev/null || { echo 'python3 not found - skipping'; exit 0; }; python3 scripts/docs/docs_lint.py"], needs: [], scrubKeys: true, parallelSafe: true, timeoutMs: 5 * MIN },
  { id: "unit", group: "static", title: "root unit sweep (shared, sdk, api, web)", command: ["pnpm", "test"], needs: [], scrubKeys: true, parallelSafe: true, timeoutMs: 15 * MIN },
  { id: "engine-unit", group: "static", title: "engine unit suite", command: ["pnpm", "--filter", "@valet/engine", "test"], needs: [], scrubKeys: true, parallelSafe: true, timeoutMs: 10 * MIN },
  { id: "browser-runtime", group: "static", title: "browser runtime, cells, journal and page fixtures", command: ["pnpm", "--filter", "@valet/browser-runtime", "test"], needs: [], scrubKeys: true, parallelSafe: true, timeoutMs: 10 * MIN },
  { id: "workflow-unit", group: "static", title: "workflow interpreter suite", command: ["pnpm", "--filter", "@valet/workflow", "test"], needs: [], scrubKeys: true, parallelSafe: true, timeoutMs: 10 * MIN },
  { id: "gateway-unit", group: "static", title: "sandbox gateway (JWT, WS proxy)", command: ["pnpm", "--filter", "@valet/sandbox-gateway", "test"], needs: [], scrubKeys: true, parallelSafe: true, timeoutMs: 10 * MIN },
  { id: "plugins-unit", group: "static", title: "plugin package suites", command: ["pnpm", ...TESTED_PLUGINS.flatMap((n) => ["--filter", n]), "test"], needs: [], scrubKeys: true, parallelSafe: true, timeoutMs: 15 * MIN },
  { id: "sandbox-local", group: "static", title: "sandbox-local suite", command: ["pnpm", "--filter", "@valet/sandbox-local", "test"], needs: [], scrubKeys: true, parallelSafe: true, timeoutMs: 10 * MIN },
  { id: "sandbox-k8s-unit", group: "static", title: "sandbox-kubernetes unit tests (no cluster)", command: ["pnpm", "--filter", "@valet/sandbox-kubernetes", "test", "--exclude", "test/**/*.cluster.test.ts"], needs: [], scrubKeys: true, parallelSafe: true, timeoutMs: 10 * MIN },
  { id: "store-postgres-unit", group: "static", title: "store-postgres PGlite tests (no docker)", command: ["pnpm", "--filter", "@valet/store-postgres", "test"], needs: [], scrubKeys: true, parallelSafe: true, timeoutMs: 10 * MIN },
  { id: "web-build", group: "static", title: "web production build (vite)", command: ["pnpm", "--filter", "@valet/web", "build"], needs: [], scrubKeys: true, timeoutMs: 10 * MIN },
  { id: "api-bundle", group: "static", title: "api production bundle + bundle-guard", command: ["bash", "-c", "pnpm --filter @valet/api build && pnpm --filter @valet/api test src/bundle-guard"], needs: [], scrubKeys: true, timeoutMs: 15 * MIN },
  { id: "helm-golden", group: "static", title: "helm chart lint + golden templates", command: ["bash", "deploy/chart/valet/test/golden.sh"], needs: ["helm"], scrubKeys: true, parallelSafe: true, timeoutMs: 5 * MIN },
  { id: "sandbox-docker-unit", group: "static", title: "sandbox-docker unit tests (no daemon)", command: ["pnpm", "--filter", "@valet/sandbox-docker", "test", "test/run-args.test.ts", "test/browser-companion.test.ts", "test/browser-companion-lifecycle.test.ts"], needs: [], scrubKeys: true, parallelSafe: true, timeoutMs: 5 * MIN },
  // Regenerate the plugin registry and fail on drift; the pre-drift file is
  // restored so the runner never leaves the tree dirty.
  { id: "registry-drift", group: "static", title: "plugin registry matches plugin.yaml manifests", command: ["bash", "-c", "set -e; f=packages/api/src/plugins/registry.gen.ts; pnpm tsx scripts/generate-v2-registry.ts >/dev/null; if ! git diff --quiet -- \"$f\"; then git checkout -- \"$f\"; echo \"registry.gen.ts is out of date - run 'make generate-registries' and commit\"; exit 1; fi"], needs: [], scrubKeys: true, timeoutMs: 5 * MIN },

  // ── integration + smoke ──────────────────────────────────────────────────
  { id: "integration-core", group: "integration", title: "keyless api integration", command: apiTest(...INTEGRATION_CORE_FILES), needs: [], scrubKeys: true, timeoutMs: 15 * MIN },
  { id: "orchestrator-smoke", group: "integration", title: "orchestrator smoke (real turn)", command: ["pnpm", "--filter", "@valet/api", "smoke:orchestrator"], needs: ["key"], timeoutMs: 5 * MIN },
  { id: "session-smoke", group: "integration", title: "session smoke (Docker round-trip)", command: ["pnpm", "--filter", "@valet/api", "smoke:session"], needs: ["key", "docker"], timeoutMs: 10 * MIN },
  { id: "integration-agent", group: "integration", title: "key-gated api integration", command: apiTest(...INTEGRATION_AGENT_FILES), needs: ["key"], timeoutMs: 30 * MIN },
  { id: "cli", group: "integration", title: "CLI e2e (T9)", command: apiTest("src/integration/cli.e2e.test.ts"), needs: [], env: { VALET_CLI_E2E: "1" }, timeoutMs: 15 * MIN },

  // ── docker / cluster gated ───────────────────────────────────────────────
  { id: "browser-docker", group: "docker", title: "managed browser isolation, persistence, approvals and HTTP flow", command: ["pnpm", "exec", "tsx", "scripts/e2e/browser.ts"], needs: ["docker"], timeoutMs: 20 * MIN },
  { id: "sandbox-docker", group: "docker", title: "sandbox-docker suite", command: ["pnpm", "--filter", "@valet/sandbox-docker", "test"], needs: ["docker"], timeoutMs: 15 * MIN },
  { id: "sandbox-dind", group: "docker", title: "rootless docker-in-sandbox", command: ["pnpm", "--filter", "@valet/sandbox-docker", "test", "test/dind.e2e.test.ts"], needs: ["docker"], timeoutMs: 15 * MIN },
  { id: "sandbox-k8s", group: "docker", title: "sandbox-kubernetes cluster suite", command: ["pnpm", "--filter", "@valet/sandbox-kubernetes", "test"], needs: ["k8sContext"], timeoutMs: 20 * MIN },
  { id: "store-postgres", group: "docker", title: "real-Postgres conformance", command: ["make", "test-pg"], needs: ["docker"], timeoutMs: 15 * MIN },
  { id: "workspace-prep-docker", group: "docker", title: "workspace prep against real sandbox", command: apiTest("src/engine/workspace-prep.docker.test.ts", "src/engine/workspace-prep-prebuilt.docker.test.ts"), needs: ["docker"], timeoutMs: 15 * MIN },
  { id: "prebuilds-docker", group: "docker", title: "image prebuild pipeline", command: apiTest("src/integration/prebuilds.e2e.test.ts"), needs: ["docker"], timeoutMs: 20 * MIN },
  { id: "k8s-builder-cluster", group: "docker", title: "in-cluster image build", command: apiTest("src/prebuilds/k8s-builder.cluster.test.ts"), needs: ["k8sContext"], timeoutMs: 20 * MIN },
  { id: "keycloak-oidc", group: "docker", title: "Keycloak OIDC code flow", command: apiTest("src/integration/oidc-keycloak.e2e.test.ts"), needs: ["docker"], preHook: "keycloak", timeoutMs: 10 * MIN },

  // ── full stack ───────────────────────────────────────────────────────────
  { id: "fullstack-docker", group: "fullstack", title: "full stack: spawned serve + docker sandbox", command: ["pnpm", "exec", "tsx", "scripts/e2e/fullstack-docker.ts"], needs: ["key", "docker"], timeoutMs: 10 * MIN },
  { id: "fullstack-k8s", group: "fullstack", title: "full stack: helm on rancher-desktop", command: ["pnpm", "exec", "tsx", "scripts/e2e/fullstack-k8s.ts"], needs: ["key", "k8sContext", "e2eK8sOptIn"], timeoutMs: 40 * MIN },

  // ── live external ────────────────────────────────────────────────────────
  { id: "telegram", group: "live", title: "live Telegram outbound", command: apiTest("src/integration/telegram.e2e.test.ts"), needs: ["telegram"], timeoutMs: 10 * MIN },
  { id: "github-live", group: "live", title: "live GitHub App", command: apiTest("src/integration/github-repo.e2e.test.ts"), needs: ["githubLive"], timeoutMs: 10 * MIN },
  { id: "openai", group: "live", title: "OpenAI provider path", command: apiTest("src/integration/llm-providers.e2e.test.ts"), needs: ["openai"], timeoutMs: 10 * MIN },
  {
    id: "onepassword",
    group: "live",
    title: "live 1Password SDK",
    command: apiTest(
      "src/integration/onepassword.live.test.ts",
      "src/integration/onepassword.live-server.test.ts",
      "src/integration/onepassword.agent-pull.test.ts",
      "src/integration/onepassword.broker-live.test.ts",
    ),
    needs: ["onepassword"],
    timeoutMs: 10 * MIN,
  },
];

export interface Waves {
  /** Serial, before everything: steps that write files others read. */
  pre: StepDef[];
  /** Concurrent pool: parallelSafe static steps. */
  parallel: StepDef[];
  /** Serial, after the pool: daemons, ports, keys, clusters. */
  serial: StepDef[];
}

/** Split steps into execution waves (order preserved within each wave). */
export function partitionWaves(steps: StepDef[]): Waves {
  return {
    pre: steps.filter((s) => s.group === "static" && !s.parallelSafe),
    parallel: steps.filter((s) => s.parallelSafe === true),
    serial: steps.filter((s) => s.group !== "static"),
  };
}

/** Needs not satisfied by the current probes ([] ⇒ armed). */
export function missingNeeds(step: StepDef, probes: Probes): Need[] {
  return step.needs.filter((n) => !probes[n]);
}

/** Human hint for a missing need — names the exact vars/prereq to fix. */
export function needHint(n: Need): string {
  switch (n) {
    case "key":
      return "set ANTHROPIC_API_KEY";
    case "docker":
      return "Docker daemon not reachable";
    case "k8sContext":
      return "kubectl context rancher-desktop not found";
    case "e2eK8sOptIn":
      return "set VALET_E2E_K8S=1";
    case "telegram":
      return "set TELEGRAM_TEST_BOT_TOKEN + TELEGRAM_TEST_CHAT_ID";
    case "githubLive":
      return "set VALET_GITHUB_LIVE_TEST=1 + VALET_GITHUB_LIVE_APP_ID + VALET_GITHUB_LIVE_APP_PRIVATE_KEY_PEM";
    case "openai":
      return "set OPENAI_API_KEY";
    case "onepassword":
      return "set OP_SERVICE_ACCOUNT_TOKEN";
  }
}

/**
 * Parse a `.env.e2e` file: `KEY=VALUE` lines, `#` comments, blank lines.
 * Throws on any other line — a malformed secrets file must fail loudly, not
 * silently run a weaker tier (spec: error handling).
 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    // Accept the natural shell-profile paste form.
    if (line.startsWith("export ")) line = line.slice("export ".length).trimStart();
    const eq = line.indexOf("=");
    if (eq <= 0) throw new Error(`.env.e2e line ${i + 1}: expected KEY=VALUE, got "${line}"`);
    const key = line.slice(0, eq).trim();
    if (/\s/.test(key)) {
      throw new Error(`.env.e2e line ${i + 1}: key "${key}" contains whitespace — expected KEY=VALUE`);
    }
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      // Unquoted values: strip trailing inline comments ("KEY=v  # note").
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }
    out[key] = value;
  }
  return out;
}

/** Cap replayed child output to the last `maxLines` lines — failure replays
 * of big vitest runs are otherwise thousands of lines of passing-test noise.
 * The tail is where vitest puts its failure summary. */
export function truncateOutput(output: string, maxLines = 120): string {
  const lines = output.split("\n");
  if (lines.length <= maxLines) return output;
  const tail = lines.slice(-maxLines).join("\n");
  return `[… ${lines.length - maxLines} lines truncated — rerun with --verbose or --only <step> for full output …]\n${tail}`;
}

// ── doctor mode (`make e2e E2E_ARGS="--doctor"`) ──────────────────────────

export interface DoctorCheck {
  id: string;
  label: string;
  ok: boolean;
  /** Required checks gate ALL runs (wrong Node, missing builds); optional
   * ones just widen coverage (creds, daemons). */
  required: boolean;
  /** Shown when ok (version, var count, …). */
  detail?: string;
  /** Repair hint shown when not ok. */
  hint?: string;
}

/** Render the readiness checklist: ✓ ok, ✗ required-missing, ⊘ optional-
 * missing, plus an armed-step summary. */
export function renderDoctor(checks: DoctorCheck[], armed: number, total: number): string {
  const lines = checks.map((c) => {
    const icon = c.ok ? "✓" : c.required ? "✗" : "⊘";
    const tail = c.ok ? (c.detail ? ` — ${c.detail}` : "") : c.hint ? ` — ${c.hint}` : "";
    return `${icon} ${c.label}${tail}`;
  });
  lines.push("");
  const requiredFailed = checks.filter((c) => c.required && !c.ok).length;
  lines.push(
    requiredFailed > 0
      ? `${requiredFailed} required check(s) failing — fix before running \`make e2e\``
      : `ready — ${armed}/${total} steps armed (run \`make e2e\`, or \`make e2e E2E_ARGS="--list"\` for what the skips need)`,
  );
  return lines.join("\n");
}

/** Exit 1 iff a required check fails; optional gaps are informational. */
export function doctorExitCode(checks: DoctorCheck[]): number {
  return checks.some((c) => c.required && !c.ok) ? 1 : 0;
}

export interface StepResult {
  id: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  skipReason?: string;
}

const ICON: Record<StepResult["status"], string> = { passed: "✓", failed: "✗", skipped: "⊘" };

/** Render the human scorecard: one line per step + totals. */
export function renderScorecard(results: StepResult[]): string {
  const width = Math.max(...results.map((r) => r.id.length));
  const lines = results.map((r) => {
    const secs = (r.durationMs / 1000).toFixed(1);
    const tail =
      r.status === "skipped" ? `skipped — ${r.skipReason ?? "unknown"}` : `${r.status} (${secs}s)`;
    return `${ICON[r.status]} ${r.id.padEnd(width)}  ${tail}`;
  });
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  lines.push("");
  lines.push(`${passed} passed · ${failed} failed · ${skipped} skipped`);
  return lines.join("\n");
}

export interface JsonReport {
  steps: StepResult[];
  passed: number;
  failed: number;
  skipped: number;
  exitCode: number;
}

/** Machine-readable report; exitCode 1 iff any armed step failed. */
export function toJsonReport(results: StepResult[]): JsonReport {
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  return { steps: results, passed, failed, skipped, exitCode: failed > 0 ? 1 : 0 };
}

/** Apply `--only`: keep listed step ids (order preserved); throw on unknown. */
export function selectSteps(all: StepDef[], only?: string[]): StepDef[] {
  if (!only || only.length === 0) return all;
  const known = new Set(all.map((s) => s.id));
  for (const id of only) {
    if (!known.has(id)) throw new Error(`unknown step "${id}" (see --list for step ids)`);
  }
  const wanted = new Set(only);
  return all.filter((s) => wanted.has(s.id));
}

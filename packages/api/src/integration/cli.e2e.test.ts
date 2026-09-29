/**
 * End-to-end CLI integration suite (single-binary CLI plan, T9).
 *
 * Drives the REAL `valet` CLI (`tsx src/cli.ts …`) as child processes against
 * a REAL `valet serve` child — no in-process app, no stubs. This is the
 * evidence that the whole dispatcher → client → HTTP → server round-trip works
 * against a live instance, including real profile resolution (the spawned serve
 * writes an implicit `local` default profile into its data dir's `config.json`,
 * which the client commands then resolve automatically).
 *
 * ── Placement ──────────────────────────────────────────────────────────────
 * This lives in `src/integration/` (NOT the plan's suggested `src/cli/
 * integration/`) on purpose. `vitest.config.ts` defines two projects: `unit`
 * (a `.test.ts` glob under `src`, EXCLUDING the `src/integration` subtree) runs
 * `vitest.setup.ts` which SCRUBS ambient env vars and has a 10s default
 * timeout; `integration` (the `src/integration` subtree) does NOT scrub env and
 * is the only home for suites that need the ambient shell env intact. A
 * PGlite/serve boot takes ~15s, so 10s is too short — every spawn/boot test
 * below sets an explicit per-test timeout.
 *
 * ── Gating ─────────────────────────────────────────────────────────────────
 * The WHOLE suite is opt-in behind `VALET_CLI_E2E` so the normal `pnpm test`
 * (both projects, possibly under cross-worktree contention) never spawns a
 * real serve. Turn-dependent sub-groups gate additionally on a REAL
 * `ANTHROPIC_API_KEY` — they SKIP on a machine without a valid key.
 *
 * ── serve boot + the placeholder key ───────────────────────────────────────
 * `startServer()` (main.ts) `process.exit(1)`s when `ANTHROPIC_API_KEY` is
 * unset ("required for prompts to run"). The core cases here drive NO turn
 * (status / session CRUD / login-logout are pure HTTP + DB), so we inject a
 * non-empty placeholder key into the spawned serve's env purely to clear that
 * boot gate. A real key, when present, passes through unchanged and enables the
 * turn sub-group. The turn tests gate on `process.env.ANTHROPIC_API_KEY` (the
 * REAL ambient key), never the placeholder, so they still SKIP without one.
 *
 * ── OWED / deliberately deferred (not forgotten) ───────────────────────────
 * Two plan items are intentionally deferred and recorded here + in the ledger:
 *   1. Real-auth login/logout e2e — this suite covers login/logout only against
 *      the STUB serve (keyless `me()` → 200). The real-auth path (a serve booted
 *      with `BETTER_AUTH_SECRET`, minting a `vlt_` key via better-auth, then
 *      `login`/whoami) needs a logged-in better-auth session to mint the key —
 *      too heavy for this pass.
 *   2. `gates resolve` round-trip — driving a deterministic decision gate needs
 *      a real agent turn that requests approval. The turn sub-group asserts
 *      `gates list --json` only; the resolve round-trip is deferred.
 * Human-mode `send` (non-`--json`) is also not exercised (only the NDJSON path).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VALET_VERSION } from "../version.js";
import type { InstanceListJson } from "../cli/commands/instance.js";
import type {
  DecisionGate,
  HealthResponse,
  ListSessionsResponse,
  SessionDetail,
  WireEvent,
} from "../wire/types.js";

// ── Locations ────────────────────────────────────────────────────────────────
// `../../` from this file (…/src/integration/) resolves to the package root
// (…/packages/api/), the cwd every child must run in (bare-specifier + tsx
// resolution). Resolve the tsx loader through the workspace dependency graph.
const apiRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliEntry = join(apiRoot, "src", "cli.ts");
const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

const e2eEnabled = Boolean(process.env.VALET_CLI_E2E);
const describeE2E = e2eEnabled ? describe : describe.skip;
// Turn-dependent cases need a REAL LLM key — the ambient one, not the serve's
// boot placeholder. Absent → this sub-group skips with a clear name.
const describeIfKey = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;

if (!e2eEnabled) {
  // eslint-disable-next-line no-console
  console.log("[cli.e2e] SKIPPED — set VALET_CLI_E2E=1 to spawn a real `valet serve` and run these.");
}

/** The captured result of one CLI child invocation. */
interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The JSON shape `valet status --json` prints (see cli/commands/status.ts). */
interface StatusJson {
  instance: { name: string; url: string };
  health: HealthResponse;
  clientVersion: string;
  skew: boolean;
}

/** A live serve child plus everything needed to talk to / tear it down. */
interface ServeHandle {
  child: ChildProcess;
  port: number;
  dataDir: string;
  url: string;
  /** Accumulated stdout+stderr, surfaced in failure messages. */
  log: () => string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Grab a free ephemeral port by binding then immediately releasing it. The
 * released port is also our "dead port" source for the Unreachable case. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Run one `valet <args…>` command as a child and capture its exit code +
 * output. `VALET_LOCAL_AUTH=1` and a caller-supplied `VALET_DATA_DIR` (the
 * serve's data dir, so profile resolution finds the implicit `local` profile)
 * are layered onto the ambient env.
 */
function runCli(args: string[], env: Record<string, string> = {}, timeoutMs = 60_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, VALET_LOCAL_AUTH: "1", ...env };
    // The `integration` vitest project does NOT scrub ambient env. An ambient
    // VALET_INSTANCE in the runner's shell would override the implicit `local`
    // default-profile resolution the core cases depend on — drop it unless a
    // case explicitly set one.
    if (env.VALET_INSTANCE === undefined) delete childEnv.VALET_INSTANCE;
    const child = spawn(process.execPath, ["--import", tsxImport, cliEntry, ...args], { cwd: apiRoot, env: childEnv });
    let stdout = "";
    let stderr = "";
    // Watchdog: never let a hung CLI child outlive the call and orphan itself —
    // vitest's per-test timeout wouldn't kill it.
    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`runCli(${args.join(" ")}) exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    watchdog.unref();
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.once("error", (err) => {
      clearTimeout(watchdog);
      reject(err);
    });
    child.once("close", (code) => {
      clearTimeout(watchdog);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Spawn `valet serve --sandbox local` on a free port with a unique PGlite data
 * dir, then poll `/api/health` until it answers 200 (up to ~45s). See the file
 * header for why a placeholder `ANTHROPIC_API_KEY` is injected.
 */
async function spawnServe(): Promise<ServeHandle> {
  const port = await getFreePort();
  const dataDir = mkdtempSync(join(tmpdir(), "valet-cli-e2e-serve-"));
  const url = `http://localhost:${port}`;

  const serveEnv: NodeJS.ProcessEnv = {
    ...process.env,
    VALET_LOCAL_AUTH: "1",
    // Non-empty so startServer()'s boot gate passes; the real key (when
    // present) flows through and enables the turn sub-group.
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "sk-ant-e2e-placeholder-not-real",
  };
  // This serve is a STUB-auth serve. An ambient BETTER_AUTH_SECRET in the
  // runner's shell would pair real auth with the stub above, which
  // `startServer` refuses to boot (see auth/config.ts's authModeConflict).
  delete serveEnv.BETTER_AUTH_SECRET;

  const child = spawn(
    process.execPath,
    ["--import", tsxImport, cliEntry, "serve", "--port", String(port), "--data-dir", dataDir, "--sandbox", "local"],
    { cwd: apiRoot, env: serveEnv },
  );

  let buf = "";
  const log = (): string => buf;
  child.stdout?.on("data", (d: Buffer) => (buf += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (buf += d.toString()));

  let spawnError: Error | undefined;
  child.once("error", (error) => { spawnError = error; });
  let exited = false;
  let exitCode: number | null = null;
  child.once("exit", (code) => {
    exited = true;
    exitCode = code;
  });

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (spawnError) {
      rmSync(dataDir, { recursive: true, force: true });
      throw spawnError;
    }
    if (exited) {
      rmSync(dataDir, { recursive: true, force: true });
      throw new Error(`valet serve exited early (code ${exitCode}) before becoming healthy:\n${buf}`);
    }
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.status === 200) return { child, port, dataDir, url, log };
    } catch {
      // not listening yet — keep polling
    }
    await sleep(500);
  }
  // Kill and AWAIT the child's exit before removing the data dir, so we don't
  // rm a dir a still-dying PGlite process holds (and don't leave a zombie).
  child.kill("SIGKILL");
  if (!exited) await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
  throw new Error(`valet serve did not become healthy within 45s:\n${buf}`);
}

/** SIGTERM the serve child (SIGKILL fallback), await exit, remove its data dir. */
async function stopServe(handle: ServeHandle): Promise<void> {
  await new Promise<void>((resolve) => {
    if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
      resolve();
      return;
    }
    handle.child.once("exit", () => resolve());
    handle.child.kill("SIGTERM");
    setTimeout(() => {
      if (handle.child.exitCode === null && handle.child.signalCode === null) {
        handle.child.kill("SIGKILL");
      }
    }, 5_000).unref();
  });
  rmSync(handle.dataDir, { recursive: true, force: true });
}

describeE2E("CLI e2e against a real `valet serve`", () => {
  let serve: ServeHandle;
  /** Env that points client commands at the serve's data dir (implicit `local`
   * profile → automatic instance resolution). */
  const dataEnv = (): Record<string, string> => ({ VALET_DATA_DIR: serve.dataDir });

  beforeAll(async () => {
    serve = await spawnServe();
  }, 60_000);

  afterAll(async () => {
    if (serve) await stopServe(serve);
  });

  it("status --json reports health, matching versions, and no skew", async () => {
    const r = await runCli(["status", "--json"], dataEnv());
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);

    const parsed = JSON.parse(r.stdout) as StatusJson;
    expect(parsed.health.ok).toBe(true);
    expect(parsed.health.version).toBe(VALET_VERSION);
    expect(parsed.health.sandboxBackend).toBe("local");
    expect(parsed.clientVersion).toBe(VALET_VERSION);
    // Client and server are the same binary here → no version skew.
    expect(parsed.skew).toBe(false);
  }, 30_000);

  it("sessions new → list → show round-trips a session id (no LLM key needed)", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "valet-cli-e2e-ws-"));
    try {
      const created = await runCli(["sessions", "new", "--workspace", workspace, "--json"], dataEnv());
      expect(created.code, `stderr: ${created.stderr}`).toBe(0);
      const detail = JSON.parse(created.stdout) as SessionDetail;
      expect(detail.id).toMatch(/^s/);
      expect(detail.workspace).toBe(workspace);
      expect(detail.status).toBe("active");

      const listed = await runCli(["sessions", "list", "--json"], dataEnv());
      expect(listed.code, `stderr: ${listed.stderr}`).toBe(0);
      const { sessions } = JSON.parse(listed.stdout) as ListSessionsResponse;
      expect(sessions.map((s) => s.id)).toContain(detail.id);

      const shown = await runCli(["sessions", "show", detail.id, "--json"], dataEnv());
      expect(shown.code, `stderr: ${shown.stderr}`).toBe(0);
      const shownDetail = JSON.parse(shown.stdout) as SessionDetail;
      expect(shownDetail.id).toBe(detail.id);
      expect(shownDetail.workspace).toBe(workspace);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it("sessions list --instance bogus → exit 2 (ProfileNotFound)", async () => {
    const r = await runCli(["sessions", "list", "--instance", "bogus"], dataEnv());
    expect(r.code).toBe(2);
  }, 20_000);

  it("a profile pointing at a dead port → exit 6 (Unreachable)", async () => {
    // A just-released ephemeral port has nothing listening → ECONNREFUSED.
    const deadPort = await getFreePort();
    const dir = mkdtempSync(join(tmpdir(), "valet-cli-e2e-dead-"));
    writeFileSync(
      join(dir, "config.json"),
      `${JSON.stringify({
        profiles: { dead: { url: `http://localhost:${deadPort}` } },
        defaultProfile: "dead",
      })}\n`,
    );
    try {
      const r = await runCli(["status"], { VALET_DATA_DIR: dir });
      expect(r.code, `stdout: ${r.stdout} stderr: ${r.stderr}`).toBe(6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("unknown command → exit 2 (Usage)", async () => {
    const r = await runCli(["definitely-not-a-command"], dataEnv());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown command");
  }, 20_000);

  it("login (keyless) → instance list → logout against the stub serve", async () => {
    // Use a SEPARATE data dir so login's config writes never clobber the
    // serve's own implicit `local` profile that the other cases depend on.
    const dir = mkdtempSync(join(tmpdir(), "valet-cli-e2e-login-"));
    try {
      // Keyless login: stub serve's `me()` returns 200 with no credential.
      const login = await runCli(["login", serve.url, "--api-key", "", "--name", "e2e"], {
        VALET_DATA_DIR: dir,
      });
      expect(login.code, `stderr: ${login.stderr}`).toBe(0);

      const listed = await runCli(["instance", "list", "--json"], { VALET_DATA_DIR: dir });
      expect(listed.code, `stderr: ${listed.stderr}`).toBe(0);
      const parsed = JSON.parse(listed.stdout) as InstanceListJson;
      expect(parsed.profiles.e2e).toBeDefined();
      expect(parsed.profiles.e2e.url).toBe(serve.url);
      expect(parsed.profiles.e2e.hasKey).toBe(false);
      expect(parsed.defaultProfile).toBe("e2e");

      const logout = await runCli(["logout", "e2e"], { VALET_DATA_DIR: dir });
      expect(logout.code, `stderr: ${logout.stderr}`).toBe(0);

      const after = await runCli(["instance", "list", "--json"], { VALET_DATA_DIR: dir });
      const afterParsed = JSON.parse(after.stdout) as InstanceListJson;
      expect(afterParsed.profiles.e2e).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  // ── handoff (keyless: delivery is HTTP + DB; no turn is awaited) ───────────
  // The --new-session path is NOT driven here: with a repo binding the serve
  // would try a real `git clone` during workspace prep. It's covered by the
  // stub-deps unit suite (handoff.test.ts).
  describe("handoff", () => {
    it("handoff <file> --session delivers the doc with a provenance header", async () => {
      const workspace = mkdtempSync(join(tmpdir(), "valet-cli-e2e-ho-ws-"));
      const docDir = mkdtempSync(join(tmpdir(), "valet-cli-e2e-ho-doc-"));
      const docPath = join(docDir, "handoff.md");
      writeFileSync(docPath, "# Fix the flaky test\n\nDetails of the handoff.\n");
      try {
        const created = await runCli(["sessions", "new", "--workspace", workspace, "--json"], dataEnv());
        expect(created.code, `stderr: ${created.stderr}`).toBe(0);
        const session = JSON.parse(created.stdout) as SessionDetail;

        const r = await runCli(["handoff", docPath, "--session", session.id, "--json"], dataEnv());
        expect(r.code, `stderr: ${r.stderr}`).toBe(0);
        const receipt = JSON.parse(r.stdout) as {
          sessionId: string;
          threadId: string;
          messageId: string;
          url: string;
        };
        expect(receipt.sessionId).toBe(session.id);
        expect(receipt.messageId).not.toBe("");
        expect(receipt.threadId).not.toBe("");
        expect(new URL(receipt.url).pathname).toBe(`/threads/${encodeURIComponent(receipt.threadId)}`);

        const status = await runCli(["status", "--thread", receipt.threadId, "--json"], dataEnv());
        expect(status.code, `stderr: ${status.stderr}`).toBe(0);
        expect(JSON.parse(status.stdout)).toMatchObject({ thread: { id: receipt.threadId }, runtime: { id: session.id } });
        const followup = await runCli(["handoff", docPath, "--thread", receipt.threadId, "--json"], dataEnv());
        expect(followup.code, `stderr: ${followup.stderr}`).toBe(0);
        expect(JSON.parse(followup.stdout)).toMatchObject({ sessionId: session.id, threadId: receipt.threadId, url: receipt.url });

        // The doc must be persisted as a user message carrying the provenance
        // header — read it back over the same REST surface the web UI uses.
        const res = await fetch(
          `${serve.url}/api/sessions/${session.id}/messages?threadId=${encodeURIComponent(receipt.threadId)}`,
        );
        expect(res.status).toBe(200);
        const bodyText = JSON.stringify(await res.json());
        expect(bodyText).toContain("[Handoff from ");
        expect(bodyText).toContain("Fix the flaky test");
      } finally {
        rmSync(workspace, { recursive: true, force: true });
        rmSync(docDir, { recursive: true, force: true });
      }
    }, 60_000);

    it("handoff without a doc → exit 2 (Usage)", async () => {
      const r = await runCli(["handoff"], dataEnv());
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("handoff doc is required");
    }, 20_000);

    it("handoff --session and --new-session together → exit 2 (Usage)", async () => {
      const r = await runCli(["handoff", "doc.md", "--session", "s1", "--new-session"], dataEnv());
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("mutually exclusive");
    }, 20_000);
  });

  // ── Turn-dependent: needs a REAL ANTHROPIC_API_KEY. SKIPS without one. ──────
  describeIfKey("turn-dependent (real ANTHROPIC_API_KEY)", () => {
    it("send --json drives a turn to completed → NDJSON wire events, exit 0", async () => {
      const r = await runCli(["send", "say hi", "--json"], dataEnv());
      expect(r.code, `stderr: ${r.stderr}`).toBe(0);

      const events = r.stdout
        .trim()
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as WireEvent);
      // completed→0 mapping: a matching settle must have appeared on the stream.
      const settled = events.filter((e) => e.type === "submission.settled");
      expect(settled.length).toBeGreaterThan(0);
      expect(settled.some((e) => e.type === "submission.settled" && e.outcome === "completed")).toBe(true);
    }, 120_000);

    it("handoff to the orchestrator with --wait follows the turn to exit 0", async () => {
      const docDir = mkdtempSync(join(tmpdir(), "valet-cli-e2e-ho-wait-"));
      const docPath = join(docDir, "handoff.md");
      writeFileSync(docPath, "# Quick check\n\nReply with the single word: done.\n");
      try {
        const r = await runCli(["handoff", docPath, "--wait", "--json"], dataEnv(), 150_000);
        expect(r.code, `stderr: ${r.stderr}`).toBe(0);
        // Output is the pretty-printed receipt (multi-line JSON) followed by
        // one NDJSON wire event per line (--wait streams the turn).
        expect(r.stdout).toMatch(/"sessionId":\s*"[^"]+"/);
        const events = r.stdout
          .split("\n")
          .filter((l) => l.startsWith("{") && l.trimEnd().endsWith("}"))
          .flatMap((l) => {
            try {
              const parsed = JSON.parse(l) as WireEvent;
              return "type" in parsed ? [parsed] : [];
            } catch {
              return [];
            }
          });
        expect(events.length).toBeGreaterThan(0);
      } finally {
        rmSync(docDir, { recursive: true, force: true });
      }
    }, 180_000);

    it("gates list --json → exit 0 (empty list is fine)", async () => {
      const r = await runCli(["gates", "list", "--json"], dataEnv());
      expect(r.code, `stderr: ${r.stderr}`).toBe(0);
      const parsed = JSON.parse(r.stdout) as { gates: DecisionGate[] };
      expect(Array.isArray(parsed.gates)).toBe(true);
    }, 60_000);
  });
});

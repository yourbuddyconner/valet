/**
 * Integration test: Phase 4 exit-criteria E2E — the full orchestrator loop
 * (roadmap "Exit Criteria (phase gate)" section, Task 10).
 *
 * Flow under test:
 *   1. Import the OKF fixture bundle (`test/fixtures/okf-bundle/`, decision
 *      24) for the user scope, trusted. index.md is skipped. The imported
 *      `preferences/style.md` is then pinned via a metadata-only
 *      `writeFile` call (decision 24: pinned isn't importable — import
 *      never sets it, see `services/memory.ts` `importFiles`).
 *   2. Ensure the orchestrator, prompt it with no-tool instructions, and
 *      assert ZERO sandbox creates AND that the pinned file's content
 *      landed in the assembled memory snapshot (systemContext), same
 *      assertion idiom as `orchestrator.test.ts`.
 *   3. Prompt the orchestrator to use the `task` tool to spawn a real
 *      Docker child running `bash echo p4-loop-ok`; await the
 *      `child.settled` signal entry on the spawning thread and confirm the
 *      child's own transcript actually ran the echo.
 *   4. Prompt the orchestrator to append a note to today's journal via
 *      `mem_patch`; assert the journal row updated.
 *
 * Key-gated (real Anthropic) AND docker-gated (the child runs in a real
 * Docker sandbox, mirroring Phase 3's suites) — skipped entirely otherwise.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { VirtualSandboxProvider, type Sandbox, type SandboxCreateOpts, type SandboxProvider } from "@valet/engine";
import { bootTestApi, type TestApi } from "./_setup.js";
import { driveTurn } from "./_test-utils.js";
import { internalToken } from "../lib/internal-auth.js";
import { childWatches, memoryFiles } from "../schema/index.js";
import { readFile as readMemoryFile } from "../services/memory.js";
import type { EnsureWorkspaceRuntimeResponse } from "../wire/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, "..", "..", "test", "fixtures", "okf-bundle");

/** Recursively loads every `.md` file under `FIXTURE_ROOT` into the
 * `{ path → content }` shape `POST /api/memory/import` accepts, keyed by
 * path relative to the bundle root (matching the export manifest shape). */
function loadFixtureBundle(): Record<string, string> {
  const files: Record<string, string> = {};
  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".md")) {
        const rel = relative(FIXTURE_ROOT, full).split("\\").join("/");
        files[rel] = readFileSync(full, "utf8");
      }
    }
  }
  walk(FIXTURE_ROOT);
  return files;
}

/** Memoized `docker info` probe — same idiom as
 * `packages/sandbox-docker/test/docker-sandbox.test.ts`. */
function dockerAvailable(): boolean {
  if (process.env.VALET_SKIP_DOCKER_TESTS === "1") return false;
  const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe" });
  return r.status === 0;
}

class CreateCountingSandboxProvider implements SandboxProvider {
  creates = 0;
  private readonly inner = new VirtualSandboxProvider();
  readonly backend = this.inner.backend;
  capabilities() {
    return this.inner.capabilities();
  }
  async create(opts: SandboxCreateOpts): Promise<Sandbox> {
    this.creates++;
    return this.inner.create(opts);
  }
  restore(id: string): Promise<Sandbox> {
    return this.inner.restore(id);
  }
  destroy(id: string): Promise<void> {
    return this.inner.destroy(id);
  }
  status(id: string) {
    return this.inner.status(id);
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("waitFor: timed out");
}

const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
const hasDocker = dockerAvailable();
const describeE2E = hasKey && hasDocker ? describe : describe.skip;

if (!hasKey || !hasDocker) {
  // eslint-disable-next-line no-console
  console.warn(
    `orchestrator-loop.test.ts skipped (ANTHROPIC_API_KEY: ${hasKey ? "present" : "MISSING"}, docker: ${hasDocker ? "available" : "unavailable"})`,
  );
}

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
}, 30_000);

describeE2E("api integration: phase 4 exit criteria — full orchestrator loop", () => {
  it(
    "import fixture -> sandbox-less wake with snapshot -> task-spawns a Docker child -> child.settled -> mem_patch journals",
    async () => {
      const counter = new CreateCountingSandboxProvider();
      api = await bootTestApi({ sandboxProvider: counter });

      // ── 1. Import the OKF bundle, trusted, then pin style.md ──────────
      const files = loadFixtureBundle();
      expect(Object.keys(files).length).toBeGreaterThanOrEqual(6);

      const importRes = await fetch(`${api.baseUrl}/api/memory/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-valet-internal": internalToken(),
          "x-valet-owner": "user:local-user",
          "x-valet-actor": "local-user",
        },
        body: JSON.stringify({ files, trusted: true }),
      });
      expect(importRes.status).toBe(200);
      const importBody = (await importRes.json()) as {
        imported: string[];
        skipped: Array<{ path: string; reason: string }>;
      };
      // index.md is skipped (decision 24) — everything else imports.
      expect(importBody.skipped.some((s) => s.path === "index.md")).toBe(true);
      expect(importBody.imported).toEqual(
        expect.arrayContaining([
          "preferences/style.md",
          "people/alice.md",
          "projects/valet/overview.md",
          "journal/2026-07-10.md",
          "notes/extras.md",
        ]),
      );

      // pinned isn't importable via the OKF frontmatter path (dropped as an
      // unknown `valet.pinned` key) — set it explicitly, metadata-only.
      const { db } = api.providers;
      const pinRes = await fetch(`${api.baseUrl}/api/memory`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-valet-internal": internalToken(),
          "x-valet-owner": "user:local-user",
          "x-valet-actor": "local-user",
        },
        body: JSON.stringify({ path: "preferences/style.md", pinned: true }),
      });
      expect(pinRes.status).toBe(200);

      const pinnedRows = await db
        .select()
        .from(memoryFiles)
        .where(eq(memoryFiles.path, "preferences/style.md"))
        .limit(1);
      const pinnedRow = pinnedRows[0];
      expect(pinnedRow?.pinned).toBe(true);

      // ── 2. Ensure orchestrator, no-tool turn, zero sandbox creates + snapshot present ──
      const ensureRes = await fetch(`${api.baseUrl}/api/workspaces/user/runtime`, { method: "POST" });
      expect(ensureRes.status).toBe(200);
      const { sessionId } = (await ensureRes.json()) as EnsureWorkspaceRuntimeResponse;

      const session = api.providers.engineHost.liveSession(sessionId);
      expect(session).not.toBeNull();
      const fragments = session?.options.systemContext ?? [];
      const snapshotFragment = fragments.find((f) => f.name === "memory-snapshot");
      expect(snapshotFragment).toBeDefined();
      expect(snapshotFragment?.content).toContain("Prefer tabs over spaces");
      expect(snapshotFragment?.content).toContain("preferences/style.md");

      await driveTurn({
        baseUrl: api.baseUrl,
        wsUrl: api.wsUrl,
        sessionId,
        prompt: "Introduce yourself in one short sentence. Do not use any tools.",
        timeoutMs: 60_000,
      });

      expect(counter.creates).toBe(0);

      // ── 3. task -> real Docker child echoes p4-loop-ok -> child.settled ──
      await driveTurn({
        baseUrl: api.baseUrl,
        wsUrl: api.wsUrl,
        sessionId,
        prompt:
          "Use the task tool exactly once to spawn a child session with the prompt " +
          '"Run the bash command `echo p4-loop-ok` and then stop." and the title ' +
          '"p4-loop-child". After the tool returns, reply \'spawned\' and stop. ' +
          "Do not use any other tools.",
        timeoutMs: 90_000,
      });

      const watchRows = await db.select().from(childWatches).where(eq(childWatches.parentSessionId, sessionId));
      expect(watchRows).toHaveLength(1);
      const watch = watchRows[0];

      await waitFor(async () => {
        const rows = await api!.providers.db
          .select()
          .from(childWatches)
          .where(eq(childWatches.childSessionId, watch.childSessionId))
          .limit(1);
        return rows[0]?.settled === true;
      }, 120_000);

      const parent = api.providers.engineHost.liveSession(sessionId);
      expect(parent).not.toBeNull();
      await waitFor(async () => {
        const entries = (await parent!.readEntries("web:default")) ?? [];
        return entries.some(
          (e) =>
            e.type === "message" &&
            e.signal?.signalType === "child.settled" &&
            e.signal.attributes?.child_session_id === watch.childSessionId,
        );
      }, 30_000);

      // The child actually ran the echo — its own transcript contains the
      // command's output. The watcher evicts the settled child from the
      // cache (compute reclaim), so rehydrate it from the store — this also
      // proves the transcript survives the settle teardown.
      const childData = await api.providers.engineStore.getSession(watch.childSessionId);
      expect(childData).not.toBeNull();
      const child = await api.providers.engineHost.sessionFor(watch.childSessionId, {
        userId: childData!.userId,
        orgId: childData!.orgId,
        workspace: childData!.workspace,
      });
      const childEntries = (await child.readEntries("web:default")) ?? [];
      const childText = JSON.stringify(childEntries);
      expect(childText).toContain("p4-loop-ok");

      // ── 4. mem_patch appends a note to today's journal ─────────────────
      const todayPath = `journal/${new Date().toISOString().slice(0, 10)}.md`;
      const before = await readMemoryFile(db, { owner: { type: "user", id: "local-user" }, actorUserId: "local-user" }, todayPath);
      const beforeContent = before.kind === "file" ? before.file.content : "";

      await driveTurn({
        baseUrl: api.baseUrl,
        wsUrl: api.wsUrl,
        sessionId,
        prompt:
          "Use mem_patch exactly once to append the exact line " +
          '"p4-loop journal note" to the end of today\'s journal file, ' +
          "then reply 'journaled' and stop. Do not use any other tools.",
        timeoutMs: 60_000,
      });

      const after = await readMemoryFile(db, { owner: { type: "user", id: "local-user" }, actorUserId: "local-user" }, todayPath);
      if (after.kind !== "file") throw new Error("expected today's journal to be a file");
      expect(after.file.content).not.toBe(beforeContent);
      expect(after.file.content).toContain("p4-loop journal note");
    },
    300_000,
  );
});

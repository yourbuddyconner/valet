/**
 * Product-mode driver (adversarial-review finding 8).
 *
 * `drive: product` cases measure the PRODUCTION agent, not a lab replica:
 * the harness boots the real api in-process (fresh scratch PGlite per case
 * — no cross-case state), ensures the real orchestrator session over
 * `POST /api/workspaces/user/runtime` (real persona, real HTTP-backed mem_* tools,
 * real plugin catalog and policy, real ChildWatcher), and drives every
 * turn over the public message route. Reads go through the back door: the
 * harness owns the providers, so settlement is polled on the engine store
 * and trajectories extract from the same entries production persists.
 *
 * This is the drive-through-the-front-door / read-through-the-back-door
 * shape from the original eval-harness design discussion on TKAI-213.
 *
 * Scope: `session_type: orchestrator` only — the orchestrator IS the
 * production agent surface. Plain interactive product sessions (Docker
 * workspace provisioning per case) can be added behind the same seam.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { createApp } from "@valet/api/app";
import { buildNodeProviders } from "@valet/api/providers-node";
import { listChildSessions } from "@valet/api/eval-flagged";
import type { SessionEntry } from "@valet/engine";
import { interpolateTurnContent, type CaseOutcome, type CaseRunResult } from "./runner.js";
import { extractTrajectory, findSpawnCallId } from "./trajectory.js";
import type { EvalCase, Trajectory } from "./types.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const POLL_MS = 150;
/** Extra settle-wait after the last submission, for straggler child signals. */
const QUIESCENCE_MS = 1_000;

export interface ProductDriveOptions {
  /** Model spec for the run. The orchestrator's own model resolution still
   * applies; this is recorded on the trajectory for comparison keys. */
  model: string;
  timeoutMs?: number;
  /** API key for the booted api's engine host. Default: process env. */
  anthropicApiKey?: string;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        rejectPort(new Error("could not allocate a port"));
        return;
      }
      srv.close(() => resolvePort(addr.port));
    });
    srv.on("error", rejectPort);
  });
}

/** Run one `drive: product` case against a freshly booted in-process api. */
export async function runProductCase(evalCase: EvalCase, opts: ProductDriveOptions): Promise<CaseRunResult> {
  if (evalCase.session_type !== "orchestrator") {
    throw new Error(
      `case ${evalCase.id}: drive: product currently requires session_type: orchestrator ` +
        "(the production agent surface). Set session_type, or use the engine drive.",
    );
  }
  const apiKey = opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(`case ${evalCase.id}: drive: product needs ANTHROPIC_API_KEY (the booted api makes real LLM calls).`);
  }

  const timeoutMs = evalCase.timeout_ms ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  const root = await mkdtemp(join(tmpdir(), `valet-eval-product-${evalCase.id}-`));
  const port = await getFreePort();
  const prevLocalAuth = process.env.VALET_LOCAL_AUTH;
  process.env.VALET_LOCAL_AUTH = "1";
  const providers = await buildNodeProviders({
    pgDataDir: resolve(root, "pg"),
    blobsRoot: resolve(root, "blobs"),
    encryptionKey: "eval",
    anthropicApiKey: apiKey,
    apiBaseUrl: `http://127.0.0.1:${port}`,
  });
  const { startServer } = createApp(providers);
  const server = await new Promise<ReturnType<typeof startServer>>((resolveListen) => {
    const s = startServer({ port, onListen: () => resolveListen(s) });
  });
  const baseUrl = `http://127.0.0.1:${port}`;

  const shutdown = async (): Promise<void> => {
    try {
      await providers.engineHost.destroyAll();
    } catch {
      // Sandboxes are virtual/absent for orchestrator cases; best-effort.
    }
    await server.close();
    if (prevLocalAuth === undefined) delete process.env.VALET_LOCAL_AUTH;
    else process.env.VALET_LOCAL_AUTH = prevLocalAuth;
    await rm(root, { recursive: true, force: true });
  };

  try {
    // ── The real orchestrator session, through the front door.
    const ensureRes = await fetch(`${baseUrl}/api/workspaces/user/runtime`, { method: "POST" });
    if (!ensureRes.ok) {
      throw new Error(`ensure orchestrator failed: ${ensureRes.status} ${await ensureRes.text()}`);
    }
    const { sessionId } = (await ensureRes.json()) as { sessionId: string };

    const remaining = (): number => deadline - Date.now();
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

    let outcome: CaseOutcome = "completed";
    let error: string | undefined;
    let threadId: string | undefined;
    let lastOutput: string | undefined;

    const lastAssistantText = async (): Promise<string | undefined> => {
      if (threadId === undefined) return undefined;
      const entries = await providers.engineStore.getEntries(sessionId, threadId);
      const assistant = [...entries]
        .reverse()
        .find((e): e is SessionEntry & { content: string } => e.type === "message" && e.role === "assistant");
      return assistant?.content;
    };

    const awaitSettled = async (queueItemId: string): Promise<boolean> => {
      for (;;) {
        if (remaining() <= 0) {
          outcome = "timeout";
          error = `case timed out after ${timeoutMs}ms`;
          return false;
        }
        const item = await providers.engineStore.getQueueItem(sessionId, queueItemId);
        if (item?.status === "settled") {
          const o = item.outcome?.outcome;
          if (o === "failed" || o === "aborted") {
            outcome = o;
            error = item.outcome?.error ?? `submission ${o}`;
            return false;
          }
          return true;
        }
        await sleep(POLL_MS);
      }
    };

    // Wait until nothing is running: no unsettled submissions and no
    // unsettled child watches, held for QUIESCENCE_MS (a settling child
    // admits a new parent signal turn).
    const awaitQuiescence = async (): Promise<boolean> => {
      let quietSince: number | undefined;
      for (;;) {
        if (remaining() <= 0) {
          outcome = "timeout";
          error = `case timed out after ${timeoutMs}ms waiting for quiescence`;
          return false;
        }
        const unsettled = await providers.engineStore.listUnsettledSubmissions(sessionId);
        const children = await listChildSessions(providers.db, sessionId);
        const busy = unsettled.length > 0 || children.some((c) => !c.settled);
        if (busy) {
          quietSince = undefined;
        } else if (quietSince === undefined) {
          quietSince = Date.now();
        } else if (Date.now() - quietSince >= QUIESCENCE_MS) {
          return true;
        }
        await sleep(POLL_MS);
      }
    };

    for (const [i, turn] of evalCase.turns.entries()) {
      let content: string;
      try {
        content = interpolateTurnContent(turn.content, lastOutput);
      } catch (err) {
        outcome = "failed";
        error = `turn ${i + 1}: ${err instanceof Error ? err.message : String(err)}`;
        break;
      }
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: content }),
      });
      if (!res.ok) {
        outcome = "failed";
        error = `POST message failed: ${res.status} ${await res.text()}`;
        break;
      }
      const body = (await res.json()) as { messageId: string | null; threadId: string };
      threadId = body.threadId;
      if (body.messageId === null) {
        outcome = "failed";
        error = "the prompt executed as a slash command; eval turns must be prompts";
        break;
      }
      if (!(await awaitSettled(body.messageId))) break;
      if (!(await awaitQuiescence())) break;
      lastOutput = await lastAssistantText();
    }

    // ── Read through the back door: the production-persisted entries.
    const durationMs = Date.now() - startedAt;
    const entries =
      threadId !== undefined ? await providers.engineStore.getEntries(sessionId, threadId) : [];

    const childTrajectories: Trajectory[] = [];
    const children = await listChildSessions(providers.db, sessionId);
    for (const [i, child] of children.entries()) {
      const childThreads = await providers.engineStore.listThreads(child.childSessionId);
      const childEntries: SessionEntry[] = [];
      for (const t of childThreads) {
        childEntries.push(...(await providers.engineStore.getEntries(child.childSessionId, t.id)));
      }
      const trajectory = extractTrajectory({
        caseId: `${evalCase.id}#child-${i}`,
        prompt:
          childEntries.find((e): e is SessionEntry & { content: string } => e.type === "message" && e.role === "user")
            ?.content ?? "",
        model: opts.model,
        durationMs: 0,
        entries: childEntries,
      });
      const spawnCall = findSpawnCallId(entries, child.childSessionId);
      if (spawnCall !== undefined) trajectory.spawnedByCallId = spawnCall;
      childTrajectories.push(trajectory);
    }

    const trajectory = extractTrajectory({
      caseId: evalCase.id,
      prompt: evalCase.turns[0].content,
      model: opts.model,
      durationMs,
      entries,
      metadata: { drive: "product", sessionId },
      children: childTrajectories,
    });

    return { trajectory, outcome, ...(error !== undefined ? { error } : {}) };
  } finally {
    await shutdown();
  }
}

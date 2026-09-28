/**
 * `valet handoff <file> [--session <id> | --new-session] [--repo <o/n>]
 *                [--title <t>] [--wait] [--json]`
 *
 * Hands work off from a local coding agent to Valet. The agent writes a
 * handoff doc (markdown) to a file and this command delivers it as a message
 * to the caller's orchestrator (default), an existing session, or a freshly
 * created one. See `docs/specs/2026-07-25-handoff-cli-design.md`.
 *
 * Structure mirrors `send.ts`: `run` is a thin shell (resolve instance, build
 * the client + real side-effect deps, delegate); `runHandoff` and its helpers
 * are pure over an injected `HandoffDeps` so tests use stubs — no fs, no git,
 * no live WS.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { InstanceClient } from "../client.js";
import { ExitCode } from "../exit.js";
import { parseGlobalFlags, printErr, printJson, printLine, type ParsedFlags } from "../output.js";
import { resolveInstance } from "../resolve.js";
import { streamSession } from "../stream.js";
import { consumeSend, type StreamFn } from "./send.js";
import type { CliContext } from "../types.js";
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  EnsureWorkspaceRuntimeResponse,
  RepoBinding,
  SendPromptRequest,
  SendPromptResponse,
} from "../../wire/types.js";

/** The subset of `InstanceClient` the `handoff` command needs. */
export interface HandoffClient {
  ensureOrchestrator(): Promise<EnsureWorkspaceRuntimeResponse>;
  createSession(body: CreateSessionRequest): Promise<CreateSessionResponse>;
  sendPrompt(id: string, body: SendPromptRequest): Promise<SendPromptResponse>;
}

export interface HandoffDeps {
  client: HandoffClient;
  stream: StreamFn;
  url: string;
  apiKey?: string;
  /** Read all of stdin (for `-`). Injectable for tests. */
  readStdin(): Promise<string>;
  /** Read a doc file (throws on missing/unreadable). Injectable for tests. */
  readFile(path: string): string;
  /** `git remote get-url origin` in cwd, or undefined when absent/not a repo. */
  gitRemoteUrl(): string | undefined;
  /** Provenance for the message header. */
  env: { host: string; cwd: string };
}

/** How long `--wait` follows the turn before giving up (the handoff itself
 * has already been delivered by then, so timing out still exits OK). */
const WAIT_TIMEOUT_MS = 120_000;

/**
 * Parse a git remote URL into a `RepoBinding`. Handles the common GitHub
 * shapes (`git@host:owner/name.git`, `https://host/owner/name[.git]`);
 * returns undefined for anything else.
 */
export function parseGitRemote(remote: string): RepoBinding | undefined {
  const m =
    /^git@[^:/\s]+:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(remote.trim()) ??
    /^https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (!m) return undefined;
  const fullName = `${m[1]}/${m[2]}`;
  return { fullName, cloneUrl: `https://github.com/${fullName}.git` };
}

/** First `# ` heading of the doc, if any — the default `--new-session` title. */
export function inferTitle(doc: string): string | undefined {
  for (const line of doc.split("\n")) {
    const m = /^#\s+(.+)$/.exec(line);
    if (m) return m[1].trim();
  }
  return undefined;
}

/** One-line header prepended to the message so the receiver knows provenance. */
export function provenanceHeader(env: { host: string; cwd: string }): string {
  return `[Handoff from ${env.host}:${env.cwd}]`;
}

/**
 * Read a boolean flag, tolerating the parser's `--flag value` greediness:
 * `--new-session doc.md` parses as `{ "new-session": "doc.md" }`, so a string
 * value means "flag present, and its value is really a positional" — the
 * value is pushed back onto `rest`.
 */
function takeBooleanFlag(flags: ParsedFlags, name: string): boolean {
  const v = flags.flags[name];
  if (v === undefined) return false;
  if (typeof v === "string") flags.rest.push(v);
  return true;
}

/** Resolve the doc content: positional path, `--file`, or `-` for stdin. */
export async function resolveDoc(deps: HandoffDeps, flags: ParsedFlags): Promise<string | undefined> {
  const fileFlag = typeof flags.flags.file === "string" ? flags.flags.file : undefined;
  const source = flags.rest[0] ?? fileFlag;
  if (source === undefined) return undefined;
  if (source === "-") return deps.readStdin();
  return deps.readFile(source);
}

interface Receipt {
  sessionId: string;
  threadId: string;
  messageId: string;
  url: string;
}

function printReceipt(receipt: Receipt, json: boolean): void {
  if (json) {
    printJson(receipt);
  } else {
    printLine(`handed off to ${receipt.sessionId}`);
    printLine(receipt.url);
  }
}

/** Pure entry: read the doc, resolve the target, send, print the receipt. */
export async function runHandoff(deps: HandoffDeps, flags: ParsedFlags): Promise<number> {
  const newSession = takeBooleanFlag(flags, "new-session");
  const wait = takeBooleanFlag(flags, "wait");
  const sessionFlag = typeof flags.flags.session === "string" ? flags.flags.session : undefined;

  if (sessionFlag !== undefined && newSession) {
    printErr("valet handoff: --session and --new-session are mutually exclusive");
    return ExitCode.Usage;
  }

  let doc: string | undefined;
  try {
    doc = await resolveDoc(deps, flags);
  } catch (err) {
    printErr(`valet handoff: could not read doc: ${err instanceof Error ? err.message : String(err)}`);
    return ExitCode.Usage;
  }
  if (doc === undefined) {
    printErr("valet handoff: a handoff doc is required (a file path, --file <path>, or - for stdin)");
    return ExitCode.Usage;
  }
  if (doc.trim() === "") {
    printErr("valet handoff: the handoff doc is empty");
    return ExitCode.Usage;
  }

  let sessionId: string;
  if (sessionFlag !== undefined) {
    sessionId = sessionFlag;
  } else if (newSession) {
    const repoFlag = typeof flags.flags.repo === "string" ? flags.flags.repo : undefined;
    const repo: RepoBinding | undefined =
      repoFlag !== undefined
        ? { fullName: repoFlag, cloneUrl: `https://github.com/${repoFlag}.git` }
        : (() => {
            const remote = deps.gitRemoteUrl();
            return remote === undefined ? undefined : parseGitRemote(remote);
          })();
    if (repo === undefined) {
      printErr(
        "valet handoff: --new-session needs a repo — pass --repo <owner/name> (no usable git remote in cwd)",
      );
      return ExitCode.Usage;
    }
    const baseName = repo.fullName.split("/")[1];
    const title = typeof flags.flags.title === "string" ? flags.flags.title : inferTitle(doc);
    const body: CreateSessionRequest = { workspace: `/workspace/${baseName}`, profile: "full", repo };
    if (title !== undefined) body.title = title;
    sessionId = (await deps.client.createSession(body)).id;
  } else {
    sessionId = (await deps.client.ensureOrchestrator()).sessionId;
  }

  const text = `${provenanceHeader(deps.env)}\n\n${doc}`;
  let sent: SendPromptResponse;
  try {
    sent = await deps.client.sendPrompt(sessionId, { text });
  } catch (err) {
    if (newSession) {
      printErr(`session ${sessionId} was created but the handoff was not delivered.`);
      printErr(`retry with: valet handoff --session ${sessionId} <file>`);
    }
    throw err;
  }

  const receipt: Receipt = {
    sessionId,
    threadId: sent.threadId,
    messageId: sent.messageId ?? "",
    url: `${deps.url}/sessions/${sessionId}`,
  };
  printReceipt(receipt, flags.json);

  if (!wait) return ExitCode.OK;
  // A null messageId means the text ran as a slash command — it executed
  // immediately and took no queue item, so there is no turn to follow.
  const sentMessageId = sent.messageId;
  if (sentMessageId === null) return ExitCode.OK;

  // Follow the turn like `send` does, but bounded: the handoff is already
  // delivered, so a quiet target should not hang the calling agent.
  const timeout = new Promise<number>((resolve) => {
    const t = setTimeout(() => {
      printErr("valet handoff: timed out waiting for a response (handoff was delivered)");
      resolve(ExitCode.OK);
    }, WAIT_TIMEOUT_MS);
    t.unref();
  });
  const follow = consumeSend(
    { stream: deps.stream, url: deps.url, apiKey: deps.apiKey },
    { sessionId, messageId: sentMessageId, threadId: sent.threadId, json: flags.json },
  );
  return Promise.race([follow, timeout]);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function gitRemoteUrl(): string | undefined {
  try {
    const out = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
}

export async function run(args: string[], ctx: CliContext): Promise<number> {
  const flags = parseGlobalFlags(args);
  const instance = resolveInstance({
    flag: typeof flags.flags.instance === "string" ? flags.flags.instance : undefined,
    env: process.env.VALET_INSTANCE,
    config: ctx.config,
  });
  const client = new InstanceClient({ url: instance.url, apiKey: instance.apiKey });
  return runHandoff(
    {
      client,
      stream: streamSession,
      url: instance.url,
      apiKey: instance.apiKey,
      readStdin,
      readFile: (path) => readFileSync(path, "utf8"),
      gitRemoteUrl,
      env: { host: hostname(), cwd: process.cwd() },
    },
    flags,
  );
}

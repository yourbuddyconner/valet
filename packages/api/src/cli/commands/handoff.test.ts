import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ExitCode } from "../exit.js";
import { parseGlobalFlags } from "../output.js";
import {
  inferTitle,
  parseGitRemote,
  provenanceHeader,
  runHandoff,
  type HandoffClient,
  type HandoffDeps,
} from "./handoff.js";
import type { CreateSessionRequest, SendPromptRequest, WireEvent } from "../../wire/types.js";

const DOC = "# Fix the flaky login test\n\nDetails and next steps.\n";

function settled(
  outcome: Extract<WireEvent, { type: "submission.settled" }>["outcome"],
  queueItemId = "q1",
  threadId = "t1",
): WireEvent {
  return { seq: 1, ts: 1, type: "submission.settled", sessionId: "s1", threadId, queueItemId, outcome };
}
function textDelta(delta: string, threadId = "t1"): WireEvent {
  return { seq: 1, ts: 1, type: "text_delta", threadId, messageId: "m1", delta };
}

interface StubOpts {
  files?: Record<string, string>;
  stdin?: string;
  remote?: string;
  createError?: Error;
  sendError?: Error;
  events?: WireEvent[];
}

function stubDeps(opts: StubOpts = {}): {
  deps: HandoffDeps;
  sent: { id: string; body: SendPromptRequest }[];
  created: CreateSessionRequest[];
  ensureCalls: () => number;
} {
  const sent: { id: string; body: SendPromptRequest }[] = [];
  const created: CreateSessionRequest[] = [];
  let ensureCalls = 0;
  const client: HandoffClient = {
    getThread: async () => ({ sessionId: "s1" }),
    ensureOrchestrator: () => {
      ensureCalls += 1;
      return Promise.resolve({ sessionId: "orch_1" });
    },
    createSession: (body) => {
      if (opts.createError) return Promise.reject(opts.createError);
      created.push(body);
      return Promise.resolve({
        id: "new_1",
        status: "active",
        kind: "code",
        runState: "idle",
        owner: { type: "user" as const, id: "u1" },
        workspace: body.workspace,
        createdAt: 1,
        updatedAt: 1,
        lastActivityAt: 1,
        messageCount: 0,
        profile: body.profile ?? "headless",
        docker: body.docker ?? false,
      });
    },
    sendPrompt: (id, body) => {
      if (opts.sendError) return Promise.reject(opts.sendError);
      sent.push({ id, body });
      return Promise.resolve({ messageId: "q1", threadId: "t1", activityAt: 1 });
    },
  };
  const deps: HandoffDeps = {
    client,
    stream: () =>
      (async function* () {
        for (const e of opts.events ?? []) yield e;
      })(),
    url: "http://inst",
    apiKey: undefined,
    readStdin: () => Promise.resolve(opts.stdin ?? ""),
    readFile: (path) => {
      const content = opts.files?.[path];
      if (content === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      return content;
    },
    gitRemoteUrl: () => opts.remote,
    env: { host: "myhost", cwd: "/home/me/proj" },
  };
  return { deps, sent, created, ensureCalls: () => ensureCalls };
}

let outSpy: MockInstance;
let errSpy: MockInstance;
beforeEach(() => {
  outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());
const stdout = (): string => outSpy.mock.calls.map((c) => String(c[0])).join("");
const stderr = (): string => errSpy.mock.calls.map((c) => String(c[0])).join("");

describe("parseGitRemote", () => {
  it("parses ssh remotes", () => {
    expect(parseGitRemote("git@github.com:owner/name.git")).toEqual({
      fullName: "owner/name",
      cloneUrl: "https://github.com/owner/name.git",
    });
  });
  it("parses https remotes with and without .git", () => {
    expect(parseGitRemote("https://github.com/owner/name.git")?.fullName).toBe("owner/name");
    expect(parseGitRemote("https://github.com/owner/name")?.fullName).toBe("owner/name");
  });
  it("returns undefined for unparseable remotes", () => {
    expect(parseGitRemote("not a remote")).toBeUndefined();
    expect(parseGitRemote("")).toBeUndefined();
  });
});

describe("inferTitle", () => {
  it("takes the first # heading", () => {
    expect(inferTitle(DOC)).toBe("Fix the flaky login test");
  });
  it("skips deeper headings and returns undefined without an h1", () => {
    expect(inferTitle("## sub\nbody")).toBeUndefined();
    expect(inferTitle("body only")).toBeUndefined();
  });
});

describe("provenanceHeader", () => {
  it("includes host and cwd", () => {
    expect(provenanceHeader({ host: "h", cwd: "/w" })).toBe("[Handoff from h:/w]");
  });
});

describe("runHandoff", () => {
  it("sends the doc to the orchestrator by default", async () => {
    const { deps, sent, ensureCalls } = stubDeps({ files: { "doc.md": DOC } });
    const code = await runHandoff(deps, parseGlobalFlags(["doc.md"]));
    expect(code).toBe(ExitCode.OK);
    expect(ensureCalls()).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].id).toBe("orch_1");
    expect(sent[0].body.text).toBe(`[Handoff from myhost:/home/me/proj]\n\n${DOC}`);
    expect(stdout()).toContain("handed off to thread t1");
    expect(stdout()).toContain("http://inst/threads/t1");
  });

  it("accepts --file as an alternative to the positional", async () => {
    const { deps, sent } = stubDeps({ files: { "doc.md": DOC } });
    const code = await runHandoff(deps, parseGlobalFlags(["--file", "doc.md"]));
    expect(code).toBe(ExitCode.OK);
    expect(sent).toHaveLength(1);
  });

  it("reads the doc from stdin with -", async () => {
    const { deps, sent } = stubDeps({ stdin: DOC });
    const code = await runHandoff(deps, parseGlobalFlags(["-"]));
    expect(code).toBe(ExitCode.OK);
    expect(sent[0].body.text).toContain("Fix the flaky login test");
  });

  it("targets an existing session with --session", async () => {
    const { deps, sent, ensureCalls } = stubDeps({ files: { "doc.md": DOC } });
    const code = await runHandoff(deps, parseGlobalFlags(["doc.md", "--session", "s9"]));
    expect(code).toBe(ExitCode.OK);
    expect(ensureCalls()).toBe(0);
    expect(sent[0].id).toBe("s9");
  });

  it("creates a fresh session with --new-session --repo", async () => {
    const { deps, sent, created } = stubDeps({ files: { "doc.md": DOC } });
    const code = await runHandoff(deps, parseGlobalFlags(["doc.md", "--new-session", "--repo", "o/n"]));
    expect(code).toBe(ExitCode.OK);
    expect(created).toEqual([
      {
        workspace: "/workspace/n",
        title: "Fix the flaky login test",
        profile: "full",
        repo: { fullName: "o/n", cloneUrl: "https://github.com/o/n.git" },
      },
    ]);
    expect(sent[0].id).toBe("new_1");
  });

  it("infers the repo from the git remote for --new-session", async () => {
    const { deps, created } = stubDeps({
      files: { "doc.md": DOC },
      remote: "git@github.com:acme/widgets.git",
    });
    const code = await runHandoff(deps, parseGlobalFlags(["doc.md", "--new-session", "--title", "T"]));
    expect(code).toBe(ExitCode.OK);
    expect(created[0].repo?.fullName).toBe("acme/widgets");
    expect(created[0].workspace).toBe("/workspace/widgets");
    expect(created[0].title).toBe("T");
  });

  it("treats a value consumed by --new-session as the doc path", async () => {
    const { deps, sent } = stubDeps({ files: { "doc.md": DOC }, remote: "https://github.com/o/n" });
    const code = await runHandoff(deps, parseGlobalFlags(["--new-session", "doc.md"]));
    expect(code).toBe(ExitCode.OK);
    expect(sent).toHaveLength(1);
  });

  it("errors on --new-session without a repo or remote", async () => {
    const { deps } = stubDeps({ files: { "doc.md": DOC } });
    const code = await runHandoff(deps, parseGlobalFlags(["doc.md", "--new-session"]));
    expect(code).toBe(ExitCode.Usage);
    expect(stderr()).toContain("--repo");
  });

  it("errors when --session and --new-session are combined", async () => {
    const { deps } = stubDeps({ files: { "doc.md": DOC } });
    const code = await runHandoff(deps, parseGlobalFlags(["doc.md", "--session", "s1", "--new-session"]));
    expect(code).toBe(ExitCode.Usage);
    expect(stderr()).toContain("mutually exclusive");
  });

  it("errors without a doc argument", async () => {
    const { deps } = stubDeps();
    const code = await runHandoff(deps, parseGlobalFlags([]));
    expect(code).toBe(ExitCode.Usage);
    expect(stderr()).toContain("handoff doc");
  });

  it("errors on an empty doc", async () => {
    const { deps } = stubDeps({ files: { "doc.md": "  \n" } });
    const code = await runHandoff(deps, parseGlobalFlags(["doc.md"]));
    expect(code).toBe(ExitCode.Usage);
    expect(stderr()).toContain("empty");
  });

  it("errors on an unreadable doc file", async () => {
    const { deps } = stubDeps();
    const code = await runHandoff(deps, parseGlobalFlags(["missing.md"]));
    expect(code).toBe(ExitCode.Usage);
    expect(stderr()).toContain("missing.md");
  });

  it("emits a machine-readable receipt with --json", async () => {
    const { deps } = stubDeps({ files: { "doc.md": DOC } });
    const code = await runHandoff(deps, parseGlobalFlags(["doc.md", "--json"]));
    expect(code).toBe(ExitCode.OK);
    expect(JSON.parse(stdout())).toEqual({
      sessionId: "orch_1",
      threadId: "t1",
      messageId: "q1",
      url: "http://inst/threads/t1",
    });
  });

  it("prints a retry hint when send fails after --new-session created", async () => {
    const { deps } = stubDeps({
      files: { "doc.md": DOC },
      remote: "https://github.com/o/n",
      sendError: new Error("boom"),
    });
    await expect(
      runHandoff(deps, parseGlobalFlags(["doc.md", "--new-session"])),
    ).rejects.toThrow("boom");
    expect(stderr()).toContain("--session new_1");
  });

  describe("--wait", () => {
    it("streams until our submission settles and exits OK", async () => {
      const { deps } = stubDeps({
        files: { "doc.md": DOC },
        events: [textDelta("on it"), settled("completed")],
      });
      const code = await runHandoff(deps, parseGlobalFlags(["doc.md", "--wait"]));
      expect(code).toBe(ExitCode.OK);
      expect(stdout()).toContain("on it");
      expect(stdout()).toContain("handed off to thread t1");
    });

    it("maps a failed settle to TurnError", async () => {
      const { deps } = stubDeps({ files: { "doc.md": DOC }, events: [settled("failed")] });
      const code = await runHandoff(deps, parseGlobalFlags(["doc.md", "--wait"]));
      expect(code).toBe(ExitCode.TurnError);
    });
  });
});


it("hands off to the requested thread without creating a runtime", async () => {
  const bundle = stubDeps({ files: { "doc.md": DOC } });
  expect(await runHandoff(bundle.deps, parseGlobalFlags(["doc.md", "--thread", "t1"]))).toBe(ExitCode.OK);
  expect(bundle.sent[0]).toMatchObject({ id: "s1", body: { threadId: "t1" } });
  expect(bundle.ensureCalls()).toBe(0);
  expect(bundle.created).toEqual([]);
  expect(stdout()).toContain("http://inst/threads/t1");
});

it("rejects conflicting thread handoff selectors before sending", async () => {
  for (const selectors of [["--thread", "t1", "--session", "other"], ["--thread", "t1", "--new-session"]]) {
    const bundle = stubDeps({ files: { "doc.md": DOC } });
    expect(await runHandoff(bundle.deps, parseGlobalFlags(["doc.md", ...selectors]))).toBe(ExitCode.Usage);
    expect(bundle.sent).toEqual([]);
    expect(bundle.created).toEqual([]);
  }
});

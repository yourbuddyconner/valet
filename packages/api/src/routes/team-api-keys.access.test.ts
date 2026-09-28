/**
 * A team `vlt_` key reaches its team's sessions and nothing else (TKAI-396
 * done-when 5). `agent_sessions.userId` on every row the creating admin
 * touched is that admin, so a view check that reads the user instead of the
 * principal admits the key to the admin's personal sessions. Every
 * session-scoped surface is pinned here against one personal and one team
 * session minted by the same admin.
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { teamMembers } from "../schema/index.js";
import type {
  CreateTeamApiKeyResponse,
  CreateTeamResponse,
  EnsureWorkspaceRuntimeResponse,
  SessionDetail,
} from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

function extractSessionCookie(setCookieHeader: string | null): string {
  expect(setCookieHeader).toBeTruthy();
  const match = setCookieHeader?.match(/better-auth\.session_token=[^;]+/);
  expect(match).toBeTruthy();
  return match![0];
}

async function signUp(baseUrl: string, email: string, name: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password: "correct-horse-battery" }),
  });
  expect(res.status).toBe(200);
  return extractSessionCookie(res.headers.get("set-cookie"));
}

async function createTeam(baseUrl: string, cookie: string, name: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/teams`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as CreateTeamResponse).team.id;
}

async function mintTeamKey(baseUrl: string, cookie: string, teamId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/teams/${teamId}/api-keys`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "CI" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as CreateTeamApiKeyResponse).key;
}

async function createSession(baseUrl: string, headers: Record<string, string>): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "valet-team-key-access-"));
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ workspace }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as SessionDetail).id;
}

interface Fixture {
  baseUrl: string;
  wsUrl: string;
  cookie: string;
  teamId: string;
  teamKey: string;
  personalSessionId: string;
  teamSessionId: string;
}

/** One admin, one team, one team key, and a session on each side of the line. */
async function bootFixture(): Promise<Fixture> {
  api = await bootTestApi({ auth: true });
  const cookie = await signUp(api.baseUrl, "admin@nowhere.test", "First Admin");
  const teamId = await createTeam(api.baseUrl, cookie, "Platform");
  const teamKey = await mintTeamKey(api.baseUrl, cookie, teamId);
  const personalSessionId = await createSession(api.baseUrl, { cookie });
  const teamSessionId = await createSession(api.baseUrl, { "x-api-key": teamKey });
  return { baseUrl: api.baseUrl, wsUrl: api.wsUrl, cookie, teamId, teamKey, personalSessionId, teamSessionId };
}

/** Opens the session socket and reports the first frame or the close code. */
function openWs(
  wsUrl: string,
  sessionId: string,
  apiKey: string,
): Promise<{ kind: "frame"; type: string } | { kind: "close"; code: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}/api/sessions/${sessionId}/ws`, { headers: { "x-api-key": apiKey } });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("ws: no frame and no close within 5s"));
    }, 5_000);
    ws.on("message", (data) => {
      clearTimeout(timer);
      const frame = JSON.parse(data.toString()) as { type: string };
      ws.close();
      resolve({ kind: "frame", type: frame.type });
    });
    ws.on("close", (code) => {
      clearTimeout(timer);
      resolve({ kind: "close", code });
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe("team API key reach", () => {
  it("reads its team's session and 404s the admin's personal session", async () => {
    const f = await bootFixture();
    const headers = { "x-api-key": f.teamKey };

    const personal = await fetch(`${f.baseUrl}/api/sessions/${f.personalSessionId}`, { headers });
    expect(personal.status).toBe(404);
    const team = await fetch(`${f.baseUrl}/api/sessions/${f.teamSessionId}`, { headers });
    expect(team.status).toBe(200);
    expect(((await team.json()) as SessionDetail).owner).toEqual({ type: "team", id: f.teamId });
  });

  it("rates its team's session and 404s the admin's personal session", async () => {
    const f = await bootFixture();
    const headers = { "content-type": "application/json", "x-api-key": f.teamKey };
    const body = JSON.stringify({ rating: "positive" });

    const personal = await fetch(`${f.baseUrl}/api/sessions/${f.personalSessionId}/rating`, {
      method: "POST",
      headers,
      body,
    });
    expect(personal.status).toBe(404);
    const team = await fetch(`${f.baseUrl}/api/sessions/${f.teamSessionId}/rating`, {
      method: "POST",
      headers,
      body,
    });
    expect(team.status).toBe(200);
  });

  it("reaches its team's gateway and 404s the admin's personal gateway", async () => {
    const f = await bootFixture();
    const headers = { "x-api-key": f.teamKey };

    const personal = await fetch(`${f.baseUrl}/api/sessions/${f.personalSessionId}/gateway/`, { headers });
    expect(personal.status).toBe(404);
    // The virtual sandbox has no gateway endpoint: an owner gets the
    // "not ready" 409, never the existence-hiding 404.
    const team = await fetch(`${f.baseUrl}/api/sessions/${f.teamSessionId}/gateway/`, { headers });
    expect(team.status).toBe(409);
  });

  it("reads its team's security engagement and 404s the admin's personal one", async () => {
    const f = await bootFixture();
    const headers = { "x-api-key": f.teamKey };

    const personal = await fetch(`${f.baseUrl}/api/sessions/${f.personalSessionId}/security`, { headers });
    expect(personal.status).toBe(404);
    expect(((await personal.json()) as { error: string }).error).toBe("session not found");
    // A plain session has no engagement: the view gate passes and the
    // route answers with the engagement-shaped 404, not the session one.
    const team = await fetch(`${f.baseUrl}/api/sessions/${f.teamSessionId}/security`, { headers });
    expect(team.status).toBe(404);
    expect(((await team.json()) as { error: string }).error).not.toBe("session not found");
  });

  it("opens its team's socket and is closed 4040 on the admin's personal one", async () => {
    const f = await bootFixture();

    const personal = await openWs(f.wsUrl, f.personalSessionId, f.teamKey);
    expect(personal).toEqual({ kind: "close", code: 4040 });
    const team = await openWs(f.wsUrl, f.teamSessionId, f.teamKey);
    expect(team).toEqual({ kind: "frame", type: "init" });
  });

  it("reaches its own workspace runtime and refuses other workspace runtimes", async () => {
    const f = await bootFixture();
    const headers = { "x-api-key": f.teamKey };

    // The key survives the admin leaving: membership is not re-checked.
    await api!.providers.db.delete(teamMembers);
    const own = await fetch(`${f.baseUrl}/api/workspaces/${f.teamId}/runtime`, { method: "POST", headers });
    expect(own.status).toBe(200);
    const { sessionId } = (await own.json()) as EnsureWorkspaceRuntimeResponse;
    const detail = await fetch(`${f.baseUrl}/api/sessions/${sessionId}`, { headers });
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as SessionDetail).owner).toEqual({ type: "team", id: f.teamId });

    const otherTeamId = await createTeam(f.baseUrl, f.cookie, "Other");
    const other = await fetch(`${f.baseUrl}/api/workspaces/${otherTeamId}/runtime`, { method: "POST", headers });
    expect(other.status).toBe(403);
    const personal = await fetch(`${f.baseUrl}/api/workspaces/user/runtime`, { method: "POST", headers });
    expect(personal.status).toBe(403);
    const probe = await fetch(`${f.baseUrl}/api/workspaces/${f.teamId}/runtime`, { headers });
    expect(probe.status).toBe(200);
    const info = await fetch(`${f.baseUrl}/api/workspaces/${f.teamId}/runtime/info`, { headers });
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ sessionId });
    for (const workspace of ["user", otherTeamId]) {
      for (const suffix of ["runtime", "runtime/info"]) {
        expect((await fetch(`${f.baseUrl}/api/workspaces/${workspace}/${suffix}`, { headers })).status).toBe(403);
      }
    }
  });

  // The always-allow check used to read the creating admin's user id, so a
  // CI key minted by an org admin could write an org-wide allow policy.
  it("cannot grant an always-allow policy: that is an org admin's decision, and a key is not one", async () => {
    const f = await bootFixture();
    const res = await fetch(`${f.baseUrl}/api/sessions/${f.teamSessionId}/decisions/gate_nope/resolve`, {
      method: "POST",
      headers: { "x-api-key": f.teamKey, "content-type": "application/json" },
      body: JSON.stringify({ actionId: "always_allow" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/team API key cannot grant/);
  });

  // Issue filing resolves GitHub or Linear from the acting user's own rows;
  // for a team key that user is the creating admin, who clicked nothing.
  it("cannot file issues with the creating admin's credentials", async () => {
    const f = await bootFixture();
    const headers = { "x-api-key": f.teamKey, "content-type": "application/json" };
    const one = await fetch(`${f.baseUrl}/api/sessions/${f.teamSessionId}/security/findings/f_nope/issues`, {
      method: "POST",
      headers,
      body: JSON.stringify({ provider: "github" }),
    });
    expect(one.status).toBe(403);
    expect(((await one.json()) as { error: string }).error).toMatch(/team API key cannot file/);
    const digest = await fetch(`${f.baseUrl}/api/sessions/${f.teamSessionId}/security/issues/digest`, {
      method: "POST",
      headers,
      body: JSON.stringify({ provider: "github" }),
    });
    expect(digest.status).toBe(403);
  });

  it("cannot mint a sandbox credential: that binds one user, which a team key is not", async () => {
    const f = await bootFixture();
    const headers = { "x-api-key": f.teamKey };

    const personal = await fetch(`${f.baseUrl}/api/sessions/${f.personalSessionId}/sandbox-jwt`, {
      method: "POST",
      headers,
    });
    expect(personal.status).toBe(404);
    const team = await fetch(`${f.baseUrl}/api/sessions/${f.teamSessionId}/sandbox-jwt`, {
      method: "POST",
      headers,
    });
    expect(team.status).toBe(403);
    expect(((await team.json()) as { error: string }).error).toContain("personal");
  });

  // A key owns its team's sessions, so the direct-owner gate on
  // sandbox/replace admits it. Rebuilding a sandbox is a person's act on a
  // live session, the same way minting a sandbox credential is.
  it("cannot replace its team's sandbox: that rebuilds a live session, which a key does not do", async () => {
    const f = await bootFixture();
    const headers = { "x-api-key": f.teamKey };

    const personal = await fetch(`${f.baseUrl}/api/sessions/${f.personalSessionId}/sandbox/replace`, {
      method: "POST",
      headers,
    });
    expect(personal.status).toBe(404);
    const team = await fetch(`${f.baseUrl}/api/sessions/${f.teamSessionId}/sandbox/replace`, {
      method: "POST",
      headers,
    });
    expect(team.status).toBe(403);
    expect(((await team.json()) as { error: string }).error).toContain("personal");
  });
});

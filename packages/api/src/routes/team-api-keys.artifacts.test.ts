/**
 * The public artifact router is mounted before the auth ladder and the
 * team-key scope gate, and resolves its caller itself. A team `vlt_` key
 * there must not read as the creating admin: it may read a public artifact
 * as an anonymous caller, and nothing else (TKAI-396 done-when 5).
 */
import { eq } from "drizzle-orm";
import { artifacts } from "../schema/index.js";
import { describe, expect, it, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { CreateTeamApiKeyResponse, CreateTeamResponse, ShareArtifactResponse } from "../wire/types.js";

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

/** The admin writes a memory file and shares it; the read URL comes back. */
async function shareArtifact(baseUrl: string, cookie: string): Promise<{ id: string; readUrl: string }> {
  const wrote = await fetch(`${baseUrl}/api/memory`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ path: "reports/deploys.md", content: "# Deploys\n\nBody.\n" }),
  });
  expect(wrote.status).toBe(200);
  const shared = await fetch(`${baseUrl}/api/artifacts/share`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ path: "reports/deploys.md" }),
  });
  expect(shared.status).toBe(200);
  const body = (await shared.json()) as ShareArtifactResponse;
  const token = new URL(body.url).pathname.replace(/^\/a\//, "");
  return { id: body.id, readUrl: `${baseUrl}/api/artifacts/${token}` };
}

async function widenToPublic(baseUrl: string, cookie: string, artifactId: string): Promise<void> {
  const flipped = await fetch(`${baseUrl}/api/org/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ allowPublicArtifacts: true }),
  });
  expect(flipped.status).toBe(200);
  const widened = await fetch(`${baseUrl}/api/artifacts/${artifactId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ visibility: "public" }),
  });
  expect(widened.status).toBe(200);
}

interface Fixture {
  baseUrl: string;
  cookie: string;
  teamKey: string;
  teamId: string;
  artifactId: string;
  readUrl: string;
}

async function bootFixture(): Promise<Fixture> {
  api = await bootTestApi({ auth: true });
  const cookie = await signUp(api.baseUrl, "admin@nowhere.test", "First Admin");
  const teamId = await createTeam(api.baseUrl, cookie, "Platform");
  const teamKey = await mintTeamKey(api.baseUrl, cookie, teamId);
  const { id, readUrl } = await shareArtifact(api.baseUrl, cookie);
  return { baseUrl: api.baseUrl, cookie, teamKey, teamId, artifactId: id, readUrl };
}

describe("team API key on the public artifact router", () => {
  it("never uses a team key's minting admin for team pages or share management", async () => {
    const f = await bootFixture();
    const published = await fetch(`${f.baseUrl}/api/artifacts/share?ownerType=team&ownerId=${f.teamId}`, {
      method: "POST", headers: { cookie: f.cookie, "content-type": "application/json" },
      body: JSON.stringify({ key: "team.md", content: "Team secret" }),
    });
    expect(published.status).toBe(200);
    // The response comes from the real share route, asserted above.
    const shared = await published.json() as ShareArtifactResponse;
    const token = new URL(shared.url).pathname.replace(/^\/a\//, "");
    const readUrl = `${f.baseUrl}/api/artifacts/${token}`;
    expect((await fetch(readUrl, { headers: { cookie: f.cookie } })).status).toBe(200);
    if (!api) throw new Error("Test API is unavailable");
    // A pre-fix public flag must never grant anonymous or team-key access.
    await api.providers.db.update(artifacts).set({ visibility: "public" }).where(eq(artifacts.id, shared.id));
    await widenToPublic(f.baseUrl, f.cookie, f.artifactId);
    expect((await fetch(readUrl)).status).toBe(401);
    expect((await fetch(`${readUrl}/comments`)).status).toBe(401);
    const keyHeaders: Record<string, string>[] = [{ "x-api-key": f.teamKey }];
    // API keys authenticate through x-api-key; unsupported bearer input is anonymous.
    expect((await fetch(readUrl, { headers: { authorization: `Bearer ${f.teamKey}` } })).status).toBe(401);
    for (const header of keyHeaders) {
      expect((await fetch(readUrl, { headers: header })).status).toBe(403);
      expect((await fetch(`${readUrl}/comments`, { headers: header })).status).toBe(403);
      expect((await fetch(`${readUrl}/comments/fake/resolve`, { method: "POST", headers: header })).status).toBe(403);
      expect((await fetch(`${f.baseUrl}/api/artifacts/${shared.id}/versions`, { headers: header })).status).toBe(403);
      expect((await fetch(`${f.baseUrl}/api/artifacts/${shared.id}`, { method: "PATCH", headers: { ...header, "content-type": "application/json" }, body: JSON.stringify({ visibility: "public" }) })).status).toBe(403);
      expect((await fetch(`${f.baseUrl}/api/artifacts/share`, { method: "POST", headers: { ...header, "content-type": "application/json" }, body: JSON.stringify({ key: "team.md", revoke: true }) })).status).toBe(403);
    }
  });

  it("cannot read an org-visibility artifact as the creating admin", async () => {
    const f = await bootFixture();
    const asAdmin = await fetch(f.readUrl, { headers: { cookie: f.cookie } });
    expect(asAdmin.status).toBe(200);

    const asTeamKey = await fetch(f.readUrl, { headers: { "x-api-key": f.teamKey } });
    expect(asTeamKey.status).toBe(403);
    expect(((await asTeamKey.json()) as { error: string }).error).toContain("public");
  });

  it("reads a public artifact as an anonymous caller: no sharer attribution", async () => {
    const f = await bootFixture();
    await widenToPublic(f.baseUrl, f.cookie, f.artifactId);

    const asTeamKey = await fetch(f.readUrl, { headers: { "x-api-key": f.teamKey } });
    expect(asTeamKey.status).toBe(200);
    const body = (await asTeamKey.json()) as { sharedBy?: string; canComment: boolean; management?: { id: string } };
    expect(body.sharedBy).toBeUndefined();
    expect(body.canComment).toBe(false);
    expect(body.management).toBeUndefined();
    const anonymous = await fetch(f.readUrl);
    expect(anonymous.status).toBe(200);
    expect(await anonymous.json()).not.toHaveProperty("management");
  });

  it("is refused on every comment route, public artifact or not", async () => {
    const f = await bootFixture();
    await widenToPublic(f.baseUrl, f.cookie, f.artifactId);
    const headers = { "content-type": "application/json", "x-api-key": f.teamKey };

    const listed = await fetch(`${f.readUrl}/comments`, { headers });
    expect(listed.status).toBe(403);
    const posted = await fetch(`${f.readUrl}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "from CI" }),
    });
    expect(posted.status).toBe(403);
  });
});

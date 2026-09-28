/**
 * Route-level checks for the artifact surface (2026-08-22 artifacts
 * design): share → public read round trip, snapshot (not live) semantics,
 * revoke + re-share token rotation, the internal-token (mem_share tool)
 * path, visibility management, and the org opt-in gate. Doesn't need
 * ANTHROPIC_API_KEY — none of these routes touch the engine.
 *
 * Anonymity is NOT exercised here: stub auth answers for every request, so
 * the anonymous branches of the access matrix are pinned by the
 * `decideArtifactAccess` unit tests in `services/artifacts.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { bootTestApi } from "./_setup.js";
import { agentSessions } from "../schema/index.js";
import { internalToken } from "../lib/internal-auth.js";
import type {
  AddArtifactCommentResponse,
  GetArtifactResponse,
  ListArtifactCommentsResponse,
  ListArtifactsResponse,
  ListArtifactVersionsResponse,
  ShareArtifactRequest,
  ShareArtifactResponse,
} from "../wire/types.js";

async function writeMemoryFile(baseUrl: string, path: string, content: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/memory`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
  expect(res.status).toBe(200);
}

async function share(baseUrl: string, path: string): Promise<ShareArtifactResponse> {
  const res = await fetch(`${baseUrl}/api/artifacts/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ShareArtifactResponse;
}

/** The share URL's path part (`/a/{token}`) → API read URL. */
function readUrl(baseUrl: string, shareUrl: string): string {
  const token = new URL(shareUrl).pathname.replace(/^\/a\//, "");
  expect(token.length).toBeGreaterThanOrEqual(20); // 16 bytes base64url
  return `${baseUrl}/api/artifacts/${token}`;
}

describe("api integration: artifacts", () => {
  it("share → read round trip serves a snapshot, not the live file", async () => {
    const api = await bootTestApi();
    try {
      await writeMemoryFile(api.baseUrl, "artifacts/report.md", "# Q3 Report\n\nFirst draft.\n");
      const shared = await share(api.baseUrl, "artifacts/report.md");
      expect(shared.visibility).toBe("org");
      expect(shared.url).toContain("/a/");

      const read = await fetch(readUrl(api.baseUrl, shared.url));
      expect(read.status).toBe(200);
      expect(read.headers.get("x-robots-tag")).toBe("noindex");
      const body = (await read.json()) as GetArtifactResponse;
      expect(body.title).toBe("Q3 Report");
      expect(body.content).toContain("First draft.");
      // Stub identity is a logged-in org member → sharer attribution.
      expect(body.sharedBy).toBe("Local Dev");

      // Edit the memory file — the artifact must NOT change until re-share.
      await writeMemoryFile(api.baseUrl, "artifacts/report.md", "# Q3 Report\n\nSecond draft.\n");
      const stale = (await (await fetch(readUrl(api.baseUrl, shared.url))).json()) as GetArtifactResponse;
      expect(stale.content).toContain("First draft.");

      // Re-share publishes the update and keeps the URL stable.
      const reshared = await share(api.baseUrl, "artifacts/report.md");
      expect(reshared.url).toBe(shared.url);
      const fresh = (await (await fetch(readUrl(api.baseUrl, shared.url))).json()) as GetArtifactResponse;
      expect(fresh.content).toContain("Second draft.");
    } finally {
      await api.cleanup();
    }
  });

  it("revoke kills the link; re-share mints a NEW token", async () => {
    const api = await bootTestApi();
    try {
      await writeMemoryFile(api.baseUrl, "artifacts/plan.md", "# Plan\n\nBody.\n");
      const shared = await share(api.baseUrl, "artifacts/plan.md");

      // Revoke with a NON-canonical spelling of the same path — rows store
      // the normalized path, and revoke must normalize too, or the link
      // stays live behind a 404.
      const revoke = await fetch(`${api.baseUrl}/api/artifacts/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/artifacts/plan.md", revoke: true }),
      });
      expect(revoke.status).toBe(200);
      expect((await fetch(readUrl(api.baseUrl, shared.url))).status).toBe(404);

      // A revoked token may have leaked — reactivation must not revive it.
      const reshared = await share(api.baseUrl, "artifacts/plan.md");
      expect(reshared.url).not.toBe(shared.url);
      expect((await fetch(readUrl(api.baseUrl, shared.url))).status).toBe(404);
      expect((await fetch(readUrl(api.baseUrl, reshared.url))).status).toBe(200);
    } finally {
      await api.cleanup();
    }
  });

  it("internal token + owner/actor headers share on behalf of a session (mem_share path)", async () => {
    const api = await bootTestApi();
    try {
      await api.providers.db.insert(agentSessions).values({
        id: "sess-123", userId: "local-user", orgId: "local-org", workspace: "/tmp",
        ownerType: "user", ownerId: "local-user", createdAt: 1, updatedAt: 1,
      });
      const headers = {
        "Content-Type": "application/json",
        "x-valet-internal": internalToken(),
        "x-valet-owner": "user:local-user",
        "x-valet-actor": "local-user",
        "x-valet-session-id": "sess-123",
      };
      const put = await fetch(`${api.baseUrl}/api/memory`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ path: "artifacts/tool-note.md", content: "# Tool Note\n\nVia tool.\n" }),
      });
      expect(put.status).toBe(200);

      const res = await fetch(`${api.baseUrl}/api/artifacts/share`, {
        method: "POST",
        headers,
        body: JSON.stringify({ path: "artifacts/tool-note.md" }),
      });
      expect(res.status).toBe(200);
      const shared = (await res.json()) as ShareArtifactResponse;
      expect(shared.visibility).toBe("org");

      const read = await fetch(readUrl(api.baseUrl, shared.url));
      expect(read.status).toBe(200);
      expect(((await read.json()) as GetArtifactResponse).content).toContain("Via tool.");
    } finally {
      await api.cleanup();
    }
  });

  it("rejects directory paths and unshared revokes", async () => {
    const api = await bootTestApi();
    try {
      await writeMemoryFile(api.baseUrl, "artifacts/one.md", "# One\n\nBody.\n");
      const dir = await fetch(`${api.baseUrl}/api/artifacts/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "artifacts/" }),
      });
      expect(dir.status).toBe(400);

      const revoke = await fetch(`${api.baseUrl}/api/artifacts/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "artifacts/never-shared.md", revoke: true }),
      });
      expect(revoke.status).toBe(404);

      // Reserved-path shapes are a 400 (mapped ReservedPathError), never a
      // 500 — the same mapping the memory routes use.
      const reserved = await fetch(`${api.baseUrl}/api/artifacts/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "artifacts/../escape.md" }),
      });
      expect(reserved.status).toBe(400);
    } finally {
      await api.cleanup();
    }
  });

  it("widening to public needs the org opt-in; the setting is org-admin gated", async () => {
    const api = await bootTestApi();
    try {
      await writeMemoryFile(api.baseUrl, "artifacts/memo.md", "# Memo\n\nBody.\n");
      const shared = await share(api.baseUrl, "artifacts/memo.md");

      // Opt-in off → widening 400s with the corrective action.
      const denied = await fetch(`${api.baseUrl}/api/artifacts/${shared.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "public" }),
      });
      expect(denied.status).toBe(400);
      expect(((await denied.json()) as { error: string }).error).toContain("Settings");

      // A non-admin member cannot flip the org setting.
      const memberFlip = await fetch(`${api.baseUrl}/api/org/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
        body: JSON.stringify({ allowPublicArtifacts: true }),
      });
      expect(memberFlip.status).toBe(403);

      // The admin can; then widening works and records the actor.
      const adminFlip = await fetch(`${api.baseUrl}/api/org/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowPublicArtifacts: true }),
      });
      expect(adminFlip.status).toBe(200);
      expect(((await adminFlip.json()) as { allowPublicArtifacts: boolean }).allowPublicArtifacts).toBe(true);

      const widened = await fetch(`${api.baseUrl}/api/artifacts/${shared.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "public" }),
      });
      expect(widened.status).toBe(200);
      expect(((await widened.json()) as { visibility: string }).visibility).toBe("public");

      // Narrowing back is allowed regardless of the setting.
      const narrowed = await fetch(`${api.baseUrl}/api/artifacts/${shared.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "org" }),
      });
      expect(narrowed.status).toBe(200);
      expect(((await narrowed.json()) as { visibility: string }).visibility).toBe("org");
    } finally {
      await api.cleanup();
    }
  });

  it("re-share after revoke RESETS a widened artifact to org visibility", async () => {
    const api = await bootTestApi();
    try {
      await writeMemoryFile(api.baseUrl, "artifacts/leak-check.md", "# Leak Check\n\nBody.\n");
      const shared = await share(api.baseUrl, "artifacts/leak-check.md");

      // Human actions: enable the opt-in, widen to public, then revoke.
      await fetch(`${api.baseUrl}/api/org/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowPublicArtifacts: true }),
      });
      const widened = await fetch(`${api.baseUrl}/api/artifacts/${shared.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "public" }),
      });
      expect(((await widened.json()) as { visibility: string }).visibility).toBe("public");
      await fetch(`${api.baseUrl}/api/artifacts/${shared.id}`, { method: "DELETE" });

      // The agent re-shares. Revoke ended the audience decision, so the
      // reactivated link must be org-visibility again — the tool surface
      // must never be the thing that restores anonymous access.
      const reshared = await share(api.baseUrl, "artifacts/leak-check.md");
      expect(reshared.visibility).toBe("org");
      const read = await fetch(readUrl(api.baseUrl, reshared.url));
      expect(((await read.json()) as GetArtifactResponse).visibility).toBe("org");
    } finally {
      await api.cleanup();
    }
  });

  it("management is sharer-or-admin: another member 403s, DELETE revokes", async () => {
    const api = await bootTestApi();
    try {
      await writeMemoryFile(api.baseUrl, "artifacts/mine.md", "# Mine\n\nBody.\n");
      const shared = await share(api.baseUrl, "artifacts/mine.md");

      // `test-member` is neither the sharer nor an org admin.
      const foreign = await fetch(`${api.baseUrl}/api/artifacts/${shared.id}`, {
        method: "DELETE",
        headers: { "x-valet-test-user-id": "test-member" },
      });
      expect(foreign.status).toBe(403);

      const list = await fetch(`${api.baseUrl}/api/artifacts`);
      const listBody = (await list.json()) as ListArtifactsResponse;
      expect(listBody.artifacts.map((a) => a.path)).toContain("artifacts/mine.md");

      const del = await fetch(`${api.baseUrl}/api/artifacts/${shared.id}`, { method: "DELETE" });
      expect(del.status).toBe(200);
      expect((await fetch(readUrl(api.baseUrl, shared.url))).status).toBe(404);
    } finally {
      await api.cleanup();
    }
  });

  it("the list carries the sharer, so same-path artifacts from two members stay distinct", async () => {
    const api = await bootTestApi();
    try {
      // Memory paths are conventional (journal dates, preferences), so two
      // members sharing their own file at the SAME path is the normal case.
      // An org admin's list contains both rows; without `actorUserId` a
      // path-only client match can land on the colleague's link.
      const path = "journal/2026-08-27.md";
      await writeMemoryFile(api.baseUrl, path, "# Mine\n\nBody.\n");
      const mine = await share(api.baseUrl, path);

      const memberHeaders = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };
      const memberWrite = await fetch(`${api.baseUrl}/api/memory`, {
        method: "PUT",
        headers: memberHeaders,
        body: JSON.stringify({ path, content: "# Theirs\n\nBody.\n" }),
      });
      expect(memberWrite.status).toBe(200);
      const memberShare = await fetch(`${api.baseUrl}/api/artifacts/share`, {
        method: "POST",
        headers: memberHeaders,
        body: JSON.stringify({ path }),
      });
      expect(memberShare.status).toBe(200);
      const theirs = (await memberShare.json()) as ShareArtifactResponse;
      expect(theirs.id).not.toBe(mine.id);

      // The default stub caller is an org admin — the list holds both rows,
      // disambiguated by actorUserId.
      const list = await fetch(`${api.baseUrl}/api/artifacts`);
      const listBody = (await list.json()) as ListArtifactsResponse;
      const atPath = listBody.artifacts.filter((a) => a.path === path);
      expect(atPath).toHaveLength(2);
      const actors = new Set(atPath.map((a) => a.actorUserId));
      expect(actors.size).toBe(2);
      for (const item of atPath) expect(item.actorUserId.length).toBeGreaterThan(0);
    } finally {
      await api.cleanup();
    }
  });

  it("mine=1 scopes even an org admin to their own rows, server-side", async () => {
    const api = await bootTestApi();
    try {
      const path = "journal/2026-08-28.md";
      await writeMemoryFile(api.baseUrl, path, "# Mine\n\nBody.\n");
      const mine = await share(api.baseUrl, path);

      const memberHeaders = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };
      await fetch(`${api.baseUrl}/api/memory`, {
        method: "PUT",
        headers: memberHeaders,
        body: JSON.stringify({ path, content: "# Theirs\n\nBody.\n" }),
      });
      const memberShare = await fetch(`${api.baseUrl}/api/artifacts/share`, {
        method: "POST",
        headers: memberHeaders,
        body: JSON.stringify({ path }),
      });
      expect(memberShare.status).toBe(200);

      // The default stub caller is an org admin — the unfiltered list holds
      // both rows.
      const unfiltered = await fetch(`${api.baseUrl}/api/artifacts`);
      const unfilteredBody = (await unfiltered.json()) as ListArtifactsResponse;
      expect(unfilteredBody.artifacts.filter((a) => a.path === path)).toHaveLength(2);

      // `mine=1` drops admin-wide visibility: only the admin's own row.
      const mineOnly = await fetch(`${api.baseUrl}/api/artifacts?mine=1`);
      expect(mineOnly.status).toBe(200);
      const mineBody = (await mineOnly.json()) as ListArtifactsResponse;
      const mineAtPath = mineBody.artifacts.filter((a) => a.path === path);
      expect(mineAtPath).toHaveLength(1);
      expect(mineAtPath[0]?.id).toBe(mine.id);
    } finally {
      await api.cleanup();
    }
  });

  it("mine cannot be combined with an owner filter", async () => {
    const api = await bootTestApi();
    try {
      const res = await fetch(`${api.baseUrl}/api/artifacts?mine=1&ownerType=team&ownerId=t1`);
      expect(res.status).toBe(400);
    } finally {
      await api.cleanup();
    }
  });
});

// ─── Artifact pages (2026-09-02 artifact-pages design) ───────────────────

async function publish(baseUrl: string, body: ShareArtifactRequest): Promise<ShareArtifactResponse> {
  const res = await fetch(`${baseUrl}/api/artifacts/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ShareArtifactResponse;
}

async function readArtifact(baseUrl: string, shareUrl: string): Promise<GetArtifactResponse> {
  const res = await fetch(readUrl(baseUrl, shareUrl));
  expect(res.status).toBe(200);
  return (await res.json()) as GetArtifactResponse;
}

describe("api integration: artifact pages", () => {
  it("inline html publish → read serves the source AND the rendered page verbatim", async () => {
    const api = await bootTestApi();
    try {
      const html = `<!doctype html><html><head><title>Deploy Board</title></head><body><h1>Deploys</h1><script>draw()</script></body></html>`;
      const shared = await publish(api.baseUrl, {
        key: "pages/deploy-board",
        content: html,
        format: "html",
        description: "Deploy failures by service",
        icon: "📊",
      });
      expect(shared.version).toBe(1);

      const body = await readArtifact(api.baseUrl, shared.url);
      expect(body.format).toBe("html");
      // Title came from the document's own <title>.
      expect(body.title).toBe("Deploy Board");
      expect(body.description).toBe("Deploy failures by service");
      expect(body.icon).toBe("📊");
      expect(body.content).toBe(html);
      // html passes the compiler verbatim — scripts included. Containment is
      // the viewer's sandboxed frame + CSP, not a publish-time sanitizer.
      expect(body.rendered).toBe(html);
      expect(body.canComment).toBe(true);
    } finally {
      await api.cleanup();
    }
  });

  it("markdown compiles at publish: the read carries GFM HTML in `rendered`", async () => {
    const api = await bootTestApi();
    try {
      const shared = await publish(api.baseUrl, {
        key: "pages/notes",
        content: "# Notes\n\n| a | b |\n|---|---|\n| 1 | 2 |\n",
      });
      const body = await readArtifact(api.baseUrl, shared.url);
      expect(body.format).toBe("markdown");
      expect(body.content).toContain("| a | b |");
      expect(body.rendered).toContain("<table>");
      expect(body.rendered).toContain("valet-artifact-doc");
    } finally {
      await api.cleanup();
    }
  });

  it("mem_share snapshots also compile — an old-style share is a page too", async () => {
    const api = await bootTestApi();
    try {
      await writeMemoryFile(api.baseUrl, "artifacts/pageful.md", "# Pageful\n\n**Bold** body.\n");
      const shared = await share(api.baseUrl, "artifacts/pageful.md");
      const body = await readArtifact(api.baseUrl, shared.url);
      expect(body.format).toBe("markdown");
      expect(body.rendered).toContain("<strong>Bold</strong>");
    } finally {
      await api.cleanup();
    }
  });

  it("every publish is a version; pinning sharedVersion changes what the link serves", async () => {
    const api = await bootTestApi();
    try {
      const v1 = await publish(api.baseUrl, { key: "pages/status", content: "# Status v1" });
      const v2 = await publish(api.baseUrl, { key: "pages/status", content: "# Status v2" });
      expect(v2.id).toBe(v1.id);
      expect(v2.url).toBe(v1.url);
      expect(v2.version).toBe(2);

      // Unpinned = latest.
      expect((await readArtifact(api.baseUrl, v2.url)).content).toBe("# Status v2");

      // Versions listing (sharer-gated) shows both, newest first.
      const versionsRes = await fetch(`${api.baseUrl}/api/artifacts/${v1.id}/versions`);
      expect(versionsRes.status).toBe(200);
      const versions = ((await versionsRes.json()) as ListArtifactVersionsResponse).versions;
      expect(versions.map((v) => v.version)).toEqual([2, 1]);

      // Pin viewers to v1.
      const pin = await fetch(`${api.baseUrl}/api/artifacts/${v1.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sharedVersion: 1 }),
      });
      expect(pin.status).toBe(200);
      const pinned = await readArtifact(api.baseUrl, v1.url);
      expect(pinned.content).toBe("# Status v1");
      expect(pinned.version).toBe(1);

      // The public read takes no version parameter — a link holder cannot
      // walk the history past the pin.
      const walk = await fetch(`${readUrl(api.baseUrl, v1.url)}?version=2`);
      expect(((await walk.json()) as GetArtifactResponse).content).toBe("# Status v1");

      // Unpin → latest again; a phantom pin is a 400, not a silent no-op.
      const unpin = await fetch(`${api.baseUrl}/api/artifacts/${v1.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sharedVersion: null }),
      });
      expect(unpin.status).toBe(200);
      expect((await readArtifact(api.baseUrl, v1.url)).content).toBe("# Status v2");
      const phantom = await fetch(`${api.baseUrl}/api/artifacts/${v1.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sharedVersion: 7 }),
      });
      expect(phantom.status).toBe(400);
    } finally {
      await api.cleanup();
    }
  });

  it("rejects a request carrying both path and key, and inline publish without content", async () => {
    const api = await bootTestApi();
    try {
      const both = await fetch(`${api.baseUrl}/api/artifacts/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "a.md", key: "pages/a", content: "x" }),
      });
      expect(both.status).toBe(400);

      const noContent = await fetch(`${api.baseUrl}/api/artifacts/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "pages/empty" }),
      });
      expect(noContent.status).toBe(400);
    } finally {
      await api.cleanup();
    }
  });

  it("comments: root + reply + resolve, threaded one level, authored and listed", async () => {
    const api = await bootTestApi();
    try {
      const shared = await publish(api.baseUrl, {
        key: "pages/commented",
        content: "<h1>Hello</h1>",
        format: "html",
      });
      const token = new URL(shared.url).pathname.replace(/^\/a\//, "");

      const add = await fetch(`${api.baseUrl}/api/artifacts/${token}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "Make it shorter", vdid: "a1b2c3d4e5f60718" }),
      });
      expect(add.status).toBe(200);
      const root = ((await add.json()) as AddArtifactCommentResponse).comment;
      expect(root.vdid).toBe("a1b2c3d4e5f60718");
      expect(root.parentId).toBeNull();
      expect(root.version).toBe(1);

      const reply = await fetch(`${api.baseUrl}/api/artifacts/${token}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
        body: JSON.stringify({ body: "Agreed", parentId: root.id }),
      });
      expect(reply.status).toBe(200);
      const replyRow = ((await reply.json()) as AddArtifactCommentResponse).comment;
      expect(replyRow.parentId).toBe(root.id);

      // A reply to a reply must be rejected: one level of nesting.
      const nested = await fetch(`${api.baseUrl}/api/artifacts/${token}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "Too deep", parentId: replyRow.id }),
      });
      expect(nested.status).toBe(400);

      const list = await fetch(`${api.baseUrl}/api/artifacts/${token}/comments`);
      expect(list.status).toBe(200);
      const listBody = (await list.json()) as ListArtifactCommentsResponse;
      expect(listBody.comments).toHaveLength(2);
      expect(listBody.comments[0]?.authorName.length).toBeGreaterThan(0);
      // No source session recorded on this artifact → sends cannot deliver.
      expect(listBody.canSendToSession).toBe(false);
      // The default stub caller shared the artifact → may resolve any thread.
      expect(listBody.canResolveAll).toBe(true);

      // A reply is not independently resolvable; the root is.
      const resolveReply = await fetch(
        `${api.baseUrl}/api/artifacts/${token}/comments/${replyRow.id}/resolve`,
        { method: "POST" },
      );
      expect(resolveReply.status).toBe(400);
      const resolveRoot = await fetch(
        `${api.baseUrl}/api/artifacts/${token}/comments/${root.id}/resolve`,
        { method: "POST" },
      );
      expect(resolveRoot.status).toBe(200);

      // Resolve authorization: a third party who is neither the commenter,
      // the sharer, nor an admin gets a 403. (test-member authored the
      // reply, not the root — but roots are the resolvable unit, so use a
      // fresh root from the sharer and try to resolve as test-member.)
      const add2 = await fetch(`${api.baseUrl}/api/artifacts/${token}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "Second thread" }),
      });
      const root2 = ((await add2.json()) as AddArtifactCommentResponse).comment;
      const foreignResolve = await fetch(
        `${api.baseUrl}/api/artifacts/${token}/comments/${root2.id}/resolve`,
        { method: "POST", headers: { "x-valet-test-user-id": "test-member" } },
      );
      expect(foreignResolve.status).toBe(403);
    } finally {
      await api.cleanup();
    }
  });

  it("sendToSession delivers the comment into the publishing session as a prompt", async () => {
    const api = await bootTestApi();
    try {
      // A real session owned by the stub user (virtual sandbox, no engine turn
      // needed — the assertion reads the persisted queue/messages).
      const createRes = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: "/tmp" }),
      });
      expect(createRes.status).toBe(201);
      const sessionId = ((await createRes.json()) as { id: string }).id;

      // Publish "from" that session — the internal-token path stamps the
      // source session exactly the way artifact_publish does.
      const res = await fetch(`${api.baseUrl}/api/artifacts/share`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-valet-internal": internalToken(),
          "x-valet-owner": "user:local-user",
          "x-valet-actor": "local-user",
          "x-valet-session-id": sessionId,
        },
        body: JSON.stringify({ key: "pages/from-session", content: "<h1>Board</h1>", format: "html" }),
      });
      expect(res.status).toBe(200);
      const shared = (await res.json()) as ShareArtifactResponse;
      const token = new URL(shared.url).pathname.replace(/^\/a\//, "");

      // The stub user owns the session → canSendToSession is true.
      const list = await fetch(`${api.baseUrl}/api/artifacts/${token}/comments`);
      expect(((await list.json()) as ListArtifactCommentsResponse).canSendToSession).toBe(true);

      const add = await fetch(`${api.baseUrl}/api/artifacts/${token}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "Add a per-region breakdown", vdid: "deadbeef00000000", sendToSession: true }),
      });
      expect(add.status).toBe(200);
      const added = (await add.json()) as AddArtifactCommentResponse;
      expect(added.sent).toBe(true);
      expect(added.comment.sentToSession).toBe(sessionId);

      // `sent: true` + `sentToSession` IS the delivery contract: the route
      // returns them only after `submitSessionPrompt` hands back a queue
      // receipt from the engine thread. The prompt does NOT show in
      // GET /messages here — a queued item becomes a message entry at turn
      // admission, and admission needs a provider key the scrubbed e2e env
      // never has, so asserting on message history would pass with keys and
      // fail in every `make e2e` run.

      // A commenter without session view access saves but does not deliver.
      const foreignAdd = await fetch(`${api.baseUrl}/api/artifacts/${token}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
        body: JSON.stringify({ body: "I want this too", sendToSession: true }),
      });
      expect(foreignAdd.status).toBe(200);
      const foreign = (await foreignAdd.json()) as AddArtifactCommentResponse;
      expect(foreign.sent).toBe(false);
      expect(foreign.comment.sentToSession).toBeNull();
    } finally {
      await api.cleanup();
    }
  });
});

/**
 * Integration tests for `/api/assistants`
 * (`docs/specs/2026-08-13-assistants-design.md`).
 *
 * Two rules the spec sets carry the weight here, and each has its own
 * describe block:
 *
 *   - Promotion is atomic. A principal must never hold zero defaults —
 *     every automation that targets it resolves through the default, and a
 *     principal with none strands every one of them.
 *   - The default cannot be archived while it is the default, and the
 *     refusal names the corrective action.
 *
 * Identities come from `bootTestApi`: `local-user` is an org admin,
 * `test-member` is a plain org member reached with the
 * `x-valet-test-user-id` impersonation header.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  archiveAssistant,
  ArchivedAssistantError,
  createAssistant,
  loadAssistant,
  patchAssistant,
  retireAssistant,
  toAssistantSummary,
} from "../assistants/service.js";
import { assistants, teamMembers, teams } from "../schema/index.js";
import type {
  AssistantSummary,
  ListAssistantsResponse
} from "../wire/types.js";
import { bootTestApi, type TestApi } from "./_setup.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  // This file is in the "integration" vitest project, which — unlike
  // "unit" — has no `vitest.setup.ts` scrub between tests (integration
  // suites need the real ambient ANTHROPIC_API_KEY). A `vi.stubEnv` in one
  // test would otherwise leak into the next.
  vi.unstubAllEnvs();
});

const MEMBER_HEADERS = { "x-valet-test-user-id": "test-member" };
const JSON_HEADERS = { "Content-Type": "application/json" };

/** Seed historical profiles directly. Public initialization no longer creates custom profiles. */
async function create(target: TestApi, body: { name?: string; owner?: { type: "user" | "team"; id: string } }, headers: Record<string, string> = {}): Promise<AssistantSummary> {
  return toAssistantSummary(await createAssistant(target.providers.db, "local-org",
    body.owner ?? { type: "user", id: headers["x-valet-test-user-id"] ?? "local-user" }, body.name ?? null));
}

async function list(target: TestApi, query = "", headers: Record<string, string> = {}): Promise<AssistantSummary[]> {
  const res = await fetch(`${target.baseUrl}/api/assistants${query}`, { headers });
  expect(res.status).toBe(200);
  return ((await res.json()) as ListAssistantsResponse).assistants;
}

/** Creates `team_1` in the local org with `userId` on it in `role`. */
async function seedTeam(target: TestApi, userId: string, role: "admin" | "member"): Promise<void> {
  await target.providers.db
    .insert(teams)
    .values({ id: "team_1", orgId: "local-org", name: "Platform", createdAt: Date.now() });
  await target.providers.db.insert(teamMembers).values({ teamId: "team_1", userId, role });
}

describe("GET /api/assistants", () => {
  it("lists the caller's own assistants, default first", async () => {
    api = await bootTestApi();
    const first = await create(api, { name: "Research" });
    const second = await create(api, { name: "Triage" });

    const rows = await list(api);
    expect(rows.map((r) => r.id)).toEqual([first.id, second.id]);
    expect(rows[0]?.isDefault).toBe(true);
  });

  it("without a filter it also lists the assistants of every team the caller is on", async () => {
    api = await bootTestApi();
    await seedTeam(api, "test-member", "member");
    const mine = await create(api, { name: "Mine" }, MEMBER_HEADERS);
    const teamOwned = await create(api, { name: "Platform bot", owner: { type: "team", id: "team_1" } });

    const rows = await list(api, "", MEMBER_HEADERS);
    expect(rows.map((r) => r.id).sort()).toEqual([mine.id, teamOwned.id].sort());
  });

  it("filters by owner", async () => {
    api = await bootTestApi();
    await seedTeam(api, "local-user", "admin");
    await create(api, { name: "Mine" });
    const teamOwned = await create(api, { name: "Platform bot", owner: { type: "team", id: "team_1" } });

    const rows = await list(api, "?ownerType=team&ownerId=team_1");
    expect(rows.map((r) => r.id)).toEqual([teamOwned.id]);
  });

  it("a non-member cannot list a team's assistants", async () => {
    api = await bootTestApi();
    await seedTeam(api, "local-user", "admin");

    const res = await fetch(`${api.baseUrl}/api/assistants?ownerType=team&ownerId=team_1`, {
      headers: MEMBER_HEADERS,
    });
    expect(res.status).toBe(404);
  });

  it("rejects half an owner filter and says how to fix it", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/assistants?ownerType=team`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("ownerId");
  });

  it("omits archived assistants", async () => {
    api = await bootTestApi();
    await create(api, { name: "Keep" });
    const archived = await create(api, { name: "Drop" });

    const row = await loadAssistant(api.providers.db, archived.id);
    if (!row) throw new Error("missing historical fixture");
    await archiveAssistant(api.providers.db, row);

    const rows = await list(api);
    expect(rows.map((r) => r.id)).not.toContain(archived.id);
  });
});

/**
 * The gap this closes: creating an assistant writes only the `assistants`
 * row, and every ordinary session route reads `agent_sessions`. Without an
 * open step a brand-new assistant listed correctly and 404'd on the first
 * click — the feature would have looked finished and failed on use.
 */
describe("POST /api/assistants/:id/session", () => {
  it("honors the row's STORED session_id when it differs from the derived one (migrated rows)", async () => {
    api = await bootTestApi();

    // A row migrated from `orchestrator_identities` keeps its legacy
    // orchestrator session id — stored != assistantSessionId(id). The
    // ensure must return the STORED id, or the chat page marks the wrong
    // session opened and spins forever (observed live on agents-dev after
    // the #264 data migration).
    const legacySessionId = "orchestrator:user:local-user";
    const now = Date.now();
    await api.providers.db.insert(assistants).values({
      id: "migrated-legacy-row",
      orgId: "local-org",
      ownerType: "user",
      ownerId: "local-user",
      name: "Legacy",
      sessionId: legacySessionId,
      isDefault: false,
      createdAt: now,
    });

    const opened = (await (
      await fetch(`${api.baseUrl}/api/assistants/migrated-legacy-row/session`, {
        method: "POST",
      })
    ).json()) as { sessionId: string };
    expect(opened.sessionId).toBe(legacySessionId);
  });

  it("makes a newly created assistant openable, which it is not on create alone", async () => {
    api = await bootTestApi();

    const created = (await (
      await fetch(`${api.baseUrl}/api/assistants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).json()) as AssistantSummary;

    // Create alone leaves no app row, so the session route cannot serve it.
    const beforeOpen = await fetch(
      `${api.baseUrl}/api/sessions/${encodeURIComponent(created.sessionId)}`,
    );
    expect(beforeOpen.status).toBe(404);

    const opened = await fetch(`${api.baseUrl}/api/assistants/${created.id}/session`, {
      method: "POST",
    });
    expect(opened.status).toBe(200);
    expect(((await opened.json()) as { sessionId: string }).sessionId).toBe(created.sessionId);

    const afterOpen = await fetch(
      `${api.baseUrl}/api/sessions/${encodeURIComponent(created.sessionId)}`,
    );
    expect(afterOpen.status).toBe(200);
  });

  it("is idempotent — opening twice returns the same session and adds no row", async () => {
    api = await bootTestApi();
    const created = (await (
      await fetch(`${api.baseUrl}/api/assistants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).json()) as AssistantSummary;

    const first = await fetch(`${api.baseUrl}/api/assistants/${created.id}/session`, { method: "POST" });
    const second = await fetch(`${api.baseUrl}/api/assistants/${created.id}/session`, { method: "POST" });
    expect(await first.json()).toEqual(await second.json());

    const rows = await api.providers.db.select().from(assistants).where(eq(assistants.id, created.id));
    expect(rows).toHaveLength(1);
  });

  it("404s an assistant the caller cannot view", async () => {
    api = await bootTestApi();
    const created = (await (
      await fetch(`${api.baseUrl}/api/assistants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Mine" }),
      })
    ).json()) as AssistantSummary;

    // `local-user` owns it; a different member has no path to it.
    const res = await fetch(`${api.baseUrl}/api/assistants/${created.id}/session`, {
      method: "POST",
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(res.status).toBe(404);
  });
});

/**
 * TKAI-296 — retire (session delete) interactions. Retire archives a row
 * that may be the default, so the two paths that used to assume "a default
 * is never archived" get explicit pins: a racing promote is refused, and a
 * wake on the retired assistant is refused at the build choke point.
 */
describe("retireAssistant interactions", () => {
  it("a promote racing a retire is refused instead of minting an archived default", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    const first = await create(api, { name: "Research" });
    const second = await create(api, { name: "Triage" });

    // Model the race: the PATCH route loaded `second` while it was live...
    const stale = await loadAssistant(db, second.id);
    if (!stale) throw new Error("seeded assistant missing");
    // ...then a session delete retired it before the PATCH's transaction.
    await retireAssistant(db, second.id);

    await expect(patchAssistant(db, stale, { isDefault: true })).rejects.toBeInstanceOf(
      ArchivedAssistantError,
    );
    // The refusal rolled back the demote: the previous default still holds.
    const rows = await db.select().from(assistants).where(eq(assistants.ownerId, "local-user"));
    expect(rows.filter((r) => r.isDefault).map((r) => r.id)).toEqual([first.id]);
  });

  it("a retired assistant's session refuses to wake", async () => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;
    const created = await create(api, { name: "Research" });
    await retireAssistant(db, created.id);

    await expect(
      engineHost.assistantSessionFor(created.id, {
        actorUserId: "local-user",
        orgId: "local-org",
      }),
    ).rejects.toBeInstanceOf(ArchivedAssistantError);
  });

  // Migrated rows keep legacy `orchestrator:*` session ids that sessionFor's
  // prefix parse cannot recognize — the column-lookup fallback must route
  // them to the assistant build, where the archived refusal applies.
  it("a retired migrated assistant refuses to wake through the generic sessionFor path", async () => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;
    await db.insert(assistants).values({
      id: "asst_legacy_wake",
      orgId: "local-org",
      ownerType: "user",
      ownerId: "local-user",
      name: null,
      personality: null,
      behavior: null,
      sessionId: "orchestrator:user:local-user",
      isDefault: true,
      createdAt: Date.now(),
      archivedAt: null,
    });
    await retireAssistant(db, "asst_legacy_wake");

    await expect(
      engineHost.sessionFor("orchestrator:user:local-user", {
        userId: "local-user",
        orgId: "local-org",
        workspace: "/tmp/legacy-wake",
      }),
    ).rejects.toBeInstanceOf(ArchivedAssistantError);
  });
});

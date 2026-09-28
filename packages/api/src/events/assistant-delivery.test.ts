import { seedWorkspaceAssistant } from "../test-helpers/assistant-fixture.js";
import { fauxAssistantMessage, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { VirtualSandboxProvider, type MessageEntry } from "@valet/engine";
import { PgEventStream, PgSessionStore } from "@valet/store-postgres";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EngineHost } from "../engine/host.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { assistants, teams, users } from "../schema/index.js";
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { deliverToAssistantThread } from "./assistant-delivery.js";

const ORG = "org-1";
const USER = "user-1";
const OWNER = { type: "org" as const, id: ORG };

/** Wait for the first user message the delivery submitted to land on the thread. */
async function firstUserEntry(
  deps: { db: TestPgDb["appDb"]; engineHost: EngineHost },
  threadKey: string,
): Promise<MessageEntry | undefined> {
  const session = await defaultAssistantSessionFor(deps, OWNER, { actorUserId: USER, orgId: ORG });
  const threadId = session.thread(threadKey).id;
  for (let i = 0; i < 100; i++) {
    const entries = await session.providers.store.getEntries(session.id, threadId);
    const entry = entries.find((e) => e.type === "message" && e.role === "user") as MessageEntry | undefined;
    if (entry) return entry;
    await new Promise((r) => setTimeout(r, 20));
  }
  return undefined;
}

describe("deliverToAssistantThread — thread-context hydration", () => {
  let testDb: TestPgDb;
  let engineHost: EngineHost;
  let faux: FauxProviderRegistration;

  beforeEach(async () => {
    faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    faux.setResponses([fauxAssistantMessage("(noted)"), fauxAssistantMessage("(noted)")]);
    vi.stubEnv("ANTHROPIC_API_KEY", "faux-key");
    testDb = await freshTestPgDb();
    const { pgdb, appDb } = testDb;
    engineHost = new EngineHost({
      engineStore: new PgSessionStore(pgdb),
      sandboxProvider: new VirtualSandboxProvider(),
      eventStream: new PgEventStream(pgdb),
      engineCredentials: new PgCredentialStore(pgdb, deriveSecretKey("test-key")),
      db: appDb,
      apiBaseUrl: "http://127.0.0.1:1",
      plugins: [],
    });
  });

  afterEach(async () => {
    await engineHost.destroyAll();
    faux.unregister();
    vi.unstubAllEnvs();
  });

  const channelSignal = (body: string) => ({
    kind: "signal" as const,
    signalType: "app_mention",
    body,
    attributes: {},
    origin: { channelType: "slack", threadKey: "slack:C1:1.2", reply: "auto" as const },
  });

  it("persists each delivery actor on a cached session without rebinding its owner", async () => {
    const deps = { db: testDb.appDb, engineHost };
    const session = await defaultAssistantSessionFor(deps, OWNER, { actorUserId: USER, orgId: ORG });
    for (const actor of ["member-b", "member-c"]) {
      const threadKey = `slack:C1:${actor}`;
      await deliverToAssistantThread(deps, {
        orgId: ORG, owner: OWNER, actorUserId: actor, threadKey,
        signal: channelSignal(actor), dispatchId: actor, mismatchReason: "test",
      });
      expect(await firstUserEntry(deps, threadKey)).toMatchObject({ author: { id: actor } });
    }
    expect(session.options.userId).toBe(USER);
    expect(session.owner).toEqual(OWNER);
  });

  it("uses the current team defaults for new Slack threads after restore", async () => {
    const deps = { db: testDb.appDb, engineHost };
    const owner = { type: "team", id: "team-defaults" } as const;
    await testDb.appDb.insert(teams).values({ id: owner.id, orgId: ORG, name: "Defaults", createdAt: Date.now(), defaultModel: "claude-opus-4-5", defaultReasoning: "high" });
    const session = await defaultAssistantSessionFor(deps, owner, { actorUserId: USER, orgId: ORG });
    const oldThread = await session.createThread("slack:C1:old", { model: "claude-sonnet-4-5", reasoning: "low" });
    await testDb.appDb.update(teams).set({ defaultModel: "m", defaultReasoning: "low" }).where(eq(teams.id, owner.id));
    // A team runtime must not inherit the member who delivered the event.
    await testDb.appDb.insert(users).values({ id: USER, email: "event-model@example.com", name: "Event user", defaultModel: "l" });
    engineHost.evictAll();

    await deliverToAssistantThread(deps, {
      orgId: ORG, owner: owner, actorUserId: USER,
      threadKey: "slack:C1:1.2", signal: channelSignal("first"),
      dispatchId: "model-first", mismatchReason: "event_target_mismatch",
    });
    const restored = await defaultAssistantSessionFor(deps, owner, { actorUserId: USER, orgId: ORG });
    expect((await restored.threadByKey("slack:C1:1.2"))?.modelId()).toBe("m");
    expect((await restored.threadByKey("slack:C1:1.2"))?.reasoning()).toBe("low");
    expect(restored.threadById(oldThread.id)?.modelId()).toBe("claude-sonnet-4-5");
    expect(restored.options.modelSpec).toBe("claude-opus-4-5");

    await testDb.appDb.update(teams).set({ defaultModel: null, defaultReasoning: null }).where(eq(teams.id, owner.id));
    await deliverToAssistantThread(deps, {
      orgId: ORG, owner: owner, actorUserId: USER,
      threadKey: "slack:C1:next", signal: channelSignal("next"),
      dispatchId: "model-next", mismatchReason: "event_target_mismatch",
    });
    expect((await restored.threadByKey("slack:C1:next"))?.modelId()).toBe("s");
    expect((await restored.threadByKey("slack:C1:next"))?.toThreadData().reasoning).toBe("off");
    expect((await restored.threadByKey("slack:C1:1.2"))?.modelId()).toBe("m");
  });

  it("prepends the fetched thread transcript on the first turn in a channel thread", async () => {
    const fetchThreadContext = vi.fn(async () => "Brian: kicking this off\nConner: this needs a skill");
    await deliverToAssistantThread(
      { db: testDb.appDb, engineHost, fetchThreadContext },
      {
        orgId: ORG,
        owner: OWNER,
        actorUserId: USER,
        threadKey: "slack:C1:1.2",
        signal: channelSignal("file an issue for this"),
        dispatchId: "d1",
        mismatchReason: "event_target_mismatch",
      },
    );

    const entry = await firstUserEntry({ db: testDb.appDb, engineHost }, "slack:C1:1.2");
    expect(fetchThreadContext).toHaveBeenCalledOnce();
    expect(entry?.content).toBe(
      "Conversation so far in this thread:\n" +
        "Brian: kicking this off\nConner: this needs a skill\n\n---\n\n" +
        "file an issue for this",
    );
  });

  it("does not fetch or prepend when the thread already has entries", async () => {
    // Seed the thread with a first delivery (no hook), then deliver again with a hook.
    await deliverToAssistantThread(
      { db: testDb.appDb, engineHost },
      {
        orgId: ORG,
        owner: OWNER,
        actorUserId: USER,
        threadKey: "slack:C1:1.2",
        signal: channelSignal("first"),
        dispatchId: "d1",
        mismatchReason: "event_target_mismatch",
      },
    );
    await firstUserEntry({ db: testDb.appDb, engineHost }, "slack:C1:1.2");

    const fetchThreadContext = vi.fn(async () => "should not be used");
    await deliverToAssistantThread(
      { db: testDb.appDb, engineHost, fetchThreadContext },
      {
        orgId: ORG,
        owner: OWNER,
        actorUserId: USER,
        threadKey: "slack:C1:1.2",
        signal: channelSignal("second"),
        dispatchId: "d2",
        mismatchReason: "event_target_mismatch",
      },
    );
    expect(fetchThreadContext).not.toHaveBeenCalled();
  });

  it("two racing deliveries on one new thread seed the transcript exactly once (TKAI-284)", async () => {
    // A slow transcript fetch is the race window: without per-thread
    // serialization, both deliveries pass the empty-thread check during the
    // other's fetch and both prepend.
    const fetchThreadContext = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return "Brian: earlier context";
    });
    await Promise.all([
      deliverToAssistantThread(
        { db: testDb.appDb, engineHost, fetchThreadContext },
        {
          orgId: ORG,
          owner: OWNER,
          actorUserId: USER,
          threadKey: "slack:C1:1.2",
          signal: channelSignal("mention one"),
          dispatchId: "d1",
          mismatchReason: "event_target_mismatch",
        },
      ),
      deliverToAssistantThread(
        { db: testDb.appDb, engineHost, fetchThreadContext },
        {
          orgId: ORG,
          owner: OWNER,
          actorUserId: USER,
          threadKey: "slack:C1:1.2",
          signal: channelSignal("mention two"),
          dispatchId: "d2",
          mismatchReason: "event_target_mismatch",
        },
      ),
    ]);
    expect(fetchThreadContext).toHaveBeenCalledOnce();

    const session = await defaultAssistantSessionFor({ db: testDb.appDb, engineHost }, OWNER, {
      actorUserId: USER,
      orgId: ORG,
    });
    const threadId = session.thread("slack:C1:1.2").id;
    let seeded: string[] = [];
    for (let i = 0; i < 100; i++) {
      const entries = await session.providers.store.getEntries(session.id, threadId);
      const userBodies = entries
        .filter((e): e is MessageEntry => e.type === "message" && e.role === "user")
        .map((e) => e.content ?? "");
      if (userBodies.length >= 2) {
        seeded = userBodies.filter((b) => b.includes("Conversation so far in this thread:"));
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(seeded).toHaveLength(1);
  });
});

describe("deliverToAssistantThread — which assistant answers", () => {
  let testDb: TestPgDb;
  let engineHost: EngineHost;
  let faux: FauxProviderRegistration;

  beforeEach(async () => {
    faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    faux.setResponses([fauxAssistantMessage("(noted)"), fauxAssistantMessage("(noted)")]);
    vi.stubEnv("ANTHROPIC_API_KEY", "faux-key");
    testDb = await freshTestPgDb();
    const { pgdb, appDb } = testDb;
    engineHost = new EngineHost({
      engineStore: new PgSessionStore(pgdb),
      sandboxProvider: new VirtualSandboxProvider(),
      eventStream: new PgEventStream(pgdb),
      engineCredentials: new PgCredentialStore(pgdb, deriveSecretKey("test-key")),
      db: appDb,
      apiBaseUrl: "http://127.0.0.1:1",
      plugins: [],
    });
  });

  afterEach(async () => {
    await engineHost.destroyAll();
    faux.unregister();
    vi.unstubAllEnvs();
  });

  const signal = (body: string) => ({
    kind: "signal" as const,
    signalType: "app_mention",
    body,
    attributes: {},
  });

  it("delivers into the owner's singleton and persists the initiating actor", async () => {
    const deps = { db: testDb.appDb, engineHost };
    await deliverToAssistantThread(deps, {
      orgId: ORG, owner: OWNER, actorUserId: USER, threadKey: "events",
      signal: signal("go"), dispatchId: "d1", mismatchReason: "event_target_mismatch",
    });
    expect(await firstUserEntry(deps, "events")).toMatchObject({ content: "go", author: { id: USER } });
    const rows = await testDb.appDb.select().from(assistants);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerType: OWNER.type, ownerId: OWNER.id });
  });
});

import { PGlite } from "@electric-sql/pglite";
import { VirtualSandboxProvider } from "@valet/engine";
import { PgEventStream, PgSessionStore, pgDbFromPglite } from "@valet/store-postgres";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { savedGatePrompts } from "../channels/gate-prompts.js";
import { EngineHost } from "../engine/host.js";
import { applyAppMigrations, buildAppDb } from "../lib/drizzle.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { defaultAssistantSessionFor } from "../test-helpers/assistant-session.js";
import { findFollowedThread, upsertFollowedThread } from "./followed-threads.js";

it("reopens a Slack conversation with its stable identity, history, pending gate and binding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "valet-thread-reopen-"));
  async function boot() {
    const pglite = new PGlite(join(dir, "pg"));
    const pgdb = pgDbFromPglite(pglite);
    await applyAppMigrations(pgdb);
    const db = buildAppDb(pglite);
    const engineStore = new PgSessionStore(pgdb);
    const engineHost = new EngineHost({ db, engineStore, sandboxProvider: new VirtualSandboxProvider(),
      eventStream: new PgEventStream(pgdb), engineCredentials: new PgCredentialStore(pgdb, deriveSecretKey("reopen-test")),
      apiBaseUrl: "http://127.0.0.1:1", plugins: [],
    });
    return { pglite, db, engineStore, engineHost };
  }
  let stack = await boot();
  const owner = { type: "user", id: "reopen-user" } as const;
  const meta = { actorUserId: owner.id, orgId: "reopen-org" };
  const key = { orgId: meta.orgId, channelType: "slack", channelId: "C1", threadTs: "100.2" };
  try {
    const session = await defaultAssistantSessionFor(stack, owner, meta);
    const thread = await session.createThread("slack:C1:100.2");
    await stack.engineStore.appendEntries(session.id, thread.id, [{
      id: "reopen-history", sessionId: session.id, threadId: thread.id, parentId: null,
      type: "message", role: "user", content: "durable Slack history", createdAt: 1,
    }]);
    await stack.engineStore.saveDecisionGate(session.id, thread.id, {
      id: "reopen-gate", sessionId: session.id, threadId: thread.id, queueItemId: "reopen-q",
      resumeKey: "approval", ordinal: 0, type: "approval", title: "Approve?", actions: [],
      status: "pending", createdAt: 1, updatedAt: 1,
    });
    await stack.engineStore.saveDecisionGateRef(session.id, thread.id, "reopen-gate", {
      channelType: "slack", ref: { channelId: "slack:T1:C1:100.2", messageId: "200.1" },
    });
    await upsertFollowedThread(stack.db, { ...key, ownerType: owner.type, ownerId: owner.id, createdBy: owner.id });
    // Close the database and rebuild every provider. This is stronger than cache eviction.
    stack.engineHost.evictAll();
    await stack.pglite.close();
    stack = await boot();
    const restored = await defaultAssistantSessionFor(stack, owner, meta);
    expect(restored.id).toBe(session.id);
    const sameThread = await restored.createThread("slack:C1:100.2");
    expect(sameThread.id).toBe(thread.id);
    expect(await stack.engineStore.getEntries(restored.id, sameThread.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "reopen-history", content: "durable Slack history" }),
    ]));
    expect(await stack.engineStore.getDecisionGate(restored.id, "reopen-gate")).toMatchObject({ status: "pending", threadId: sameThread.id });
    expect(await savedGatePrompts(stack.db, meta.orgId)).toEqual([
      { gateId: "reopen-gate", sessionId: restored.id, ref: { conversationKey: "slack:T1:C1:100.2", messageId: "200.1" } },
    ]);
    expect(await savedGatePrompts(stack.db, "other-org")).toEqual([]);
    expect(await findFollowedThread(stack.db, key)).toMatchObject({ ownerType: owner.type, ownerId: owner.id });
    expect(await findFollowedThread(stack.db, { ...key, orgId: "other-org" })).toBeNull();
  } finally {
    await stack.engineHost.destroyAll();
    await stack.pglite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

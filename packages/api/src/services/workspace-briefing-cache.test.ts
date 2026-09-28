import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, artifacts, sessionThreads, workflowDefinitions, workflowRuns, workspaceBriefingCache } from "../schema/index.js";
import type { WorkspaceBriefingsResponse } from "../wire/types.js";
import type { BriefingEvidence } from "./workspace-briefing-sources.js";
import { briefingEvidenceHash, createDurableBriefingCache } from "./workspace-briefing-cache.js";
import { canReadCachedBriefingSources } from "./workspace-briefing-cache-access.js";

const owner = { type: "user" as const, id: "local-user" };
const evidence: BriefingEvidence[] = [{ source: { id: "thread:s:t", kind: "thread", title: "Goal", sessionId: "s", threadId: "t", updatedAt: 10 }, content: "Awaiting verification.", state: "updated" }];
const snapshot: WorkspaceBriefingsResponse = { briefings: [{ id: "brief", title: "Goal", summary: "Awaiting verification.", status: "updated", updatedAt: 10,
  latestThread: { sessionId: "s", threadId: "t" }, sources: evidence.map(item => item.source) }], generatedAt: 1000, coverage: "recent" };
let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });
async function setup() { api = await bootTestApi(); return api.providers.db; }
const valid = async () => true;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

describe("durable workspace briefing cache", () => {
  it("reuses persisted responses across instances and checks evidence only at the cadence", async () => {
    const db = await setup(); let clock = 1000;
    const collect = vi.fn(async () => evidence);
    const generate = vi.fn(async () => snapshot);
    const options = { version: "v1", collect, generate, validate: valid, now: () => clock };
    const first = createDurableBriefingCache(options);
    expect((await first(db,"local-org",owner)).generatedAt).toBe(1000);
    const restarted = createDurableBriefingCache(options);
    expect((await restarted(db,"local-org",owner)).checkedAt).toBe(1000);
    expect(collect).toHaveBeenCalledTimes(1); expect(generate).toHaveBeenCalledTimes(1);
    clock += 60_001;
    expect((await restarted(db,"local-org",owner)).checkedAt).toBe(clock);
    expect(collect).toHaveBeenCalledTimes(2); expect(generate).toHaveBeenCalledTimes(1);
    await createDurableBriefingCache({ ...options, version: "v2" })(db,"local-org",owner);
    expect(generate).toHaveBeenCalledTimes(2);
    await restarted(db,"other-org",owner);
    await restarted(db,"local-org",{ type: "team", id: "team" });
    expect(generate).toHaveBeenCalledTimes(4);
  });
  it("coalesces replicas with an atomic lease and clears changed snapshots during refresh", async () => {
    const db = await setup(); let clock = 1000;
    const pending = deferred<WorkspaceBriefingsResponse>();
    const collect = vi.fn(async () => evidence);
    const generate = vi.fn(async () => snapshot);
    const options = { version: "v1", collect, generate, validate: valid, now: () => clock };
    const first = createDurableBriefingCache(options); const second = createDurableBriefingCache(options);
    await first(db,"local-org",owner);
    clock += 60_001;
    collect.mockResolvedValue([{ ...evidence[0], content: "New conclusion." }]);
    generate.mockImplementation(() => pending.promise);
    const refreshing = first(db,"local-org",owner);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(await second(db,"local-org",owner)).toMatchObject({ briefings: [], refreshing: true, unavailable: true });
    expect(collect).toHaveBeenCalledTimes(2);
    pending.resolve({ ...snapshot, generatedAt: clock });
    expect((await refreshing).generatedAt).toBe(clock);
    expect((await second(db,"local-org",owner)).refreshing).toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it("backs off failed generations across instances without repeated source or model reads", async () => {
    const db = await setup(); let clock = 1000;
    const collect = vi.fn(async () => evidence);
    const generate = vi.fn(async (): Promise<WorkspaceBriefingsResponse> => ({ briefings: [], generatedAt: null, coverage: "recent", unavailable: true }));
    const options = { version: "v1", collect, generate, validate: valid, now: () => clock };
    expect((await createDurableBriefingCache(options)(db,"local-org",owner)).unavailable).toBe(true);
    const another = createDurableBriefingCache(options);
    await another(db,"local-org",owner); await another(db,"local-org",owner);
    expect(generate).toHaveBeenCalledTimes(1); expect(collect).toHaveBeenCalledTimes(1);
    clock += 60_001;
    generate.mockResolvedValue(snapshot);
    expect((await another(db,"local-org",owner)).unavailable).toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it("fences an expired worker so it cannot overwrite a newer replica's result", async () => {
    const db = await setup(); let clock = 1000;
    const pending = deferred<WorkspaceBriefingsResponse>();
    const generate = vi.fn(() => pending.promise);
    const options = { version: "v1", collect: async () => evidence, generate, validate: valid, now: () => clock, leaseMs: 100 };
    const stale = createDurableBriefingCache(options)(db,"local-org",owner);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    clock += 101;
    const newest = { ...snapshot, generatedAt: 2000 };
    await createDurableBriefingCache({ ...options, generate: async () => newest })(db,"local-org",owner);
    pending.resolve(snapshot);
    expect((await stale).generatedAt).toBe(2000);
    expect((await db.select().from(workspaceBriefingCache))[0].response?.generatedAt).toBe(2000);
  });
  it("revalidates source ownership on fresh hits and after generation", async () => {
    const db = await setup();
    await db.insert(agentSessions).values({ id: "s", orgId: "local-org", userId: "local-user", ownerType: "user", ownerId: "local-user", workspace: "w", createdAt: 1, updatedAt: 1 });
    await db.insert(sessionThreads).values({ id: "t", sessionId: "s", createdAt: 1 });
    const collect = vi.fn(async () => evidence);
    const cached = createDurableBriefingCache({ version: "v1", collect, generate: async () => snapshot });
    expect((await cached(db,"local-org",owner)).briefings).toHaveLength(1);
    await db.update(agentSessions).set({ ownerId: "test-member" }).where(eq(agentSessions.id,"s"));
    expect(await cached(db,"local-org",owner)).toMatchObject({ briefings: [], unavailable: true });
    expect(collect).toHaveBeenCalledTimes(1);
    await db.update(agentSessions).set({ ownerId: "local-user" }).where(eq(agentSessions.id,"s"));
    const pending = deferred<WorkspaceBriefingsResponse>();
    const generate = vi.fn(() => pending.promise);
    const started = createDurableBriefingCache({ version: "v2", collect, generate })(db,"local-org",owner);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await db.update(agentSessions).set({ status: "deleted" }).where(eq(agentSessions.id,"s"));
    pending.resolve(snapshot);
    expect(await started).toMatchObject({ briefings: [], unavailable: true });
    expect((await db.select().from(workspaceBriefingCache).where(and(eq(workspaceBriefingCache.orgId,"local-org"),eq(workspaceBriefingCache.ownerId,owner.id))))[0].response).toBeNull();
  });
  it("rejects revoked artifact sources and moved workflow sources without scanning their bodies", async () => {
    const db = await setup();
    await db.insert(artifacts).values({ id: "a", token: "token", orgId: "local-org", ownerType: "user", ownerId: owner.id, actorUserId: owner.id, sourceMemoryPath: "a", content: "private", createdAt: 1, updatedAt: 1 });
    await db.insert(workflowDefinitions).values({ id: "w", orgId: "local-org", ownerType: "user", ownerId: owner.id, name: "w", definition: {}, createdAt: 1, updatedAt: 1 });
    await db.insert(workflowRuns).values({ id: "r", workflowId: "w", definitionVersionId: "v", definition: {}, params: {}, ownerType: "user", ownerId: owner.id, createdAt: 1, updatedAt: 1 });
    const response: WorkspaceBriefingsResponse = { ...snapshot, briefings: [{ ...snapshot.briefings[0], latestThread: null, sources: [
      { id: "artifact:a", kind: "artifact", token: "token", title: "a", updatedAt: 1 },
      { id: "workflow:r", kind: "workflow", runId: "r", title: "r", updatedAt: 1 },
    ] }] };
    expect(await canReadCachedBriefingSources(db,"local-org",owner,response)).toBe(true);
    await db.update(artifacts).set({ revokedAt: 2 }).where(eq(artifacts.id,"a"));
    expect(await canReadCachedBriefingSources(db,"local-org",owner,response)).toBe(false);
    await db.update(artifacts).set({ revokedAt: null }).where(eq(artifacts.id,"a"));
    await db.update(workflowRuns).set({ ownerType: "team", ownerId: "another" }).where(eq(workflowRuns.id,"r"));
    expect(await canReadCachedBriefingSources(db,"local-org",owner,response)).toBe(false);
  });
  it("hashes semantic changes but ignores source ordering and non-conversation heartbeats", () => {
    const run: BriefingEvidence = { source: { id: "run", kind: "workflow", title: "Run", runId: "r", updatedAt: 10 }, content: "Awaiting approval.", state: "needs_attention" };
    expect(briefingEvidenceHash([...evidence,run])).toBe(briefingEvidenceHash([{ ...run, source: { ...run.source, updatedAt: 20 } },...evidence]));
    expect(briefingEvidenceHash(evidence)).not.toBe(briefingEvidenceHash([{ ...evidence[0], content: "Changed" }]));
    expect(briefingEvidenceHash(evidence)).not.toBe(briefingEvidenceHash([{ ...evidence[0], source: { ...evidence[0].source, updatedAt: 20 } }]));
  });
});

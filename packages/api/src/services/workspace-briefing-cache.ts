import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, lte, or, ne } from "drizzle-orm";
import type { Principal } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { workspaceBriefingCache as cache } from "../schema/index.js";
import type { WorkspaceBriefingsResponse } from "../wire/types.js";
import { canReadCachedBriefingSources } from "./workspace-briefing-cache-access.js";
import type { BriefingEvidence } from "./workspace-briefing-sources.js";

type CacheRow = typeof cache.$inferSelect;

/** Ordering and workflow heartbeats do not change the facts sent to the model. */
export function briefingEvidenceHash(evidence: readonly BriefingEvidence[]): string {
  const stable = evidence.map(item => {
    const { updatedAt, ...source } = item.source;
    return { ...item, source: { ...source, ...(source.kind === "thread" ? { updatedAt } : {}) } };
  }).sort((a,b) => a.source.id.localeCompare(b.source.id));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
interface CacheOptions {
  version: string;
  collect: (db: AppDb, orgId: string, owner: Principal) => Promise<BriefingEvidence[]>;
  generate: (orgId: string, owner: Principal, evidence: readonly BriefingEvidence[]) => Promise<WorkspaceBriefingsResponse>;
  validate?: typeof canReadCachedBriefingSources;
  now?: () => number;
  checkIntervalMs?: number;
  failureBackoffMs?: number;
  leaseMs?: number;
}

/** Route authorization runs on every GET. Evidence checks run at most once per minute.
 * Atomic leases serialize those checks and generation across API replicas. */
export function createDurableBriefingCache(options: CacheOptions) {
  const validate = options.validate ?? canReadCachedBriefingSources;
  const now = options.now ?? Date.now;
  const interval = options.checkIntervalMs ?? 60_000;
  const backoff = options.failureBackoffMs ?? 60_000;
  const leaseMs = options.leaseMs ?? 30_000;
  const unavailable = (checkedAt: number | null, refreshing = false): WorkspaceBriefingsResponse => ({
    briefings: [], generatedAt: null, coverage: "recent", unavailable: true, checkedAt,
    ...(refreshing ? { refreshing: true } : {}),
  });
  return async (db: AppDb, orgId: string, owner: Principal): Promise<WorkspaceBriefingsResponse> => {
    const scope = and(eq(cache.orgId,orgId),eq(cache.ownerType,owner.type),eq(cache.ownerId,owner.id));
    const visible = async (row: CacheRow | undefined): Promise<WorkspaceBriefingsResponse> => {
      const refreshing = !!row?.leaseToken && row.leaseUntil > now();
      if (!row || row.version !== options.version || !row.response) return unavailable(row?.checkedAt ?? null,refreshing);
      if (!await validate(db,orgId,owner,row.response)) {
        await db.update(cache).set({ response: null, evidenceHash: null, nextCheckAt: 0 })
          .where(and(scope,eq(cache.version,row.version),row.evidenceHash === null ? undefined : eq(cache.evidenceHash,row.evidenceHash)));
        return unavailable(row.checkedAt,refreshing);
      }
      return { ...row.response, checkedAt: row.checkedAt, ...(refreshing ? { refreshing: true } : {}) };
    };
    const read = async () => (await db.select().from(cache).where(scope).limit(1))[0];
    const existing = await read();
    const at = now();
    if (existing?.version === options.version && existing.nextCheckAt > at) return visible(existing);
    const token = randomUUID();
    const [claimed] = await db.insert(cache).values({ orgId, ownerType: owner.type, ownerId: owner.id,
      version: options.version, leaseToken: token, leaseUntil: at+leaseMs,
    }).onConflictDoUpdate({ target: [cache.orgId,cache.ownerType,cache.ownerId],
      set: { leaseToken: token, leaseUntil: at+leaseMs },
      setWhere: and(lte(cache.leaseUntil,at),or(lte(cache.nextCheckAt,at),ne(cache.version,options.version))),
    }).returning();
    if (!claimed) return visible(await read());
    const fence = () => and(scope,eq(cache.leaseToken,token),gt(cache.leaseUntil,now()));
    try {
      const evidence = await options.collect(db,orgId,owner);
      const evidenceHash = briefingEvidenceHash(evidence);
      const checkedAt = now();
      if (claimed.version === options.version && claimed.evidenceHash === evidenceHash && claimed.response) {
        const [row] = await db.update(cache).set({ checkedAt, nextCheckAt: checkedAt+interval,
          leaseToken: null, leaseUntil: 0 }).where(fence()).returning();
        return visible(row ?? await read());
      }
      // Changed evidence can revoke a source link. Clear the old snapshot before generation.
      const [invalidated] = await db.update(cache).set({ version: options.version, response: null,
        evidenceHash: null, checkedAt }).where(fence()).returning();
      if (!invalidated) return visible(await read());
      let response = evidence.length ? await options.generate(orgId,owner,evidence)
        : { briefings: [], generatedAt: null, coverage: "recent" as const };
      if (!response.unavailable && !await validate(db,orgId,owner,response)) response = unavailable(checkedAt);
      const [published] = await db.update(cache).set({ evidenceHash: response.unavailable ? null : evidenceHash,
        response: response.unavailable ? null : response, nextCheckAt: response.unavailable ? now()+backoff : checkedAt+interval,
        leaseToken: null, leaseUntil: 0 }).where(fence()).returning();
      return visible(published ?? await read());
    } catch {
      // Failed reads cannot prove old links are still authorized. Retry after the backoff.
      const [failed] = await db.update(cache).set({ version: options.version, evidenceHash: null, response: null,
        nextCheckAt: now()+backoff, leaseToken: null, leaseUntil: 0 }).where(fence()).returning();
      return visible(failed ?? await read());
    }
  };
}

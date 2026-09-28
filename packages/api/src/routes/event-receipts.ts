import { decodePageCursor, encodePageCursor, readLimit } from "../lib/page-cursor.js";
import { Hono } from "hono";
import { and, desc, eq, gte, lt, or, sql, type SQL } from "drizzle-orm";
import type { AppEnv } from "../env.js";
import { eventReceipts } from "../schema/index.js";
import { receiptWire } from "../events/receipts.js";
import { isOrgAdminUser } from "./_org-admin.js";
import type { ListEventReceiptsResponse } from "../wire/types.js";

export const eventReceiptsRouter = new Hono<AppEnv>();
eventReceiptsRouter.get("/events/receipts", async c => {
  if (!(await isOrgAdminUser(c))) return c.json({ error: "org admin required" }, 403);
  const orgId = c.var.user.orgId, db = c.var.providers.db;
  const q = (c.req.query("q") ?? "").trim();
  if (q.length > 200) return c.json({ error: "Shorten the search to 200 characters or fewer." }, 400);
  const limit = readLimit(c.req.query("limit"), 25, 100);
  if (limit === undefined) return c.json({ error: "Send a positive whole number for limit." }, 400);
  const base = and(eq(eventReceipts.orgId, orgId), gte(eventReceipts.createdAt, Date.now() - 7 * 86400000));
  const filters: SQL[] = [base!];
  if (q) {
    const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    // Search only redacted identity fields and stage outcomes; never arbitrary raw payloads.
    filters.push(sql`(${eventReceipts.id} ILIKE ${pattern} OR ${eventReceipts.externalId} ILIKE ${pattern} OR ${eventReceipts.service} ILIKE ${pattern} OR ${eventReceipts.eventKey} ILIKE ${pattern} OR ${eventReceipts.eventId} ILIKE ${pattern} OR EXISTS (SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(${eventReceipts.metadata}) = 'object' THEN ${eventReceipts.metadata} ELSE '{}'::jsonb END) m WHERE m.key = ANY(ARRAY['channelId','workspaceId','actorId','botId','appId','rawType','rawSubtype','messageTs','threadTs','retryNum','retryReason','botIdentityAvailable','botUserIdentityAvailable','payloadBytes','configuredTriggerCount']) AND m.value ILIKE ${pattern}) OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${eventReceipts.stages}) = 'array' THEN ${eventReceipts.stages} ELSE '[]'::jsonb END) s WHERE s->>'outcome' ILIKE ${pattern}))`);
  }
  const rawCursor = c.req.query("cursor");
  if (rawCursor !== undefined) {
    try {
      if (rawCursor.length > 4096) throw new Error();
      const cursor = decodePageCursor(rawCursor);
      if (!cursor || typeof cursor !== "object" || !("orgId" in cursor) || cursor.orgId !== orgId || !("q" in cursor) || cursor.q !== q || !("at" in cursor) || typeof cursor.at !== "number" || !Number.isSafeInteger(cursor.at) || !("id" in cursor) || typeof cursor.id !== "string") throw new Error();
      filters.push(or(lt(eventReceipts.createdAt, cursor.at), and(eq(eventReceipts.createdAt, cursor.at), lt(eventReceipts.id, cursor.id)))!);
    } catch { return c.json({ error: "Invalid receipt cursor. Return to the first page." }, 400); }
  }
  const [rows, latest] = await Promise.all([
    db.select().from(eventReceipts).where(and(...filters)).orderBy(desc(eventReceipts.createdAt), desc(eventReceipts.id)).limit(limit + 1),
    db.select({ at: eventReceipts.createdAt }).from(eventReceipts).where(base).orderBy(desc(eventReceipts.createdAt), desc(eventReceipts.id)).limit(1),
  ]);
  const page = rows.slice(0, limit), last = page.at(-1);
  return c.json({ receipts: page.map(receiptWire), nextCursor: rows.length > limit && last ? encodePageCursor({ orgId, q, at: last.createdAt, id: last.id }) : null, lastReceiptAt: latest[0]?.at ?? null, retentionDays: 7 } satisfies ListEventReceiptsResponse);
});

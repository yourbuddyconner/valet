/**
 * The follow store for Slack thread auto-follow. A `followed_threads` row binds
 * one Slack thread to one owner's assistant: once bound (by a follow-enabled
 * mention), later messages in that thread route to the assistant without a
 * re-mention. One row per `(org, channel, thread)`.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { followedThreads } from "../schema/index.js";

export interface FollowedThreadKey {
  orgId: string;
  channelType: string;
  channelId: string;
  threadTs: string;
}

export interface FollowedThreadRow extends FollowedThreadKey {
  ownerType: "user" | "team" | "org";
  ownerId: string;
  createdBy: string;
  /** A team re-mention must keep the original conversation binding. */
  preserveBinding?: boolean;
  /** Provider ts of the message that bound the follow (the mention), so the
   * router's gap re-hydration has a starting point before the first overheard
   * delivery. Absent → tracking starts at the first delivery. */
  lastSeenTs?: string;
  /** The mention rule this bind came from, so the router can read that rule's
   * current invocation audience on every later message. Absent → team-only,
   * which is what every follow bound before the column means. */
  subscriptionId?: string;
}

/** Bind a thread to an owner's assistant. Idempotent on `(org, channel, thread)`. */
export async function upsertFollowedThread(db: AppDb, row: FollowedThreadRow): Promise<void> {
  const now = Date.now();
  const insert = db
    .insert(followedThreads)
    .values({
      id: randomUUID(),
      orgId: row.orgId,
      channelType: row.channelType,
      channelId: row.channelId,
      threadTs: row.threadTs,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      createdBy: row.createdBy,
      createdAt: now,
      lastActivityAt: now,
      lastSeenTs: row.lastSeenTs ?? null,
      subscriptionId: row.subscriptionId ?? null,
    });
  const target = [followedThreads.orgId, followedThreads.channelType,
    followedThreads.channelId, followedThreads.threadTs];
  if (row.preserveBinding) {
    await insert.onConflictDoNothing({ target });
    return;
  }
  await insert.onConflictDoUpdate({
    target,
    // `createdBy` too: it is the actor the follow-router runs the assistant
    // session as, so a re-bind by a different owner must carry the new
    // binder's actor, not the first one's. The workspace owner stays fixed.
    // `lastSeenTs` is deliberately NOT in the update set: a re-mention on an
    // already-followed thread must not rewind the router's gap tracking.
    set: {
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      createdBy: row.createdBy,
      // `subscriptionId` follows `createdBy`: the rule that re-binds the
      // thread decides which membership the router re-checks for the new
      // actor.
      subscriptionId: row.subscriptionId ?? null,
      lastActivityAt: now,
    },
  });
}

/** The follow record for a thread, or `null` when the thread is not followed. */
export async function findFollowedThread(db: AppDb, key: FollowedThreadKey) {
  const rows = await db
    .select()
    .from(followedThreads)
    .where(
      and(
        eq(followedThreads.orgId, key.orgId),
        eq(followedThreads.channelType, key.channelType),
        eq(followedThreads.channelId, key.channelId),
        eq(followedThreads.threadTs, key.threadTs),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Record that a followed thread just saw activity. `lastSeenTs`, when given,
 * advances the router's gap-tracking cursor to the delivered message. */
export async function touchFollowedThread(db: AppDb, id: string, lastSeenTs?: string): Promise<void> {
  await db
    .update(followedThreads)
    .set({ lastActivityAt: Date.now(), ...(lastSeenTs !== undefined ? { lastSeenTs } : {}) })
    .where(eq(followedThreads.id, id));
}

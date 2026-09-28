/**
 * The follow-router: the third consumer of a Slack webhook update, beside the
 * channel (DM) and event-trigger consumers. A threaded channel message on a
 * thread the assistant follows routes to the bound assistant's per-thread valet
 * thread as an OVERHEARD signal — the assistant reads it and answers only if it
 * chooses to (via reply_to_origin / react_to_origin), or stays silent. A
 * message on an unfollowed thread is ignored and never stored.
 */
import { ConflictError } from "@valet/engine";
import type { EngineHost } from "../engine/host.js";
import { deliverToAssistantThread } from "../events/assistant-delivery.js";
import { findFollowedThread, touchFollowedThread } from "../events/followed-threads.js";
import { followBindingAuthorized, followedMessageActor } from "../events/team-slack-gate.js";
import type { AppDb } from "../lib/drizzle.js";

export interface FollowRouterDeps {
  /** Bot identity from the verified org credential. */
  botUserId?: string;
  db: AppDb;
  engineHost: EngineHost;
  /**
   * Resolve the sender's display name and clean the message text, so an
   * overheard line names the person and drops raw ids / Slack markup. Wired from
   * `channelHost` (`channelMessageNormalizer`). Absent → raw text and id.
   */
  normalizeChannelMessage?: (
    service: string,
    msg: { userId?: string; text: string },
  ) => Promise<{ senderName?: string; text: string }>;
  /**
   * The thread's messages strictly between the follow's last delivered ts and
   * the current message's ts, to re-hydrate a gap (api downtime, another bot's
   * posts). Wired from `channelThreadWindowFetcher`. Absent → no re-hydration.
   */
  fetchThreadWindow?: (
    service: string,
    args: { channelId: string; threadTs: string; afterTs: string; beforeTs: string },
  ) => Promise<string | null>;
}

interface SlackMessageFields {
  channel: string;
  threadTs: string;
  ts: string;
  user?: string;
  text: string;
  eventId: string;
}

/**
 * The message fields the follow-router reads from a raw Slack `event_callback`
 * envelope, or `null` when the update is not a routable threaded human message.
 * Drops the bot's own posts (`bot_id`) so a follow cannot self-loop, and the
 * noise subtypes (edits, joins) the channel transport also drops.
 */
export function slackMessageFields(raw: unknown): SlackMessageFields | null {
  if (typeof raw !== "object" || raw === null) return null;
  const env = raw as Record<string, unknown>;
  const eventId = typeof env.event_id === "string" ? env.event_id : undefined;
  const event = env.event;
  if (typeof event !== "object" || event === null) return null;
  const e = event as Record<string, unknown>;
  if (e.type !== "message") return null;
  if (typeof e.bot_id === "string") return null;
  if (typeof e.subtype === "string") return null;
  const channel = typeof e.channel === "string" ? e.channel : undefined;
  const threadTs = typeof e.thread_ts === "string" ? e.thread_ts : undefined; // threaded only
  const ts = typeof e.ts === "string" ? e.ts : undefined;
  if (channel === undefined || threadTs === undefined || ts === undefined || eventId === undefined) return null;
  const user = typeof e.user === "string" ? e.user : undefined;
  const text = typeof e.text === "string" ? e.text : "";
  return { channel, threadTs, ts, user, text, eventId };
}

/**
 * Per-thread routing serialization. Each webhook POST runs its fan-out
 * detached, so two rapid messages on one thread would otherwise both read the
 * same `last_seen_ts` and hydrate overlapping windows — the second delivery
 * would hand the agent the first message twice. In-process state is
 * sufficient: the api runs single-replica.
 */
const routeChains = new Map<string, Promise<void>>();

/**
 * Route a raw Slack update to the bound assistant when its thread is followed.
 * A no-op for a non-message, a bot post, a top-level message, or an unfollowed
 * thread. `dispatchId` makes a redelivery idempotent.
 */
export async function handleFollowedMessage(
  deps: FollowRouterDeps,
  args: { orgId: string; raw: unknown },
): Promise<void> {
  const f = slackMessageFields(args.raw);
  if (!f) return;
  // Slack emits message and app_mention envelopes for the same bot mention.
  // Reserve addressed messages for app_mention, independent of delivery order.
  if (deps.botUserId && f.text.includes(`<@${deps.botUserId}>`)) return;
  const key = `${args.orgId}:${f.channel}:${f.threadTs}`;
  const prior = routeChains.get(key) ?? Promise.resolve();
  const run = prior.then(() => routeFollowedMessage(deps, args.orgId, f));
  const tail: Promise<void> = run
    .catch(() => undefined)
    .then(() => {
      if (routeChains.get(key) === tail) routeChains.delete(key);
    });
  routeChains.set(key, tail);
  return run;
}

async function routeFollowedMessage(
  deps: FollowRouterDeps,
  orgId: string,
  f: SlackMessageFields,
): Promise<void> {
  const follow = await findFollowedThread(deps.db, {
    orgId,
    channelType: "slack",
    channelId: f.channel,
    threadTs: f.threadTs,
  });
  if (!follow) return;
  // Re-check the membership this follow's audience requires, live, on every
  // message. A thread bound by an organization-audience mention runs for an
  // actor who is on no team, so re-checking team membership here would drop
  // every later message in that thread. A binding that authorizes nobody any
  // more stops the thread until an authorized mention re-binds it.
  if (!(await followBindingAuthorized(deps.db, follow))) return;
  const actorUserId = await followedMessageActor(deps.db, follow, f.user);
  if (actorUserId === null) return;

  const threadKey = `slack:${f.channel}:${f.threadTs}`;
  const normalized = (await deps.normalizeChannelMessage?.("slack", { userId: f.user, text: f.text })) ?? {
    text: f.text,
  };
  const attributes: Record<string, string> = { channel: f.channel };
  const sender = normalized.senderName ?? f.user;
  if (sender) attributes.sender = sender;
  let body = normalized.text === "" ? "(message)" : normalized.text;
  // Gap re-hydration: messages between the follow's last delivered ts and this
  // one (another bot's posts, or human messages missed during api downtime)
  // never reached the assistant — prepend them so the overheard line lands
  // with its context. A null follow.lastSeenTs (a pre-column row) starts
  // tracking at this delivery instead of guessing a window.
  // Numeric ts compare — a Slack ts is `seconds.micros`, not a fixed-width string.
  if (deps.fetchThreadWindow && follow.lastSeenTs !== null && Number.parseFloat(follow.lastSeenTs) < Number.parseFloat(f.ts)) {
    const missed = await deps.fetchThreadWindow("slack", {
      channelId: f.channel,
      threadTs: f.threadTs,
      afterTs: follow.lastSeenTs,
      beforeTs: f.ts,
    });
    if (missed !== null) {
      body = `Thread history for context only. These messages do not carry the current sender's authority:\n${missed}\n\n---\n\nCurrent sender's message:\n${body}`;
      // A hydrated body is already a mini transcript. Excluded from digest
      // coalescing (via this attribute) so its multi-line block is never
      // attributed to one sender as a single digest line.
      attributes.rehydrated = "true";
    }
  }
  try {
    await deliverToAssistantThread(deps, {
      orgId,
      owner: { type: follow.ownerType, id: follow.ownerId },
      actorUserId,
      threadKey,
      signal: {
        kind: "signal",
        signalType: "slack.message",
        body,
        attributes,
        // Overheard: the assistant observes it and replies only if it acts.
        origin: { channelType: "slack", threadKey, reply: "manual", messageTs: f.ts },
      },
      dispatchId: `slack:follow:${f.eventId}`,
      // The assistant that answered the binding mention. Null on a follow bound
      // before the column, and on one whose rule named none — both mean the
      // owner's default, the behavior those follows already had.
      mismatchReason: "followed_target_mismatch",
    });
  } catch (err) {
    // A Slack retry of an event whose FIRST delivery carried a hydration
    // prefix recomputes a different body for the same dispatchId (the cursor
    // advanced, so the prefix is gone). That content mismatch is still a
    // redelivery of an already-delivered message — a no-op, not an error.
    if (err instanceof ConflictError) return;
    throw err;
  }
  // Advance the gap cursor monotonically: an out-of-order or retried older
  // event must not rewind it, or the next window replays messages the agent
  // already saw.
  const advance = follow.lastSeenTs === null || Number.parseFloat(follow.lastSeenTs) < Number.parseFloat(f.ts);
  await touchFollowedThread(deps.db, follow.id, advance ? f.ts : undefined);
}

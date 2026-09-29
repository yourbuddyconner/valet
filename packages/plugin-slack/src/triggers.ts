/**
 * Slack TriggerDefs — workspace events normalized into the generic event
 * pipeline. These are the event-system half of the Slack integration and are
 * independent of the agent DM surface: channel messages, reactions,
 * membership, channel lifecycle and files, for workflows to subscribe to.
 *
 * `verify` implements the full signing-secret HMAC even though the dedicated
 * api route short-circuits with pre-verified events. Keeping it complete
 * means the TriggerDef stays correct if it is ever driven directly.
 *
 * `payload` on the VerifiedEvent / NormalizedEvent is the INNER Events API
 * `event` object, so catalog filter dot-paths address the raw event directly
 * (e.g. "channel", "item.channel").
 */
import type { EventCatalogEntry, NormalizedEvent, TriggerDef, VerifiedEvent } from "@valet/engine";
import { verifySlackSignature } from "./transport/verify.js";
import { SKIP_SUBTYPES } from "./subtypes.js";

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** "slack.message" for plain message events; "slack.{type}" otherwise. */
function keyFor(eventType: string): string {
  if (eventType === "message") return "slack.message";
  if (eventType === "bot_message") return "slack.bot_message";
  return `slack.${eventType}`;
}

/** Slack can put a bot identity in either field. Do not use display names. */
export function canonicalBotId(event: Record<string, unknown>): string | undefined {
  const direct = str(event.bot_id);
  if (direct) return direct;
  return str(rec(event.bot_profile)?.id);
}

/** Slack seconds.decimal ("1773177297.231269") → ISO; wall clock fallback. */
function tsToIso(ts: string | undefined): string {
  if (ts !== undefined) {
    const seconds = Number.parseFloat(ts);
    if (Number.isFinite(seconds)) return new Date(seconds * 1000).toISOString();
  }
  return new Date().toISOString();
}

function makeVerify(eventTypes: readonly string[], botMessages = false): TriggerDef["verify"] {
  return async (req, secrets) => {
    const secret = secrets.webhookSecret;
    if (!secret) return null;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) headers[key.toLowerCase()] = value;
    const bodyText = new TextDecoder().decode(req.rawBody);
    if (!(await verifySlackSignature(headers, bodyText, secret))) return null;
    let body: Record<string, unknown> | undefined;
    try { body = rec(JSON.parse(bodyText)); } catch { return null; }
    if (!body || body.type !== "event_callback") return null;
    const rawEvent = rec(body.event);
    const rawType = str(rawEvent?.type);
    if (!rawEvent || rawType === undefined || !eventTypes.includes(rawType)) return null;
    const subtype = str(rawEvent.subtype);
    const botId = canonicalBotId(rawEvent);
    if (botMessages) {
      // A missing installation identity fails closed. Reconnect Slack to refresh it.
      if (rawType !== "message" || (subtype !== undefined && subtype !== "bot_message") || !botId || !secrets.botId) return null;
      if (botId === secrets.botId) return null;
      if (secrets.botUserId && str(rawEvent.user) === secrets.botUserId) return null;
    } else {
      // `slack.message` is human-only. This explicit subtype check keeps classifiers disjoint.
      if (rawType === "message" && (subtype === "bot_message" || botId)) return null;
      if (rawType === "app_mention" && botId) return null;
      if (rawType === "message" && subtype !== undefined && SKIP_SUBTYPES.has(subtype)) return null;
    }
    const deliveryId = str(body.event_id);
    if (!deliveryId) return null;
    // Make the canonical identity available to the catalog filter when Slack uses bot_profile.
    const payload = botMessages && rawEvent.bot_id !== botId ? { ...rawEvent, bot_id: botId } : rawEvent;
    return { eventType: botMessages ? "bot_message" : rawType, deliveryId, payload };
  };
}
function toEvent(event: VerifiedEvent): NormalizedEvent {
  const p = rec(event.payload) ?? {};
  const type = event.eventType;

  const refs: Record<string, string> = {};
  const item = rec(p.item);
  const channelRec = rec(p.channel);

  const channel =
    str(p.channel) ?? str(channelRec?.id) ?? str(p.channel_id) ?? str(item?.channel);
  if (channel) refs.channel = channel;
  const channelName = str(channelRec?.name);
  if (channelName) refs.channel_name = channelName;

  const userRec = rec(p.user);
  const user = str(p.user) ?? str(p.user_id) ?? str(userRec?.id);
  if (user) refs.user = user;

  const team = str(p.team) ?? str(userRec?.team_id);
  if (team) refs.team = team;

  const reaction = str(p.reaction);
  if (reaction) refs.reaction = reaction;
  const itemUser = str(p.item_user);
  if (itemUser) refs.item_user = itemUser;

  const creator = str(channelRec?.creator);
  if (creator) refs.creator = creator;

  const fileId = str(p.file_id) ?? str(rec(p.file)?.id);
  if (fileId) refs.file = fileId;

  let summary: string;
  switch (type) {
    case "message":
      summary = `message in ${channel ?? "unknown channel"} by ${user ?? "unknown user"}`;
      break;
    case "app_mention":
      summary = `app mentioned in ${channel ?? "unknown channel"} by ${user ?? "unknown user"}`;
      break;
    case "reaction_added":
    case "reaction_removed":
      summary = `reaction :${reaction ?? "?"}: ${type === "reaction_added" ? "added" : "removed"} in ${channel ?? "unknown channel"} by ${user ?? "unknown user"}`;
      break;
    case "member_joined_channel":
      summary = `${user ?? "unknown user"} joined ${channel ?? "unknown channel"}`;
      break;
    case "member_left_channel":
      summary = `${user ?? "unknown user"} left ${channel ?? "unknown channel"}`;
      break;
    case "channel_created":
      summary = `channel #${channelName ?? channel ?? "?"} created${creator ? ` by ${creator}` : ""}`;
      break;
    case "channel_rename":
      summary = `channel ${channel ?? "?"} renamed to #${channelName ?? "?"}`;
      break;
    case "channel_archive":
      summary = `channel ${channel ?? "?"} archived${user ? ` by ${user}` : ""}`;
      break;
    case "channel_unarchive":
      summary = `channel ${channel ?? "?"} unarchived${user ? ` by ${user}` : ""}`;
      break;
    case "file_shared":
      summary = `file ${fileId ?? "?"} shared in ${channel ?? "unknown channel"} by ${user ?? "unknown user"}`;
      break;
    case "team_join":
      summary = `${user ?? "unknown user"} joined the workspace`;
      break;
    default:
      summary = `slack ${type}${channel ? ` in ${channel}` : ""}${user ? ` by ${user}` : ""}`;
  }

  return {
    key: keyFor(type),
    dedupeKey: event.deliveryId,
    occurredAt: tsToIso(str(p.ts) ?? str(p.event_ts)),
    actor: user ? { externalId: user } : undefined,
    refs,
    summary,
    payload: event.payload,
  };
}

/**
 * One trigger definition, before it is compiled to a `TriggerDef`. `eventTypes`
 * is the set of Slack Events API `event.type` values this trigger matches. It
 * is the single source both `slackTriggerDefs` (which hides it inside a `verify`
 * closure) and `slackTriggerEventTypes` (which the Slack app manifest reads)
 * derive from, so the two can never drift.
 */
interface TriggerSpec {
  id: string;
  eventTypes: readonly string[];
  description: string;
  catalog: EventCatalogEntry[];
}

const triggerSpecs: TriggerSpec[] = [
  {
    id: "slack.app_mention",
    eventTypes: ["app_mention"],
    description: "Slack app was @-mentioned in a conversation the app can see",
    catalog: [
      {
        key: "slack.app_mention",
        description: "When someone @-mentions the bot in a channel or thread",
        filters: [
          {
            field: "channel",
            path: "channel",
            description: "Slack channel id where the mention happened",
            options: { source: "slack.channels" },
          },
          {
            field: "user",
            path: "user",
            description: "Slack user id of the mentioner",
            options: { source: "slack.users" },
          },
          { field: "text", path: "text", description: "Message text, for a slash command or a pattern match" },
        ],
      },
    ],
  },
  {
    id: "slack.message",
    eventTypes: ["message"],
    description: "Slack message posted in a conversation the app can see",
    catalog: [
      {
        key: "slack.message",
        description: "When a message is posted in a channel or DM the bot can see",
        filters: [
          {
            field: "channel",
            path: "channel",
            description: "Slack channel id (C…/D…)",
            options: { source: "slack.channels" },
          },
          { field: "channel_type", path: "channel_type", description: "Conversation type (channel, group, im, mpim)" },
          { field: "thread_ts", path: "thread_ts", description: "Parent message timestamp, to match replies in one thread" },
          {
            field: "user",
            path: "user",
            description: "Slack user id of the sender",
            options: { source: "slack.users" },
          },
          { field: "text", path: "text", description: "Message text, for a slash command or a pattern match" },
        ],
      },
    ],
  },
  {
    id: "slack.bot_message",
    eventTypes: ["message"],
    description: "Third-party Slack bot or app message posted in a conversation the app can see",
    catalog: [{ key: "slack.bot_message", description: "When a third-party Slack bot or app posts a message", filters: [
      { field: "channel", path: "channel", description: "Slack channel id", options: { source: "slack.channels" } },
      { field: "channel_type", path: "channel_type", description: "Conversation type" },
      { field: "bot_id", path: "bot_id", description: "Slack bot id" },
      { field: "app_id", path: "app_id", description: "Slack app id" },
      { field: "user", path: "user", description: "Slack user id when Slack supplies it", options: { source: "slack.users" } },
      { field: "text", path: "text", description: "Message text" },
    ] }],
  },
  {
    id: "slack.reaction",
    eventTypes: ["reaction_added", "reaction_removed"],
    description: "Slack emoji reactions added or removed",
    catalog: [
      {
        key: "slack.reaction_added",
        description: "When someone adds an emoji reaction to a message",
        filters: [
          {
            field: "channel",
            path: "item.channel",
            description: "Slack channel id of the reacted message",
            options: { source: "slack.channels" },
          },
          { field: "reaction", path: "reaction", description: "Emoji name without colons (e.g. tada)" },
          {
            field: "user",
            path: "user",
            description: "Slack user id of the reactor",
            options: { source: "slack.users" },
          },
          { field: "item_user", path: "item_user", description: "Slack user id of the message author" },
        ],
      },
      {
        key: "slack.reaction_removed",
        description: "When someone removes an emoji reaction from a message",
        filters: [
          {
            field: "channel",
            path: "item.channel",
            description: "Slack channel id of the reacted message",
            options: { source: "slack.channels" },
          },
          { field: "reaction", path: "reaction", description: "Emoji name without colons (e.g. tada)" },
          {
            field: "user",
            path: "user",
            description: "Slack user id of the reactor",
            options: { source: "slack.users" },
          },
          { field: "item_user", path: "item_user", description: "Slack user id of the message author" },
        ],
      },
    ],
  },
  {
    id: "slack.member",
    eventTypes: ["member_joined_channel", "member_left_channel"],
    description: "Slack channel membership changes",
    catalog: [
      {
        key: "slack.member_joined_channel",
        description: "When someone joins a channel",
        filters: [
          { field: "channel", path: "channel", description: "Slack channel id", options: { source: "slack.channels" } },
          { field: "user", path: "user", description: "Slack user id who joined", options: { source: "slack.users" } },
        ],
      },
      {
        key: "slack.member_left_channel",
        description: "When someone leaves a channel",
        filters: [
          { field: "channel", path: "channel", description: "Slack channel id", options: { source: "slack.channels" } },
          { field: "user", path: "user", description: "Slack user id who left", options: { source: "slack.users" } },
        ],
      },
    ],
  },
  {
    id: "slack.channel",
    eventTypes: ["channel_created", "channel_rename", "channel_archive", "channel_unarchive"],
    description: "Slack channel lifecycle events",
    catalog: [
      {
        key: "slack.channel_created",
        description: "When a channel is created",
        filters: [
          { field: "channel", path: "channel.id", description: "New channel id" },
          { field: "creator", path: "channel.creator", description: "Slack user id of the creator" },
        ],
      },
      {
        key: "slack.channel_rename",
        description: "When a channel is renamed",
        filters: [{ field: "channel", path: "channel.id", description: "Renamed channel id" }],
      },
      {
        key: "slack.channel_archive",
        description: "When a channel is archived",
        filters: [{ field: "channel", path: "channel", description: "Archived channel id" }],
      },
      {
        key: "slack.channel_unarchive",
        description: "When a channel is unarchived",
        filters: [{ field: "channel", path: "channel", description: "Unarchived channel id" }],
      },
    ],
  },
  {
    id: "slack.file",
    eventTypes: ["file_shared"],
    description: "Slack file shared",
    catalog: [
      {
        key: "slack.file_shared",
        description: "When a file is shared into a conversation",
        filters: [
          { field: "channel", path: "channel_id", description: "Slack channel id the file was shared in" },
          { field: "user", path: "user_id", description: "Slack user id who shared the file" },
        ],
      },
    ],
  },
  {
    id: "slack.team",
    eventTypes: ["team_join"],
    description: "Slack workspace membership",
    catalog: [
      {
        key: "slack.team_join",
        description: "When someone joins the workspace",
        filters: [],
      },
    ],
  },
];

export const slackTriggerDefs: TriggerDef[] = triggerSpecs.map((spec) => ({
  id: spec.id,
  service: "slack",
  description: spec.description,
  verify: makeVerify(spec.eventTypes, spec.id === "slack.bot_message"),
  toEvent,
  catalog: spec.catalog,
}));

/**
 * Every Slack Events API `event.type` the trigger defs above match. The Slack
 * app manifest (`SLACK_BOT_EVENTS`, packages/api/src/services/slack-app.ts)
 * MUST subscribe to each of these, or Slack never delivers the event and the
 * trigger silently never fires. One caveat: the `message` type is delivered
 * as one bot event per channel type (`message.channels`, `message.im`, …), so
 * the manifest expands it; `slack-app.test.ts` pins that expansion against
 * this list.
 */
export const slackTriggerEventTypes: readonly string[] = [
  ...new Set(triggerSpecs.flatMap((spec) => spec.eventTypes)),
];

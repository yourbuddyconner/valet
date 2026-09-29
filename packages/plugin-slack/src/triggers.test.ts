import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TriggerDef } from "@valet/engine";
import { slackTriggerDefs, slackTriggerEventTypes } from "./triggers.js";

const SECRET = "test-signing-secret";

function findTrigger(id: string): TriggerDef {
  const trigger = slackTriggerDefs.find((t) => t.id === id);
  if (!trigger) throw new Error(`no trigger def for ${id}`);
  return trigger;
}

function signedRequest(
  body: unknown,
  opts: { timestamp?: string; secret?: string; signature?: string } = {},
): { headers: Record<string, string>; rawBody: Uint8Array } {
  const text = JSON.stringify(body);
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature =
    opts.signature ??
    "v0=" + createHmac("sha256", opts.secret ?? SECRET).update(`v0:${timestamp}:${text}`).digest("hex");
  return {
    headers: {
      // Mixed case on purpose — verify must be header-case-insensitive.
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": signature,
    },
    rawBody: new TextEncoder().encode(text),
  };
}

function envelope(event: Record<string, unknown>, eventId = "Ev0001"): Record<string, unknown> {
  return { type: "event_callback", team_id: "T1", event_id: eventId, event };
}

const REACTION_EVENT = {
  type: "reaction_added",
  user: "U0456",
  reaction: "tada",
  item_user: "U0789",
  item: { type: "message", channel: "C0123", ts: "1700000000.000100" },
  event_ts: "1700000005.000200",
};

describe("slackTriggerDefs verify", () => {
  it("accepts a correctly signed event of the right family", async () => {
    const trigger = findTrigger("slack.reaction");
    const verified = await trigger.verify(signedRequest(envelope(REACTION_EVENT, "Ev-r1")), {
      webhookSecret: SECRET,
    });
    expect(verified).not.toBeNull();
    expect(verified?.eventType).toBe("reaction_added");
    expect(verified?.deliveryId).toBe("Ev-r1");
    expect(verified?.payload).toEqual(REACTION_EVENT);
  });

  it("rejects a bad signature", async () => {
    const trigger = findTrigger("slack.reaction");
    const verified = await trigger.verify(
      signedRequest(envelope(REACTION_EVENT), { signature: "v0=bogus" }),
      { webhookSecret: SECRET },
    );
    expect(verified).toBeNull();
  });

  it("rejects the wrong secret", async () => {
    const trigger = findTrigger("slack.reaction");
    const verified = await trigger.verify(signedRequest(envelope(REACTION_EVENT), { secret: "wrong" }), {
      webhookSecret: SECRET,
    });
    expect(verified).toBeNull();
  });

  it("rejects an expired timestamp (replay window)", async () => {
    const trigger = findTrigger("slack.reaction");
    const verified = await trigger.verify(
      signedRequest(envelope(REACTION_EVENT), { timestamp: String(Math.floor(Date.now() / 1000) - 400) }),
      { webhookSecret: SECRET },
    );
    expect(verified).toBeNull();
  });

  it("rejects events from another family", async () => {
    const trigger = findTrigger("slack.member");
    const verified = await trigger.verify(signedRequest(envelope(REACTION_EVENT)), { webhookSecret: SECRET });
    expect(verified).toBeNull();
  });

  it("rejects an envelope without event_id", async () => {
    const trigger = findTrigger("slack.reaction");
    const body = { type: "event_callback", team_id: "T1", event: REACTION_EVENT };
    const verified = await trigger.verify(signedRequest(body), { webhookSecret: SECRET });
    expect(verified).toBeNull();
  });

  it("rejects non-event_callback bodies", async () => {
    const trigger = findTrigger("slack.reaction");
    const verified = await trigger.verify(
      signedRequest({ type: "url_verification", challenge: "c" }),
      { webhookSecret: SECRET },
    );
    expect(verified).toBeNull();
  });

  it("rejects when no secret is configured", async () => {
    const trigger = findTrigger("slack.reaction");
    const verified = await trigger.verify(signedRequest(envelope(REACTION_EVENT)), {});
    expect(verified).toBeNull();
  });

  it("drops the bot's own message posts (echo) so workflows can't self-trigger", async () => {
    const trigger = findTrigger("slack.message");
    const botMessage = { type: "message", channel: "C0ALERTS", user: "UBOT", bot_id: "B999", text: "workflow summary" };
    const verified = await trigger.verify(signedRequest(envelope(botMessage, "Ev-bot")), { webhookSecret: SECRET });
    expect(verified).toBeNull();
  });

  it("accepts only third-party bot_message events", async () => {
    const trigger = findTrigger("slack.bot_message");
    const secrets = { webhookSecret: SECRET, botId: "BVALET", botUserId: "UVALET" };
    const bot = { type: "message", subtype: "bot_message", bot_id: "BOTHER", app_id: "AOTHER", channel: "C1", text: "ready" };
    expect(await trigger.verify(signedRequest(envelope(bot, "Ev-bot-ok")), secrets)).not.toBeNull();
    expect(await trigger.verify(signedRequest(envelope({ ...bot, bot_id: "" }, "Ev-bot-empty")), secrets)).toBeNull();
    expect(await trigger.verify(signedRequest(envelope({ ...bot, subtype: "file_share" }, "Ev-bot-subtype")), secrets)).toBeNull();
    expect(await trigger.verify(signedRequest(envelope({ ...bot, bot_id: "BVALET" }, "Ev-bot-own")), secrets)).toBeNull();
    expect(await trigger.verify(signedRequest(envelope({ ...bot, user: "UVALET" }, "Ev-bot-user")), secrets)).toBeNull();
    expect(await trigger.verify(signedRequest(envelope(bot, "Ev-bot-legacy")), { webhookSecret: SECRET })).toBeNull();
  });

  it.each([{ bot_id: "BOTHER" }, { bot_profile: { id: "BOTHER" } }])("normalizes modern bot posts without a subtype: %j", async (identity) => {
    const trigger = findTrigger("slack.bot_message");
    const secrets = { webhookSecret: SECRET, botId: "BVALET", botUserId: "UVALET" };
    const event = { type: "message", channel: "C1", text: "ready", ...identity };
    const request = signedRequest(envelope(event, "Ev-modern"));
    const verified = await trigger.verify(request, secrets);
    expect(verified).not.toBeNull();
    if (!verified) throw new Error("Expected a verified bot event");
    expect(trigger.toEvent(verified)).toMatchObject({ key: "slack.bot_message", payload: { bot_id: "BOTHER" } });
    expect(await findTrigger("slack.message").verify(request, secrets)).toBeNull();
    expect(await trigger.verify(signedRequest(envelope({ ...event, bot_id: "BVALET" })), secrets)).toBeNull();
    expect(await trigger.verify(signedRequest(envelope({ ...event, user: "UVALET" })), secrets)).toBeNull();
    for (const subtype of ["message_changed", "message_deleted", "channel_join"]) {
      expect(await trigger.verify(signedRequest(envelope({ ...event, subtype })), secrets)).toBeNull();
    }
  });

  it("canonicalizes bot_profile.id", async () => {
    const trigger = findTrigger("slack.bot_message");
    const event = { type: "message", subtype: "bot_message", bot_profile: { id: "BOTHER", name: "not an identity" } };
    const verified = await trigger.verify(signedRequest(envelope(event, "Ev-profile")), { webhookSecret: SECRET, botId: "BVALET" });
    expect(verified?.payload).toMatchObject({ bot_id: "BOTHER" });
  });

  it("drops non-post message subtypes (edits/deletes) but keeps file_share", async () => {
    const trigger = findTrigger("slack.message");
    const edited = { type: "message", subtype: "message_changed", channel: "C1", message: { user: "U1", text: "new" } };
    expect(await trigger.verify(signedRequest(envelope(edited, "Ev-edit")), { webhookSecret: SECRET })).toBeNull();

    const fileShare = { type: "message", subtype: "file_share", channel: "C1", user: "U1", files: [{ id: "F1" }] };
    expect(await trigger.verify(signedRequest(envelope(fileShare, "Ev-fs")), { webhookSecret: SECRET })).not.toBeNull();
  });

  it("accepts an app_mention and rejects it under the message family", async () => {
    const mention = { type: "app_mention", user: "U1", channel: "C1", text: "<@UBOT> ship it", ts: "1700000000.000100" };

    const mentionTrigger = findTrigger("slack.app_mention");
    const verified = await mentionTrigger.verify(signedRequest(envelope(mention, "Ev-am")), { webhookSecret: SECRET });
    expect(verified?.eventType).toBe("app_mention");
    expect(verified?.deliveryId).toBe("Ev-am");

    // The message trigger must not swallow an app_mention: its family list
    // excludes the type, so it rejects rather than double-firing.
    const messageTrigger = findTrigger("slack.message");
    expect(await messageTrigger.verify(signedRequest(envelope(mention, "Ev-am2")), { webhookSecret: SECRET })).toBeNull();
  });

  it("drops a bot-authored app_mention so a workflow reply cannot self-trigger", async () => {
    const trigger = findTrigger("slack.app_mention");
    // A post the app itself made whose text @-mentions the bot fires an
    // app_mention carrying bot_id. Delivering it would loop a workflow that
    // replies with a mention. The bot_id guard drops it.
    const botMention = { type: "app_mention", user: "UBOT", bot_id: "B999", channel: "C1", text: "<@UBOT> done" };
    expect(await trigger.verify(signedRequest(envelope(botMention, "Ev-am-bot")), { webhookSecret: SECRET })).toBeNull();
  });
});

describe("slackTriggerDefs toEvent", () => {
  it("normalizes a reaction_added event", () => {
    const trigger = findTrigger("slack.reaction");
    const normalized = trigger.toEvent({ eventType: "reaction_added", deliveryId: "Ev-r2", payload: REACTION_EVENT });
    expect(normalized.key).toBe("slack.reaction_added");
    expect(normalized.dedupeKey).toBe("Ev-r2");
    expect(normalized.occurredAt).toBe(new Date(1700000005.0002 * 1000).toISOString());
    expect(normalized.actor).toEqual({ externalId: "U0456" });
    expect(normalized.refs).toMatchObject({ channel: "C0123", user: "U0456", reaction: "tada", item_user: "U0789" });
    expect(normalized.summary).toBe("reaction :tada: added in C0123 by U0456");
    expect(normalized.payload).toEqual(REACTION_EVENT);
  });

  it("normalizes an app_mention event", () => {
    const trigger = findTrigger("slack.app_mention");
    const event = { type: "app_mention", user: "U1", channel: "C9", text: "<@UBOT> hi", ts: "1700.5" };
    const normalized = trigger.toEvent({ eventType: "app_mention", deliveryId: "Ev-am1", payload: event });
    expect(normalized.key).toBe("slack.app_mention");
    expect(normalized.actor).toEqual({ externalId: "U1" });
    expect(normalized.refs).toMatchObject({ channel: "C9", user: "U1" });
    expect(normalized.summary).toBe("app mentioned in C9 by U1");
  });

  it("normalizes a message event under the single slack.message key", () => {
    const trigger = findTrigger("slack.message");
    const event = { type: "message", channel: "C9", channel_type: "channel", user: "U1", text: "hi", ts: "1700.5" };
    const normalized = trigger.toEvent({ eventType: "message", deliveryId: "Ev-m1", payload: event });
    expect(normalized.key).toBe("slack.message");
    expect(normalized.occurredAt).toBe(new Date(1700.5 * 1000).toISOString());
    expect(normalized.refs).toMatchObject({ channel: "C9", user: "U1" });
    expect(normalized.summary).toBe("message in C9 by U1");
  });

  it("normalizes channel_created with nested channel object refs", () => {
    const trigger = findTrigger("slack.channel");
    const event = {
      type: "channel_created",
      channel: { id: "C77", name: "alerts", creator: "U5", created: 1700000100 },
    };
    const normalized = trigger.toEvent({ eventType: "channel_created", deliveryId: "Ev-c1", payload: event });
    expect(normalized.key).toBe("slack.channel_created");
    expect(normalized.refs).toMatchObject({ channel: "C77", channel_name: "alerts", creator: "U5" });
    expect(normalized.summary).toBe("channel #alerts created by U5");
  });

  it("normalizes team_join (user object payload)", () => {
    const trigger = findTrigger("slack.team");
    const event = { type: "team_join", user: { id: "U-new", team_id: "T1", name: "newbie" } };
    const normalized = trigger.toEvent({ eventType: "team_join", deliveryId: "Ev-t1", payload: event });
    expect(normalized.key).toBe("slack.team_join");
    expect(normalized.actor).toEqual({ externalId: "U-new" });
    expect(normalized.summary).toBe("U-new joined the workspace");
  });

  it("normalizes file_shared refs from *_id fields", () => {
    const trigger = findTrigger("slack.file");
    const event = { type: "file_shared", channel_id: "C3", user_id: "U3", file_id: "F3", event_ts: "1700.9" };
    const normalized = trigger.toEvent({ eventType: "file_shared", deliveryId: "Ev-f1", payload: event });
    expect(normalized.key).toBe("slack.file_shared");
    expect(normalized.refs).toMatchObject({ channel: "C3", user: "U3", file: "F3" });
    expect(normalized.summary).toBe("file F3 shared in C3 by U3");
  });

  it("falls back to wall clock when no ts is present", () => {
    const trigger = findTrigger("slack.member");
    const before = Date.now();
    const normalized = trigger.toEvent({
      eventType: "member_joined_channel",
      deliveryId: "Ev-j1",
      payload: { type: "member_joined_channel", channel: "C1", user: "U1" },
    });
    const after = Date.now();
    const occurred = Date.parse(normalized.occurredAt);
    expect(occurred).toBeGreaterThanOrEqual(before - 1000);
    expect(occurred).toBeLessThanOrEqual(after + 1000);
  });
});

describe("slackTriggerDefs catalog", () => {
  it("covers exactly the spec's event keys", () => {
    const keys = slackTriggerDefs.flatMap((t) => t.catalog.map((c) => c.key)).sort();
    expect(keys).toEqual(
      [
        "slack.app_mention",
        "slack.bot_message",
        "slack.message",
        "slack.reaction_added",
        "slack.reaction_removed",
        "slack.member_joined_channel",
        "slack.member_left_channel",
        "slack.channel_created",
        "slack.channel_rename",
        "slack.channel_archive",
        "slack.channel_unarchive",
        "slack.file_shared",
        "slack.team_join",
      ].sort(),
    );
  });

  it("exports every event type its defs match, for the manifest to subscribe", () => {
    expect([...slackTriggerEventTypes].sort()).toEqual(
      [
        "app_mention",
        "message",
        "reaction_added",
        "reaction_removed",
        "member_joined_channel",
        "member_left_channel",
        "channel_created",
        "channel_rename",
        "channel_archive",
        "channel_unarchive",
        "file_shared",
        "team_join",
      ].sort(),
    );
  });

  it("declares the spec's filter fields for slack.message", () => {
    const entry = findTrigger("slack.message").catalog[0];
    expect(entry.filters.map((f) => `${f.field}:${f.path}`)).toEqual([
      "channel:channel",
      "channel_type:channel_type",
      "thread_ts:thread_ts",
      "user:user",
      "text:text",
    ]);
  });

  it("all defs use service slack", () => {
    for (const trigger of slackTriggerDefs) expect(trigger.service).toBe("slack");
  });
});

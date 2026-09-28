import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ChannelStreamError, type StoredCredential } from "@valet/engine";
import { startFakeSlackApi, type FakeSlackApi } from "../../test/fake-slack-api.js";
import {
  cleanSlackText,
  conversationKeyFor,
  parseConversationKey,
  slackTransportFactory,
  SlackTransport,
  splitForStream,
} from "./transport.js";

const TEAM = "T1";
const CHANNEL = "D100";
const THREAD_TS = "1700000000.000100";
const KEY = conversationKeyFor(TEAM, CHANNEL, THREAD_TS);
const SIGNING_SECRET = "shh";

let fake: FakeSlackApi;

beforeAll(async () => {
  fake = await startFakeSlackApi();
});

afterAll(async () => {
  await fake.close();
});

beforeEach(() => {
  fake.calls.length = 0;
  fake.streams.clear();
});

function credential(metadata: Record<string, unknown>): StoredCredential {
  return { type: "bot_token", accessToken: "xoxb-test", metadata };
}

/** A transport wired at the fake API, with the metadata a real credential carries. */
function makeTransport(extraMetadata: Record<string, unknown> = {}): SlackTransport {
  const transport = slackTransportFactory.create({
    credential: credential({
      teamId: TEAM,
      signingSecret: SIGNING_SECRET,
      botUserId: "UBOT",
      ...extraMetadata,
    }),
    config: { apiBaseUrl: fake.baseUrl },
  });
  if (!(transport instanceof SlackTransport)) throw new Error("factory returned the wrong type");
  return transport;
}

/** Wrap an inner Events API event the way Slack posts it. */
function envelope(event: Record<string, unknown>, eventId = "Ev1"): Record<string, unknown> {
  return { type: "event_callback", event_id: eventId, team_id: TEAM, event };
}

function imMessage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "message",
    channel_type: "im",
    channel: CHANNEL,
    user: "U1",
    text: "hello",
    ts: "1700000000.000100",
    ...over,
  };
}

/** Drive one inbound turn so the transport learns the conversation's thread.
 * Returns the conversation key for this turn (which now includes the threadTs). */
function primeTurn(transport: SlackTransport, ts = "1700000000.000100"): string {
  transport.parseUpdate(envelope(imMessage({ ts }), `Ev-${ts}`));
  return conversationKeyFor(TEAM, CHANNEL, ts);
}

function lastCall(method: string): Record<string, unknown> {
  const call = [...fake.calls].reverse().find((c) => c.method === method);
  if (!call) throw new Error(`no ${method} call recorded`);
  return call.body;
}

describe("conversation key codec", () => {
  it("round-trips a four-part key through the engine thread key", () => {
    const transport = makeTransport();
    const threadKey = transport.threadKeyFromConversationKey(KEY);
    expect(threadKey).toBe(`slack:${CHANNEL}:${THREAD_TS}`);
    expect(transport.conversationKeyFromThreadKey(threadKey)).toBe(KEY);
  });

  it("rejects keys missing the threadTs segment", () => {
    // Old 2-segment key shape is now invalid
    expect(parseConversationKey(`slack:${TEAM}:${CHANNEL}`)).toBeNull();
    expect(parseConversationKey("slack:T1")).toBeNull();
    expect(parseConversationKey("slack::D1")).toBeNull();
    expect(parseConversationKey("telegram:dm:9")).toBeNull();
  });

  it("parses a valid four-part key", () => {
    const parsed = parseConversationKey(`slack:${TEAM}:${CHANNEL}:1700000000.000100`);
    expect(parsed).toEqual({ teamId: TEAM, channelId: CHANNEL, threadTs: "1700000000.000100" });
  });

  it("does not claim another transport's thread keys", () => {
    const transport = makeTransport();
    expect(transport.conversationKeyFromThreadKey("telegram:99")).toBeNull();
    expect(transport.conversationKeyFromThreadKey("slack:")).toBeNull();
    // Single-segment after slack: is now invalid
    expect(transport.conversationKeyFromThreadKey("slack:C123")).toBeNull();
  });

  it("rejects thread keys with empty segments", () => {
    const transport = makeTransport();
    expect(transport.conversationKeyFromThreadKey("slack:C123:")).toBeNull();
    expect(transport.conversationKeyFromThreadKey("slack::1700000000.000100")).toBeNull();
  });
});

describe("send threads on the conversation key's thread root", () => {
  it("escapes broadcasts in non-streaming transport replies", async () => {
    const transport = makeTransport();
    await transport.send(KEY, { markdown: "the doc said <!channel>" });
    expect(lastCall("chat.postMessage").text).toBe("the doc said &lt;!channel>");
  });

  it("threads on the key's threadTs when no inbound turn was recorded (event-triggered reply)", async () => {
    const transport = makeTransport();
    // No parseUpdate/primeTurn: the reply's key was rebuilt from a thread key
    // by the outbound bridge (the app_mention trigger path), so `lastTurn` is
    // empty. The reply must still land in the mention's thread.
    const conversationKey = conversationKeyFor(TEAM, CHANNEL, "1700000000.000100");
    await transport.send(conversationKey, { markdown: "hi" });
    expect(lastCall("chat.postMessage").thread_ts).toBe("1700000000.000100");
  });

  it("threads a primed (inbound) conversation, unchanged", async () => {
    const transport = makeTransport();
    const key = primeTurn(transport, "1700000000.000200");
    await transport.send(key, { markdown: "reply" });
    expect(lastCall("chat.postMessage").thread_ts).toBe("1700000000.000200");
  });

  it("stays top-level for a fresh DM key from openDirectConversation (no real thread)", async () => {
    const transport = makeTransport();
    const key = await transport.openDirectConversation("U9");
    await transport.send(key, { markdown: "nudge" });
    expect(lastCall("chat.postMessage").thread_ts).toBeUndefined();
  });
});

describe("home channel", () => {
  it("starts a new top-level message", async () => {
    const transport = makeTransport();
    await transport.sendToChannel("C0123456789", { markdown: "Team update" });
    expect(lastCall("chat.postMessage").channel).toBe("C0123456789");
    expect(lastCall("chat.postMessage").thread_ts).toBeUndefined();
  });
});

describe("threadKeyFromEvent", () => {
  it("builds a thread key from an app_mention payload", () => {
    const transport = makeTransport();
    const payload = { type: "app_mention", channel: CHANNEL, user: "U1", text: "<@UBOT> hi", ts: "1700000000.000100" };
    expect(transport.threadKeyFromEvent("slack.app_mention", payload)).toBe(`slack:${CHANNEL}:1700000000.000100`);
  });

  it("anchors to thread_ts when the mention is inside a thread", () => {
    const transport = makeTransport();
    const payload = { type: "app_mention", channel: CHANNEL, ts: "1700000000.000200", thread_ts: "1700000000.000100" };
    expect(transport.threadKeyFromEvent("slack.app_mention", payload)).toBe(`slack:${CHANNEL}:1700000000.000100`);
  });

  it("builds a thread key from a channel message payload", () => {
    const transport = makeTransport();
    const payload = { type: "message", channel: CHANNEL, ts: "1700000000.000300" };
    expect(transport.threadKeyFromEvent("slack.message", payload)).toBe(`slack:${CHANNEL}:1700000000.000300`);
  });

  it("returns null for an event with no conversation to reply into", () => {
    const transport = makeTransport();
    expect(transport.threadKeyFromEvent("slack.team_join", { type: "team_join", user: { id: "U9" } })).toBeNull();
    // Missing channel is not routable.
    expect(transport.threadKeyFromEvent("slack.app_mention", { type: "app_mention" })).toBeNull();
  });
});

describe("messageTsFromEvent", () => {
  it("returns the triggering message's own ts (not thread_ts)", () => {
    const transport = makeTransport();
    const payload = { type: "app_mention", channel: CHANNEL, ts: "1700000000.000200", thread_ts: "1700000000.000100" };
    expect(transport.messageTsFromEvent("slack.app_mention", payload)).toBe("1700000000.000200");
  });

  it("returns null for a non-message event or a payload with no ts", () => {
    const transport = makeTransport();
    expect(transport.messageTsFromEvent("slack.team_join", { user: "U9" })).toBeNull();
    expect(transport.messageTsFromEvent("slack.app_mention", { channel: CHANNEL })).toBeNull();
  });
});

describe("normalizeForAgent", () => {
  it("resolves the sender's display name and cleans the text of self-mention and markup", async () => {
    const transport = makeTransport();
    fake.setMembers([
      { id: "U1", profile: { display_name: "Brian Brown" } },
      { id: "U2", profile: { real_name: "Conner Swann" } },
    ]);
    const out = await transport.normalizeForAgent({ userId: "U1", text: "<@UBOT> ping <@U2> about <https://x.io|the doc>" });
    expect(out).toEqual({ senderName: "Brian Brown", text: "ping @Conner Swann about the doc" });
  });

  it("leaves senderName undefined when there is no sender or the id names nobody", async () => {
    const transport = makeTransport();
    fake.setMembers([]);
    expect(await transport.normalizeForAgent({ text: "hi" })).toEqual({ senderName: undefined, text: "hi" });
    expect(await transport.normalizeForAgent({ userId: "U9", text: "hi" })).toEqual({ senderName: undefined, text: "hi" });
  });
});

describe("parseUpdate — the agent surface events", () => {
  it("routes a direct message and anchors the turn to the user's own message", () => {
    const transport = makeTransport();
    const event = transport.parseUpdate(envelope(imMessage()));
    expect(event).toMatchObject({
      kind: "message",
      conversationKey: KEY,
      sender: { externalId: "U1" },
      text: "hello",
      threadTs: "1700000000.000100",
      dispatchId: "slack:Ev1",
    });
  });

  it("keeps an existing thread's root when the user replies inside one", () => {
    const transport = makeTransport();
    const event = transport.parseUpdate(
      envelope(imMessage({ ts: "1700000000.000200", thread_ts: "1700000000.000100" })),
    );
    expect(event?.threadTs).toBe("1700000000.000100");
    // The conversationKey includes the parent thread's ts
    expect(event?.conversationKey).toBe(conversationKeyFor(TEAM, CHANNEL, "1700000000.000100"));
  });

  it("produces different keys for two top-level DMs in the same channel", () => {
    const transport = makeTransport();
    // First top-level message (no thread_ts)
    const event1 = transport.parseUpdate(
      envelope(imMessage({ ts: "1700000000.000100" }), "Ev1"),
    );
    // Second top-level message (no thread_ts, different ts)
    const event2 = transport.parseUpdate(
      envelope(imMessage({ ts: "1700000000.000200" }), "Ev2"),
    );
    expect(event1?.conversationKey).toBe(conversationKeyFor(TEAM, CHANNEL, "1700000000.000100"));
    expect(event2?.conversationKey).toBe(conversationKeyFor(TEAM, CHANNEL, "1700000000.000200"));
    expect(event1?.conversationKey).not.toBe(event2?.conversationKey);
    // Thread keys are also different
    expect(transport.threadKeyFromConversationKey(event1!.conversationKey)).not.toBe(
      transport.threadKeyFromConversationKey(event2!.conversationKey),
    );
  });

  it("produces different keys for replies inside two different Slack threads", () => {
    const transport = makeTransport();
    // Reply in thread rooted at 1700000000.000100
    const event1 = transport.parseUpdate(
      envelope(imMessage({ ts: "1700000000.000300", thread_ts: "1700000000.000100" }), "Ev1"),
    );
    // Reply in a different thread rooted at 1700000000.000200
    const event2 = transport.parseUpdate(
      envelope(imMessage({ ts: "1700000000.000400", thread_ts: "1700000000.000200" }), "Ev2"),
    );
    expect(event1?.conversationKey).toBe(conversationKeyFor(TEAM, CHANNEL, "1700000000.000100"));
    expect(event2?.conversationKey).toBe(conversationKeyFor(TEAM, CHANNEL, "1700000000.000200"));
    expect(event1?.conversationKey).not.toBe(event2?.conversationKey);
    // Thread keys are also different
    expect(transport.threadKeyFromConversationKey(event1!.conversationKey)).not.toBe(
      transport.threadKeyFromConversationKey(event2!.conversationKey),
    );
  });

  it("drops app_home_opened because it has no thread_ts to anchor a per-thread key", () => {
    const transport = makeTransport();
    // Both messages tab and home tab return null under per-thread routing
    expect(
      transport.parseUpdate(
        envelope({ type: "app_home_opened", user: "U1", channel: CHANNEL, tab: "messages" }, "Ev2"),
      ),
    ).toBeNull();
    expect(
      transport.parseUpdate(
        envelope({ type: "app_home_opened", user: "U1", channel: CHANNEL, tab: "home" }, "Ev3"),
      ),
    ).toBeNull();
  });

  it("consumes app_context_changed without emitting an event", () => {
    const transport = makeTransport();
    expect(
      transport.parseUpdate(
        envelope(
          { type: "app_context_changed", context: { entities: [{ type: "slack#/types/channel_id", value: "C9" }] } },
          "Ev4",
        ),
      ),
    ).toBeNull();
  });

  it("carries app context injected into a message", () => {
    const transport = makeTransport();
    const event = transport.parseUpdate(
      envelope(
        imMessage({
          context: { entities: [{ type: "slack#/types/channel_id", value: "C9", team_id: TEAM }] },
        }),
      ),
    );
    expect(event?.context).toEqual({ entities: [{ type: "slack#/types/channel_id", value: "C9" }] });
  });

  it("tolerates an empty context object, which arrives with no entities key", () => {
    const transport = makeTransport();
    const event = transport.parseUpdate(envelope(imMessage({ context: {} })));
    expect(event?.context).toBeUndefined();
  });

  it("drops the app's own streamed output instead of answering itself", () => {
    const transport = makeTransport();
    expect(transport.parseUpdate(envelope(imMessage({ bot_id: "B1", user: "UBOT" })))).toBeNull();
    expect(transport.parseUpdate(envelope(imMessage({ user: "UBOT" })))).toBeNull();
  });

  it("drops edits, deletes and system notices", () => {
    const transport = makeTransport();
    for (const subtype of ["message_changed", "message_deleted", "channel_join"]) {
      expect(transport.parseUpdate(envelope(imMessage({ subtype })))).toBeNull();
    }
  });

  it("keeps a file_share, which carries a real user turn", () => {
    const transport = makeTransport();
    const event = transport.parseUpdate(
      envelope(
        imMessage({
          subtype: "file_share",
          text: "",
          files: [{ id: "F1", url_private: "http://x/f", mimetype: "image/png", name: "a.png", size: 10 }],
        }),
      ),
    );
    expect(event?.media).toEqual([
      { kind: "photo", fileId: "F1", mimeType: "image/png", fileName: "a.png", fileSize: 10 },
    ]);
  });

  it("leaves channel traffic to the event pipeline", () => {
    const transport = makeTransport();
    expect(transport.parseUpdate(envelope(imMessage({ channel_type: "channel", channel: "C1" })))).toBeNull();
    expect(transport.parseUpdate(envelope({ type: "app_mention", channel: "C1", user: "U1", text: "hi" }))).toBeNull();
  });

  it("parses a link command DM into a command event", () => {
    const transport = makeTransport();
    const event = transport.parseUpdate(envelope(imMessage({ text: "link AbC123xyz" })));
    expect(event).toMatchObject({
      kind: "command",
      conversationKey: KEY,
      sender: { externalId: "U1" },
      dispatchId: "slack:Ev1",
      text: "link AbC123xyz",
      command: { name: "start", args: "AbC123xyz" },
    });
    expect(event).not.toHaveProperty("threadTs");
    expect(event).not.toHaveProperty("context");
  });

  it("parses link command regardless of case and surrounding whitespace", () => {
    const transport = makeTransport();
    const event = transport.parseUpdate(envelope(imMessage({ text: "  LINK   AbC123xyz  " })));
    expect(event).toMatchObject({
      kind: "command",
      command: { name: "start", args: "AbC123xyz" },
    });
  });

  it("treats link with no code as a plain message, not a command", () => {
    const transport = makeTransport();
    expect(transport.parseUpdate(envelope(imMessage({ text: "link" })))).toMatchObject({ kind: "message" });
  });

  it("treats messages that contain link but don't match the command pattern as plain messages", () => {
    const transport = makeTransport();
    expect(transport.parseUpdate(envelope(imMessage({ text: "linked you a doc" })))).toMatchObject({ kind: "message" });
  });
});

describe("parseUpdate — forwarded messages (is_msg_unfurl)", () => {
  it("extracts forwarded content from an is_msg_unfurl attachment", () => {
    const transport = makeTransport();
    const event = transport.parseUpdate(
      envelope(
        imMessage({
          text: "",
          attachments: [
            { is_msg_unfurl: true, author_name: "Alice", text: "the original message content", fallback: "fb" },
          ],
        }),
      ),
    );
    expect(event).not.toBeNull();
    expect(event?.text).toBe("[Forwarded message from Alice]:\nthe original message content");
  });

  it("does not drop a comment-less forward at the empty-text check", () => {
    // A forward without a typed comment has empty event.text and no files.
    // Before unfurl extraction this returned null and the agent never woke.
    const transport = makeTransport();
    const event = transport.parseUpdate(
      envelope(imMessage({ text: "", attachments: [{ is_msg_unfurl: true, text: "forwarded body" }] })),
    );
    expect(event).toMatchObject({ kind: "message", text: "[Forwarded message]:\nforwarded body" });
  });

  it("preserves the user's comment alongside the forward", () => {
    const transport = makeTransport();
    const event = transport.parseUpdate(
      envelope(
        imMessage({
          text: "check this out",
          attachments: [{ is_msg_unfurl: true, author_name: "Bob", text: "forwarded content here" }],
        }),
      ),
    );
    expect(event?.text).toBe("check this out\n\n[Forwarded message from Bob]:\nforwarded content here");
  });

  it("falls back to the attachment's fallback text when text is empty", () => {
    const transport = makeTransport();
    const event = transport.parseUpdate(
      envelope(
        imMessage({
          text: "",
          attachments: [{ is_msg_unfurl: true, text: "", fallback: "fallback content from forwarded message" }],
        }),
      ),
    );
    expect(event?.text).toBe("[Forwarded message]:\nfallback content from forwarded message");
  });

  it("handles multiple forwarded messages in one event", () => {
    const transport = makeTransport();
    const event = transport.parseUpdate(
      envelope(
        imMessage({
          text: "",
          attachments: [
            { is_msg_unfurl: true, author_name: "Alice", text: "first message" },
            { is_msg_unfurl: true, author_name: "Bob", text: "second message" },
          ],
        }),
      ),
    );
    expect(event?.text).toContain("[Forwarded message from Alice]:\nfirst message");
    expect(event?.text).toContain("[Forwarded message from Bob]:\nsecond message");
  });

  it("ignores link-preview attachments that are not message unfurls", () => {
    const transport = makeTransport();
    const event = transport.parseUpdate(
      envelope(
        imMessage({
          text: "see https://example.com",
          attachments: [{ title: "Example", text: "A link preview, not a forward" }],
        }),
      ),
    );
    expect(event?.text).toBe("see https://example.com");
  });

  it("routes a forwarded image into the media path", () => {
    const transport = makeTransport();
    const event = transport.parseUpdate(
      envelope(
        imMessage({
          text: "",
          attachments: [
            {
              is_msg_unfurl: true,
              author_name: "Alice",
              text: "",
              image_url: "https://files.slack.com/files-pri/T123-F456/photo.png",
            },
          ],
        }),
      ),
    );
    expect(event?.text).toBe("[Forwarded message from Alice]: [image]");
    expect(event?.media).toEqual([
      { kind: "photo", fileId: "unfurl:D100:1700000000.000100:0", mimeType: "image/png" },
    ]);
  });

  it("routes a forwarded file-share's att.files through the real file path", () => {
    // A forwarded file_share message carries its files inside the unfurl
    // attachment. Real file ids survive an api restart via files.info.
    const transport = makeTransport();
    const event = transport.parseUpdate(
      envelope(
        imMessage({
          text: "",
          attachments: [
            {
              is_msg_unfurl: true,
              author_name: "Alice",
              text: "",
              files: [{ id: "F9", url_private: "https://files.slack.com/f9", mimetype: "application/pdf", name: "doc.pdf", size: 5 }],
            },
          ],
        }),
      ),
    );
    expect(event?.text).toBe("[Forwarded message from Alice]: [file]");
    expect(event?.media).toEqual([
      { kind: "document", fileId: "F9", mimeType: "application/pdf", fileName: "doc.pdf", fileSize: 5 },
    ]);
  });

  it("keeps the link command when a forward rides along with it", () => {
    const transport = makeTransport();
    const event = transport.parseUpdate(
      envelope(
        imMessage({
          text: "link AbC123xyz",
          attachments: [{ is_msg_unfurl: true, author_name: "Alice", text: "forwarded body" }],
        }),
      ),
    );
    expect(event?.kind).toBe("command");
    expect(event?.command).toEqual({ name: "start", args: "AbC123xyz" });
  });

  it("marks a dropped foreign-host image even when the forward has body text", () => {
    const transport = makeTransport();
    const event = transport.parseUpdate(
      envelope(
        imMessage({
          text: "",
          attachments: [
            { is_msg_unfurl: true, author_name: "Eve", text: "some words", image_url: "https://evil.example.com/x.png" },
          ],
        }),
      ),
    );
    expect(event?.media).toBeUndefined();
    expect(event?.text).toBe("[Forwarded message from Eve]:\nsome words\n\n[Forwarded message from Eve]: [image]");
  });

  it("accepts Slack-operated CDN hosts and falls back to a fetchable thumb_url", () => {
    const transport = makeTransport();
    const proxied = transport.parseUpdate(
      envelope(imMessage({ text: "", attachments: [{ is_msg_unfurl: true, text: "", image_url: "https://a.slack-imgs.com/i.png" }] }), "EvP"),
    );
    expect(proxied?.media).toHaveLength(1);
    const thumbed = transport.parseUpdate(
      envelope(
        imMessage({
          ts: "1700000000.000900",
          text: "",
          attachments: [
            { is_msg_unfurl: true, text: "", image_url: "https://cdn.example.com/i.png", thumb_url: "https://files.slack.com/t.jpg" },
          ],
        }),
        "EvT",
      ),
    );
    expect(thumbed?.media).toEqual([
      { kind: "photo", fileId: "unfurl:D100:1700000000.000900:0", mimeType: "image/jpeg" },
    ]);
  });

  it("does not resolve a mime through the Object prototype chain", () => {
    // A file named x.constructor must fall back to image/jpeg, not return
    // Object's constructor function as the mimeType.
    const transport = makeTransport();
    const event = transport.parseUpdate(
      envelope(
        imMessage({
          text: "",
          attachments: [{ is_msg_unfurl: true, text: "", image_url: "https://files.slack.com/x.constructor" }],
        }),
      ),
    );
    expect(event?.media?.[0]?.mimeType).toBe("image/jpeg");
  });

  it("keeps a non-Slack image out of the authenticated media path", () => {
    // fetchMedia sends the bot token as a bearer header; a foreign host must
    // not receive it. The forward still surfaces as an [image] marker.
    const transport = makeTransport();
    const event = transport.parseUpdate(
      envelope(
        imMessage({
          text: "",
          attachments: [
            { is_msg_unfurl: true, author_name: "Mallory", text: "", image_url: "https://evil.example.com/x.png" },
          ],
        }),
      ),
    );
    expect(event?.text).toBe("[Forwarded message from Mallory]: [image]");
    expect(event?.media).toBeUndefined();
  });

  it("drops an attachments-only event with no unfurl content", () => {
    // A bare link preview with no user text still has nothing for the agent.
    const transport = makeTransport();
    const event = transport.parseUpdate(
      envelope(imMessage({ text: "", attachments: [{ title: "Example", text: "preview" }] })),
    );
    expect(event).toBeNull();
  });
});

describe("parseUpdate — gate callbacks", () => {
  const blockActions = {
    type: "block_actions",
    trigger_id: "TRIG1",
    user: { id: "U1", username: "someone" },
    team: { id: TEAM },
    channel: { id: CHANNEL },
    container: { message_ts: "1700000000.000900", thread_ts: "1700000000.000100" },
    actions: [{ value: "g|gate-77|approve" }],
  };

  it("carries the gate id from the button value so gates survive a restart", () => {
    const transport = makeTransport();
    const event = transport.parseUpdate(blockActions);
    expect(event).toMatchObject({
      kind: "gate_callback",
      conversationKey: KEY,
      gateCallback: {
        gateId: "gate-77",
        actionId: "approve",
        callbackId: "TRIG1",
        ref: { conversationKey: KEY, messageId: "1700000000.000900" },
      },
    });
  });

  it("rejects a button value that is not a gate", () => {
    const transport = makeTransport();
    expect(transport.parseUpdate({ ...blockActions, actions: [{ value: "something-else" }] })).toBeNull();
    expect(transport.parseUpdate({ ...blockActions, actions: [{ value: "g||approve" }] })).toBeNull();
    expect(transport.parseUpdate({ ...blockActions, actions: [{ value: "g|gate-77|" }] })).toBeNull();
  });
});

describe("answerCallback", () => {
  const EXPIRED = "This approval has expired — resolve it on the web.";

  function click(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: "block_actions",
      trigger_id: "TRIG-ANSWER",
      user: { id: "U1", username: "someone" },
      team: { id: TEAM },
      channel: { id: CHANNEL },
      container: { message_ts: "1700000000.000900", thread_ts: THREAD_TS },
      actions: [{ value: "g|gate-77|deny" }],
      response_url: `${fake.baseUrl}/response-url`,
      ...over,
    };
  }

  it("answers the click on its own response_url", async () => {
    const transport = makeTransport();
    transport.parseUpdate(click());

    await transport.answerCallback("TRIG-ANSWER", EXPIRED);

    const answer = fake.calls.find((c) => c.method === "response-url");
    expect(answer?.body).toEqual({ response_type: "ephemeral", replace_original: false, text: EXPIRED });
    // The response_url is a capability URL. It carries no bot token.
    expect(answer?.auth).toBeUndefined();
    expect(fake.calls.some((c) => c.method === "chat.postEphemeral")).toBe(false);
  });

  it("answers with an ephemeral message when the click carried no response_url", async () => {
    const transport = makeTransport();
    const payload = click();
    delete payload.response_url;
    transport.parseUpdate(payload);

    await transport.answerCallback("TRIG-ANSWER", EXPIRED);

    const ephemeral = fake.calls.find((c) => c.method === "chat.postEphemeral");
    expect(ephemeral?.body).toMatchObject({ channel: CHANNEL, user: "U1", text: EXPIRED });
  });

  it("answers with an ephemeral message when the response_url no longer accepts the post", async () => {
    const transport = makeTransport();
    transport.parseUpdate(click());
    fake.failNext("response-url", "expired_url", 500);

    await transport.answerCallback("TRIG-ANSWER", EXPIRED);

    const ephemeral = fake.calls.find((c) => c.method === "chat.postEphemeral");
    expect(ephemeral?.body).toMatchObject({ channel: CHANNEL, user: "U1", text: EXPIRED });
  });

  it("refuses a response_url that does not belong to Slack", async () => {
    const transport = makeTransport();
    // A reachable host is still the wrong host. A payload that reached the
    // parser without Slack's signature must not aim the answer elsewhere.
    const foreign = `${fake.baseUrl.replace("127.0.0.1", "localhost")}/response-url`;
    transport.parseUpdate(click({ response_url: foreign }));

    await transport.answerCallback("TRIG-ANSWER", EXPIRED);

    expect(fake.calls.some((c) => c.method === "response-url")).toBe(false);
    const ephemeral = fake.calls.find((c) => c.method === "chat.postEphemeral");
    expect(ephemeral?.body).toMatchObject({ channel: CHANNEL, user: "U1", text: EXPIRED });
  });

  it("says nothing when the callback carries no text", async () => {
    const transport = makeTransport();
    transport.parseUpdate(click());

    await transport.answerCallback("TRIG-ANSWER");

    expect(fake.calls.some((c) => c.method === "response-url")).toBe(false);
    expect(fake.calls.some((c) => c.method === "chat.postEphemeral")).toBe(false);
  });

  it("stays quiet for a callback it never parsed", async () => {
    const transport = makeTransport();

    await expect(transport.answerCallback("TRIG-UNKNOWN", EXPIRED)).resolves.toBeUndefined();
    expect(fake.calls).toHaveLength(0);
  });

  it("keeps the ephemeral answer working when the message send fails", async () => {
    const transport = makeTransport();
    const payload = click();
    delete payload.response_url;
    transport.parseUpdate(payload);
    fake.failNext("chat.postEphemeral", "channel_not_found");

    await expect(transport.answerCallback("TRIG-ANSWER", EXPIRED)).resolves.toBeUndefined();
  });
});

describe("verifyWebhook", () => {
  function signed(body: string, secret = SIGNING_SECRET, timestamp = Math.floor(Date.now() / 1000)) {
    const digest = createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
    return {
      headers: { "x-slack-request-timestamp": String(timestamp), "x-slack-signature": `v0=${digest}` },
      rawBody: new TextEncoder().encode(body),
    };
  }

  it("accepts a correctly signed event and returns the parsed body", () => {
    const transport = makeTransport();
    const body = JSON.stringify(envelope(imMessage()));
    const raws = transport.verifyWebhook(signed(body), {});
    expect(raws).toHaveLength(1);
    expect(transport.parseUpdate(raws?.[0])).toMatchObject({ kind: "message" });
  });

  it("rejects a wrong signature", () => {
    const transport = makeTransport();
    expect(transport.verifyWebhook(signed("{}", "wrong"), {})).toBeNull();
  });

  it("rejects a replayed request outside the window", () => {
    const transport = makeTransport();
    const old = Math.floor(Date.now() / 1000) - 400;
    expect(transport.verifyWebhook(signed("{}", SIGNING_SECRET, old), {})).toBeNull();
  });

  it("unwraps a form-encoded interactivity payload", () => {
    const transport = makeTransport();
    const payload = JSON.stringify({ type: "block_actions", trigger_id: "T" });
    const body = `payload=${encodeURIComponent(payload)}`;
    const raws = transport.verifyWebhook(signed(body), {});
    expect(raws?.[0]).toMatchObject({ type: "block_actions" });
  });

  it("rejects everything when no signing secret is configured", () => {
    const transport = makeTransport({ signingSecret: "" });
    expect(transport.verifyWebhook(signed("{}"), {})).toBeNull();
  });

  it("lets the host override the signing secret", () => {
    const transport = makeTransport({ signingSecret: "" });
    expect(transport.verifyWebhook(signed("{}", "host-held"), { signingSecret: "host-held" })).toEqual([{}]);
  });
});

describe("streaming", () => {
  it("opens a stream anchored to the turn's thread, appends, then closes it", async () => {
    const transport = makeTransport();
    const ref = await transport.startStream(KEY, { threadTs: "1700000000.000100" });
    expect(ref).toMatchObject({ conversationKey: KEY, threadTs: "1700000000.000100" });
    expect(lastCall("chat.startStream")).toMatchObject({
      channel: CHANNEL,
      thread_ts: "1700000000.000100",
    });

    await transport.appendStream(ref, "one ");
    await transport.appendStream(ref, "two");
    await transport.stopStream(ref, { markdown: "done" });

    const stream = fake.streams.get(ref.messageId);
    expect(stream?.appended).toEqual(["one ", "two"]);
    expect(stream?.open).toBe(false);
    expect(stream?.final).toBe("done");
  });

  it("omits recipient_user_id, which Slack requires only for channels", async () => {
    const transport = makeTransport();
    await transport.startStream(KEY, { threadTs: "1700000000.000100" });
    expect(lastCall("chat.startStream")).not.toHaveProperty("recipient_user_id");
  });

  it("splits an append over the 12,000-character limit without losing a character", async () => {
    const transport = makeTransport();
    const ref = await transport.startStream(KEY, { threadTs: "1700000000.000100" });
    const long = `${"a".repeat(9000)}\n\n${"b".repeat(9000)}`;
    await transport.appendStream(ref, long);
    const stream = fake.streams.get(ref.messageId);
    expect(stream?.appended.length).toBeGreaterThan(1);
    for (const piece of stream?.appended ?? []) expect(piece.length).toBeLessThanOrEqual(12_000);
    expect(stream?.appended.join("")).toBe(long);
  });

  it("appends the overflow before closing rather than truncating a long final answer", async () => {
    const transport = makeTransport();
    const ref = await transport.startStream(KEY, { threadTs: "1700000000.000100" });
    const long = "z".repeat(20_000);
    await transport.stopStream(ref, { markdown: long });
    const stream = fake.streams.get(ref.messageId);
    expect(stream?.open).toBe(false);
    expect(`${stream?.appended.join("")}${stream?.final ?? ""}`).toBe(long);
  });

  it("splits losslessly, keeping the newline it broke on", () => {
    expect(splitForStream("aa\nbb\ncc", 4).join("")).toBe("aa\nbb\ncc");
    expect(splitForStream("aaaaaaa", 3)).toEqual(["aaa", "aaa", "a"]);
    expect(splitForStream("short", 100)).toEqual(["short"]);
    expect(splitForStream("", 10)).toEqual([]);
  });

  it("neutralizes a broadcast sequence rather than pinging the workspace", async () => {
    const transport = makeTransport();
    const ref = await transport.startStream(KEY, { threadTs: "1700000000.000100" });
    await transport.appendStream(ref, "the doc said <!channel> and <@U123>");
    expect(fake.streams.get(ref.messageId)?.appended[0]).toBe(
      "the doc said &lt;!channel> and &lt;@U123>",
    );
  });

  it("leaves ordinary angle brackets alone on the markdown path", async () => {
    const transport = makeTransport();
    const ref = await transport.startStream(KEY, { threadTs: "1700000000.000100" });
    await transport.appendStream(ref, "`Array<string>` and 3 < 4");
    expect(fake.streams.get(ref.messageId)?.appended[0]).toBe("`Array<string>` and 3 < 4");
  });

  it("reports a reader-cancelled stream as stopped_by_user so the turn can abort", async () => {
    const transport = makeTransport();
    const ref = await transport.startStream(KEY, { threadTs: "1700000000.000100" });
    fake.stopStreamAsUser(ref.messageId);
    await expect(transport.appendStream(ref, "more")).rejects.toMatchObject({
      name: "ChannelStreamError",
      kind: "stopped_by_user",
    });
  });

  it("reports an already-closed stream as stream_gone", async () => {
    const transport = makeTransport();
    const ref = await transport.startStream(KEY, { threadTs: "1700000000.000100" });
    await transport.stopStream(ref);
    const err = await transport.appendStream(ref, "late").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChannelStreamError);
    expect(err).toMatchObject({ kind: "stream_gone" });
  });

  it("reports an unmapped failure as unknown rather than pretending it is retryable", async () => {
    const transport = makeTransport();
    fake.failNext("chat.startStream", "invalid_blocks");
    await expect(transport.startStream(KEY, { threadTs: "1700000000.000100" })).rejects.toMatchObject({
      kind: "unknown",
    });
  });

  it("declares the whole streaming triple, so the host can feature-detect it", () => {
    const transport = makeTransport();
    expect(typeof transport.startStream).toBe("function");
    expect(typeof transport.appendStream).toBe("function");
    expect(typeof transport.stopStream).toBe("function");
  });
});

describe("assistant thread controls", () => {
  it("sets a status on a thread", async () => {
    const transport = makeTransport();
    await transport.setStatus(KEY, "1700000000.000100", "is thinking...");
    expect(lastCall("assistant.threads.setStatus")).toEqual({
      channel_id: CHANNEL,
      thread_ts: "1700000000.000100",
      status: "is thinking...",
    });
  });

  it("omits thread_ts for a conversation with no turn yet", async () => {
    const transport = makeTransport();
    await transport.setSuggestedPrompts(KEY, [{ title: "Connect Valet", message: "How do I link my account?" }]);
    const body = lastCall("assistant.threads.setSuggestedPrompts");
    expect(body).not.toHaveProperty("thread_ts");
    expect(body.channel_id).toBe(CHANNEL);
  });

  it("keeps at most the four prompts Slack renders", async () => {
    const transport = makeTransport();
    await transport.setSuggestedPrompts(
      KEY,
      [1, 2, 3, 4, 5, 6].map((n) => ({ title: `t${n}`, message: `m${n}` })),
    );
    const prompts = lastCall("assistant.threads.setSuggestedPrompts").prompts;
    expect(Array.isArray(prompts) ? prompts.length : 0).toBe(4);
  });

  it("does not call Slack with an empty prompt list", async () => {
    const transport = makeTransport();
    await transport.setSuggestedPrompts(KEY, []);
    expect(fake.calls.some((c) => c.method === "assistant.threads.setSuggestedPrompts")).toBe(false);
  });

  it("titles a thread", async () => {
    const transport = makeTransport();
    await transport.setThreadTitle(KEY, "1700000000.000100", "Deploy the worker");
    expect(lastCall("assistant.threads.setTitle")).toEqual({
      channel_id: CHANNEL,
      thread_ts: "1700000000.000100",
      title: "Deploy the worker",
    });
  });

  it("shows the status shimmer on the most recent turn", async () => {
    const transport = makeTransport();
    const turnKey = primeTurn(transport, "1700000000.000500");
    await transport.sendTyping(turnKey);
    expect(lastCall("assistant.threads.setStatus").thread_ts).toBe("1700000000.000500");
  });

  it("stays quiet when no turn has arrived yet", async () => {
    const transport = makeTransport();
    await transport.sendTyping(KEY);
    expect(fake.calls.some((c) => c.method === "assistant.threads.setStatus")).toBe(false);
  });
});

describe("gate prompts", () => {
  it("escapes broadcasts in gate titles and bodies", async () => {
    const transport = makeTransport();
    await transport.sendGatePrompt(KEY, {
      gateId: "gate-broadcast",
      title: "Notify <!channel>",
      body: "Ask <!here> to review.",
      actions: [{ id: "approve", label: "Approve" }],
    });
    const body = lastCall("chat.postMessage");
    expect(body.text).toBe("*Notify &lt;!channel>*\n\nAsk &lt;!here> to review.");
    expect(body.blocks).toContainEqual({
      type: "section",
      text: { type: "mrkdwn", text: "Ask &lt;!here> to review." },
    });
  });

  it("posts the gate under the turn that raised it, with the gate id in the button", async () => {
    const transport = makeTransport();
    const turnKey = primeTurn(transport, "1700000000.000700");
    const ref = await transport.sendGatePrompt(turnKey, {
      gateId: "gate-77",
      title: "Deploy?",
      body: "This ships to production.",
      actions: [
        { id: "approve", label: "Approve", style: "primary" },
        { id: "deny", label: "Deny", style: "danger" },
      ],
    });
    const body = lastCall("chat.postMessage");
    expect(body.thread_ts).toBe("1700000000.000700");
    const blocks = body.blocks;
    if (!Array.isArray(blocks)) throw new Error("expected blocks");
    expect(blocks[0]).toMatchObject({ type: "header", text: { type: "plain_text", text: "Deploy?" } });
    expect(blocks[1]).toMatchObject({
      type: "section",
      text: { type: "mrkdwn", text: "This ships to production." },
    });
    const actions = blocks[blocks.length - 1];
    expect(actions).toMatchObject({
      type: "actions",
      elements: [
        { value: "g|gate-77|approve", style: "primary" },
        { value: "g|gate-77|deny", style: "danger" },
      ],
    });
    expect(ref.conversationKey).toBe(turnKey);
  });

  it("renders pre-digested fields as labeled section columns, never raw JSON", async () => {
    const transport = makeTransport();
    const turnKey = primeTurn(transport, "1700000000.000700");
    await transport.sendGatePrompt(turnKey, {
      gateId: "gate-79",
      title: "Approve Create PR?",
      body: "Open a pull request on tkhq/tk-brain.",
      fields: [
        { label: "Tool", value: "`github.create_pr`" },
        { label: "Risk", value: "high" },
      ],
      actions: [{ id: "approve", label: "Approve" }],
    });
    const body = lastCall("chat.postMessage");
    const blocks = body.blocks;
    if (!Array.isArray(blocks)) throw new Error("expected blocks");
    const fieldSection = blocks[2];
    expect(fieldSection).toMatchObject({
      type: "section",
      fields: [
        { type: "mrkdwn", text: "*Tool*\n`github.create_pr`" },
        { type: "mrkdwn", text: "*Risk*\nhigh" },
      ],
    });
    // The notification fallback stays compact: title + body, no field dump.
    expect(body.text).toBe("*Approve Create PR?*\n\nOpen a pull request on tkhq/tk-brain.");
  });

  it("field values render escaped, not markdown-converted — no live links from args", async () => {
    const transport = makeTransport();
    const turnKey = primeTurn(transport, "1700000000.000700");
    await transport.sendGatePrompt(turnKey, {
      gateId: "gate-81",
      title: "Approve?",
      fields: [
        { label: "url", value: "[https://good.example](https://evil.example)" },
        { label: "note", value: "a <!channel> & b" },
      ],
      actions: [{ id: "approve", label: "Approve" }],
    });
    const blocks = lastCall("chat.postMessage").blocks;
    if (!Array.isArray(blocks)) throw new Error("expected blocks");
    const section = blocks[1] as { fields?: Array<{ text: string }> };
    // The spoofed-link markdown stays literal text, never an mrkdwn <url|label>.
    expect(section.fields?.[0]?.text).toBe("*url*\n[https://good.example](https://evil.example)");
    expect(section.fields?.[1]?.text).toBe("*note*\na &lt;!channel> &amp; b");
  });

  it("substitutes a placeholder for a blank title instead of posting an invalid header", async () => {
    const transport = makeTransport();
    const turnKey = primeTurn(transport, "1700000000.000700");
    await transport.sendGatePrompt(turnKey, {
      gateId: "gate-82",
      title: "   ",
      actions: [{ id: "approve", label: "Approve" }],
    });
    const body = lastCall("chat.postMessage");
    const blocks = body.blocks;
    if (!Array.isArray(blocks)) throw new Error("expected blocks");
    expect(blocks[0]).toMatchObject({ type: "header", text: { type: "plain_text", text: "Approval needed" } });
    expect(body.text).toBe("*Approval needed*");
  });

  it("splits more than ten fields across sections (Slack's per-section cap)", async () => {
    const transport = makeTransport();
    const turnKey = primeTurn(transport, "1700000000.000700");
    await transport.sendGatePrompt(turnKey, {
      gateId: "gate-80",
      title: "Approve?",
      fields: Array.from({ length: 12 }, (_, i) => ({ label: `k${i}`, value: `v${i}` })),
      actions: [{ id: "approve", label: "Approve" }],
    });
    const blocks = lastCall("chat.postMessage").blocks;
    if (!Array.isArray(blocks)) throw new Error("expected blocks");
    const fieldSections = blocks.filter(
      (b): b is { type: string; fields: unknown[] } =>
        typeof b === "object" && b !== null && "fields" in b && Array.isArray((b as { fields?: unknown }).fields),
    );
    expect(fieldSections.map((s) => s.fields.length)).toEqual([10, 2]);
  });

  it("re-keys a DM prompt's ref to the posted ts so the inbound click round-trips", async () => {
    const transport = makeTransport();
    // openDirectConversation mints a SYNTHETIC thread ts; the inbound click
    // rebuilds the key from the REAL message ts. The returned ref must carry
    // the real one, or gateForRef can never match (dead buttons).
    const dmKey = await transport.openDirectConversation("U1");
    const ref = await transport.sendGatePrompt(dmKey, {
      gateId: "gate-88",
      title: "Deploy?",
      actions: [{ id: "approve", label: "Approve" }],
    });
    expect(ref.conversationKey).not.toBe(dmKey);
    expect(ref.conversationKey).toBe(conversationKeyFor(TEAM, "D-U1", ref.messageId));

    const inbound = transport.parseUpdate({
      type: "block_actions",
      trigger_id: "trig-1",
      actions: [{ value: "g|gate-88|approve" }],
      container: { message_ts: ref.messageId, channel_id: "D-U1" },
      user: { id: "U1" },
      team: { id: TEAM },
    });
    expect(inbound?.gateCallback?.ref).toEqual(ref);
    expect(inbound?.gateCallback?.gateId).toBe("gate-88");
  });

  it("replaces the prompt with title + outcome and clears the buttons, pinning parse to none", async () => {
    const transport = makeTransport();
    const ref = await transport.sendGatePrompt(KEY, {
      gateId: "gate-77",
      title: "Deploy?",
      body: "This ships to production.",
      fields: [{ label: "Tool", value: "`deploy.ship`" }],
      actions: [{ id: "approve", label: "Approve" }],
    });
    await transport.updateGatePrompt(ref, {
      actionId: "approve",
      label: "✅ Approved by Conner",
      resolvedAtMs: 1700000000000,
    });
    const body = lastCall("chat.update");
    expect(body.parse).toBe("none");
    const text = String(body.text);
    expect(text).toContain("*Deploy?*");
    expect(text).toContain("✅ Approved by Conner");
    expect(text).toContain("<!date^1700000000^{date_short_pretty} at {time}|");
    // The prompt detail is gone — a settled approval stops occupying the thread.
    expect(text).not.toContain("This ships to production.");
    expect(text).not.toContain("deploy.ship");
    const blocks = body.blocks;
    expect(Array.isArray(blocks) ? blocks.length : 0).toBe(1);
  });

  it("keeps the human-written body through the edit for a gate without fields", async () => {
    const transport = makeTransport();
    const ref = await transport.sendGatePrompt(KEY, {
      gateId: "gate-83",
      title: "Proceed with rollback?",
      body: "This reverts deploys 122-125 and drops migration 0007.",
      actions: [{ id: "approve", label: "Approve" }],
    });
    await transport.updateGatePrompt(ref, { actionId: "approve", label: "✅ Approved by Conner" });
    const text = String(lastCall("chat.update").text);
    // An ask_approval body IS the record of what was approved — it must
    // survive the edit; only digested tool cards collapse to the title.
    expect(text).toContain("This reverts deploys 122-125");
    expect(text).toContain("✅ Approved by Conner");
  });

  it("escapes a resolver name that carries mrkdwn control sequences", async () => {
    const transport = makeTransport();
    const ref = await transport.sendGatePrompt(KEY, {
      gateId: "gate-78",
      title: "Deploy?",
      actions: [{ id: "approve", label: "Approve" }],
    });
    await transport.updateGatePrompt(ref, { actionId: "approve", label: "✅ Approved by <!channel>" });
    expect(String(lastCall("chat.update").text)).toContain("&lt;!channel>");
  });
});

describe("gate prompt identity (TKAI-387)", () => {
  it("brands the approval card with the asking assistant's identity", async () => {
    const transport = makeTransport();
    await transport.sendGatePrompt(KEY, {
      gateId: "gate-identity",
      title: "Deploy?",
      actions: [{ id: "approve", label: "Approve" }],
      sender: { displayName: "Ledger", avatarUrl: "https://cdn.example.com/ledger.png" },
    });
    const body = lastCall("chat.postMessage");
    expect(body.username).toBe("Ledger");
    expect(body.icon_url).toBe("https://cdn.example.com/ledger.png");
  });
});

describe("discrete sends", () => {
  it("renders short tables as blocks and keeps raw mentions inert", async () => {
    const transport = makeTransport();
    const markdown = '| PR | Status |\n| --- | --- |\n| [PR](https://github.com/tkhq/mono/pull/8240) | <!channel> |';
    await transport.send(KEY, { markdown });
    const body = lastCall("chat.postMessage");
    expect(body.blocks).toEqual([{ type: 'section', text: { type: 'mrkdwn', text: '*PR*: <https://github.com/tkhq/mono/pull/8240|PR>\n*Status*: &lt;!channel>\n' } }]);
    expect(fake.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
  });

  it("replies in the turn's thread", async () => {
    const transport = makeTransport();
    const turnKey = primeTurn(transport, "1700000000.000300");
    await transport.send(turnKey, { markdown: "**done**" });
    const body = lastCall("chat.postMessage");
    expect(body.thread_ts).toBe("1700000000.000300");
    expect(body.text).toBe("*done*");
  });

  it("switches to blocks rather than several messages when the text is long", async () => {
    const transport = makeTransport();
    await transport.send(KEY, { markdown: "x".repeat(5000) });
    const posts = fake.calls.filter((c) => c.method === "chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(Array.isArray(posts[0].body.blocks)).toBe(true);
  });

  it("names the expected key shape when handed a key it cannot parse", async () => {
    const transport = makeTransport();
    // Old 2-segment key is now invalid
    await expect(transport.send("slack:T1:D1", { markdown: "hi" })).rejects.toThrow(
      /Expected "slack:\{teamId\}:\{channelId\}:\{threadTs\}"/,
    );
  });

  it("passes the assistant identity as username/icon_url (TKAI-387)", async () => {
    const transport = makeTransport();
    await transport.send(KEY, {
      markdown: "hi",
      sender: { displayName: "Ledger", avatarUrl: "https://cdn.example.com/ledger.png" },
    });
    const body = lastCall("chat.postMessage");
    expect(body.username).toBe("Ledger");
    expect(body.icon_url).toBe("https://cdn.example.com/ledger.png");
  });

  it("omits username/icon_url when no sender identity is set (bot identity fallback)", async () => {
    const transport = makeTransport();
    await transport.send(KEY, { markdown: "hi" });
    const body = lastCall("chat.postMessage");
    expect(body.username).toBeUndefined();
    expect(body.icon_url).toBeUndefined();
  });

  it("treats empty/whitespace identity fields as unset — Slack rejects an empty username", async () => {
    const transport = makeTransport();
    await transport.send(KEY, { markdown: "hi", sender: { displayName: "  ", avatarUrl: "" } });
    const body = lastCall("chat.postMessage");
    expect(body.username).toBeUndefined();
    expect(body.icon_url).toBeUndefined();
  });

  it("retries without the identity override when the workspace lacks chat:write.customize", async () => {
    const transport = makeTransport();
    fake.failNext("chat.postMessage", "missing_scope");
    await transport.send(KEY, { markdown: "hi", sender: { displayName: "Ledger" } });
    const posts = fake.calls.filter((c) => c.method === "chat.postMessage");
    expect(posts).toHaveLength(2);
    expect(posts[0].body.username).toBe("Ledger");
    expect(posts[1].body.username).toBeUndefined();
    expect(posts[1].body.text).toBe("hi");
  });

  it("retries without identity for any Slack rejection, not only missing_scope", async () => {
    const transport = makeTransport();
    fake.failNext("chat.postMessage", "invalid_arguments");
    await transport.send(KEY, { markdown: "must land", sender: { displayName: "Ledger" } });
    const posts = fake.calls.filter((c) => c.method === "chat.postMessage");
    expect(posts).toHaveLength(2);
    expect(posts[0].body.username).toBe("Ledger");
    expect(posts[1].body.username).toBeUndefined();
  });

  it("does not retry an HTTP failure because Slack might have accepted the request", async () => {
    const transport = makeTransport();
    fake.failNext("chat.postMessage", "server_error", 500);
    await expect(
      transport.send(KEY, { markdown: "must not duplicate", sender: { displayName: "Ledger" } }),
    ).rejects.toThrow("server_error");
    const posts = fake.calls.filter((c) => c.method === "chat.postMessage");
    expect(posts).toHaveLength(1);
  });

  it("sanitizes long control-character names and drops malformed avatar URLs", async () => {
    const transport = makeTransport();
    await transport.send(KEY, {
      markdown: "hi",
      sender: {
        displayName: `  Ledger\n${"x".repeat(100)}  `,
        avatarUrl: "https://not a url",
      },
    });
    const body = lastCall("chat.postMessage");
    expect(body.username).toBe(`Ledger ${"x".repeat(73)}`);
    expect(body.icon_url).toBeUndefined();
  });

  it("refuses a well-formed key from another workspace instead of posting anyway", async () => {
    // A host that rebuilds the key with a fixed middle segment produces
    // exactly this: it parses, its channel id is usable, and the reply would
    // land in the DM root with no error. The team check makes it loud.
    const transport = makeTransport();
    await expect(transport.send(`slack:dm:${CHANNEL}:${THREAD_TS}`, { markdown: "hi" })).rejects.toThrow(
      /names workspace "dm", but this transport serves "T1"/,
    );
    expect(fake.calls.some((c) => c.method === "chat.postMessage")).toBe(false);
  });
});

describe("factory", () => {
  it("declares external-webhook ingress so the host registers nothing", () => {
    expect(slackTransportFactory.ingress).toBe("external-webhook");
  });

  it("offers Socket Mode only when an app token is present", () => {
    expect(makeTransport().poll).toBeUndefined();
    expect(makeTransport({ appToken: "xapp-1" }).poll).toBeDefined();
  });

  it("names the fix when the bot token is missing", () => {
    expect(() =>
      slackTransportFactory.create({ credential: { type: "bot_token", metadata: { teamId: TEAM } }, config: {} }),
    ).toThrow(/Connect Slack in Settings/);
  });

  it("names the fix when the team id is missing", () => {
    expect(() =>
      slackTransportFactory.create({ credential: credential({}), config: {} }),
    ).toThrow(/Re-save the Slack credential/);
  });
});

describe("cleanSlackText", () => {
  it("removes the app's own mention and flattens link syntax", () => {
    expect(cleanSlackText("<@UBOT> check <https://x.dev|the docs>", "UBOT")).toBe("check the docs");
    expect(cleanSlackText("ping <@U9> in <#C1|general>")).toBe("ping @U9 in #general");
  });
});

describe("lookupUserByEmail", () => {
  it("resolves a member by email, preferring the profile display name", async () => {
    fake.setMembers([
      {
        id: "U7",
        name: "conner",
        real_name: "Conner Swann",
        profile: { email: "conner@example.com", display_name: "connerbot" },
      },
    ]);
    const transport = makeTransport();
    await expect(transport.lookupUserByEmail("conner@example.com")).resolves.toEqual({
      externalId: "U7",
      displayName: "connerbot",
    });
  });

  it("returns null when the email names nobody in the workspace", async () => {
    fake.setMembers([]);
    const transport = makeTransport();
    await expect(transport.lookupUserByEmail("nobody@example.com")).resolves.toBeNull();
  });

  it("maps missing_scope to an actionable ChannelLookupError", async () => {
    fake.failNext("users.lookupByEmail", "missing_scope");
    const transport = makeTransport();
    await expect(transport.lookupUserByEmail("x@example.com")).rejects.toMatchObject({
      name: "ChannelLookupError",
      kind: "missing_scope",
      message: expect.stringContaining("users:read.email"),
    });
  });

  it("maps other failures to a transport-kind ChannelLookupError", async () => {
    fake.failNext("users.lookupByEmail", "fatal_error");
    const transport = makeTransport();
    await expect(transport.lookupUserByEmail("x@example.com")).rejects.toMatchObject({
      name: "ChannelLookupError",
      kind: "transport",
    });
  });
});

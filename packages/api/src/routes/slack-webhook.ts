/**
 * PUBLIC Slack ingress: `POST /api/channels/slack/webhook`.
 *
 * Slack delivers everything an app receives to one app-level URL: Events
 * API envelopes as JSON, and interactivity payloads as a form-encoded
 * `payload=` field. This route is mounted before the generic
 * `/api/channels/:channelType/webhook` so the more specific path wins, and
 * before the auth middleware because the caller is Slack, not a signed-in
 * Valet user. The signing-secret HMAC is the whole authentication.
 *
 * It verifies once and fans each update out to both consumers:
 *
 * - channel: `transport.parseUpdate` then `channelHost.handleUpdate` — the
 *   agent surface (`app_home_opened` on the Messages tab, `message.im`,
 *   `app_context_changed`) and Block Kit approval callbacks.
 * - events: the Slack `TriggerDef`s then `ingestEvent` — workflow
 *   subscriptions. Ingest is match-gated: an event that matches no
 *   subscription is dropped and never lands in the events table.
 *
 * ── Ack policy ───────────────────────────────────────────────────────────
 * Slack expects a response inside three seconds and redelivers up to three
 * times when it does not get one. A turn of agent work takes far longer
 * than that, so the fan-out runs after the response is returned. One
 * credential read stays on the path to the 200, because the signing secret
 * lives on it and nothing can be verified without it.
 *
 * A redelivery is processed like any other delivery, and logged as well
 * because a burst of them is the signal that this ack path became slow.
 * Processing is safe because both consumers dedupe durably: the engine
 * holds a unique index on `(session_id, dispatch_id)`, and ingest holds an
 * `ON CONFLICT DO NOTHING` on `(service, dedupe_key)`. Slack repeats
 * `event_id` across retries, so both keys are stable.
 *
 * Dropping redeliveries instead would be strictly worse. Slack does not
 * redeliver to save us duplicate work; it redelivers because the first
 * attempt produced no 2xx. A dropped redelivery therefore turns every
 * transient failure on this route — a database blip, a deploy that lands
 * mid-request — into a message the user typed and Valet silently lost.
 *
 * ── Which credential, and which workspace ────────────────────────────────
 * The org's Slack credential holds the signing secret and the workspace id,
 * both recorded at connect time by `PUT /api/credentials/slack?scope=org`.
 * A Slack app's signing secret is valid for every workspace that installs
 * that app, so a valid signature alone does not prove the update belongs to
 * us: the update must also name our workspace. An update from any other
 * workspace, or one that names none, is dropped. Inside our workspace each
 * Slack user reaches only their own linked Valet user's orchestrator
 * session (`ChannelHost.routeUpdate`), so two members of one workspace
 * never see each other's threads.
 *
 * Linking works two ways. The OAuth auto-link runs when a user completes the
 * slack-user connect flow and records their Slack user id at that point. The
 * `link <code>` DM command lets a user link manually: the Slack transport
 * parses the message into a `command` event that `ChannelHost.handleStart`
 * consumes. Until a user completes one of these flows their DMs drop at
 * `unlinked_sender`.
 *
 * Org resolution is the single-org assumption this deployment makes
 * everywhere else (`lib/org.ts`). A multi-org deployment needs a real
 * workspace-to-org lookup here.
 */
import { Hono } from "hono";
import type { ChannelTransport, RawChannelUpdate, TriggerDef, ValetPlugin } from "@valet/engine";
import type { AppEnv } from "../env.js";
import type { AppDb } from "../lib/drizzle.js";
import { resolveOrgId } from "../lib/org.js";
import { writeDropLog } from "../orchestrator/signals.js";
import { ingestEvent, logSlackMessageBotNearMiss } from "../events/ingest.js";
import type { ChannelHost } from "../channels/host.js";
import type { EngineHost } from "../engine/host.js";
import { handleFollowedMessage } from "../channels/follow-router.js";
import { channelMessageNormalizer } from "../events/channel-origin.js";
import { channelThreadWindowFetcher } from "../events/channel-thread-context.js";

/**
 * Slack updates are small JSON; files arrive by reference, never inline. The
 * cap rejects an oversized body before it is parsed or verified.
 *
 * It is not a memory bound. `content-length` is advisory and a chunked body
 * carries none, so the bytes are already buffered when the second check
 * runs. Every public webhook route in this api reads its body the same way
 * (`event-webhooks.ts`, `channels.ts`, `github-app.ts`); a real bound
 * belongs in one shared place, in front of all four.
 */
const MAX_BODY_BYTES = 1024 * 1024;

/** The handshake echo is answered before the signature is checked, so it is
 * an unauthenticated reflection. Slack's own challenge is a short random
 * string; a longer one is not Slack. */
const MAX_CHALLENGE_CHARS = 512;

/** Same rationale as `ChannelHost.maybeLogVerifyFailed`: this route is
 * public and unauthenticated, so a burst of bad or half-configured posts
 * must not flood `event_drop_log`. The throttle covers the write, never the
 * response — every bad request still gets its real status. */
const DROPLOG_COOLDOWN_MS = 60_000;
const droplogLoggedAt = new Map<string, number>();
const interactionLoggedAt = new Map<string, number>();

/** Test-only: clears the per-process drop-log throttle so suites can assert
 * one row per reason without the cooldown bleeding across cases. */
export function __resetSlackWebhookThrottle(): void {
  droplogLoggedAt.clear();
  interactionLoggedAt.clear();
}

async function throttledDropLog(db: AppDb, args: { orgId: string; reason: string; detail: string }): Promise<void> {
  const now = Date.now();
  const last = droplogLoggedAt.get(args.reason);
  if (last !== undefined && now - last < DROPLOG_COOLDOWN_MS) return;
  droplogLoggedAt.set(args.reason, now);
  await writeDropLog(db, args);
}

function slackTriggerDefs(plugins: ValetPlugin[]): TriggerDef[] {
  return plugins.flatMap((p) => p.triggers ?? []).filter((t) => t.service === "slack");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** `team_id` sits on the Events API envelope; interactivity nests it at `team.id`. */
function teamIdOf(update: unknown): string | undefined {
  if (!isRecord(update)) return undefined;
  if (typeof update.team_id === "string") return update.team_id;
  if (isRecord(update.team) && typeof update.team.id === "string") return update.team.id;
  return undefined;
}

const DIAGNOSTIC_INTERACTION_TYPES = new Set(["block_actions", "view_submission"]);

/** Retain only diagnostic metadata for Slack forms. The event payload, including
 * Slack's deprecated verification token, never enters durable storage. */
async function logUnmatchedInteraction(db: AppDb, orgId: string, raw: RawChannelUpdate): Promise<void> {
  const type = isRecord(raw) && typeof raw.type === "string" ? raw.type : undefined;
  if (!type || !DIAGNOSTIC_INTERACTION_TYPES.has(type)) return;
  const throttleKey = `${orgId}:${type}`;
  const now = Date.now();
  const last = interactionLoggedAt.get(throttleKey);
  if (last !== undefined && now - last < DROPLOG_COOLDOWN_MS) return;
  interactionLoggedAt.set(throttleKey, now);
  await writeDropLog(db, {
    orgId,
    reason: "slack_interaction_unmatched",
    detail: `A Slack ${type} interaction arrived. Valet did not start a workflow because Slack interactions do not match workflow subscriptions.`,
  });
}

/** Only verified envelopes reach this diagnostic; never retain message text or tokens. */
async function logClassifierRejection(deps: FanOutDeps, raw: RawChannelUpdate): Promise<void> {
  if (!isRecord(raw) || raw.type !== "event_callback" || !isRecord(raw.event)) return;
  const event = raw.event;
  const type = typeof event.type === "string" ? event.type : "unknown";
  const botId = typeof event.bot_id === "string" ? event.bot_id : undefined;
  const explanation = botId && botId === deps.botId || event.user === deps.botUserId && deps.botUserId !== undefined
    ? "Ignored Valet's own message to prevent a reply loop."
    : !raw.event_id ? "The envelope has no delivery event ID."
    : type === "message" && event.subtype && event.subtype !== "bot_message"
      ? "This message subtype is not a subscribable message (for example, an edit or deletion)."
      : botId && !deps.botId ? "Bot message classification requires the connected Valet bot identity."
      : "No enabled Slack trigger classifier accepted this event type or message shape.";
  const key = `${deps.orgId}:classifier:${explanation}`;
  const now = Date.now();
  const last = interactionLoggedAt.get(key);
  if (last !== undefined && now - last < DROPLOG_COOLDOWN_MS) return;
  interactionLoggedAt.set(key, now);
  await writeDropLog(deps.db, { orgId: deps.orgId, reason: "slack_classifier_rejected", detail: `A verified Slack event was received but did not enter subscription matching. ${explanation}` });
}

interface FanOutDeps {
  botUserId?: string;
  botId?: string;
  db: AppDb;
  plugins: ValetPlugin[];
  transport: ChannelTransport;
  channelHost: ChannelHost;
  engineHost: EngineHost;
  triggerDefs: TriggerDef[];
  onIngest: () => void;
  orgId: string;
  webhookSecret: string;
  headers: Record<string, string>;
  rawBody: Uint8Array;
}

/**
 * Feeds one verified update to both consumers. Errors are contained per
 * update: one malformed payload must not stop the rest of a batch, and
 * neither consumer may block the other.
 */
async function fanOutUpdate(deps: FanOutDeps, raw: RawChannelUpdate): Promise<void> {
  try {
    const event = deps.transport.parseUpdate(raw);
    if (event) await deps.channelHost.handleUpdate("slack", event);
  } catch (err) {
    console.error("[slack-webhook] channel consumer failed", err);
  }

  // The trigger definitions re-verify over the same raw bytes so their own
  // extraction stays authoritative. The HMAC is cheap, and each definition
  // rejects event types outside its family, so the first match wins.
  try {
    let matchedTrigger = false;
    for (const def of deps.triggerDefs) {
      const verified = await def.verify({ headers: deps.headers, rawBody: deps.rawBody }, { webhookSecret: deps.webhookSecret, ...(deps.botId ? { botId: deps.botId } : {}), ...(deps.botUserId ? { botUserId: deps.botUserId } : {}) });
      if (!verified) continue;
      const normalized = def.toEvent(verified);
      const ingestResult = await ingestEvent(
        { db: deps.db, plugins: deps.plugins, onIngest: deps.onIngest },
        { orgId: deps.orgId, service: "slack", event: normalized },
      );
      // A bot-message subscription that matched or excluded this event owns
      // its diagnostic. Only a classifier miss with no named bot subscription
      // should suggest that a slack.message subscription use slack.bot_message.
      if (normalized.key === "slack.bot_message" && ingestResult.skipped && !ingestResult.namedSubscription) {
        await logSlackMessageBotNearMiss(deps.db, deps.orgId, normalized.payload);
      }
      matchedTrigger = true;
      break;
    }
    if (!matchedTrigger) {
      await logUnmatchedInteraction(deps.db, deps.orgId, raw);
      await logClassifierRejection(deps, raw);
    }
  } catch (err) {
    console.error("[slack-webhook] event consumer failed", err);
  }

  // Follow-router: a threaded message on a followed thread routes to the bound
  // assistant. Independent of the two consumers above; its error is contained.
  try {
    await handleFollowedMessage(
      {
        db: deps.db,
        botUserId: deps.botUserId,
        engineHost: deps.engineHost,
        normalizeChannelMessage: channelMessageNormalizer(deps.channelHost),
        fetchThreadWindow: channelThreadWindowFetcher(deps.channelHost),
      },
      { orgId: deps.orgId, raw },
    );
  } catch (err) {
    console.error("[slack-webhook] follow-router failed", err);
  }
}

export const slackWebhookRouter = new Hono<AppEnv>();

slackWebhookRouter.post("/webhook", async (c) => {
  const { db, plugins, engineCredentials, channelHost, engineHost, eventDispatcher } = c.var.providers;

  // Reject on the declared length before reading the body, then again on
  // the bytes actually read — the header can be absent or lying.
  const contentLength = c.req.header("content-length");
  if (contentLength !== undefined && Number(contentLength) > MAX_BODY_BYTES) {
    return c.json({ error: "payload too large" }, 413);
  }
  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  if (rawBody.byteLength > MAX_BODY_BYTES) return c.json({ error: "payload too large" }, 413);

  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });

  // The handshake comes before the signature check: it is how Slack enables
  // the endpoint in the first place, and at that moment the org credential
  // that holds the signing secret may not exist yet. Interactivity bodies
  // are form-encoded, so they are never parsed as handshake JSON.
  const bodyText = new TextDecoder().decode(rawBody);
  if (!bodyText.startsWith("payload=")) {
    try {
      const peek: unknown = JSON.parse(bodyText);
      if (isRecord(peek) && peek.type === "url_verification" && typeof peek.challenge === "string") {
        if (peek.challenge.length > MAX_CHALLENGE_CHARS) return c.json({ error: "challenge too long" }, 400);
        return c.json({ challenge: peek.challenge });
      }
    } catch {
      // Not JSON. `verifyWebhook` below rejects an unparseable body.
    }
  }

  // A redelivery means the previous delivery did not get a fast 2xx. It is
  // recorded, then processed like any other delivery — see the ack policy
  // above for why it must not be dropped. The log is throttled and runs
  // after the response, because this path exists precisely for the case
  // where this endpoint is already too slow.
  const retryNum = headers["x-slack-retry-num"];
  if (retryNum !== undefined) {
    const retryReason = headers["x-slack-retry-reason"] ?? "unknown";
    void (async () => {
      try {
        const retryOrgId = await resolveOrgId(db);
        await throttledDropLog(db, {
          orgId: retryOrgId,
          reason: "slack_retry",
          detail:
            `slack redelivered an update (attempt ${retryNum}, reason ${retryReason}). ` +
            "Check the api response time on this route and the last non-2xx it returned.",
        });
      } catch (err) {
        console.error("[slack-webhook] retry drop-log failed", err);
      }
    })();
  }

  const orgId = await resolveOrgId(db);
  const credential = await engineCredentials.get({ type: "org", id: orgId }, "slack");
  const webhookSecret = typeof credential?.metadata?.webhookSecret === "string" ? credential.metadata.webhookSecret : undefined;
  const credentialTeamId = typeof credential?.metadata?.teamId === "string" ? credential.metadata.teamId : undefined;
  if (!credential || !webhookSecret || !credentialTeamId) {
    // Ack rather than 401: a half-configured org must not put Slack into a
    // retry loop against an endpoint that will keep failing.
    await throttledDropLog(db, {
      orgId,
      reason: "unknown_org",
      detail:
        "slack webhook received with no usable org credential. " +
        "Connect Slack in Settings to record the signing secret and the workspace id.",
    });
    return c.body(null, 200);
  }

  const transport = channelHost.transportFor("slack");
  if (!transport) {
    // The credential exists but the transport did not start, so nothing can
    // verify the signature. Ack for the same reason as above.
    await throttledDropLog(db, {
      orgId,
      reason: "transport_unavailable",
      detail:
        "slack webhook received but the slack transport is not running. " +
        "Read the api startup log for the slack transport error.",
    });
    return c.body(null, 200);
  }

  // `verifyWebhook` is wrapped defensively: a crafted signature header must
  // never surface as an unauthenticated 500. Any throw is a rejection.
  let raws: RawChannelUpdate[] | null;
  try {
    raws = transport.verifyWebhook({ headers, rawBody }, { webhookSecret });
  } catch {
    raws = null;
  }
  if (raws === null) {
    await throttledDropLog(db, {
      orgId,
      reason: "bad_signature",
      detail:
        "slack webhook signature verification failed. " +
        "Compare the stored signing secret with Basic Information in your Slack app settings.",
    });
    return c.json({ error: "signature verification failed" }, 401);
  }

  const deps: FanOutDeps = {
    db,
    plugins,
    transport,
    channelHost,
    engineHost,
    botUserId: typeof credential?.metadata?.botUserId === "string" ? credential.metadata.botUserId : undefined,
    botId: typeof credential?.metadata?.botId === "string" ? credential.metadata.botId : undefined,
    triggerDefs: slackTriggerDefs(plugins),
    onIngest: eventDispatcher.nudge,
    orgId,
    webhookSecret,
    headers,
    rawBody,
  };

  // Verified. Everything below this point runs after the 200.
  void (async () => {
    for (const raw of raws) {
      try {
        const teamId = teamIdOf(raw);
        if (teamId !== credentialTeamId) {
          await throttledDropLog(db, {
            orgId,
            reason: "foreign_workspace",
            detail:
              `slack webhook for workspace ${teamId ?? "(none)"}. ` +
              `This deployment answers workspace ${credentialTeamId} only.`,
          });
          continue;
        }
        await fanOutUpdate(deps, raw);
      } catch (err) {
        console.error("[slack-webhook] fan-out failed", err);
      }
    }
  })();

  return c.body(null, 200);
});

/**
 * The ValetPlugin manifest — the single seam between plugin packages and
 * hosts (spec: docs/specs/2026-07-13-plugin-system-v2-design.md). Composes
 * only engine-owned types; the engine gains no dependencies.
 *
 * Entry-point convention: a plugin package declares
 * `"valet": { "plugin": "./dist/plugin.js" }` in package.json; that
 * module's default export is a ValetPlugin, or a
 * `() => ValetPlugin | Promise<ValetPlugin>` factory. The marker's presence
 * is the whole contract — a package without it is not a plugin.
 *
 * See the "Channel transports" section below for the v2 ChannelTransport
 * contract (Telegram, Phase 7).
 */
import type { ActionPlugin } from "./plugin-catalog.js";
import type { RiskLevel, SkillSource, RoleSpec, StoredCredential } from "./types.js";
import { BUILTIN_COMMAND_NAMES, type CommandDef } from "./commands/types.js";
import type { WorkflowTemplate } from "./workflow-template.js";

export interface OAuthIdentity {
  provider: string;
  externalId: string;
  externalName?: string;
  teamId?: string;
}

export interface TokenInterpretation {
  accessToken: string;
  refreshToken?: string;
  expiresInSec?: number;
  /** Scopes the provider actually granted (not requested). */
  grantedScopes?: string[];
  /** Provider facts stored on the credential (team_id, slack_user_id, …). */
  metadata?: Record<string, string>;
  /** Present → the connect flow also writes a user_identity_links row. */
  identity?: OAuthIdentity;
}

/** Thrown by interpretTokenResponse. `message` is user-facing: name the corrective action. */
export class OAuthInterpretError extends Error {}

/** How the connect UI obtains an oauth2 credential (integration-OAuth design). */
export type OAuthDeclaration =
  | {
      /** MCP OAuth: RFC 8414 discovery + RFC 7591 dynamic registration, PKCE public client. */
      mode: "mcp";
      /** The MCP server URL discovery runs against (same URL the plugin's mcpActionPlugin uses). */
      serverUrl: string;
    }
  | {
      /** Pre-registered confidential client; id/secret come from the host's env. */
      mode: "authorization_code";
      authorizationUrl: string;
      tokenUrl: string;
      clientIdEnv: string;
      clientSecretEnv: string;
      /** Extra authorize-URL params, e.g. Google's access_type=offline&prompt=consent. */
      extraAuthParams?: Record<string, string>;
      /** Query param that carries the scope list. Default "scope".
       *  Slack user tokens use "user_scope". */
      scopesParam?: string;
      /** Interpret a non-standard token response. Absent → standard OAuth2
       *  shape. Throw OAuthInterpretError to fail the flow. */
      interpretTokenResponse?: (raw: unknown) => TokenInterpretation;
    };

export interface CredentialDeclaration {
  /** Service the credential is stored under. Defaults to the plugin name. */
  service?: string;
  type: "oauth2" | "api_key" | "bot_token" | "service_account";
  /** OAuth scopes, for oauth2 declarations. */
  scopes?: string[];
  /** Keys the plugin's actions read off the resolved Credential (e.g. ["accessToken"]). */
  configKeys: string[];
  /** Human copy for connect UI. */
  connectLabel?: string;
  /** How the connect UI obtains this credential via OAuth. Absent = manual token entry only. Only valid on `type: "oauth2"`. */
  oauth?: OAuthDeclaration;
  /** Deployment/org prerequisite for offering this credential. Absent = the
   * credential is self-sufficient (a personal token works with no org setup)
   * and the service is always offered. `orgCredential: true` = the org-scoped
   * credential an admin creates in Settings → Organization IS the
   * integration; users never connect this credential themselves. Until the
   * admin connects, the service is unavailable; after, sessions resolve the
   * org credential by owner escalation. Evaluated by the API host, never by
   * the engine. */
  requires?: { orgCredential: true };
}

/** A webhook event that passed signature verification. */
export interface VerifiedEvent {
  eventType: string;
  deliveryId: string;
  payload: unknown;
}

/** A provider webhook normalized into the generic event pipeline. */
export interface NormalizedEvent {
  /** Namespaced key, e.g. "github.pull_request.opened", "linear.issue.create". */
  key: string;
  /** Provider delivery id — unique per service; makes redelivery idempotent. */
  dedupeKey: string;
  /** ISO timestamp of when the event happened at the provider. */
  occurredAt: string;
  /** External actor, when the payload carries one (enables identity-link attribution). */
  actor?: { externalId: string; login?: string };
  /** Flat scope refs for filtering/display: repo, installation_id, team_id, … */
  refs: Record<string, string>;
  /** One-line human summary (used as the SignalContent body for orchestrator delivery). */
  summary: string;
  /** Raw provider payload. */
  payload: unknown;
}

export interface EventCatalogEntry {
  key: string;
  description: string;
  /** Filterable fields: `field` is the user-facing name, `path` a dot-path into the raw payload. */
  filters: {
    field: string;
    path: string;
    description: string;
    /**
     * When set, the field's value is chosen from a provider-populated list, not
     * typed by hand. `source` names a `FilterOptionResolver` the owning plugin
     * registers (`slack.users`, `github.repos`). `dependsOn` names earlier
     * fields whose chosen values scope this one — `github.branches` dependsOn
     * `["repo"]`, because a branch list means nothing until a repo is chosen.
     */
    options?: { source: string; dependsOn?: string[] };
  }[];
}

/** An option a filter value can take: a named id the picker shows and stores. */
export interface FilterOption {
  id: string;
  label: string;
  hint?: string;
}

/** What a `FilterOptionResolver` receives to list options for a filter field. */
export interface FilterOptionContext {
  orgId: string;
  /** The typeahead query, when the user has typed one. */
  q?: string;
  /** Chosen values for the fields this source dependsOn (e.g. `{ repo: "acme/app" }`). */
  deps: Record<string, string>;
  /** The org's stored credential for the owning plugin's service; `null` when unconnected. */
  credential: StoredCredential | null;
}

/**
 * Lists the options for one filter-field source (`slack.users` → the workspace
 * directory). Called by the filter-options endpoint, cached per org. Returns an
 * empty list (not a throw) when it cannot resolve — a missing credential is a
 * normal, reportable outcome the picker turns into a free-text fallback.
 */
export type FilterOptionResolver = (ctx: FilterOptionContext) => Promise<FilterOption[]>;

export interface TriggerDef {
  /** e.g. "github.pull_request" */
  id: string;
  service: string;
  description: string;
  /**
   * Signature verification over the exact raw request bytes, BEFORE any
   * parsing. Return null to reject. May be async (HMAC via node/web crypto).
   */
  verify(
    req: { headers: Record<string, string>; rawBody: Uint8Array },
    secrets: Record<string, string>,
  ): VerifiedEvent | null | Promise<VerifiedEvent | null>;
  /** Normalize a verified event for the generic event pipeline. */
  toEvent(event: VerifiedEvent): NormalizedEvent;
  /** Subscribable event keys this trigger can emit, with their filterable fields. */
  catalog: EventCatalogEntry[];
}

// ─── Channel transports (v2 contract, Phase 7) ─────────────────────────────
//
// Verify-before-parse, same philosophy as TriggerDef: the host hands raw
// bytes to `verifyWebhook` (or consumes `poll()`), then feeds each
// RawChannelUpdate through `parseUpdate`. Conversation keys are a
// transport-owned codec (e.g. "telegram:dm:{chatId}") — the host treats
// them as opaque and passes them back verbatim for outbound sends.

/** One raw provider update (e.g. a Telegram Update object). Opaque to the host. */
export type RawChannelUpdate = unknown;

export interface TransportContext {
  /** Resolved org credential for the transport's service (e.g. the bot token). */
  credential: StoredCredential;
  /** Transport-specific config. Factories never read env vars. */
  config: Record<string, string>;
}

export interface ChannelSender {
  externalId: string;
  displayName?: string;
}

export interface InboundChannelMedia {
  kind: "photo" | "document" | "voice" | "audio";
  fileId: string;
  mimeType?: string;
  fileName?: string;
  fileSize?: number;
}

/** Where a sent message landed; also the correlation handle for gate edits. */
export interface SendRef {
  conversationKey: string;
  messageId: string;
}
export type GatePromptRef = SendRef;

export interface InboundChannelEvent {
  /** Dedup key, e.g. "telegram:{update_id}". */
  dispatchId: string;
  conversationKey: string;
  sender: ChannelSender;
  /**
   * `surface_opened` fires when the user opens the conversation without
   * saying anything (Slack: `app_home_opened` on the messages tab). It
   * carries no text. The host answers it with suggested prompts, so an
   * empty conversation offers a way in.
   */
  kind: "message" | "command" | "gate_callback" | "surface_opened";
  text?: string;
  /** Set when kind === "command" (e.g. /start <code>). */
  command?: { name: string; args?: string };
  media?: InboundChannelMedia[];
  /** Set when kind === "gate_callback". `ref` identifies the gate-prompt message. */
  gateCallback?: {
    actionId: string;
    callbackId: string;
    ref: GatePromptRef;
    /**
     * Advisory gate id supplied by a transport. It does not authorize a
     * callback. The host requires a recorded prompt reference and validates
     * the acting user's access before resolving the gate.
     */
    gateId?: string;
  };
  /**
   * What the user is looking at when the event fired (Slack: the entities on
   * `app_context_changed`, which the provider then injects into messages).
   * Advisory only — treat `type` as an open enum.
   */
  context?: { entities?: Array<{ type: string; value: string }> };
  /**
   * Provider-side reply anchor for the turn this message starts (Slack's
   * `thread_ts`). The streaming bridge sends it back on `startStream` so the
   * reply lands under the user's own message. Transports without threading
   * omit it.
   */
  threadTs?: string;
  raw: RawChannelUpdate;
}

/**
 * Per-assistant outbound identity. The host resolves it from the assistant
 * that owns the sending session; a transport that can brand a post (Slack:
 * `username`/`icon_url` under `chat:write.customize`) applies it. Absent —
 * or on a transport without the capability — the post keeps the bot's own
 * identity.
 */
export interface ChannelSenderIdentity {
  displayName?: string;
  avatarUrl?: string;
}

export interface OutboundChannelMessage {
  markdown: string;
  /** Assistant identity override. Absent = the bot's own identity. */
  sender?: ChannelSenderIdentity;
}

export type OutboundChannelAttachment =
  | { type: "image"; data: Uint8Array; mimeType: string; name?: string; caption?: string }
  | { type: "file"; data: Uint8Array; mimeType: string; name: string; caption?: string };

export interface ChannelGatePrompt {
  gateId: string;
  title: string;
  body?: string;
  /**
   * Labeled key parameters of the gated action, pre-digested by the host so
   * every transport renders the same facts natively (Slack: section fields;
   * Telegram: label/value lines) instead of a raw JSON dump. Values are
   * standard markdown; long values arrive already truncated. Absent when the
   * gate has no structured context — `body` then carries everything.
   */
  fields?: Array<{ label: string; value: string }>;
  actions: Array<{ id: string; label: string; style?: "primary" | "danger" }>;
  /** Assistant identity override for the prompt card. Absent = the bot's
   * own identity. Resolution edits keep the identity the card posted with. */
  sender?: ChannelSenderIdentity;
}

export interface ChannelGateResolution {
  actionId?: string;
  /** Human-readable outcome line, e.g. "✅ Approved by Conner". */
  label: string;
  /** Epoch ms of the resolution, for transports that render timestamps. */
  resolvedAtMs?: number;
}

export interface FetchedChannelMedia {
  data: Uint8Array;
  mimeType: string;
  name?: string;
}

/** An open provider-side stream. `messageId` is the provider's handle for the
 * streaming message (Slack: the `ts` returned by chat.startStream). */
export interface StreamRef {
  conversationKey: string;
  messageId: string;
  threadTs: string;
}

export interface SuggestedPrompt {
  title: string;
  message: string;
}

/**
 * Why a stream call failed, in terms the host can act on. The host must not
 * read provider error codes, so each transport maps its own vocabulary onto
 * these four kinds. Anything unmapped stays `unknown` and is treated as
 * fatal for the stream, never as retryable — retrying an unclassified error
 * forever is how a turn burns tokens into a message nobody sees.
 *
 * - `rate_limited`: back off for `retryAfterMs`, keep the text, send it later.
 * - `stream_gone`: the provider no longer owns the message. Stop appending.
 * - `stopped_by_user`: the reader pressed stop. Abort the turn as well.
 * - `unknown`: close the stream and report.
 */
export type ChannelStreamErrorKind = "rate_limited" | "stream_gone" | "stopped_by_user" | "unknown";

export class ChannelStreamError extends Error {
  constructor(
    readonly kind: ChannelStreamErrorKind,
    message: string,
    /** Only meaningful when kind === "rate_limited". */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ChannelStreamError";
  }
}

export interface ChannelTransport {
  readonly channelType: string;
  /**
   * Verify an incoming webhook and extract its raw updates. `null` = reject.
   * secrets carries host-held values (for Telegram: { webhookSecret }).
   */
  verifyWebhook(
    req: { headers: Record<string, string>; rawBody: Uint8Array },
    secrets: Record<string, string>,
  ): RawChannelUpdate[] | null;
  /** Long-poll ingress; yields until `signal` aborts. Optional per transport. */
  poll?(signal: AbortSignal): AsyncIterable<RawChannelUpdate>;
  /** Normalize one raw update. `null` = not something we handle. */
  parseUpdate(update: RawChannelUpdate): InboundChannelEvent | null;
  send(conversationKey: string, message: OutboundChannelMessage): Promise<SendRef>;
  /** Start a new message in a provider channel, without changing inbound subscriptions. */
  sendToChannel?(channelId: string, message: OutboundChannelMessage): Promise<SendRef>;
  sendMedia(conversationKey: string, attachment: OutboundChannelAttachment): Promise<SendRef>;
  sendGatePrompt(conversationKey: string, gate: ChannelGatePrompt): Promise<GatePromptRef>;
  updateGatePrompt(ref: GatePromptRef, resolution: ChannelGateResolution): Promise<void>;
  /** Download inbound media. `null` = unavailable (oversize, expired, …). */
  fetchMedia?(media: InboundChannelMedia): Promise<FetchedChannelMedia | null>;
  sendTyping?(conversationKey: string): Promise<void>;
  /** Ack an interactive callback (Telegram answerCallbackQuery). */
  answerCallback?(callbackId: string, text?: string): Promise<void>;
  /** Register the webhook endpoint with the provider (webhook mode only). */
  registerWebhook?(url: string, secretToken: string): Promise<void>;
  /**
   * Engine thread key for a conversationKey. Absent → the host default,
   * `${channelType}:${lastKeySegment}`. Slack overrides it because its
   * conversationKey carries a team id the thread key does not need.
   */
  threadKeyFromConversationKey?(conversationKey: string): string;
  /**
   * Inverse of `threadKeyFromConversationKey`, for outbound delivery: rebuild
   * the conversationKey from a stored engine thread key. `null` = not one of
   * this transport's keys. Needed whenever the round trip is lossy — Slack's
   * team id lives on the transport, not in the thread key.
   */
  conversationKeyFromThreadKey?(threadKey: string): string | null;
  /**
   * Engine thread key for a raw event payload, so a reply to a
   * channel-triggered event routes back to its conversation. `payload` is the
   * provider's inner event object (e.g. a Slack `app_mention`). Returns `null`
   * for an event with no conversation to reply into (a workspace-join, a
   * channel-lifecycle event). Consumed by the event dispatcher.
   */
  threadKeyFromEvent?(eventKey: string, payload: unknown): string | null;
  /**
   * Resolve a workspace member by email (Slack: `users.lookupByEmail`).
   * `null` = the email names nobody in the workspace — a normal outcome the
   * caller uses to fall back to another flow, never an error. Rejects with
   * `ChannelLookupError` so the caller can tell a missing bot scope (an
   * admin must act) from a transport fault. Optional: providers without a
   * directory lookup omit it.
   */
  lookupUserByEmail?(email: string): Promise<{ externalId: string; displayName: string } | null>;
  /**
   * Workspace-member typeahead (Slack: `users.list`). Backs the "find me by
   * name" identity-link fallback for users whose provider email differs from
   * their Valet email. Optional: providers without a member directory omit it.
   */
  listWorkspaceMembers?(query: string): Promise<Array<{ id: string; name: string; realName?: string }>>;
  /**
   * Prior messages in a thread as a plain attributed transcript (`Name: text`
   * per line), to hydrate an assistant's FIRST turn in that thread so it starts
   * with the whole conversation instead of the lone trigger message. `channelId`
   * and `threadTs` come from the `ChannelOrigin.threadKey`. `null` when the
   * thread is empty, unreadable, or the provider has no thread history. Optional:
   * providers without threads omit it.
   */
  fetchThreadContext?(channelId: string, threadTs: string): Promise<string | null>;
  /**
   * The thread's messages STRICTLY BETWEEN two provider timestamps, as the same
   * attributed transcript shape as `fetchThreadContext`. The follow-router uses
   * it to re-hydrate the gap between a follow's last delivered message and a
   * new one, so an overheard line after downtime carries the missed context.
   * The bot's own posts are excluded — the agent already has its own replies.
   * `null` when the window is empty or the thread is unreadable. Optional:
   * providers without thread history omit it.
   */
  fetchThreadWindow?(channelId: string, threadTs: string, afterTs: string, beforeTs: string): Promise<string | null>;
  /**
   * Normalize an inbound message into what an agent should read: the sender's
   * display name (not a raw id) and the message text with the bot's own mention
   * stripped, other mentions resolved to names, and markup collapsed. The event
   * dispatcher and follow-router stamp the result so the model never sees
   * `sender="U0AJ…"` or `<@U…>` markup. `senderName` is absent when `userId` is
   * omitted or names nobody. Optional: a transport without a directory omits it.
   */
  normalizeForAgent?(msg: { userId?: string; text: string }): Promise<{ senderName?: string; text: string }>;
  /**
   * The ts of the specific message that triggered a channel event, so a reply
   * turn can `react_to_origin` to it. Distinct from the thread key's `threadTs`,
   * which is the parent. `null` for an event with no single message. Optional.
   */
  messageTsFromEvent?(eventKey: string, payload: unknown): string | null;

  // ── Streaming egress ────────────────────────────────────────────────
  //
  // A transport that streams implements all three of start/append/stop. The
  // host calls them only when all three are present, so Telegram — which
  // posts finished messages — is unaffected. Every one of them rejects with
  // `ChannelStreamError` so the host can tell a retryable rate limit from a
  // dead stream without reading provider error codes.

  /** Open a stream. `threadTs` anchors it to the user's own message. */
  startStream?(conversationKey: string, ctx: { threadTs: string }): Promise<StreamRef>;
  /** Append markdown to an open stream. */
  appendStream?(ref: StreamRef, markdown: string): Promise<void>;
  /** Close a stream. `final` carries the last markdown and any trailing blocks. */
  stopStream?(ref: StreamRef, final?: { markdown?: string }): Promise<void>;
  /** Show a transient working indicator on a thread. */
  setStatus?(conversationKey: string, threadTs: string, status: string): Promise<void>;
  /** Offer starter prompts. `threadTs` omitted = the conversation's entry point. */
  setSuggestedPrompts?(
    conversationKey: string,
    prompts: SuggestedPrompt[],
    opts?: { threadTs?: string; title?: string },
  ): Promise<void>;
  /** Name a thread, once, after its first turn. */
  setThreadTitle?(conversationKey: string, threadTs: string, title: string): Promise<void>;
}

/** True when a transport implements the whole streaming triple. Feature-detected
 * rather than declared, so a transport cannot claim streaming it cannot finish —
 * a half-implemented triple would open streams it can never close. */
export function canStream(
  transport: ChannelTransport,
): transport is ChannelTransport &
  Required<Pick<ChannelTransport, "startStream" | "appendStream" | "stopStream">> {
  return (
    typeof transport.startStream === "function" &&
    typeof transport.appendStream === "function" &&
    typeof transport.stopStream === "function"
  );
}

export interface ChannelTransportFactory {
  channelType: string;
  /**
   * How inbound reaches the host. "registered-webhook" (the default): the
   * host mints a per-boot secret and calls `transport.registerWebhook`.
   * "external-webhook": the provider's webhook URL is app-level config the
   * operator sets, and verification uses a provider-issued secret held on the
   * credential — the host neither mints a secret nor registers anything.
   */
  ingress?: "registered-webhook" | "external-webhook";
  create(ctx: TransportContext): ChannelTransport;
}

export interface IdentityLinkDeclaration {
  /** Identity provider key in user_identity_links (e.g. "slack", "telegram"). */
  provider: string;
  /** Shown in the web UI; tells the user how to deliver the code. */
  instructions: string;
  /** Optional deep link for one-tap delivery (Telegram's t.me URL). Return
   *  null when the transport is not ready. */
  deepLink?: (ctx: { botUsername: string | null; code: string }) => string | null;
  /**
   * The anchor DM the bot sends in the "DM me" flow. It MUST NOT contain
   * the link code or any code-shaped token. The code is returned only in
   * the authenticated web response, and the user carries it into the chat
   * themselves — that trip IS the ownership proof (web session + provider
   * account). A code in the DM would collapse it to bot→user→bot, and a DM
   * sent to a picked member would become a one-reply account takeover.
   * Point the reader at the command shown in the web UI, name the expiry
   * window, and tell an unexpecting recipient to ignore the message. Keep
   * it plain prose: no backticks or angle brackets — the mrkdwn path
   * restores code spans unescaped, so a `<` inside one reaches Slack raw.
   * Meaningful only for providers whose transport implements
   * `lookupUserByEmail`; the deliver flow also needs `deliveryReply`.
   */
  deliveryDm?: string;
  /**
   * Build the exact reply the user sends back after the anchor DM (Slack:
   * `link ${code}`). Shown ONLY in the authenticated web response — never
   * sent to the provider — so embedding the code here is safe and is the
   * point: the card renders one copyable line the transport's parser
   * accepts verbatim.
   */
  deliveryReply?: (ctx: { code: string }) => string;
}

/**
 * Why `lookupUserByEmail` failed, in terms the caller can act on:
 * - `missing_scope`: the bot credential lacks a required OAuth scope. An
 *   admin can fix it, so surface the message as a 4xx.
 * - `transport`: upstream HTTP/network fault or an unclassified provider
 *   error. Not the caller's fault — surface as a 502.
 */
export type ChannelLookupErrorKind = "missing_scope" | "transport";

export class ChannelLookupError extends Error {
  constructor(
    readonly kind: ChannelLookupErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ChannelLookupError";
  }
}

export interface ValetPlugin {
  /** Plugin id, e.g. "github". Unique across loaded plugins. */
  name: string;
  version: string;
  /** Human-readable name for UI surfaces, e.g. "Grafana Cloud". Clients
   * fall back to a title-cased `name` when absent. */
  displayName?: string;
  description?: string;
  actions?: ActionPlugin[];
  triggers?: TriggerDef[];
  skills?: SkillSource[];
  roles?: RoleSpec[];
  credentials?: CredentialDeclaration[];
  transports?: ChannelTransportFactory[];
  /** Action-backed slash commands this plugin exposes. */
  commands?: CommandDef[];
  /** Installable workflow templates this plugin contributes to the gallery. */
  templates?: WorkflowTemplate[];
  /** Declares this plugin's provider supports code-based identity linking. */
  identityLink?: IdentityLinkDeclaration;
  /**
   * Declares this plugin as gateable by the org entitlement rail
   * (docs/specs/2026-08-29-plugin-entitlements-design.md). A plugin with a
   * `gate` opts into per-org admin control: off / all users / specific teams.
   * The `label` and `description` drive the admin UI. A plugin with no `gate`
   * is not org-gateable — it rides the instance (deployment) switch only.
   */
  gate?: PluginGate;
  /**
   * Provider option sources for filter fields, keyed by the `source` name a
   * catalog field's `options.source` references (`slack.users`,
   * `github.branches`). Backs the filter-options endpoint so a rule filters on
   * a looked-up name, never a raw id.
   */
  filterOptionResolvers?: Record<string, FilterOptionResolver>;
  /**
   * Hot document fields this plugin filters on at volume
   * (docs/specs/2026-08-29-plugin-store-design.md). The host ensures a
   * matching expression index on the shared `plugin_store` table at boot
   * (`(doc->>'<field>')`, scoped by plugin + collection), idempotently. Absent
   * === the table's GIN index covers general filters. `collection` and `field`
   * MUST be identifier-safe (`[a-z0-9_]+`) — the boot ensurer rejects anything
   * else rather than build an index from unsanitized text.
   */
  storeIndexes?: PluginStoreIndex[];
}

/** One declared `plugin_store` expression index (see `ValetPlugin.storeIndexes`). */
export interface PluginStoreIndex {
  collection: string;
  field: string;
}

/** UI-facing labels for a gateable plugin (see `ValetPlugin.gate`). */
export interface PluginGate {
  label: string;
  description: string;
}

export interface PluginValidationIssue {
  path: string;
  message: string;
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;
/** Identifier-safe check for a declared store index's collection/field. Matches
 * the boot ensurer's rule so a manifest that would build an unsafe index name
 * is rejected at load, not at boot. */
const STORE_IDENTIFIER_RE = /^[a-z0-9_]+$/;
const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high", "critical"];
const CREDENTIAL_TYPES = ["oauth2", "api_key", "bot_token", "service_account"] as const;

/**
 * Structural validation of an unknown value as a ValetPlugin. Hand-rolled
 * rather than a TypeBox schema because manifests carry functions (execute,
 * verify, toEvent, resolveActions), which JSON Schema cannot express.
 * Collects every issue instead of failing fast so quarantine logs are
 * actionable in one pass.
 */
export function validateValetPlugin(
  value: unknown,
): { ok: true; plugin: ValetPlugin } | { ok: false; issues: PluginValidationIssue[] } {
  const issues: PluginValidationIssue[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, issues: [{ path: "", message: "manifest must be an object" }] };
  }
  const v = value as Record<string, unknown>;

  if (typeof v.name !== "string" || !NAME_RE.test(v.name)) {
    issues.push({ path: "name", message: "required string matching /^[a-z][a-z0-9-]*$/" });
  }
  if (typeof v.version !== "string" || v.version.length === 0) {
    issues.push({ path: "version", message: "required non-empty string" });
  }
  if (v.displayName !== undefined && typeof v.displayName !== "string") {
    issues.push({ path: "displayName", message: "must be a string when present" });
  }
  if (v.description !== undefined && typeof v.description !== "string") {
    issues.push({ path: "description", message: "must be a string when present" });
  }

  checkArray(v.actions, "actions", issues, (p, path) => {
    const plugin = asRecord(p, path, issues);
    if (!plugin) return;
    if (typeof plugin.service !== "string" || plugin.service.length === 0) {
      issues.push({ path: `${path}.service`, message: "required non-empty string" });
    }
    if (plugin.resolveActions !== undefined && typeof plugin.resolveActions !== "function") {
      issues.push({ path: `${path}.resolveActions`, message: "must be a function when present" });
    }
    if (!Array.isArray(plugin.actions)) {
      issues.push({ path: `${path}.actions`, message: "required array" });
      return;
    }
    plugin.actions.forEach((a, i) => {
      const action = asRecord(a, `${path}.actions[${i}]`, issues);
      if (!action) return;
      for (const key of ["id", "name", "description"] as const) {
        if (typeof action[key] !== "string" || action[key].length === 0) {
          issues.push({ path: `${path}.actions[${i}].${key}`, message: "required non-empty string" });
        }
      }
      if (!RISK_LEVELS.includes(action.riskLevel as RiskLevel)) {
        issues.push({ path: `${path}.actions[${i}].riskLevel`, message: `must be one of ${RISK_LEVELS.join("|")}` });
      }
      if (typeof action.parameters !== "object" || action.parameters === null) {
        issues.push({ path: `${path}.actions[${i}].parameters`, message: "required schema object" });
      }
      if (typeof action.execute !== "function") {
        issues.push({ path: `${path}.actions[${i}].execute`, message: "required function" });
      }
    });
  });

  checkArray(v.triggers, "triggers", issues, (t, path) => {
    const trigger = asRecord(t, path, issues);
    if (!trigger) return;
    for (const key of ["id", "service", "description"] as const) {
      if (typeof trigger[key] !== "string" || trigger[key].length === 0) {
        issues.push({ path: `${path}.${key}`, message: "required non-empty string" });
      }
    }
    for (const key of ["verify", "toEvent"] as const) {
      if (typeof trigger[key] !== "function") {
        issues.push({ path: `${path}.${key}`, message: "required function" });
      }
    }
    if (trigger.catalog === undefined) {
      issues.push({ path: `${path}.catalog`, message: "required array" });
    } else {
      checkArray(trigger.catalog, `${path}.catalog`, issues, (entry, entryPath) => {
        const e = asRecord(entry, entryPath, issues);
        if (!e) return;
        if (typeof e.key !== "string" || e.key.length === 0) {
          issues.push({ path: `${entryPath}.key`, message: "required non-empty string" });
        }
        if (typeof e.description !== "string") {
          issues.push({ path: `${entryPath}.description`, message: "required string" });
        }
        if (!Array.isArray(e.filters)) {
          issues.push({ path: `${entryPath}.filters`, message: "required array" });
        }
      });
    }
  });

  checkArray(v.skills, "skills", issues, (s, path) => {
    const skill = asRecord(s, path, issues);
    if (!skill) return;
    if (typeof skill.name !== "string" || skill.name.length === 0) {
      issues.push({ path: `${path}.name`, message: "required non-empty string" });
    }
    if (typeof skill.content !== "string") {
      issues.push({ path: `${path}.content`, message: "required string" });
    }
  });

  checkArray(v.roles, "roles", issues, (r, path) => {
    const role = asRecord(r, path, issues);
    if (!role) return;
    if (typeof role.name !== "string" || role.name.length === 0) {
      issues.push({ path: `${path}.name`, message: "required non-empty string" });
    }
    if (typeof role.content !== "string") {
      issues.push({ path: `${path}.content`, message: "required string" });
    }
  });

  checkArray(v.credentials, "credentials", issues, (c, path) => {
    const cred = asRecord(c, path, issues);
    if (!cred) return;
    if (!CREDENTIAL_TYPES.includes(cred.type as (typeof CREDENTIAL_TYPES)[number])) {
      issues.push({ path: `${path}.type`, message: `must be one of ${CREDENTIAL_TYPES.join("|")}` });
    }
    if (!Array.isArray(cred.configKeys) || cred.configKeys.some((k) => typeof k !== "string")) {
      issues.push({ path: `${path}.configKeys`, message: "required string array" });
    }
    if (cred.service !== undefined && typeof cred.service !== "string") {
      issues.push({ path: `${path}.service`, message: "must be a string when present" });
    }
    if (cred.oauth !== undefined) {
      const oauth = asRecord(cred.oauth, `${path}.oauth`, issues);
      if (!oauth) return;
      if (cred.type !== "oauth2") {
        issues.push({ path: `${path}.oauth`, message: "only valid on type=\"oauth2\" declarations" });
        return;
      }
      if (oauth.mode === "mcp") {
        if (typeof oauth.serverUrl !== "string" || oauth.serverUrl.length === 0) {
          issues.push({ path: `${path}.oauth.serverUrl`, message: "required non-empty string" });
        }
        for (const field of ["scopesParam", "interpretTokenResponse"] as const) {
          if (oauth[field] !== undefined) {
            issues.push({ path: `${path}.oauth.${field}`, message: "only valid on authorization_code mode" });
          }
        }
      } else if (oauth.mode === "authorization_code") {
        for (const key of ["authorizationUrl", "tokenUrl", "clientIdEnv", "clientSecretEnv"] as const) {
          if (typeof oauth[key] !== "string" || oauth[key].length === 0) {
            issues.push({ path: `${path}.oauth.${key}`, message: "required non-empty string" });
          }
        }
        if (oauth.extraAuthParams !== undefined) {
          const params = asRecord(oauth.extraAuthParams, `${path}.oauth.extraAuthParams`, issues);
          if (params && Object.values(params).some((v) => typeof v !== "string")) {
            issues.push({ path: `${path}.oauth.extraAuthParams`, message: "values must be strings" });
          }
        }
        if (oauth.scopesParam !== undefined && (typeof oauth.scopesParam !== "string" || oauth.scopesParam === "")) {
          issues.push({ path: `${path}.oauth.scopesParam`, message: "must be a non-empty string when present" });
        }
        if (oauth.interpretTokenResponse !== undefined && typeof oauth.interpretTokenResponse !== "function") {
          issues.push({ path: `${path}.oauth.interpretTokenResponse`, message: "must be a function when present" });
        }
      } else {
        issues.push({ path: `${path}.oauth.mode`, message: "must be \"mcp\" or \"authorization_code\"" });
      }
    }
  });

  checkArray(v.transports, "transports", issues, (item, path) => {
    const t = item as Partial<ChannelTransportFactory>;
    if (typeof t.channelType !== "string" || t.channelType === "") {
      issues.push({ path: `${path}.channelType`, message: "must be a non-empty string" });
    }
    if (typeof t.create !== "function") {
      issues.push({ path: `${path}.create`, message: "must be a function" });
    }
  });

  checkArray(v.commands, "commands", issues, (cmd, path) => {
    const c = asRecord(cmd, path, issues);
    if (!c) return;
    if (typeof c.name !== "string" || !NAME_RE.test(c.name)) {
      issues.push({ path: `${path}.name`, message: `must match ${NAME_RE.source}` });
    } else if ((BUILTIN_COMMAND_NAMES as readonly string[]).includes(c.name)) {
      issues.push({ path: `${path}.name`, message: `"${c.name}" is a reserved built-in command name` });
    }
    if (typeof c.description !== "string" || c.description.length === 0) {
      issues.push({ path: `${path}.description`, message: "must be a non-empty string" });
    }
    if (typeof c.mapArgs !== "function") {
      issues.push({ path: `${path}.mapArgs`, message: "must be a function" });
    }
    // Collect all action ids declared in this plugin's actions array.
    const actionIds = new Set<string>(
      (Array.isArray(v.actions) ? v.actions : []).flatMap((ap) => {
        const apRecord = asRecord(ap, "", []);
        if (!apRecord || !Array.isArray(apRecord.actions)) return [];
        return apRecord.actions.map((a) => {
          const aRecord = asRecord(a, "", []);
          return typeof aRecord?.id === "string" ? aRecord.id : undefined;
        }).filter((id): id is string => id !== undefined);
      }),
    );
    if (typeof c.action !== "string" || !actionIds.has(c.action)) {
      issues.push({ path: `${path}.action`, message: "must name an action declared by this plugin" });
    }
  });

  checkArray(v.templates, "templates", issues, (tpl, path) => {
    const t = asRecord(tpl, path, issues);
    if (!t) return;
    for (const key of ["id", "name", "description", "category"] as const) {
      if (typeof t[key] !== "string" || t[key].length === 0) {
        issues.push({ path: `${path}.${key}`, message: "required non-empty string" });
      }
    }
    for (const key of ["apps", "steps"] as const) {
      if (!Array.isArray(t[key]) || t[key].some((entry) => typeof entry !== "string")) {
        issues.push({ path: `${path}.${key}`, message: "required string array" });
      }
    }
    if (t.caveats !== undefined && (!Array.isArray(t.caveats) || t.caveats.some((entry) => typeof entry !== "string"))) {
      issues.push({ path: `${path}.caveats`, message: "must be a string array when present" });
    }
    // Only the shape is checked here. The dag/v1 contract is checked by the
    // host's own definition validator, which produces messages an author can
    // act on — see the WorkflowTemplate doc comment.
    if (typeof t.definition !== "object" || t.definition === null) {
      issues.push({ path: `${path}.definition`, message: "required dag/v1 workflow definition object" });
    }
    // BEFORE the schedule branch on purpose. That branch ends its guard
    // with a bare `return`, which leaves this whole per-template callback —
    // so a check placed after it is silently skipped for every template
    // whose schedule is malformed.
    checkArray(t.events, `${path}.events`, issues, (raw, evPath) => {
      const ev = asRecord(raw, evPath, issues);
      if (!ev) return;
      for (const key of ["name", "description"] as const) {
        if (typeof ev[key] !== "string" || ev[key].length === 0) {
          issues.push({ path: `${evPath}.${key}`, message: "required non-empty string" });
        }
      }
      if (
        !Array.isArray(ev.eventKeys) ||
        ev.eventKeys.length === 0 ||
        ev.eventKeys.some((key) => typeof key !== "string" || key.length === 0)
      ) {
        issues.push({ path: `${evPath}.eventKeys`, message: "required non-empty string array" });
      }
      checkArray(ev.filters, `${evPath}.filters`, issues, (rawFilter, filterPath) => {
        const f = asRecord(rawFilter, filterPath, issues);
        if (!f) return;
        if (typeof f.field !== "string" || f.field.length === 0) {
          issues.push({ path: `${filterPath}.field`, message: "required non-empty string" });
        }
        if (typeof f.op !== "string" || !FILTER_OPS.includes(f.op)) {
          issues.push({ path: `${filterPath}.op`, message: `must be one of ${FILTER_OPS.join(", ")}` });
        }
        // Exactly one source. Both is ambiguous; neither arms a
        // subscription whose filter can never match, which is invisible
        // at run time because a filter that matches nothing simply never
        // fires.
        if ((f.value !== undefined) === (f.fromInput !== undefined)) {
          issues.push({ path: filterPath, message: 'requires exactly one of "value" or "fromInput"' });
        }
        if (f.fromInput !== undefined && (typeof f.fromInput !== "string" || f.fromInput.length === 0)) {
          issues.push({ path: `${filterPath}.fromInput`, message: "must be a non-empty string" });
        }
      });
    });
    if (t.schedule !== undefined) {
      const schedule = asRecord(t.schedule, `${path}.schedule`, issues);
      if (!schedule) return;
      for (const key of ["name", "cron", "description"] as const) {
        if (typeof schedule[key] !== "string" || schedule[key].length === 0) {
          issues.push({ path: `${path}.schedule.${key}`, message: "required non-empty string" });
        }
      }
      if (schedule.timezone !== undefined && typeof schedule.timezone !== "string") {
        issues.push({ path: `${path}.schedule.timezone`, message: "must be a string when present" });
      }
    }
  });

  if (v.identityLink !== undefined) {
    const link = asRecord(v.identityLink, "identityLink", issues);
    if (link) {
      if (typeof link.provider !== "string" || !NAME_RE.test(link.provider)) {
        issues.push({ path: "identityLink.provider", message: "required string matching /^[a-z][a-z0-9-]*$/" });
      }
      if (typeof link.instructions !== "string" || link.instructions === "") {
        issues.push({ path: "identityLink.instructions", message: "required non-empty string" });
      }
      if (link.deepLink !== undefined && typeof link.deepLink !== "function") {
        issues.push({ path: "identityLink.deepLink", message: "must be a function when present" });
      }
      if (link.deliveryDm !== undefined && (typeof link.deliveryDm !== "string" || link.deliveryDm === "")) {
        issues.push({ path: "identityLink.deliveryDm", message: "must be a non-empty string when present" });
      }
      if (link.deliveryReply !== undefined && typeof link.deliveryReply !== "function") {
        issues.push({ path: "identityLink.deliveryReply", message: "must be a function when present" });
      }
    }
  }

  if (v.gate !== undefined) {
    const gate = asRecord(v.gate, "gate", issues);
    if (gate) {
      for (const key of ["label", "description"] as const) {
        if (typeof gate[key] !== "string" || gate[key] === "") {
          issues.push({ path: `gate.${key}`, message: "required non-empty string" });
        }
      }
    }
  }

  checkArray(v.storeIndexes, "storeIndexes", issues, (idx, path) => {
    const record = asRecord(idx, path, issues);
    if (!record) return;
    for (const key of ["collection", "field"] as const) {
      if (typeof record[key] !== "string" || !STORE_IDENTIFIER_RE.test(record[key] as string)) {
        issues.push({ path: `${path}.${key}`, message: "required identifier-safe string matching /^[a-z0-9_]+$/" });
      }
    }
  });

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, plugin: value as ValetPlugin };
}

/** Filter operators a template event trigger may use. Mirrors the host's
 * own `FILTER_OPS` (`api/src/routes/events.ts`), which is the list the
 * ingest matcher actually implements. */
const FILTER_OPS: readonly string[] = ["eq", "in", "prefix", "contains"];

function checkArray(
  value: unknown,
  field: string,
  issues: PluginValidationIssue[],
  each: (item: unknown, path: string) => void,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push({ path: field, message: "must be an array when present" });
    return;
  }
  value.forEach((item, i) => each(item, `${field}[${i}]`));
}

function asRecord(
  value: unknown,
  path: string,
  issues: PluginValidationIssue[],
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    issues.push({ path, message: "must be an object" });
    return null;
  }
  return value as Record<string, unknown>;
}

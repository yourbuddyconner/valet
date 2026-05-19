# Slack Data Enrichment & Image Support

**Date:** 2026-05-01
**Status:** Draft

## Problem

When the agent reads Slack via `read_history` and `read_thread`, it gets a minimal view of messages: text, timestamps, user IDs (now resolved to display names), and thread metadata. Several categories of useful information are either dropped or unavailable:

1. **Files/images are invisible.** `slimMessage` strips the `files` array entirely. The thread context builder notes `[file: name.ext]` but doesn't provide content or metadata. Multiple users have flagged image support as a blocker — the agent can't read images in linked Slack threads, only in DM attachments.

2. **Reactions are dropped.** Reactions signal consensus, acknowledgment, and importance. The agent has no way to see that a message got 5 thumbsup (important) vs being ignored.

3. **Noise pollutes history.** Channel join/leave messages, topic changes, and bot housekeeping clutter `read_history` results. The agent wastes context parsing messages that aren't conversation.

4. **No way to inspect specific signals.** The agent can't fetch pinned messages (curated important items), detailed channel metadata (topic, purpose, who created it), or who specifically reacted to a message.

5. **No generic image path for actions.** The `screenshot` protocol message exists but is named narrowly and only used by sandbox tools. Actions (which run in the worker) have no way to return images that reach the agent's vision context.

## Design

### 1. Enriched Message Data

#### File metadata in `slimMessage`

Slack messages carry a `files` array. `slimMessage` currently drops it. We add an optional `files` field that surfaces metadata the agent can act on:

```typescript
function slimMessage(msg: Record<string, unknown>): Record<string, unknown> {
  // ... existing fields ...
  const files = Array.isArray(msg.files)
    ? (msg.files as Record<string, unknown>[])
        .filter((f) => !f.mode || f.mode !== 'tombstone') // skip deleted files
        .map((f) => ({
          name: f.name,
          mimetype: f.mimetype,
          size: f.size,
          url: f.url_private,
          filetype: f.filetype,
        }))
    : undefined;

  return {
    // ... existing fields ...
    files: files && files.length > 0 ? files : undefined,
  };
}
```

The `url` field is `url_private` — requires the bot token to fetch, which `slack.fetch_file` handles (see section 3).

Example output:
```json
{
  "user": "U123",
  "user_display": "@conner <Conner Swann> (U123)",
  "text": "here's the mockup",
  "ts": "1714500000.000100",
  "files": [
    { "name": "mockup.png", "mimetype": "image/png", "size": 245000, "url": "https://files.slack.com/...", "filetype": "png" }
  ]
}
```

Only included when files exist. No change to messages without files.

#### Reactions

Slack messages carry a `reactions` array when reactions exist. We include reaction names and counts (but not the per-reaction user list — that's what `get_reactions` is for):

```typescript
const reactions = Array.isArray(msg.reactions)
  ? (msg.reactions as Record<string, unknown>[]).map((r) => ({
      name: r.name,
      count: r.count,
    }))
  : undefined;
```

Example output:
```json
{
  "reactions": [
    { "name": "thumbsup", "count": 5 },
    { "name": "eyes", "count": 2 }
  ]
}
```

#### Message subtype filtering

`read_history` gets a new optional `include_subtypes` boolean parameter (default `false`). When false, messages with housekeeping subtypes are filtered out:

Filtered subtypes: `channel_join`, `channel_leave`, `channel_topic`, `channel_purpose`, `channel_name`, `bot_add`, `bot_remove`, `channel_archive`, `channel_unarchive`.

```typescript
const NOISE_SUBTYPES = new Set([
  'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose',
  'channel_name', 'bot_add', 'bot_remove', 'channel_archive', 'channel_unarchive',
]);

// In read_history handler, after slimming:
if (!p.include_subtypes) {
  messages = messages.filter((m) => {
    const subtype = m.subtype as string | undefined;
    return !subtype || !NOISE_SUBTYPES.has(subtype);
  });
}
```

This requires `slimMessage` to also pass through `msg.subtype` (as an optional field, omitted when undefined). The subtype is included in the output so the agent can see message types when `include_subtypes` is true, and so the filter logic can check it before enrichment:

```typescript
subtype: msg.subtype || undefined,
```

The `include_subtypes` param definition:
```typescript
include_subtypes: z.boolean().optional().describe(
  'When true, include system messages (joins, topic changes, etc.). Default false — only human/bot conversation.'
),
```

### 2. Generic Image Path for Actions

#### Rename `screenshot` → `image` in the protocol

The existing `screenshot` message type in the Runner protocol is the proven path for injecting images into the agent's vision context. We rename it to reflect its general purpose:

**`packages/shared/src/types/runner-protocol.ts`:**
```typescript
// Before:
| { type: 'screenshot'; messageId?: string; data: string; description: string }
// After:
| { type: 'image'; messageId?: string; data: string; mimeType: string; description: string }
```

Add `mimeType` to the message so consumers don't have to guess the format.

**`packages/runner/src/agent-client.ts`:**
```typescript
// Before:
sendScreenshot(messageId, data, description)
// After:
sendImage(messageId, data, mimeType, description)
```

**`packages/runner/src/gateway.ts`:**

The `/api/image` endpoint already exists and is correctly named. Update the callback signature to include `mimeType`:
```typescript
onImage: (data: string, mimeType: string, description: string) => void
```

**`packages/runner/src/bin.ts`:**
```typescript
onImage: (data, mimeType, description) => {
  const messageId = promptHandler?.getActiveMessageId();
  agentClient.sendImage(messageId, data, mimeType, description);
}
```

**Existing consumers updated:** `browser_screenshot.ts` and `send_image.ts` already POST to `/api/image` — they just need to pass `mimeType` (which they already have).

**DO handler:** The SessionAgent DO handler that processes `screenshot` messages updates to handle `image` type instead. Backward-compat: accept both types during rollout.

#### `images` field on `ActionResult`

Any action can attach images to its result. The Runner routes them through the image path automatically.

**`packages/sdk/src/integrations/index.ts`:**
```typescript
export interface ActionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  /** Images to inject into the agent's vision context. */
  images?: Array<{ data: string; mimeType: string; description: string }>;
}
```

**Runner action result handling:**

When the Runner receives an action result containing `images`, it calls `sendImage` for each entry before passing the text result to the agent. The `data` field in the action result is still returned as normal (so the agent gets the text description), but the images are routed out-of-band to the vision context.

```typescript
// In the Runner's action result handler:
if (result.images?.length) {
  for (const img of result.images) {
    agentClient.sendImage(messageId, img.data, img.mimeType, img.description);
  }
}
```

### 3. New Slack Actions

All new actions go in `packages/plugin-slack/src/actions/actions.ts`, added to the `allActions` array, with cases in `executeAction`.

#### `slack.fetch_file`

Downloads a file from Slack using the bot token and returns it. For images, attaches to the `images` array on the result so the agent can see it.

```typescript
const fetchFile: ActionDefinition = {
  id: 'slack.fetch_file',
  name: 'Fetch File',
  description: 'Download a file from Slack. For images, the content is returned visually. For text files, the content is returned as text. Use the url from the files array in message data.',
  riskLevel: 'low',
  params: z.object({
    url: z.string().describe('Slack file URL (from the files array in message data)'),
  }),
};
```

Execution:
1. Validate URL is `files.slack.com` domain — reject arbitrary URLs.
2. Fetch with `Authorization: Bearer <bot_token>`.
3. Check `Content-Type` response header.
4. **Images** (`image/*`): base64 encode, return in `images` array with description from filename. Size guard: reject files over 10MB.
5. **Text** (`text/*`, `application/json`, etc.): return content as text in `data`.
6. **Other**: return metadata only (name, size, mimetype) with a note that the content type isn't viewable.

#### `slack.get_pins`

Fetches pinned items for a channel.

```typescript
const getPins: ActionDefinition = {
  id: 'slack.get_pins',
  name: 'Get Pins',
  description: 'Get pinned messages in a channel. Returns messages in the same format as read_history. Useful for understanding what a channel considers important.',
  riskLevel: 'low',
  params: z.object({
    channel: z.string().describe('Channel ID (C...)'),
  }),
};
```

Execution:
1. Private channel guard.
2. Call `pins.list` with the channel ID.
3. Extract messages from pin items (pins contain the full message object).
4. Run through `slimMessage` + `resolveAndEnrichMessages` for consistent formatting.
5. Return `{ pins: SlimMessage[] }`.

#### `slack.get_channel_info`

Fetches detailed channel metadata.

```typescript
const getChannelInfo: ActionDefinition = {
  id: 'slack.get_channel_info',
  name: 'Get Channel Info',
  description: 'Get detailed information about a channel: topic, purpose, member count, creation date, creator. Useful when reading a channel for the first time.',
  riskLevel: 'low',
  params: z.object({
    channel: z.string().describe('Channel ID (C...)'),
  }),
};
```

Execution:
1. Private channel guard.
2. Call `conversations.info` with the channel ID.
3. Resolve the `creator` user ID through the user cache.
4. Return `{ id, name, is_private, topic, purpose, num_members, created, is_archived, creator_display }`.

#### `slack.get_reactions`

Fetches reactions for a specific message with resolved user names.

```typescript
const getReactions: ActionDefinition = {
  id: 'slack.get_reactions',
  name: 'Get Reactions',
  description: 'Get reactions on a specific message with the list of who reacted. Use when you need to know who agreed/acknowledged, not just the count.',
  riskLevel: 'low',
  params: z.object({
    channel: z.string().describe('Channel ID (C...)'),
    timestamp: z.string().describe('Message timestamp'),
  }),
};
```

Execution:
1. Private channel guard.
2. Call `reactions.get` with channel and timestamp.
3. Collect all user IDs from all reaction `users` arrays.
4. Resolve through user cache.
5. Return `{ reactions: [{ name, count, users: ["@handle <Name> (UID)", ...] }] }`.

### 4. Slack Skill

New skill file: `packages/plugin-slack/skills/slack-tools.md`

Teaches the agent how to use the full Slack toolkit. This is guidance on *when* and *why*, not a reference manual.

**Contents:**

- **Reading channels:** Use `list_channels` to find IDs, `read_history` to read. Use `filter` and `threads_only` params to cut noise. Subtype filtering is on by default — system messages are already hidden.
- **Understanding context signals:** Reactions on messages indicate consensus and attention. Pins are channel-curated important items. Check both when trying to understand what matters in a channel.
- **Thread workflow:** `read_history` shows thread parents with `reply_count`. Use `read_thread` to go deeper on threads that matter. Don't read every thread — use reply count and reactions to prioritize which are worth expanding.
- **Image/file workflow:** Messages include a `files` array with metadata (name, mimetype, size, URL). Use `slack.fetch_file` to view images when visual understanding matters (mockups, screenshots, diagrams, error screenshots). Don't fetch every image — read the filename and surrounding message context first to decide if viewing the image is necessary.
- **Channel research:** First time reading a channel, use `get_channel_info` for topic/purpose and `get_pins` for curated important items. Save what you learn to memory (channel purpose, norms, key pins) so you don't re-fetch next time. Only re-check if the channel seems to have shifted purpose or you're getting unexpected content.
- **People:** `user_display` and `bot_display` fields identify who said what. Use `list_users` with `filter` when you need a Slack user ID by name, handle, or email; it paginates through the workspace and includes deactivated human users with `deleted: true`. Use `get_reactions` when you need to know who specifically agreed or acknowledged something, not just the count.
- **Private channels:** Access is scoped to channels the session owner is a member of. If access is denied, tell the user rather than guessing at content.
- **Pagination:** Large channels require paging via `cursor`/`next_cursor`. Use `oldest`/`latest` to narrow time windows instead of paging through everything.

### 5. Plugin Registration

After adding the new actions and skill:
- Add new action definitions to the `allActions` array.
- Add `skills/slack-tools.md` to the plugin directory.
- Run `make generate-registries` to update the content registry with the new skill.
- The skill is delivered to sandboxes via the Runner WebSocket (existing content plugin mechanism).

## What This Does NOT Cover

- **Slack search** (`search.messages`) — requires user-level OAuth tokens, which is a separate project.
- **Thread summaries** — expensive (API call per threaded message) and the agent can already `read_thread` selectively.
- **Video/audio file content** — `fetch_file` handles images and text; other media types return metadata only.
- **Outbound file uploads** — agent sending files to Slack (separate feature).
- **Caching beyond module-level Maps** — centralized caching (KV, D1) for entity resolution is a future optimization.

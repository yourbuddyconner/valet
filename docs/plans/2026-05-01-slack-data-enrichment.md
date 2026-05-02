# Slack Data Enrichment & Image Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Slack data richer and more understandable for the agent by surfacing files, reactions, and subtype filtering in messages; building a generic action→agent image pipeline; adding new inspection actions (pins, channel info, reactions, file fetch); and writing a Slack skill.

**Architecture:** Message enrichment happens in `slimMessage` (new fields) and `read_history` (subtype filter). The image pipeline renames the existing `screenshot` protocol to `image`, adds an `images` field to `ActionResult`, and teaches the Runner to extract and route images from action results. New actions follow the existing pattern in `actions.ts`. The skill is a content plugin file delivered to sandboxes.

**Tech Stack:** TypeScript, Slack Web API, Hono, Vitest

**Spec:** `docs/specs/2026-05-01-slack-data-enrichment-design.md`

---

### Task 1: Enrich `slimMessage` with files, reactions, and subtype

**Files:**
- Modify: `packages/plugin-slack/src/actions/actions.ts:252-268` (slimMessage function)

- [ ] **Step 1: Add files, reactions, and subtype to slimMessage**

Replace the `slimMessage` function:

```typescript
function slimMessage(msg: Record<string, unknown>): Record<string, unknown> {
  const reply_count = typeof msg.reply_count === 'number' ? msg.reply_count : undefined;

  // Extract file metadata (skip deleted/tombstone files)
  const rawFiles = Array.isArray(msg.files) ? (msg.files as Record<string, unknown>[]) : [];
  const files = rawFiles
    .filter((f) => f.mode !== 'tombstone')
    .map((f) => ({
      name: f.name,
      mimetype: f.mimetype,
      size: f.size,
      url: f.url_private,
      filetype: f.filetype,
    }));

  // Extract reaction summary (names + counts only — get_reactions has full user lists)
  const rawReactions = Array.isArray(msg.reactions) ? (msg.reactions as Record<string, unknown>[]) : [];
  const reactions = rawReactions.map((r) => ({
    name: r.name,
    count: r.count,
  }));

  return {
    user: msg.user,
    bot_id: msg.bot_id || undefined,
    subtype: msg.subtype || undefined,
    text: msg.text,
    ts: msg.ts,
    thread_ts: msg.thread_ts || undefined,
    reply_count,
    reply_users_count: reply_count !== undefined
      ? (typeof msg.reply_users_count === 'number' ? msg.reply_users_count : undefined)
      : undefined,
    files: files.length > 0 ? files : undefined,
    reactions: reactions.length > 0 ? reactions : undefined,
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @valet/plugin-slack exec tsc --noEmit`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add packages/plugin-slack/src/actions/actions.ts
git commit -m "feat(plugin-slack): surface files, reactions, and subtype in slimMessage"
```

---

### Task 2: Add subtype filtering to `read_history`

**Files:**
- Modify: `packages/plugin-slack/src/actions/actions.ts:68-81` (readHistory definition)
- Modify: `packages/plugin-slack/src/actions/actions.ts:399-431` (read_history case)

- [ ] **Step 1: Add the noise subtypes constant and the param**

Add the constant after the `allActions` array (before the entity resolution section):

```typescript
const NOISE_SUBTYPES = new Set([
  'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose',
  'channel_name', 'bot_add', 'bot_remove', 'channel_archive', 'channel_unarchive',
]);
```

Add `include_subtypes` to `readHistory.params`:

```typescript
include_subtypes: z.boolean().optional().describe(
  'When true, include system messages (joins, topic changes, etc.). Default false — only human/bot conversation.'
),
```

- [ ] **Step 2: Add the filter logic in the read_history case**

After the `threads_only` filter block and before `resolveAndEnrichMessages`, add:

```typescript
if (!p.include_subtypes) {
  messages = messages.filter((m) => {
    const subtype = m.subtype as string | undefined;
    return !subtype || !NOISE_SUBTYPES.has(subtype);
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @valet/plugin-slack exec tsc --noEmit`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add packages/plugin-slack/src/actions/actions.ts
git commit -m "feat(plugin-slack): filter noise subtypes from read_history by default"
```

---

### Task 3: Rename `screenshot` → `image` in the Runner protocol

**Files:**
- Modify: `packages/shared/src/types/runner-protocol.ts:330`
- Modify: `packages/runner/src/agent-client.ts:278-280`
- Modify: `packages/runner/src/gateway.ts:596,691-708`
- Modify: `packages/runner/src/bin.ts:196-204`
- Modify: `docker/opencode/tools/browser_screenshot.ts:42-50`
- Modify: `docker/opencode/tools/send_image.ts:99-107,133-141`
- Modify: `packages/worker/src/durable-objects/session-agent.ts:2201-2236`

- [ ] **Step 1: Update the protocol type**

In `packages/shared/src/types/runner-protocol.ts`, replace the screenshot union variant (line 330):

```typescript
| { type: 'image'; messageId?: string; data: string; mimeType: string; description: string }
```

Also grep for any other references to the `screenshot` type string in this file and update them.

- [ ] **Step 2: Update agent-client.ts**

Replace `sendScreenshot` method (lines 278-280):

```typescript
sendImage(messageId: string | undefined, data: string, mimeType: string, description: string): void {
  this.send({ type: "image", messageId, data, mimeType, description });
}
```

- [ ] **Step 3: Update gateway.ts callback type**

Replace the `onImage` callback type in the `GatewayCallbacks` interface (line 596):

```typescript
onImage?: (data: string, mimeType: string, description: string) => void;
```

Update the `/api/image` handler (lines 691-708) to pass `mimeType`:

```typescript
app.post("/api/image", async (c) => {
  if (!callbacks.onImage) {
    return c.json({ error: "Image handler not configured" }, 500);
  }

  try {
    const body = await c.req.json() as { data: string; description?: string; mimeType?: string };
    if (!body.data) {
      return c.json({ error: "Missing 'data' field" }, 400);
    }

    callbacks.onImage(body.data, body.mimeType || "image/png", body.description || "Image");
    return c.json({ ok: true });
  } catch (err) {
    console.error("[Gateway] Image upload error:", err);
    return c.json({ error: "Invalid request body" }, 400);
  }
});
```

- [ ] **Step 4: Update bin.ts callback wiring**

Replace the `onImage` callback (lines 196-204):

```typescript
onImage: (data, mimeType, description) => {
  const messageId = promptHandler?.getActiveMessageId();
  if (!messageId) {
    console.warn('[Runner] image dropped — no active prompt messageId');
    return;
  }
  agentClient.sendImage(messageId, data, mimeType, description);
},
```

- [ ] **Step 5: Update sandbox tools**

In `docker/opencode/tools/browser_screenshot.ts`, update the fetch body to pass `mimeType` (it already does — just verify it sends `mimeType: "image/png"`). No change needed if it already includes `mimeType` in the POST body.

In `docker/opencode/tools/send_image.ts`, verify both fetch calls include `mimeType` in the POST body. They already do — no change needed.

- [ ] **Step 6: Update DO screenshot handler**

In `packages/worker/src/durable-objects/session-agent.ts`, find the `'screenshot'` handler (lines 2201-2236). Add an `'image'` handler that does the same thing, and keep the `'screenshot'` handler as a backward-compat alias:

```typescript
'image': (msg) => {
  if (!msg.messageId) {
    dropEmission('no_message_id', { eventType: 'image' });
    return;
  }
  const imgCh = this.getChannelForMessage(msg.messageId);
  if (!imgCh) {
    dropEmission('no_prompt_row', { eventType: 'image', messageId: msg.messageId });
    return;
  }

  const imgId = crypto.randomUUID();
  this.messageStore.writeMessage({
    id: imgId,
    role: 'system',
    content: msg.description || 'Image',
    parts: JSON.stringify({ type: 'image', data: msg.data, mimeType: msg.mimeType }),
    channelType: imgCh.channelType,
    channelId: imgCh.channelId,
  });

  this.broadcastToClients({
    type: 'message',
    data: {
      id: imgId,
      role: 'system',
      content: msg.description || 'Image',
      parts: { type: 'image', data: msg.data, mimeType: msg.mimeType },
      createdAt: Math.floor(Date.now() / 1000),
      channelType: imgCh.channelType,
      channelId: imgCh.channelId,
    },
  });
},
// Backward compat — old runners still send 'screenshot'
'screenshot': (msg) => {
  handlers['image']({ ...msg, mimeType: (msg as Record<string, unknown>).mimeType as string || 'image/png' });
},
```

Note: The exact structure of the handler map may differ — read the surrounding code to match the pattern used by other handlers. The key change is adding `'image'` as the primary handler and making `'screenshot'` delegate to it.

- [ ] **Step 7: Typecheck all affected packages**

Run: `pnpm typecheck`
Expected: clean across all packages

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/types/runner-protocol.ts packages/runner/src/agent-client.ts packages/runner/src/gateway.ts packages/runner/src/bin.ts packages/worker/src/durable-objects/session-agent.ts docker/opencode/tools/browser_screenshot.ts docker/opencode/tools/send_image.ts
git commit -m "refactor: rename screenshot protocol to generic image, add mimeType field"
```

---

### Task 4: Add `images` field to `ActionResult`

**Files:**
- Modify: `packages/sdk/src/integrations/index.ts:54-58`

- [ ] **Step 1: Add images field to ActionResult interface**

In `packages/sdk/src/integrations/index.ts`, update the `ActionResult` interface:

```typescript
export interface ActionResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  /** Images to inject into the agent's vision context via the image protocol. */
  images?: Array<{ data: string; mimeType: string; description: string }>;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: clean — the new field is optional so no consumers break

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/integrations/index.ts
git commit -m "feat(sdk): add images field to ActionResult for generic action→agent image pipeline"
```

---

### Task 5: Runner image extraction from action results

**Files:**
- Modify: `packages/runner/src/prompt.ts:3774-3778`

- [ ] **Step 1: Add image extraction before sendToolUpdate**

In `packages/runner/src/prompt.ts`, find the `handleToolPart` method's completed branch (lines 3774-3778). Replace:

```typescript
} else if (currentStatus === "completed") {
  const toolResult = state.output ?? null;
  console.log(`[PromptHandler] Tool "${toolName}" completed (output: ${typeof toolResult === "string" ? toolResult.length + " chars" : "null"})`);

  this.agentClient.sendToolUpdate(channel.turnId!, callID, toolName, "completed", state.input ?? undefined, toolResult ?? undefined);
```

With:

```typescript
} else if (currentStatus === "completed") {
  const toolResult = state.output ?? null;
  console.log(`[PromptHandler] Tool "${toolName}" completed (output: ${typeof toolResult === "string" ? toolResult.length + " chars" : "null"})`);

  // Extract images from action results and route to agent vision context
  if (toolResult && typeof toolResult === 'object' && !Array.isArray(toolResult)) {
    const result = toolResult as Record<string, unknown>;
    if (Array.isArray(result.images) && result.images.length > 0) {
      const messageId = this.getActiveMessageId();
      for (const img of result.images as Array<{ data: string; mimeType: string; description: string }>) {
        if (img.data && img.mimeType) {
          this.agentClient.sendImage(messageId, img.data, img.mimeType, img.description || 'Image');
        }
      }
      // Strip base64 data from the tool result so it doesn't bloat the text output
      result.images = (result.images as Array<Record<string, unknown>>).map((img) => ({
        description: img.description,
        mimeType: img.mimeType,
        sent_to_vision: true,
      }));
    }
  }

  this.agentClient.sendToolUpdate(channel.turnId!, callID, toolName, "completed", state.input ?? undefined, toolResult ?? undefined);
```

This does three things:
1. Checks if the tool result has an `images` array
2. Sends each image to the agent via `sendImage`
3. Strips the base64 `data` from images in the tool result (replaces with `sent_to_vision: true` marker) so the full base64 doesn't appear in the text output

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter runner exec tsc --noEmit`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add packages/runner/src/prompt.ts
git commit -m "feat(runner): extract images from action results and route to agent vision"
```

---

### Task 6: New action `slack.fetch_file`

**Files:**
- Modify: `packages/plugin-slack/src/actions/actions.ts` (add definition + execution case)

- [ ] **Step 1: Add the action definition**

Add after the `listUsers` definition (before `allActions`):

```typescript
const fetchFile: ActionDefinition = {
  id: 'slack.fetch_file',
  name: 'Fetch File',
  description: 'Download a file from Slack. For images, the content is returned visually so you can see it. For text files, the content is returned as text. Use the url from the files array in message data.',
  riskLevel: 'low',
  params: z.object({
    url: z.string().describe('Slack file URL (from the files array in message data)'),
  }),
};
```

Add `fetchFile` to the `allActions` array.

- [ ] **Step 2: Add the execution case**

Add before the `default:` case in `executeAction`:

```typescript
case 'slack.fetch_file': {
  const p = fetchFile.params.parse(params);

  // Only allow files.slack.com URLs
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(p.url);
  } catch {
    return { success: false, error: 'Invalid URL' };
  }
  if (!parsedUrl.hostname.endsWith('.slack.com')) {
    return { success: false, error: 'URL must be a files.slack.com URL from the files array in message data' };
  }

  const res = await fetch(p.url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    return { success: false, error: `Failed to fetch file: ${res.status} ${res.statusText}` };
  }

  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const contentLength = parseInt(res.headers.get('content-length') || '0', 10);

  // Image files — return via the images pipeline so the agent can see them
  if (contentType.startsWith('image/')) {
    if (contentLength > 10 * 1024 * 1024) {
      return { success: false, error: `Image too large (${Math.round(contentLength / 1024 / 1024)}MB). Max 10MB.` };
    }
    const buf = await res.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    // Extract filename from URL path for the description
    const filename = parsedUrl.pathname.split('/').pop() || 'image';
    return {
      success: true,
      data: { filename, mimetype: contentType, size: buf.byteLength },
      images: [{ data: base64, mimeType: contentType, description: filename }],
    };
  }

  // Text files — return content directly
  if (contentType.startsWith('text/') || contentType === 'application/json' || contentType === 'application/xml') {
    if (contentLength > 1 * 1024 * 1024) {
      return { success: false, error: `File too large for text extraction (${Math.round(contentLength / 1024)}KB). Max 1MB.` };
    }
    const text = await res.text();
    return { success: true, data: { content: text, mimetype: contentType } };
  }

  // Other file types — return metadata only
  return {
    success: true,
    data: {
      mimetype: contentType,
      size: contentLength,
      note: 'File type is not viewable. Only images and text files can be fetched.',
    },
  };
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @valet/plugin-slack exec tsc --noEmit`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add packages/plugin-slack/src/actions/actions.ts
git commit -m "feat(plugin-slack): add slack.fetch_file action for downloading files and viewing images"
```

---

### Task 7: New action `slack.get_pins`

**Files:**
- Modify: `packages/plugin-slack/src/actions/actions.ts` (add definition + execution case)

- [ ] **Step 1: Add the action definition**

Add after `fetchFile` definition:

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

Add `getPins` to the `allActions` array.

- [ ] **Step 2: Add the execution case**

Add before the `default:` case:

```typescript
case 'slack.get_pins': {
  const p = getPins.params.parse(params);
  const denied = await guardPrivateChannel(token, p.channel, ctx);
  if (denied) return denied;

  const res = await slackGet('pins.list', token, { channel: p.channel });
  if (!res.ok) return slackError(res);
  const data = (await res.json()) as { ok: boolean; error?: string; items?: unknown[] };
  if (!data.ok) return slackError(res, data);

  // pins.list returns items with a message object inside
  const rawMessages = (data.items || [])
    .map((item) => (item as Record<string, unknown>).message as Record<string, unknown> | undefined)
    .filter((msg): msg is Record<string, unknown> => msg !== undefined);

  const pins = await resolveAndEnrichMessages(
    token,
    rawMessages.map((m) => slimMessage(m)),
  );

  return { success: true, data: { total: pins.length, pins } };
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @valet/plugin-slack exec tsc --noEmit`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add packages/plugin-slack/src/actions/actions.ts
git commit -m "feat(plugin-slack): add slack.get_pins action"
```

---

### Task 8: New action `slack.get_channel_info`

**Files:**
- Modify: `packages/plugin-slack/src/actions/actions.ts` (add definition + execution case)

- [ ] **Step 1: Add the action definition**

Add after `getPins` definition:

```typescript
const getChannelInfo: ActionDefinition = {
  id: 'slack.get_channel_info',
  name: 'Get Channel Info',
  description: 'Get detailed information about a channel: topic, purpose, member count, creation date, creator. Useful when reading a channel for the first time — save the context to memory so you do not re-fetch.',
  riskLevel: 'low',
  params: z.object({
    channel: z.string().describe('Channel ID (C...)'),
  }),
};
```

Add `getChannelInfo` to the `allActions` array.

- [ ] **Step 2: Add the execution case**

Add before the `default:` case:

```typescript
case 'slack.get_channel_info': {
  const p = getChannelInfo.params.parse(params);
  const denied = await guardPrivateChannel(token, p.channel, ctx);
  if (denied) return denied;

  const res = await slackGet('conversations.info', token, { channel: p.channel });
  if (!res.ok) return slackError(res);
  const data = (await res.json()) as { ok: boolean; error?: string; channel?: Record<string, unknown> };
  if (!data.ok) return slackError(res, data);
  const ch = data.channel;
  if (!ch) return { success: false, error: 'Channel not found' };

  const topic = (ch.topic || {}) as Record<string, unknown>;
  const purpose = (ch.purpose || {}) as Record<string, unknown>;

  // Resolve creator through user cache
  let creatorDisplay: string | undefined;
  if (typeof ch.creator === 'string') {
    if (!userCache.has(ch.creator as string)) {
      try {
        const userRes = await slackGet('users.info', token, { user: ch.creator });
        if (userRes.ok) {
          const userData = (await userRes.json()) as { ok: boolean; user?: Record<string, unknown> };
          if (userData.ok && userData.user) {
            userCache.set(ch.creator as string, formatUserDisplay(ch.creator as string, userData.user));
          }
        }
      } catch { /* leave unresolved */ }
    }
    creatorDisplay = userCache.get(ch.creator as string) || (ch.creator as string);
  }

  return {
    success: true,
    data: {
      id: ch.id,
      name: ch.name,
      is_private: ch.is_private || false,
      is_archived: ch.is_archived || false,
      topic: topic.value || undefined,
      purpose: purpose.value || undefined,
      num_members: ch.num_members,
      created: ch.created,
      creator: creatorDisplay,
    },
  };
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @valet/plugin-slack exec tsc --noEmit`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add packages/plugin-slack/src/actions/actions.ts
git commit -m "feat(plugin-slack): add slack.get_channel_info action"
```

---

### Task 9: New action `slack.get_reactions`

**Files:**
- Modify: `packages/plugin-slack/src/actions/actions.ts` (add definition + execution case)

- [ ] **Step 1: Add the action definition**

Add after `getChannelInfo` definition:

```typescript
const getReactions: ActionDefinition = {
  id: 'slack.get_reactions',
  name: 'Get Reactions',
  description: 'Get reactions on a specific message with the list of who reacted. Use when you need to know who agreed/acknowledged, not just the count from read_history.',
  riskLevel: 'low',
  params: z.object({
    channel: z.string().describe('Channel ID (C...)'),
    timestamp: z.string().describe('Message timestamp'),
  }),
};
```

Add `getReactions` to the `allActions` array.

- [ ] **Step 2: Add the execution case**

Add before the `default:` case:

```typescript
case 'slack.get_reactions': {
  const p = getReactions.params.parse(params);
  const denied = await guardPrivateChannel(token, p.channel, ctx);
  if (denied) return denied;

  const res = await slackGet('reactions.get', token, {
    channel: p.channel,
    timestamp: p.timestamp,
    full: true,
  });
  if (!res.ok) return slackError(res);
  const data = (await res.json()) as { ok: boolean; error?: string; message?: Record<string, unknown> };
  if (!data.ok) return slackError(res, data);
  const msg = data.message;
  if (!msg) return { success: false, error: 'Message not found' };

  const rawReactions = Array.isArray(msg.reactions) ? (msg.reactions as Record<string, unknown>[]) : [];
  if (rawReactions.length === 0) {
    return { success: true, data: { reactions: [] } };
  }

  // Collect all user IDs across all reactions for batch resolution
  const allUserIds = new Set<string>();
  for (const r of rawReactions) {
    if (Array.isArray(r.users)) {
      for (const uid of r.users as string[]) allUserIds.add(uid);
    }
  }

  // Resolve uncached users
  const uncached = [...allUserIds].filter((uid) => !userCache.has(uid));
  if (uncached.length > 0) {
    await Promise.all(
      uncached.map(async (uid) => {
        try {
          const userRes = await slackGet('users.info', token, { user: uid });
          if (!userRes.ok) return;
          const userData = (await userRes.json()) as { ok: boolean; user?: Record<string, unknown> };
          if (userData.ok && userData.user) userCache.set(uid, formatUserDisplay(uid, userData.user));
        } catch { /* leave unresolved */ }
      }),
    );
  }

  const reactions = rawReactions.map((r) => ({
    name: r.name,
    count: r.count,
    users: (Array.isArray(r.users) ? (r.users as string[]) : []).map(
      (uid) => userCache.get(uid) || uid,
    ),
  }));

  return { success: true, data: { reactions } };
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @valet/plugin-slack exec tsc --noEmit`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add packages/plugin-slack/src/actions/actions.ts
git commit -m "feat(plugin-slack): add slack.get_reactions action with resolved user names"
```

---

### Task 10: Create the Slack skill

**Files:**
- Create: `packages/plugin-slack/skills/slack-tools.md`

- [ ] **Step 1: Create the skills directory and skill file**

```bash
mkdir -p packages/plugin-slack/skills
```

Create `packages/plugin-slack/skills/slack-tools.md`:

```markdown
---
name: slack-tools
description: How to effectively use Slack tools to read, understand, and interact with Slack channels and threads
---

# Using Slack Tools

## Reading Channels

Use `slack.list_channels` to find channel IDs. Use `slack.read_history` to read messages. Key parameters:

- **`filter`** — case-insensitive keyword filter, useful for finding specific topics in noisy channels
- **`threads_only`** — only return messages with thread replies, good for finding discussions in alert channels
- **`oldest` / `latest`** — narrow to a time window instead of paging through everything
- System messages (joins, topic changes) are filtered out by default. Pass `include_subtypes: true` if you need them.

## Understanding Context Signals

Messages include **reactions** (name + count) that signal consensus and attention. A message with 5 thumbsup is important; one with no reactions may not be. Use reactions to prioritize what to read deeper.

**Pins** are channel-curated important items. Use `slack.get_pins` to see what a channel considers worth preserving.

## Threads

`read_history` shows thread parents with `reply_count`. Use `slack.read_thread` to read replies on threads that matter. Don't read every thread — prioritize by:

1. High `reply_count` — active discussions
2. Reactions on the parent — signals importance
3. Relevance to your current task

## Images and Files

Messages include a `files` array with metadata: name, mimetype, size, and URL. Use `slack.fetch_file` with the URL to view images (mockups, screenshots, diagrams, error screenshots) or read text files.

Don't fetch every file. Read the filename and surrounding message context first — only fetch when visual understanding actually matters for the task.

## Channel Research

First time reading a channel, use `slack.get_channel_info` to understand its topic, purpose, and who created it. Check `slack.get_pins` for curated important messages.

**Save what you learn to memory** — channel purpose, norms, key context. Don't re-fetch this every time you read the channel. Only re-check if the channel content seems inconsistent with what you remember.

## People

Messages include `user_display` (e.g., `@conner <Conner Swann> (U123)`) and `bot_display` fields. These tell you who said what without needing to call `slack.list_users`.

Use `slack.get_reactions` when you need to know **who specifically** agreed or acknowledged something, not just the count.

## Private Channels

Access is scoped to channels the session owner is a member of. If access is denied, tell the user rather than guessing at content.

## Pagination

Large channels require paging via `cursor` / `next_cursor`. Prefer narrowing with `oldest` / `latest` over paging through the full history.
```

- [ ] **Step 2: Commit**

```bash
git add packages/plugin-slack/skills/slack-tools.md
git commit -m "feat(plugin-slack): add Slack tools skill for agent guidance"
```

---

### Task 11: Regenerate plugin registries

**Files:**
- Modify: `packages/worker/src/plugins/content-registry.ts` (auto-generated)

- [ ] **Step 1: Regenerate registries**

Run: `make generate-registries`
Expected: content-registry.ts updates to include the new `slack-tools` skill from `packages/plugin-slack/skills/`

- [ ] **Step 2: Verify the skill appears in the registry**

Grep for `slack-tools` in the generated file:

```bash
grep -n 'slack-tools' packages/worker/src/plugins/content-registry.ts
```

Expected: at least one match showing the skill is registered.

- [ ] **Step 3: Typecheck everything**

Run: `pnpm typecheck`
Expected: clean across all packages

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/plugins/content-registry.ts packages/worker/src/integrations/packages.ts packages/worker/src/channels/packages.ts
git commit -m "chore: regenerate plugin registries with new Slack skill and actions"
```

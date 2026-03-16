# Slack Image & File Support

## Problem

Telegram has full image and file support in both directions — users can send images to the agent, and the agent can send images/files back. Slack currently lacks both:

- **Inbound**: File attachments are parsed but `url_private` URLs are passed through raw, requiring bot token auth that downstream consumers don't have.
- **Outbound**: `sendMessage()` ignores `message.attachments` entirely — text only.
- **Tool**: `channel_reply` has `imageBase64`/`imageMimeType` params but no general file support and the outbound transport doesn't handle them for Slack anyway.

## Design

### 1. Inbound: Download + Base64

Add `downloadSlackFile(url: string, token: string)` helper to Slack transport that fetches `url_private` with `Authorization: Bearer <token>` and converts to base64 data URL (`data:{mime};base64,{data}`).

In `parseInbound()`, call this for each file in `event.files`, replacing the raw `url_private` with the data URL. This matches the Telegram pattern and makes attachments work uniformly downstream.

- Bot token comes from `routing.botToken` (already in `RoutingMetadata`)
- Skip files > 10MB (log warning, drop attachment)
- Supports images (png, jpg, gif, webp) and documents (pdf, txt, csv, etc.)

### 2. Outbound: Slack Files Upload v2

When `message.attachments` is present in `sendMessage()`, upload each attachment via Slack's v2 file upload API:

1. `files.getUploadURLExternal` — get pre-signed upload URL
2. POST file bytes to the upload URL
3. `files.completeUploadExternal` — finalize and share to `channel_id` + `thread_ts`

If there's also text in the message, send it as a separate `chat.postMessage`.

Handle both data URLs (decode base64 → bytes) and remote URLs (fetch → bytes).

Requires `files:write` scope in the Slack app manifest.

### 3. Tool Extension: Generalize `channel_reply`

Rename/generalize `imageBase64`/`imageMimeType` to `fileBase64`/`fileMimeType` and add `fileName` in `handleChannelReply()`. Keep backward compat for existing `imageBase64` callers.

Build `OutboundAttachment` with `type: 'image'` for `image/*` MIMEs, `type: 'file'` otherwise.

Update the `channel_reply` tool documentation in the orchestrator system prompt to describe:
- `file_base64` (optional): base64-encoded file content
- `file_mime_type` (optional): MIME type of the file
- `file_name` (optional): filename for the attachment

### Files Touched

| File | Changes |
|------|---------|
| `packages/plugin-slack/src/channels/transport.ts` | Add `downloadSlackFile()`, modify `parseInbound()`, add `uploadSlackFile()`, modify `sendMessage()` |
| `packages/plugin-slack/src/channels/transport.test.ts` | Tests for download, upload, and round-trip |
| `packages/worker/src/routes/slack-events.ts` | Verify botToken is in routing metadata |
| `packages/worker/src/durable-objects/session-agent.ts` | Generalize `handleChannelReply()` file params |
| `packages/worker/src/lib/orchestrator-persona.ts` | Update `channel_reply` tool docs in system prompt |
| Slack app manifest | Add `files:write` scope |

### Out of Scope

- Image generation (blocked by opencode [#12859](https://github.com/anomalyco/opencode/issues/12859))
- Video/audio file handling
- Block Kit image blocks (using native file upload instead)

### Dependencies

- Slack bot token must have `files:read` (already present) and `files:write` scopes
- The `RoutingMetadata.botToken` must be passed through in `slack-events.ts` (verify)

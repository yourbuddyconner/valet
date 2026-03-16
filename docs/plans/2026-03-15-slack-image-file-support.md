# Slack Image & File Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add bidirectional image and file support for Slack, matching Telegram's existing capabilities.

**Architecture:** Inbound files are downloaded via `url_private` with the bot token and converted to base64 data URLs (matching Telegram's pattern). Outbound files are uploaded via Slack's v2 file upload API (`files.getUploadURLExternal` + `files.completeUploadExternal`). The `channel_reply` tool params are generalized from image-specific to file-generic.

**Tech Stack:** TypeScript, Slack Web API, Vitest

---

### Task 1: Inbound — Add `downloadSlackFile()` helper

**Files:**
- Modify: `packages/plugin-slack/src/channels/transport.ts:17-21` (add after SLACK_API constant)
- Test: `packages/plugin-slack/src/channels/transport.test.ts`

**Step 1: Write the failing test**

Add to `transport.test.ts` inside the `parseInbound` describe block, after the existing `'parses file_share subtype'` test (~line 300):

```typescript
it('downloads file_share images as base64 data URLs when botToken provided', async () => {
  // Mock the fetch call to url_private
  const fakeImageBytes = new Uint8Array([137, 80, 78, 71]); // PNG magic bytes
  mockFetch.mockResolvedValueOnce(
    new Response(fakeImageBytes, { status: 200 }),
  );

  const body = JSON.stringify({
    type: 'event_callback',
    team_id: 'T123',
    event: {
      type: 'message',
      subtype: 'file_share',
      channel: 'C456',
      user: 'U789',
      text: 'check this out',
      ts: '1234567890.123456',
      files: [
        {
          url_private: 'https://files.slack.com/files-pri/T123-F456/photo.png',
          mimetype: 'image/png',
          name: 'photo.png',
          size: 4,
          filetype: 'png',
        },
      ],
    },
  });

  const result = await transport.parseInbound({}, body, { userId: 'u1', botToken: 'xoxb-test' });
  expect(result).not.toBeNull();
  expect(result!.attachments).toHaveLength(1);
  expect(result!.attachments[0].type).toBe('image');
  expect(result!.attachments[0].url).toMatch(/^data:image\/png;base64,/);
  expect(result!.attachments[0].mimeType).toBe('image/png');

  // Verify fetch was called with authorization header
  expect(mockFetch).toHaveBeenCalledTimes(1);
  const [fetchUrl, fetchOpts] = mockFetch.mock.calls[0];
  expect(fetchUrl).toBe('https://files.slack.com/files-pri/T123-F456/photo.png');
  expect(fetchOpts.headers.Authorization).toBe('Bearer xoxb-test');
});

it('falls back to url_private when botToken is not provided', async () => {
  const body = JSON.stringify({
    type: 'event_callback',
    team_id: 'T123',
    event: {
      type: 'message',
      subtype: 'file_share',
      channel: 'C456',
      user: 'U789',
      text: 'file here',
      ts: '1234567890.123456',
      files: [
        {
          url_private: 'https://files.slack.com/files-pri/T123-F456/photo.png',
          mimetype: 'image/png',
          name: 'photo.png',
          size: 4,
          filetype: 'png',
        },
      ],
    },
  });

  const result = await transport.parseInbound({}, body, { userId: 'u1' });
  expect(result!.attachments[0].url).toBe('https://files.slack.com/files-pri/T123-F456/photo.png');
});

it('skips files larger than 10MB during download', async () => {
  const body = JSON.stringify({
    type: 'event_callback',
    team_id: 'T123',
    event: {
      type: 'message',
      subtype: 'file_share',
      channel: 'C456',
      user: 'U789',
      text: '',
      ts: '1234567890.123456',
      files: [
        {
          url_private: 'https://files.slack.com/files-pri/T123-F456/huge.zip',
          mimetype: 'application/zip',
          name: 'huge.zip',
          size: 11 * 1024 * 1024,
          filetype: 'zip',
        },
      ],
    },
  });

  const result = await transport.parseInbound({}, body, { userId: 'u1', botToken: 'xoxb-test' });
  expect(result!.attachments).toHaveLength(0);
  expect(mockFetch).not.toHaveBeenCalled();
});

it('gracefully handles download failure', async () => {
  mockFetch.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));

  const body = JSON.stringify({
    type: 'event_callback',
    team_id: 'T123',
    event: {
      type: 'message',
      subtype: 'file_share',
      channel: 'C456',
      user: 'U789',
      text: 'file',
      ts: '1234567890.123456',
      files: [
        {
          url_private: 'https://files.slack.com/files-pri/T123-F456/secret.png',
          mimetype: 'image/png',
          name: 'secret.png',
          size: 1000,
          filetype: 'png',
        },
      ],
    },
  });

  const result = await transport.parseInbound({}, body, { userId: 'u1', botToken: 'xoxb-test' });
  // File is dropped on download failure
  expect(result!.attachments).toHaveLength(0);
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/plugin-slack && npx vitest run src/channels/transport.test.ts --reporter=verbose`
Expected: FAIL — tests expect base64 data URLs but `parseInbound` still returns raw `url_private`

**Step 3: Write the `downloadSlackFile` helper and modify `parseInbound`**

Add after the `slackApiGet` function (~line 67) in `transport.ts`:

```typescript
const MAX_FILE_DOWNLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

/** Download a Slack file via url_private, returning a base64 data URL. */
async function downloadSlackFile(
  urlPrivate: string,
  token: string,
  mimeType: string,
): Promise<string | null> {
  try {
    const resp = await fetch(urlPrivate, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return null;

    const buffer = await resp.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return `data:${mimeType};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}
```

Then modify the file attachment loop in `parseInbound()` (currently lines 214-235). Replace the inner loop body:

```typescript
if (files && files.length > 0) {
  const botToken = routing.botToken as string | undefined;

  for (const file of files) {
    const urlPrivate = file.url_private as string | undefined;
    const mimetype = file.mimetype as string | undefined;
    const name = file.name as string | undefined;
    const size = file.size as number | undefined;
    const filetype = file.filetype as string | undefined;

    if (!urlPrivate) continue;

    const mime = mimetype || 'application/octet-stream';
    const isImage = mime.startsWith('image/') ||
      ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(filetype || '');

    // Skip files over 10MB
    if (size && size > MAX_FILE_DOWNLOAD_BYTES) {
      console.warn(`[SlackTransport] Skipping file ${name}: ${size} bytes exceeds 10MB limit`);
      continue;
    }

    // Download and convert to base64 data URL if bot token is available
    let url = urlPrivate;
    if (botToken) {
      const dataUrl = await downloadSlackFile(urlPrivate, botToken, mime);
      if (!dataUrl) {
        console.warn(`[SlackTransport] Failed to download file: ${name}`);
        continue;
      }
      url = dataUrl;
    }

    attachments.push({
      type: isImage ? 'image' : 'file',
      url,
      mimeType: mime,
      fileName: name,
      size,
    });
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/plugin-slack && npx vitest run src/channels/transport.test.ts --reporter=verbose`
Expected: PASS — all new tests pass, existing tests still pass

**Step 5: Commit**

```bash
git add packages/plugin-slack/src/channels/transport.ts packages/plugin-slack/src/channels/transport.test.ts
git commit -m "feat(slack): download inbound file attachments as base64 data URLs"
```

---

### Task 2: Verify botToken is passed in routing metadata

**Files:**
- Read: `packages/worker/src/routes/slack-events.ts`

**Step 1: Check if botToken is already passed**

Search `slack-events.ts` for where `transport.parseInbound()` is called and inspect the `routing` argument. The bot token is fetched earlier in the route handler as part of Slack install lookup. Verify it's included in the routing metadata object passed to `parseInbound()`.

**Step 2: Add botToken to routing if missing**

If the routing metadata doesn't include `botToken`, add it where the routing object is constructed. The bot token is available as `install.botToken` (or similar) from the Slack install lookup earlier in the handler.

Look for the call pattern:
```typescript
const message = await transport.parseInbound(rawHeaders, rawBody, {
  userId,
  senderName: displayName,
  mentionMap,
  // Add here if missing:
  botToken: install.botToken,
});
```

**Step 3: Run tests**

Run: `cd packages/worker && npx vitest run src/routes/slack-events.test.ts --reporter=verbose` (if test file exists)
Expected: PASS

**Step 4: Commit (if changes were needed)**

```bash
git add packages/worker/src/routes/slack-events.ts
git commit -m "fix(slack): pass botToken in routing metadata for file downloads"
```

---

### Task 3: Outbound — Add Slack v2 file upload

**Files:**
- Modify: `packages/plugin-slack/src/channels/transport.ts:282-315` (sendMessage method)
- Test: `packages/plugin-slack/src/channels/transport.test.ts`

**Step 1: Write the failing tests**

Add to `transport.test.ts` inside the `sendMessage` describe block (~after line 470):

```typescript
it('uploads image attachment via files.getUploadURLExternal + completeUploadExternal', async () => {
  // 1. files.getUploadURLExternal response
  mockFetch.mockResolvedValueOnce(
    jsonResponse({
      ok: true,
      upload_url: 'https://files.slack.com/upload/v1/ABC123',
      file_id: 'F_UPLOAD_1',
    }),
  );
  // 2. PUT to upload URL
  mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));
  // 3. files.completeUploadExternal response
  mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

  const target: ChannelTarget = { channelType: 'slack', channelId: 'C456', threadId: '111.222' };

  const result = await transport.sendMessage(
    target,
    {
      attachments: [{
        type: 'image' as const,
        url: 'data:image/png;base64,iVBORw0KGgo=',
        mimeType: 'image/png',
        fileName: 'chart.png',
      }],
    },
    ctx,
  );

  expect(result.success).toBe(true);
  expect(mockFetch).toHaveBeenCalledTimes(3);

  // Verify getUploadURLExternal call
  const [url1, opts1] = mockFetch.mock.calls[0];
  expect(url1).toBe('https://slack.com/api/files.getUploadURLExternal');
  const body1 = JSON.parse(opts1.body);
  expect(body1.filename).toBe('chart.png');
  expect(body1.length).toBeGreaterThan(0);

  // Verify upload to pre-signed URL
  const [url2, opts2] = mockFetch.mock.calls[1];
  expect(url2).toBe('https://files.slack.com/upload/v1/ABC123');
  expect(opts2.method).toBe('POST');

  // Verify completeUploadExternal call
  const [url3, opts3] = mockFetch.mock.calls[2];
  expect(url3).toBe('https://slack.com/api/files.completeUploadExternal');
  const body3 = JSON.parse(opts3.body);
  expect(body3.files).toEqual([{ id: 'F_UPLOAD_1' }]);
  expect(body3.channel_id).toBe('C456');
  expect(body3.thread_ts).toBe('111.222');
});

it('sends text alongside file attachment as separate message', async () => {
  // File upload flow (3 calls)
  mockFetch.mockResolvedValueOnce(
    jsonResponse({ ok: true, upload_url: 'https://upload.example.com', file_id: 'F1' }),
  );
  mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));
  mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
  // chat.postMessage for text
  mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true, ts: '111.333' }));

  const result = await transport.sendMessage(
    { channelType: 'slack', channelId: 'C456', threadId: '111.222' },
    {
      markdown: 'Here is the file',
      attachments: [{
        type: 'file' as const,
        url: 'data:application/pdf;base64,JVBERi0=',
        mimeType: 'application/pdf',
        fileName: 'report.pdf',
      }],
    },
    ctx,
  );

  expect(result.success).toBe(true);
  // 3 for upload + 1 for text
  expect(mockFetch).toHaveBeenCalledTimes(4);
  const [textUrl] = mockFetch.mock.calls[3];
  expect(textUrl).toBe('https://slack.com/api/chat.postMessage');
});

it('returns error when file upload fails at getUploadURLExternal', async () => {
  mockFetch.mockResolvedValueOnce(
    jsonResponse({ ok: false, error: 'not_allowed' }),
  );

  const result = await transport.sendMessage(
    { channelType: 'slack', channelId: 'C456' },
    {
      attachments: [{
        type: 'image' as const,
        url: 'data:image/png;base64,iVBORw0KGgo=',
        mimeType: 'image/png',
      }],
    },
    ctx,
  );

  expect(result.success).toBe(false);
  expect(result.error).toContain('not_allowed');
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/plugin-slack && npx vitest run src/channels/transport.test.ts --reporter=verbose`
Expected: FAIL — `sendMessage` doesn't handle attachments

**Step 3: Implement file upload in `sendMessage`**

Add a private `uploadFile` method and modify `sendMessage` in `transport.ts`:

```typescript
/** Upload a file to Slack via the v2 upload API. */
private async uploadFile(
  target: ChannelTarget,
  attachment: import('@valet/sdk').OutboundAttachment,
  token: string,
): Promise<{ success: boolean; error?: string }> {
  // Decode the file content
  let fileBytes: Uint8Array;
  if (attachment.url.startsWith('data:')) {
    const base64Data = attachment.url.split(',')[1];
    const binaryString = atob(base64Data);
    fileBytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      fileBytes[i] = binaryString.charCodeAt(i);
    }
  } else {
    const resp = await fetch(attachment.url);
    if (!resp.ok) return { success: false, error: `Failed to fetch file: ${resp.status}` };
    fileBytes = new Uint8Array(await resp.arrayBuffer());
  }

  const filename = attachment.fileName || `file-${Date.now()}`;

  // Step 1: Get upload URL
  const uploadUrlResult = await slackApiCall('files.getUploadURLExternal', {
    filename,
    length: fileBytes.length,
  }, token);

  if (!uploadUrlResult.ok) {
    return { success: false, error: `Slack files.getUploadURLExternal error: ${uploadUrlResult.error}` };
  }

  const uploadUrl = uploadUrlResult.upload_url as string;
  const fileId = uploadUrlResult.file_id as string;

  // Step 2: Upload file content
  const uploadResp = await fetch(uploadUrl, {
    method: 'POST',
    body: fileBytes,
  });

  if (!uploadResp.ok) {
    return { success: false, error: `File upload failed: ${uploadResp.status}` };
  }

  // Step 3: Complete the upload and share to channel
  const completeBody: Record<string, unknown> = {
    files: [{ id: fileId }],
    channel_id: target.channelId,
  };
  if (target.threadId) {
    completeBody.thread_ts = target.threadId;
  }
  if (attachment.caption) {
    completeBody.initial_comment = attachment.caption;
  }

  const completeResult = await slackApiCall('files.completeUploadExternal', completeBody, token);
  if (!completeResult.ok) {
    return { success: false, error: `Slack files.completeUploadExternal error: ${completeResult.error}` };
  }

  return { success: true };
}
```

Then modify `sendMessage` to handle attachments before/alongside text:

```typescript
async sendMessage(
  target: ChannelTarget,
  message: OutboundMessage,
  ctx: ChannelContext,
): Promise<SendResult> {
  // Upload file attachments first
  if (message.attachments && message.attachments.length > 0) {
    for (const attachment of message.attachments) {
      const uploadResult = await this.uploadFile(target, attachment, ctx.token);
      if (!uploadResult.success) {
        return { success: false, error: uploadResult.error };
      }
    }

    // If no text content, we're done after uploading files
    const text = message.markdown || message.text || '';
    if (!text) {
      return { success: true };
    }
  }

  // Send text message
  const text = message.markdown || message.text || '';
  if (!text) return { success: true };

  const formatted = this.formatMarkdown(text);

  const body: Record<string, unknown> = {
    channel: target.channelId,
    text: formatted,
    unfurl_links: false,
  };

  if (target.threadId) {
    body.thread_ts = target.threadId;
  }

  // Persona identity overrides (requires chat:write.customize scope)
  if (message.platformOptions?.username) {
    body.username = message.platformOptions.username;
  }
  if (message.platformOptions?.icon_url) {
    body.icon_url = message.platformOptions.icon_url;
  }

  const result = await slackApiCall('chat.postMessage', body, ctx.token);

  if (!result.ok) {
    return { success: false, error: `Slack chat.postMessage error: ${result.error}` };
  }

  return { success: true, messageId: result.ts };
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/plugin-slack && npx vitest run src/channels/transport.test.ts --reporter=verbose`
Expected: PASS — all tests pass including new upload tests

**Step 5: Commit**

```bash
git add packages/plugin-slack/src/channels/transport.ts packages/plugin-slack/src/channels/transport.test.ts
git commit -m "feat(slack): add outbound file upload via Slack v2 upload API"
```

---

### Task 4: Generalize `channel_reply` tool params

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts:3371-3372` (dispatch) and `8504-8547` (handler)

**Step 1: Modify `handleChannelReply` to accept generic file params**

Update the method signature and the outbound message construction:

```typescript
private async handleChannelReply(
  requestId: string,
  channelType: string,
  channelId: string,
  message: string,
  imageBase64?: string,       // kept for backward compat
  imageMimeType?: string,     // kept for backward compat
  followUp?: boolean,
  fileBase64?: string,        // new generic param
  fileMimeType?: string,      // new generic param
  fileName?: string,          // new generic param
) {
```

Then update the outbound message construction (currently lines 8537-8547):

```typescript
// Build outbound message — prefer new file params, fall back to legacy image params
const attachBase64 = fileBase64 || imageBase64;
const attachMime = fileMimeType || imageMimeType || 'application/octet-stream';
const attachName = fileName;

const outbound: import('@valet/sdk').OutboundMessage = attachBase64
  ? {
      markdown: message || undefined,
      attachments: [{
        type: (attachMime.startsWith('image/') ? 'image' : 'file') as 'image' | 'file',
        url: `data:${attachMime};base64,${attachBase64}`,
        mimeType: attachMime,
        fileName: attachName,
        caption: message || undefined,
      }],
    }
  : { markdown: message };
```

**Step 2: Update the dispatch line**

Update the `case 'channel-reply'` dispatch (line 3372) to pass the new params:

```typescript
case 'channel-reply':
  await this.handleChannelReply(
    msg.requestId!, msg.channelType!, msg.channelId!, msg.message || '',
    msg.imageBase64, msg.imageMimeType, msg.followUp,
    msg.fileBase64, msg.fileMimeType, msg.fileName,
  );
  break;
```

**Step 3: Run the full test suite**

Run: `cd packages/worker && npx vitest run --reporter=verbose`
Expected: PASS — no regressions, existing channel_reply tests still pass

**Step 4: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts
git commit -m "feat: generalize channel_reply to support file attachments"
```

---

### Task 5: Update orchestrator system prompt

**Files:**
- Modify: `packages/worker/src/lib/orchestrator-persona.ts:392-430`

**Step 1: Update the channel_reply documentation**

Add file attachment params to the `## Channel Replies` section. After the `follow_up` parameter documentation (~line 407), add:

```markdown
### Sending files

The \`channel_reply\` tool supports sending file attachments alongside or instead of text:
- \`file_base64\` (optional): base64-encoded file content
- \`file_mime_type\` (optional): MIME type (e.g. \`image/png\`, \`application/pdf\`)
- \`file_name\` (optional): filename for the attachment (e.g. \`chart.png\`, \`report.pdf\`)

To send a file, include these params along with your message text. The file will be uploaded natively to the platform (Slack, Telegram) and appear inline in the conversation.

Example: \`channel_reply("slack", "C123:1234567890.123456", "Here's the report", file_base64="...", file_mime_type="application/pdf", file_name="report.pdf")\`
```

**Step 2: Run tests**

Run: `cd packages/worker && npx vitest run src/lib/orchestrator-persona.test.ts --reporter=verbose` (if exists, otherwise skip)
Expected: PASS

**Step 3: Commit**

```bash
git add packages/worker/src/lib/orchestrator-persona.ts
git commit -m "docs: document file attachment params in channel_reply system prompt"
```

---

### Task 6: Verify runner-side message types include new params

**Files:**
- Search: `packages/worker/src/durable-objects/session-agent.ts` for the message type interface/type that includes `imageBase64`

**Step 1: Find and update the runner message type**

Search for where the `channel-reply` message type is defined or typed. It may be in the session-agent file or in a shared types file. The type needs `fileBase64`, `fileMimeType`, and `fileName` fields.

Look for something like:
```typescript
interface RunnerMessage {
  type: string;
  // ... other fields
  imageBase64?: string;
  imageMimeType?: string;
  // Add:
  fileBase64?: string;
  fileMimeType?: string;
  fileName?: string;
}
```

Also check the runner-side code (likely in `packages/worker/src/runners/` or similar) where the model's tool call params are mapped to the `channel-reply` message. The runner needs to pass through `file_base64`, `file_mime_type`, and `file_name` from the tool call params.

**Step 2: Update the type and runner mapping**

Add the new fields to the message type and ensure the runner maps the tool params through.

**Step 3: Run tests**

Run: `cd packages/worker && npx vitest run --reporter=verbose`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/worker/src/
git commit -m "feat: wire file attachment params through runner message types"
```

---

### Task 7: End-to-end integration test

**Step 1: Write an integration test (if test infrastructure supports it)**

If there's an existing integration/e2e test pattern, add a test that:
1. Constructs a Slack file_share event with a mock file
2. Verifies `parseInbound` produces a base64 data URL attachment
3. Constructs an outbound message with that attachment
4. Verifies `sendMessage` calls the v2 upload API correctly

If no e2e pattern exists, do a manual verification by reviewing the full data flow.

**Step 2: Run the full test suite**

Run: `npx vitest run --reporter=verbose`
Expected: PASS — all tests pass across all packages

**Step 3: Final commit if any adjustments were needed**

```bash
git add -A
git commit -m "test: add integration coverage for Slack file support"
```

---

### Task 8: Update Slack app manifest (if applicable)

**Step 1: Find the manifest**

Search for a Slack manifest file (e.g., `manifest.json`, `manifest.yaml`, or similar) in the repo.

**Step 2: Add `files:write` scope**

Add `files:write` to the bot token scopes list, alongside the existing `files:read`.

**Step 3: Commit**

```bash
git add <manifest-file>
git commit -m "feat(slack): add files:write scope to app manifest"
```

**Note:** If no manifest file exists in the repo (Slack app may be configured via web UI), document that the `files:write` scope needs to be added manually and skip this task.

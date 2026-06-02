# Gmail Skill

Use these actions to read, compose, and manage Gmail messages and drafts on behalf of the authenticated user.

## Body formatting

The `body` field on `gmail.send_email`, `gmail.create_draft`, and `gmail.update_draft` accepts **markdown**. Supported formatting includes headings (`#`, `##`, `###`), bullet and numbered lists with nesting, **bold**, *italic*, `inline code`, fenced code blocks, links (`[text](url)`), blockquotes (`> `), and tables.

The email is sent as `multipart/alternative` with the markdown source as the plain-text part and rendered HTML as the HTML part. Recipients with HTML support see formatted output; plain-text clients see the raw markdown fallback.

Write paragraphs as single lines separated by blank lines. Do not hard-wrap inside a paragraph.

Raw HTML in the body is escaped, not interpreted, so it is safe to include `<` and `>` in code or examples. Images are not supported in v1; use a publicly accessible URL and reference it as a link.

## Messages

### `gmail.send_email`
Send a markdown-formatted email. Supports `cc`, `bcc`, and threading via `replyToMessageId` (which sets `In-Reply-To`/`References` and places the reply in the original thread).

```json
{
  "to": "alice@example.com",
  "subject": "Hello",
  "body": "Hi Alice,\n\n**Here is the update:** ...",
  "cc": ["bob@example.com"],
  "replyToMessageId": "<optional gmail message id>"
}
```

Risk: **high** (sends immediately).

---

### `gmail.list_messages`
List messages matching a Gmail search query. Returns sender, subject, date, snippet, and label IDs for each result.

```json
{
  "maxResults": 10,
  "q": "is:unread from:boss@acme.com",
  "labelIds": ["INBOX"],
  "includeSpamTrash": false
}
```

Risk: **low**.

---

### `gmail.get_message`
Fetch a single message with full headers, decoded plain-text and HTML body, and attachment metadata.

```json
{
  "messageId": "18e1a2b3c4d5e6f7",
  "format": "full"
}
```

`format` options: `full` (default) | `metadata` (headers only) | `minimal` (labels + snippet).

Risk: **low**.

---

### `gmail.modify_labels`
Add or remove labels on a message. Common patterns:
- Archive: `removeLabelIds: ["INBOX"]`
- Star: `addLabelIds: ["STARRED"]`
- Mark read: `removeLabelIds: ["UNREAD"]`
- Apply custom label: `addLabelIds: ["<label id from list_labels>"]`

```json
{
  "messageId": "18e1a2b3c4d5e6f7",
  "addLabelIds": ["STARRED"],
  "removeLabelIds": ["UNREAD"]
}
```

At least one of `addLabelIds` or `removeLabelIds` must be provided.

Risk: **medium**.

---

### `gmail.trash_message`
Move a message to Trash (reversible for 30 days — not a permanent delete).

```json
{ "messageId": "18e1a2b3c4d5e6f7" }
```

Risk: **high**.

---

## Drafts

### `gmail.create_draft`
Create a draft without sending. Prefer this over `send_email` when the user should review before sending. Supports threading via `replyToMessageId`.

```json
{
  "to": "alice@example.com",
  "subject": "Proposal",
  "body": "Dear Alice,\n\n## Proposal\n\n- Scope\n- Timeline",
  "replyToMessageId": "<optional>"
}
```

Risk: **medium**.

---

### `gmail.list_drafts`
List drafts with subject, recipient, snippet, and date. Use the returned `draftId` with `send_draft`, `update_draft`, or `delete_draft`.

```json
{ "maxResults": 25, "q": "subject:proposal" }
```

Risk: **low**.

---

### `gmail.get_draft`
Fetch a single draft with full headers and decoded body.

```json
{ "draftId": "r8765432109" }
```

Risk: **low**.

---

### `gmail.update_draft`
Fully replace a draft's contents (subject, body, recipients). This is a full overwrite, not a patch.

```json
{
  "draftId": "r8765432109",
  "to": "alice@example.com",
  "subject": "Updated Proposal",
  "body": "Dear Alice,\n\n**Revised text:** ..."
}
```

Risk: **medium**.

---

### `gmail.send_draft`
Send an existing draft. The draft is removed after sending and the message appears in Sent.

```json
{ "draftId": "r8765432109" }
```

Risk: **high**.

---

### `gmail.delete_draft`
Permanently delete a draft. Irreversible — not moved to Trash.

```json
{ "draftId": "r8765432109" }
```

Risk: **high**.

---

## Labels + Triage

### `gmail.list_labels`
List all labels (system and user-created) with their IDs and visibility settings. Use returned IDs with `modify_labels` or `list_messages`.

```json
{}
```

Risk: **low**.

---

### `gmail.triage_inbox`
Composite action: fetch recent unread messages with heuristic categorization in a single call. Each message is tagged with signals: `isNewsletter`, `containsMeetingReference`, `containsQuestion`, `actionRequested`. Also returns aggregate stats: total unread count, top senders, and counts per category.

Use the returned data to decide which messages need a reply, can be archived, or warrant a draft response.

```json
{
  "maxResults": 20,
  "additionalQuery": "newer_than:2d",
  "bodyExcerptLength": 400
}
```

Pairs naturally with `create_draft`, `modify_labels`, and `trash_message`.

Risk: **medium**.

---

## Common workflows

**Triage and respond:**
1. `gmail.triage_inbox` — get overview of unread messages with signals
2. For action-required messages: `gmail.create_draft` to compose a reply
3. User reviews draft, then `gmail.send_draft` or `gmail.delete_draft`
4. For newsletters/noise: `gmail.modify_labels` with `removeLabelIds: ["INBOX"]` to archive

**Reply to a specific thread:**
1. `gmail.list_messages` with `q: "from:alice@example.com"` to find the message
2. `gmail.get_message` to read the full content
3. `gmail.send_email` with `replyToMessageId` set to thread correctly

**Manage labels:**
1. `gmail.list_labels` to discover label IDs
2. `gmail.modify_labels` to apply/remove labels on messages

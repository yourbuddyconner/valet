---
name: google-docs
description: How to use Google Docs tools effectively — reading documents with index awareness, surgical text editing, markdown rewrites, formatting, tabs, and comments.
---

# Google Docs

You have full read/write access to Google Docs through the Google Workspace integration. The 26 available tools support surgical index-based editing, full markdown rewrites, formatting, tab management, and comments.

Documents are created via `drive.create_document` (not a docs action). All tools that accept `documentId` accept either a bare document ID or a full Google Docs URL.

## Available Tools

### List / Search

- **`docs.list_tabs`** — List all tabs in a document (tab IDs, titles, nesting).
- **`docs.find_text_index`** — Find the character index of a text string. Returns `{ startIndex, endIndex }` for use with index-based tools. Much lighter than `format=json`.

### Read / Get

- **`docs.read_document`** — Read document content. Use `format=markdown` for human-readable output, `format=text` for plain text, or `format=json` for raw document structure (large output — prefer `find_text_index` when you only need a position).
- **`docs.list_comments`** — List all comments on a document (open or resolved).
- **`docs.get_comment`** — Get a single comment by ID, including all replies.

### Write / Modify

**Text edits (use `textToFind` targets or `find_text_index` to get positions):**
- **`docs.insert_text`** — Insert text at a specific character index.
- **`docs.append_text`** — Append plain text at the end of a document (or tab).
- **`docs.modify_text`** — Replace text within a range or by text search. Supports `textToFind` target and optional `style`.
- **`docs.delete_range`** — Delete content between a start–end index range.

**Bulk text changes:**
- **`docs.find_and_replace`** — Find and replace text throughout the document or a specific tab.

**Markdown-based writes:**
- **`docs.append_markdown`** — Convert markdown and append at the end of the document.
- **`docs.replace_document_with_markdown`** — Replace the entire document body with rendered markdown content.

**Structural insertion:**
- **`docs.insert_table`** — Insert an empty table at a specific index.
- **`docs.insert_table_with_data`** — Insert a table pre-populated with data at a specific index.
- **`docs.insert_image`** — Insert an image (by URL) at a specific index.
- **`docs.insert_page_break`** — Insert a page break at a specific index.
- **`docs.insert_section_break`** — Insert a section break (continuous, next page, even page, odd page) at a specific index.

**Tabs:**
- **`docs.add_tab`** — Add a new tab to the document.
- **`docs.rename_tab`** — Rename an existing tab by tab ID.

**Formatting:**
- **`docs.apply_text_style`** — Apply character-level style (bold, italic, underline, font, color, linkUrl, etc.) to text identified by range or text search.
- **`docs.apply_paragraph_style`** — Apply paragraph-level style (heading level, alignment, spacing, etc.) to a range.
- **`docs.update_section_style`** — Update section layout properties (margins, columns, etc.).

**Comments:**
- **`docs.add_comment`** — Add a new comment anchored to a text range or the whole document.
- **`docs.reply_to_comment`** — Reply to an existing comment thread.
- **`docs.delete_comment`** — Delete a comment (and its replies).
- **`docs.resolve_comment`** — Mark a comment thread as resolved.

## Core Workflows

### Edit by Text Search (preferred)

Most edits don't need character indices. Use `textToFind` targets on `modify_text` and `apply_text_style` to identify what to change:

```
# Replace text by searching for it
docs.modify_text({ documentId: "...", target: { textToFind: "old text" }, text: "new text" })

# Apply formatting by searching for text
docs.apply_text_style({ documentId: "...", target: { textToFind: "important" }, style: { bold: true } })
```

### Insert at a Position

When you need to insert at a specific location (not replace existing text), use `find_text_index` to get the position without downloading the full document structure:

```
1. docs.find_text_index({ documentId: "...", textToFind: "insert after this" })
   → Returns { startIndex: 42, endIndex: 60 }

2. docs.insert_text({ documentId: "...", index: 60, text: "new content" })
```

### Surgical Index-Based Editing

Use this as a last resort when text search is ambiguous (e.g., the document has duplicate paragraphs). Read with `format=json` to get the full document structure with character indices:

```
1. docs.read_document({ documentId: "...", format: "json" })
   → Returns document structure with startIndex/endIndex on every element

2. Locate the range in the JSON, then apply edits:
   - docs.modify_text({ documentId: "...", target: { startIndex: 42, endIndex: 67 }, text: "replacement" })
   - docs.delete_range({ documentId: "...", startIndex: 42, endIndex: 67 })
   - docs.insert_text({ documentId: "...", index: 42, text: "new content" })
```

Important: Character indices shift after every mutation. Plan all edits from a single read snapshot and apply them in reverse order (highest index first) to avoid offset drift.

### Find and Replace

For bulk text substitutions — placeholders, renames, or corrections throughout the document:

```
docs.find_and_replace({
  documentId: "...",
  find: "{{PROJECT_NAME}}",
  replace: "Wallet Export v2"
})
```

Use `find_and_replace` for any case where you know the exact text to swap. It is simpler and safer than calculating indices.

### Full Document Rewrite

When you want to replace the entire document body with new markdown content:

```
docs.replace_document_with_markdown({
  documentId: "...",
  markdown: "# New Title\n\n## Section 1\n\nContent here..."
})
```

Use this for complete rewrites, template population from scratch, or when structure has changed enough that surgical edits would be more complex than starting fresh.

### Append Content

To add new content at the end without touching existing content:

```
# Plain text
docs.append_text({ documentId: "...", text: "New paragraph." })

# Markdown (converted to native formatting)
docs.append_markdown({ documentId: "...", markdown: "## New Section\n\nContent..." })
```

Use `append_markdown` when the content has headings, lists, tables, or other formatting. Use `append_text` for simple unformatted additions.

### Working with Tabs

Multi-tab documents require listing tabs first:

```
1. docs.list_tabs({ documentId: "..." })
   → Returns tabId, title, nesting for each tab

2. Pass tabId to any index-based tool to scope edits to that tab:
   docs.read_document({ documentId: "...", tabId: "t.abc123", format: "json" })
   docs.insert_text({ documentId: "...", tabId: "t.abc123", index: 10, text: "..." })
```

### Commenting

```
# Add a comment
docs.add_comment({ documentId: "...", content: "Needs review" })

# Reply to a thread
docs.reply_to_comment({ documentId: "...", commentId: "...", content: "Fixed in v2" })

# Resolve when done
docs.resolve_comment({ documentId: "...", commentId: "..." })
```

### Hyperlinks

To make existing text into a clickable link (no index lookup needed):

```
docs.apply_text_style({
  documentId: "...",
  target: { textToFind: "click here" },
  style: { linkUrl: "https://example.com" }
})
```

To replace text and make the replacement a link in one call:

```
docs.modify_text({
  documentId: "...",
  target: { textToFind: "placeholder" },
  text: "linked text",
  style: { linkUrl: "https://example.com" }
})
```

The style property name is `linkUrl` (not `link`). This applies to both `apply_text_style` and `modify_text`.

## Drive Labels Guard Awareness

When the Drive Labels Guard is active (configured per organization), all docs tools that operate on a specific document are subject to label enforcement. The guard classifies each action:

- **`docs.list_tabs`** — list/search (label filter applied to results)
- **`docs.read_document`, `docs.find_text_index`, `docs.list_comments`, `docs.get_comment`** — read/get (document must carry a required label)
- All write/modify tools — require the document to carry a required label before the edit proceeds

If a document does not carry the required label, the tool returns `"File not found or access denied"` regardless of actual permissions. This is intentional — it is indistinguishable from a 404 to prevent information leakage.

Documents are created via `drive.create_document`, which is classified as a create action. When the guard is active, the newly created document is automatically labeled.

## Tips

- **Prefer text search over indices**: Use `textToFind` targets on `modify_text` and `apply_text_style` whenever possible. Use `find_text_index` when you need a position for insertion. Only fall back to `format=json` when text search is ambiguous.
- **Index order for multi-edit**: When applying multiple index-based edits from a single read, work from highest index to lowest. Each insertion or deletion shifts indices for everything that follows.
- **Find-and-replace for placeholders**: If the document uses `{{PLACEHOLDER}}` style tokens, `find_and_replace` is simpler and doesn't require indices.
- **Markdown for new content**: Use `append_markdown` / `replace_document_with_markdown` when generating fresh content.
- **Tab awareness**: Operations that don't specify a `tabId` apply to the first (default) tab. Always call `list_tabs` first on documents where you don't know the tab structure.
- **Formatting after content**: Apply `apply_text_style` and `apply_paragraph_style` after inserting content, targeting the known index range of the newly inserted text.

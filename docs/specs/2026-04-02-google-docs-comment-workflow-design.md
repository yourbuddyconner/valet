# Google Docs Comment-Driven Editing Workflow

**Date:** 2026-04-02
**Status:** Approved

## Problem

The valet agent cannot read or resolve Google Docs comments. When a reviewer (e.g., Zeke) leaves comments on a doc, the user must manually relay them to the agent. Beyond that, even when the agent makes edits to address feedback, section-level replacements corrupt formatting (heading levels, font sizes get scrambled), and there's no way to make surgical edits at the sentence level near a comment's location.

These are interconnected problems. A "resolve comments" workflow requires:
1. Reading comments and understanding what text they refer to
2. Making precise edits at or near the commented text
3. Reliable formatting when replacing larger sections
4. Resolving the comment after addressing it

## Design

### 1. Comments API Actions

Three new actions on the `docs` provider, using Drive API v3 comments/replies endpoints via the existing `driveFetch()` helper.

**`docs.list_comments`**

Lists comments on a document. Returns unresolved comments by default.

Parameters:
- `documentId` (required) — Google Doc ID or URL
- `includeResolved` (optional, default false) — Include resolved comments

Returns array of:
```ts
{
  id: string;
  content: string;           // comment text
  author: { displayName: string; emailAddress: string };
  resolved: boolean;
  quotedFileContent?: {      // the text the comment is anchored to
    mimeType: string;
    value: string;
  };
  replies: {
    id: string;
    content: string;
    author: { displayName: string; emailAddress: string };
    action?: string;         // "resolve" or "reopen"
  }[];
}
```

Uses `GET /files/{fileId}/comments` with `fields=comments(id,content,author,resolved,quotedFileContent,replies(id,content,author,action)),nextPageToken`. Paginates internally to return all matching comments.

**`docs.create_comment`**

Creates an unanchored comment on a document.

Parameters:
- `documentId` (required)
- `content` (required) — comment text

Uses `POST /files/{fileId}/comments` with `fields=id,content,author`.

**`docs.reply_to_comment`**

Replies to an existing comment. Can optionally resolve or reopen the comment in the same call — resolving a comment is done by posting a reply with `action: "resolve"` (the `resolved` field on comments is read-only).

Parameters:
- `documentId` (required)
- `commentId` (required)
- `content` (required) — reply text
- `resolve` (optional, boolean) — if true, posts reply with `action: "resolve"`
- `reopen` (optional, boolean) — if true, posts reply with `action: "reopen"`

Uses `POST /files/{fileId}/comments/{commentId}/replies`.

**OAuth scope change:** The current `drive.metadata.readonly` scope must be upgraded to `drive` for comment access per Google's documentation.

### 2. Style-Aware Insert (Formatting Fix)

**Root cause:** When content is deleted and new text inserted at the same index, the new text inherits character-level formatting (font size, font family) from the text immediately before the insertion point — not from the named style. Our `convertMarkdownToRequests` sets `namedStyleType` on paragraphs but never clears the inherited character-level overrides.

**Fix:** A formatting reset pass in `finalizeFormatting()` in `markdown-to-docs.ts`.

For every paragraph range that receives a `namedStyleType` assignment, also emit a `updateTextStyle` request covering that same range with `fields: "fontSize,weightedFontFamily"` and no values set. Per the Google Docs API, including a property in the field mask without setting a value resets it to the inherited value from the paragraph's named style. This clears any character-level font size/family that bled in from surrounding text.

Example reset request for a HEADING_1 paragraph at indices 50-70:
```json
{
  "updateTextStyle": {
    "range": { "startIndex": 50, "endIndex": 70 },
    "textStyle": {},
    "fields": "fontSize,weightedFontFamily"
  }
}
```

Apply the same reset for non-heading paragraphs (NORMAL_TEXT) to prevent body text from picking up heading styles from adjacent content.

Additionally, sort requests within each phase of `executeBatchUpdate()` by reverse index (highest first) to align with Google's documented "write backwards" recommendation for avoiding index recalculation issues.

Changes:
- `markdown-to-docs.ts` — Add style reset requests in `finalizeFormatting()`
- `api.ts` — Sort requests within each phase by descending index

### 3. Surgical Edit Operation

A new `replaceText` operation type for the existing `docs.update_document` action, enabling precise edits at a specific location in the document.

**`replaceText` operation:**
- `find` (required) — The exact text string to locate in the document
- `replace` (required) — The replacement text
- `occurrence` (optional, default 1) — Which occurrence to target (1 = first, 2 = second, etc.)

Unlike the existing `replaceAll` operation (which uses the Docs API's `replaceAllText` and hits every occurrence), `replaceText` requires a document read to locate the target index, then emits a `deleteContentRange` + `insertText` pair for just that one occurrence. It participates in the same `IndexMutation` tracking as `fillCell` and `insertText` operations, so multiple `replaceText` operations can be composed in a single `update_document` call.

**Intended workflow:**
1. `docs.list_comments` — get comment with `quotedFileContent.value: "The system uses AES-128 encryption"`
2. `docs.read_document` or `docs.read_section` — see surrounding context
3. `docs.update_document` with `replaceText` — replace the quoted text with corrected version
4. `docs.reply_to_comment` with `resolve: true` — resolve the comment

Changes:
- `operations.ts` — Add `replaceText` operation type, index location logic, mutation tracking

### 4. List Sections Action

A new `docs.list_sections` action that exposes the document's heading structure, so the agent can see the full layout before making targeted edits.

Parameters:
- `documentId` (required)
- `tabId` (optional)

Returns array of:
```ts
{
  heading: string;     // heading text
  level: number;       // 1-6
  startIndex: number;
  endIndex: number;
}
```

This exposes the existing `extractSections()` function from `sections.ts` as an action. Gives the agent a table of contents it can use to pass exact heading text to `read_section`, `replace_section`, `delete_section`, etc.

Changes:
- `actions.ts` — Add `docs.list_sections` case using existing `extractSections()`

## Scope

### In scope
- Comments: list, create, reply/resolve/reopen
- Formatting reset pass for style-aware inserts
- Reverse-index sorting in batch execution
- `replaceText` operation for surgical edits
- `list_sections` action

### Out of scope
- Comment anchoring on create (unreliable across revisions per Google's docs)
- Named style definition writes (`updateNamedStyle` is read-only in the API)
- Suggestions/tracked changes API
- Document permissions/sharing

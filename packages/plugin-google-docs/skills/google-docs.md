---
name: google-docs
description: How to use Google Docs tools effectively — markdown formatting, section-based editing, read-before-write patterns, and rich text best practices.
---

# Google Docs

You have full read/write access to Google Docs through the `google-docs` plugin. The key advantage is **rich text formatting** — content you write in markdown is automatically converted to properly formatted Google Docs (headings, bold, italic, links, lists, tables, code blocks, etc).

## Critical Rule: Always Use Markdown

**Every piece of content you write to a Google Doc MUST be formatted in markdown.** The system converts markdown to native Google Docs formatting. If you write plain text without markdown, the document will look unformatted and unprofessional.

```markdown
# Meeting Notes — March 15, 2026

## Action Items

- **@alice**: Finalize the API spec by Friday
- **@bob**: Review the [design doc](https://docs.google.com/...)
- ~~Cancelled: vendor demo~~ — rescheduled to next week

## Technical Summary

The migration uses a `three-phase approach`:

1. **Phase 1** — Schema migration with backwards compatibility
2. **Phase 2** — Dual-write to old and new tables
3. **Phase 3** — Cut over and deprecate old schema
```

This produces a document with proper headings, bold names, a clickable link, strikethrough, inline code, and a numbered list — not just raw text.

## Supported Markdown Formatting

| Markdown | Result in Google Docs |
|---|---|
| `# Heading` through `###### Heading` | Heading 1 through Heading 6 |
| `**bold**` | Bold text |
| `*italic*` | Italic text |
| `~~strikethrough~~` | Strikethrough text |
| `[text](url)` | Clickable hyperlink |
| `` `inline code` `` | Monospace font (Roboto Mono, green) |
| Triple-backtick code blocks | Gray-background table cell with monospace font |
| `- item` or `* item` | Bullet list |
| `1. item` | Numbered list |
| `- [ ] task` / `- [x] task` | Checkbox list items |
| `---` | Horizontal rule |
| Markdown tables | Native Google Docs tables |

## Available Tools

### Reading

- **`docs.search_documents`** — Find documents by title keyword. Use this to locate documents before reading/editing.
- **`docs.get_document`** — Get full document metadata (title, sections, revision info). Good for understanding document structure.
- **`docs.read_document`** — Read entire document content as markdown. Tables are annotated as `[Table N]` in document order to make `fillCell` targeting easier.
- **`docs.read_section`** — Read a specific section by heading name. Use for long documents where you only need part of the content.

### Writing (Markdown-Based)

- **`docs.create_document`** — Create a new document. Content MUST be markdown.
- **`docs.replace_document`** — Replace the entire document body. Content MUST be markdown.
- **`docs.append_content`** — Append content to the end of the document. Content MUST be markdown.
- **`docs.replace_section`** — Replace the content under a specific heading. Content MUST be markdown.
- **`docs.insert_section`** — Insert a new section before or after an existing heading.
- **`docs.delete_section`** — Delete a section and all its content.

### Targeted Edits (Format-Preserving)

- **`docs.update_document`** — Apply surgical edits with high-level operations. Bypasses markdown conversion entirely, preserving all existing formatting, table styling, and document structure.

**When to use `update_document`:**
- Filling in template fields (e.g., replacing `{{PLACEHOLDER}}` with values)
- Replacing specific text throughout a document
- Editing individual table cells without destroying cell formatting
- Making small targeted changes to richly formatted documents

**When to use markdown-based tools instead:**
- Rewriting large sections where formatting isn't critical
- Creating new documents from scratch
- Appending new content to the end of a document

**Supported operations:**
- `replaceAll` — Find-and-replace across the document. Best for placeholders like `{{CAPABILITY_NAME}}`.
- `fillCell` — Replace the content of a specific table cell by `(tableIndex, row, col)`, using 0-based indexing.
- `insertText` — Insert text immediately after an anchor string that already exists in the document.

**Input formats:**
- `operationsJson` — Preferred when possible. Pass a normal JSON array of operations, not a JSON string.
- `operationsToon` — Supported for token-efficient prompts, but easier to misformat than JSON.

**Document identifiers:**
- All tools that take `documentId` accept either a bare document ID or a full Google Docs URL. You do not need to manually strip the ID out of a standard Docs URL.

**Use `replaceAll` for placeholders:**
```text
documentId: 1Jmzvis-SH_...
operationsJson:
  - type: replaceAll
    find: "{{PROJECT_NAME}}"
    replace: Wallet Export v2
  - type: replaceAll
    find: "{{LAUNCH_DATE}}"
    replace: 2026-04-15
```

**Use `fillCell` for template tables:**
```text
documentId: 1Jmzvis-SH_...
operationsJson:
  - type: fillCell
    tableIndex: 0
    row: 0
    col: 1
    text: Wallet Export v2
  - type: fillCell
    tableIndex: 0
    row: 1
    col: 1
    text: Tier 1
```

**Use `insertText` for anchored insertions:**
```text
documentId: 1Jmzvis-SH_...
operationsJson:
  - type: insertText
    after: "Marketing Owner:"
    text: " Jane Smith"
```

`insertText` is anchor-based only. It does not accept a raw document index. If you need to insert near existing content, first read the document and choose a stable `after` anchor string that already exists.

For `update_document`, first read the doc with `docs.read_document` to understand the structure:
- Use the `[Table N]` labels in the readback to map table indices
- Count table rows and columns starting from `0`
- Prefer `replaceAll` when the template already has stable placeholder text
- Use `fillCell` when a value belongs in a specific table cell
- Use `insertText` when you know the exact anchor string already present in the doc
- Prefer `operationsJson` unless you specifically need TOON

**Caution:** `fillCell` and `insertText` require non-empty `text`. The Google Docs API rejects empty `insertText` requests. If a cell should remain blank, omit the operation for that cell instead of passing an empty string.

**TOON encoding rules:**
- Each TOON block must use a single consistent column schema.
- Do not mix `replaceAll`, `fillCell`, and `insertText` rows in the same TOON block because they have different fields.
- In practice, prefer `operationsJson` when mixing operation types.
- If you must use TOON, keep each `update_document` call to one operation shape or make separate `update_document` calls per shape.

## Common Patterns

### Read Before Write

Always read a document before modifying it to understand its structure:

```
1. docs.search_documents({ query: "Q1 Planning" })
2. docs.get_document({ documentId: "..." })      // see section headings
3. docs.read_section({ documentId: "...", sectionHeading: "Budget" })
4. docs.replace_section({ documentId: "...", sectionHeading: "Budget", content: "..." })
```

For targeted edits to formatted templates:

```
1. docs.read_document({ documentId: "..." })
2. Use the [Table N] labels to identify the table you want, then count row/col positions
3. docs.update_document({
     documentId: "...",
     operationsJson: [
       { type: "replaceAll", find: "{{PROJECT_NAME}}", replace: "Wallet Export v2" },
       { type: "fillCell", tableIndex: 0, row: 2, col: 1, text: "2026-04-01" }
     ]
   })
```

### Worked Example: Read → Plan → Fill

Use this workflow when filling a structured template without disturbing formatting:

```text
1. docs.read_document({
     documentId: "https://docs.google.com/document/d/1Jmzvis-SH_.../edit"
   })

2. Inspect the markdown response:
   - Find `[Table 0]`, `[Table 1]`, etc.
   - Note which table row/col holds each value you need to fill
   - Leave untouched cells out of the plan entirely

3. Build the operation list:
   operationsJson:
     - type: replaceAll
       find: "{{CAPABILITY_NAME}}"
       replace: Wallet Export v2
     - type: insertText
       after: "Marketing Owner:"
       text: " Jane Smith"
     - type: fillCell
       tableIndex: 0
       row: 0
       col: 1
       text: Wallet Export v2
     - type: fillCell
       tableIndex: 0
       row: 1
       col: 1
       text: Tier 1

4. Apply the targeted edit:
   docs.update_document({
     documentId: "https://docs.google.com/document/d/1Jmzvis-SH_.../edit",
     operationsJson: [...]
   })

5. Re-read the document and verify the filled cells and inline fields landed in the expected places.
```

### Section-Based Editing

Documents are organized by headings. Use section tools to surgically edit specific parts without touching the rest:

- **Replace a section**: `docs.replace_section` replaces everything under a heading (up to the next heading of equal or higher level)
- **Insert a section**: `docs.insert_section` adds a new section before or after an existing one
- **Delete a section**: `docs.delete_section` removes a heading and everything under it

When targeting a section, the heading parameter is a case-insensitive substring match.

### Creating Well-Structured Documents

When creating new documents, use heading hierarchy to establish clear structure:

```markdown
# Project Title

Brief overview paragraph.

## Background

Context and motivation.

## Requirements

### Functional Requirements

- Requirement 1
- Requirement 2

### Non-Functional Requirements

- Performance: < 200ms p99
- Availability: 99.9%

## Timeline

| Phase | Date | Milestone |
|---|---|---|
| Design | Mar 20 | Design doc approved |
| Build | Apr 10 | MVP complete |
| Launch | Apr 30 | GA release |
```

### Appending to Existing Documents

Use `docs.append_content` to add new content at the end. This is useful for running logs, meeting notes, or adding new sections to an existing document.

### Code in Documents

Code blocks render as gray-background table cells with monospace font, making them visually distinct:

````markdown
```python
def hello():
    print("Hello, world!")
```
````

Inline code like `variable_name` renders in green monospace font.

## Tips

- **Search first**: Use `docs.search_documents` to find documents by title before working with them. You need the document ID for all other operations.
- **Use sections**: For large documents, prefer `read_section` and `replace_section` over reading/replacing the entire document.
- **Markdown everywhere**: Every content string — in create, replace, append, insert — is parsed as markdown. Take advantage of this for professional-looking documents.
- **Targeted edits are not markdown**: `docs.update_document` writes plain text into existing structures and takes either `operationsJson` or a TOON-encoded operation list. Use it when preserving current formatting matters more than generating new formatting from markdown.
- **Heading levels matter**: Section operations use heading hierarchy. A `## Subheading` under `# Heading` is part of the `# Heading` section. Replacing `# Heading` replaces everything including sub-sections.

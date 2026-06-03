# Gmail Markdown HTML Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Gmail write actions accept markdown in `body`, render it to HTML, and send multipart emails with markdown as the plain-text fallback.

**Architecture:** Add a small Gmail-local markdown renderer using the Google Docs `markdown-it` configuration. Keep the Gmail action schemas unchanged and route the existing MIME builder through a multipart/alternative message shape.

**Tech Stack:** TypeScript, Vitest, `markdown-it`, Gmail MIME raw messages.

---

### Task 1: Renderer

**Files:**
- Create: `packages/plugin-gmail/src/actions/markdown.ts`
- Test: `packages/plugin-gmail/src/actions/markdown.test.ts`
- Modify: `packages/plugin-gmail/package.json`

- [ ] Write failing tests for semantic markdown rendering, linkify, escaped raw HTML, code blocks, tables, and intraword underscores.
- [ ] Run `pnpm --filter @valet/plugin-gmail test -- src/actions/markdown.test.ts` and confirm the renderer module is missing.
- [ ] Add `markdown-it` and `@types/markdown-it` to the Gmail package.
- [ ] Implement `renderMarkdownToHtml(markdown: string): string` with `html: false`, `linkify: true`, `typographer: false`, and `breaks: false`.
- [ ] Re-run the markdown tests and confirm they pass.

### Task 2: MIME Builder

**Files:**
- Modify: `packages/plugin-gmail/src/actions/actions.ts`
- Test: `packages/plugin-gmail/src/actions/mime.test.ts`

- [ ] Write failing tests for multipart/alternative structure, plain markdown fallback, rendered HTML part, UTF-8 subject encoding, outer reply headers, unique boundaries, and boundary collision regeneration.
- [ ] Run `pnpm --filter @valet/plugin-gmail test -- src/actions/mime.test.ts` and confirm `buildMimeMessage` does not yet satisfy the tests.
- [ ] Import `renderMarkdownToHtml` in `actions.ts`.
- [ ] Export `buildMimeMessage` for package-local tests.
- [ ] Generate a `b1_<uuid>` MIME boundary, regenerating if the candidate appears in the plain or HTML parts.
- [ ] Build the outer headers and two MIME parts with CRLF separators.
- [ ] Re-run the MIME tests and confirm they pass.

### Task 3: Tool Guidance And Specs

**Files:**
- Modify: `packages/plugin-gmail/src/actions/actions.ts`
- Modify: `packages/plugin-gmail/skills/gmail.md`
- Modify: `docs/specs/integrations.md`

- [ ] Update `send_email`, `create_draft`, and `update_draft` body descriptions from plain text to markdown.
- [ ] Add Gmail skill guidance for markdown body formatting, plain-text fallback, raw HTML escaping, and image limitations.
- [ ] Update the integrations spec to record Gmail markdown-to-HTML send behavior.

### Task 4: Verification

**Files:**
- Verify all changed files.

- [ ] Run `pnpm --filter @valet/plugin-gmail test`.
- [ ] Run `pnpm --filter @valet/plugin-gmail build`.
- [ ] Run `make generate-registries` if root typecheck needs generated registries.
- [ ] Run `make typecheck`.
- [ ] Commit and open the PR from the Linear branch.

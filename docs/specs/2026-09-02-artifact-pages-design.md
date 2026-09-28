# Artifact pages design

Date: 2026-09-02
Status: accepted
Extends: `docs/specs/2026-08-22-artifacts-design.md`
Related: `docs/specs/2026-08-23-valet-design-design.md`

## Problem

Valet can hand a human one kind of document: a markdown snapshot of a memory
file, rendered as GFM with raw HTML stripped
(`packages/web/src/components/markdown.tsx`). That covers a report. It does
not cover the work the agent is best placed to show: an annotated diff, a
chart over data the session already pulled, four layout options side by side,
a checklist that fills in while a long task runs.

Three gaps block that work.

**The agent cannot publish a page.** The share tool is `mem_share`, whose only
input is a memory path. The stored content is markdown, and the reader strips
every tag. An agent that writes an SVG diagram or a sortable table has nowhere
to put it.

**A reader cannot talk back.** A share link is a dead end: the reader sees the
document, and their feedback travels over Slack, disconnected from the element
it is about and from the session that produced the page.

**The publish leg exists once and is needed twice.** Valet Design
(`docs/specs/2026-08-23-valet-design-design.md`) authors `.dc.html` documents
with real revision history. Its spec describes a read-only share link at
`/sessions/$id/design/share?token=...`, and its plan records that link as
shipped. It is not built: no token, no visibility model, no public route.
Artifacts owns all of that machinery and has no version history at all —
re-sharing overwrites `content` in place. Building the design share link
separately would duplicate the token minting, the org opt-in check, the
share-URL trust ladder, the pre-auth mount, the rate limiter, and the
logged-out reader's return-to-login path.

## Decision

One published-page primitive: **every artifact is a page**.

An artifact stores a **source** (`format: markdown | html`) and serves a
**rendered page**. At publish time the api compiles the source — markdown
through a GFM compiler, HTML verbatim — and the web client renders the result
inside a sandboxed frame under a strict Content Security Policy. There is one
viewer, one element-addressing scheme, and one comment system for a prose
report and an interactive dashboard alike.

`format` survives, but it names the compiler, not a render path. `mem_share`
keeps snapshotting markdown; the `.md` download keeps serving the source; a
re-share keeps working exactly as today. What changes is where the page
renders (the frame, always) and what a reader can do there (anchor a comment
to any element, and send it to the agent).

The publish leg stays in `artifacts`. Design does not grow a second one: when
a user shares a design, the canvas publishes the current revision's bytes as
an `html` artifact through the same route, the same token, and the same
visibility rules.

Three things do not change:

- Sharing is explicit. Writing a file never publishes it.
- The tool surface can only create `org` visibility. Personal artifacts can
  widen to `public` through the web UI with the org's `allowPublicArtifacts`
  opt-in. Team artifacts always require current team membership. The gallery
  and page show Team-only, regardless of their stored visibility.
- An artifact is a snapshot, never a live reference.

## What we take from Claude Code artifacts, and what we reject

The two source documents are `code.claude.com/docs/en/artifacts` and the
Claude help center article on artifacts. Their model: a self-contained HTML
page, published to a private URL, served from a sandboxed origin under a
strict CSP, versioned on every publish, shared through a viewer-facing
control, with comment threads a viewer can leave on the page and route to the
agent.

Adopted:

| Feature | How it lands here |
|---|---|
| HTML as a first-class artifact format | `format` column; the page renders in a sandboxed frame |
| A document shell around the published file | `buildArtifactDocument` in `@valet/shared` |
| Strict CSP with a named external allowlist | `ARTIFACT_CSP`, meta tag in the shell |
| Title, description, and an emoji tab icon | `title` / `description` / `icon` columns |
| Every publish is a version | `artifact_versions` table |
| The publisher picks which version viewers see | `shared_version` column, null means latest |
| Comment threads on the page | `artifact_comments`, element-anchored |
| "Send to Claude" routes a comment to the agent | Delivery into the source session's prompt queue |
| A rendered-size cap | `ARTIFACT_MAX_CONTENT_BYTES`, 2 MiB |
| Theme-aware pages | Shell defines light and dark tokens |

Rejected, with reasons:

- **A separate `*.claudeusercontent.com`-style origin.** Correct, and out of
  scope for one PR: it needs DNS, TLS, and an ingress rule per deployment.
  The sandboxed frame gives an opaque origin today, which closes the same
  attack. `VALET_ARTIFACT_ORIGIN` is the named re-entry seam.
- **MCP connector calls from a published page.** The viewer-account
  delegation model is a large feature with its own consent surface.
- **An asset store for images and fonts.** The engine has a `BlobStore` port
  (`packages/engine/src/types.ts`), so the seam exists. v1 embeds images as
  data URIs and enforces the 2 MiB cap.
- **Editor roles on a shared link.** Valet's sharing is read-only by design;
  editing happens in the session.
- **Comment activation ceremony.** Claude Code requires a thread to be
  "activated" before the agent may reply. Valet's equivalent consent is
  session view access: a comment reaches the agent only when the commenter
  could already open that session and type into it (see "Send to the agent").

## The pipeline

```
publish (source, format)
  │  compile: markdown → GFM HTML (server), html → verbatim
  ▼
version row { content: source, rendered: page body }
  ▼
GET /api/artifacts/:token → { rendered, title, icon, … }
  ▼
/a/$token → buildArtifactDocument(shell + comment runtime) → sandboxed iframe
  │            frame ⇄ parent postMessage: element picking, anchor rects
  ▼
comment popover, threads, "Send to Claude" — in app chrome, outside the frame
```

### Formats

`format` names the compiler for the stored source. It is a property of the
bytes, not a render hint — the render path is the same for both.

| Format | Source | Compile step |
|---|---|---|
| `markdown` | GFM source | `marked` (GFM) to HTML, server-side, at publish |
| `html` | A self-contained HTML document or fragment | Verbatim |

`markdown` stays the default, so every existing row and every `mem_share`
call keeps its meaning. The compiled output of a markdown artifact is plain
semantic HTML styled by the shell's base sheet; it is not sanitized, because
it renders in the same frame, under the same CSP, as an `html` artifact — the
containment does not depend on what the compiler emits.

An `html` artifact must be self-contained. Relative links do not resolve,
because nothing is deployed beside the page. Use in-page anchors instead.

### Mermaid diagrams

A fenced `mermaid` block compiles to the standard `language-mermaid` code marker. The artifact runtime sends its source to the parent page. The parent uses the same Mermaid renderer as memory and chat content.

The renderer uses Mermaid's `strict` security level and disables HTML labels. A second SVG filter removes executable elements, event handlers, remote links, and remote CSS loads. The UI loads the filtered SVG as an image, so SVG scripts cannot run.

If rendering fails, the frame shows an error and the original source. A theme change requests a new render. A content change remounts the frame and discovers the new blocks. The parent coalesces duplicate active, pending, and completed block, source, and theme requests. A newer request always replaces an older result for the same block. It keeps one active render and at most 32 replacement and completed requests per frame. A frame reload or unmount invalidates its coordinator. A stale render cannot send a result to a new or removed frame. The global render queue skips invalidated work before Mermaid loads or parses it.

### Why one render path

The first draft of this spec kept two: markdown through the app's
react-markdown component, HTML through the frame. Element-anchored comments
killed that split. Anchoring needs stable element ids, a picker, overlay
positioning, and highlight rendering — and two render regimes mean building
all four twice, once against the app's live DOM and once across a frame
boundary. One frame means one implementation, and it also upgrades markdown's
isolation from "sanitized into our document" to "not in our document at all."

## The document shell

`buildArtifactDocument` in `packages/shared/src/artifact-page.ts` wraps the
rendered body in one document. It is a pure function, so the whole contract is
unit-testable without a browser.

The shell supplies:

1. `<!doctype html>`, a charset, and a responsive viewport.
2. The CSP, as a `<meta http-equiv>` tag.
3. `<title>` and an emoji favicon, as an inline SVG data URI.
4. A minimal reset plus typography for the compiled-markdown elements: box
   sizing, `max-width: 100%` on media, and a body background painted from a
   token. A page that paints no background borrows the host's, which reads as
   broken in the opposite theme.
5. Light and dark color tokens, for three viewer states. Light tokens sit on
   bare `:root`. The dark block sits under `@media (prefers-color-scheme:
   dark)`, guarded by `:root:not([data-theme="light"])` so an explicit light
   choice can block it. A duplicate dark block sits under
   `:root[data-theme="dark"]`, outside the media query, so an explicit dark
   choice wins regardless of OS preference. `buildArtifactDocument` stamps
   `data-theme` on `<html>` when the caller passes a `theme`; an unstamped
   page follows the reader's system.
6. The comment runtime (below), when the caller asks for it.

The page's own content follows Valet's head whole and verbatim — even when it
is a full document of its own. The shell never searches the artifact for a
`<head>` to splice into: any locator can be decoyed by a `<head>` inside a
comment, script, or attribute, landing the CSP in dead text while the real
head parses without it. Emitting the policy before any artifact-controlled
byte is the only ordering an attacker cannot influence, and a CSP meta
governs everything parsed after it. The parser tolerates the artifact's stray
doctype/html/head/body tokens: its meta and styles still apply (later styles
win the cascade), and a later CSP meta of its own can only tighten, never
loosen (browsers intersect policies; they never replace them).

### Content Security Policy

`ARTIFACT_CSP` is one exported constant, so the api's publish-time
documentation and the web's render-time meta tag cannot drift.

```
default-src 'none';
script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com;
style-src 'unsafe-inline' https://fonts.googleapis.com;
font-src https://fonts.gstatic.com data:;
img-src data: blob:;
media-src data: blob:;
connect-src 'none';
form-action 'none';
base-uri 'none';
frame-src 'none'
```

Three choices in that policy deserve a reason.

`connect-src 'none'` is the important one. A published page has no backend
and no reason to call one. Denying `fetch`, `XHR`, and WebSocket outright
removes the exfiltration channel that a sanitizer cannot see: a page that can
read the DOM but cannot phone home cannot leak what it reads. `postMessage`
is not governed by CSP, which is what lets the comment runtime work.

`'unsafe-inline'` and `'unsafe-eval'` in `script-src` look alarming and are
not. The whole document is attacker-authored in the threat model, so a nonce
protects nothing. The containment boundary is the frame's opaque origin, not
the script directive. Charting libraries commonly compile expressions, which
is why `'unsafe-eval'` is present.

The two script CDNs are the ones the agent is told to use for a library it
cannot inline. Deployments that restrict outbound access can block both; a
blocked library has no fallback, so block it with a fast rejection rather
than a silent drop.

### Size cap

`ARTIFACT_MAX_CONTENT_BYTES` is 2 MiB of source, matching `design_edit`'s
existing cap. The content columns are Postgres `text`, not a blob store. The
publish route rejects a larger document and names the corrective action:
embed fewer raster images, or prefer SVG.

## Rendering: the sandboxed frame

`ArtifactFrame` renders the shell output in an iframe via `srcDoc` with this
sandbox:

```
sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals"
```

`allow-same-origin` is absent, and that omission is the whole security
argument. Without it the frame runs in an opaque origin. It cannot read the
app's cookies or `localStorage`, it cannot reach `window.parent`'s DOM, and a
request it makes carries no credentials. `allow-top-navigation` is also
absent, so the page cannot navigate the tab out from under the reader.

The frame is sized to the viewport and scrolls internally. The parent cannot
measure a cross-origin document's height, and the anchor-rect channel below
deliberately reports only comment anchors, not layout.

The frame remounts on a `srcDoc` change: a republished page must not keep the
previous document's script state.

### Why a frame, and not the design canvas's shadow root

Valet Design renders `.dc.html` by sanitizing with DOMPurify and mounting
under a shadow root. Its spec's resolved decision 1 is correct about its own
case, including the note that a per-artifact CSP is not enforceable inside a
shadow root, because CSP is a document-level control.

That is exactly the reason the published view uses a frame. A frame is a
document, so the CSP applies. Two consequences follow:

- **Scripts can run.** Sanitization has to strip `<script>` to be safe, which
  rules out every interactive page. Origin isolation contains scripts instead
  of removing them.
- **The boundary is enforced by the browser, not by a parser.** DOMPurify is
  the right tool when content must share the app's document. When it does not
  have to, an opaque origin is a stronger claim than any allowlist.

The canvas keeps its shadow-root renderer: it needs live DOM access for
click selection and comment anchoring during authoring, and its content is
the session owner's own work in an authenticated view. The shadow root is the
**authoring** renderer; the frame is the **published** renderer.

## Styling: self-contained pages, skills, and the chart runtime

An artifact is a self-contained asset: everything that styles it lives in
its own bytes. There is deliberately no server-side styling injection and no
stored theme a publish bakes in — that idea was considered and rejected,
because it breaks the snapshot property's simplest reading (the bytes you
published are the bytes served) and because stored design systems are Valet
Design's concept (`docs/specs/2026-08-23-valet-design-design.md`,
`DesignSystemProvider`), not the publish pipeline's.

Consistency across sessions comes from the prompt side instead:

1. **The `artifact-design` skill**
   (`packages/plugin-memory/skills/artifact-design/SKILL.md`) carries the
   design rules and a copy-paste component system — page scaffold, stat
   tiles, data tables, pills, chart blocks, comparisons, timelines — all
   speaking the shell's token vocabulary. The `artifact_publish` tool
   description points the agent at it. Org-specific looks are more skills:
   a brand skill that overrides the defaults wins over this one.
2. **Shell tokens.** The shell defines light/dark-aware CSS variables
   (`--artifact-bg/fg/muted/line/accent`) plus a categorical chart palette
   (`--artifact-chart-1..8`). Pages that style with the variables adapt to
   dark mode for free.
3. **The chart runtime.** The shell injects `window.valetDS` into every page
   (downloads included): a tiny script that resolves theme values lazily
   from CSS variables — `--ds-*` variables the page's own stylesheet
   defines first, the `--artifact-*` defaults second — and exposes
   `palette`, `font`, `textColor`, `gridColor`, plus two adapters for the
   blessed CDN libraries: `applyChartTheme(Chart)` for Chart.js 4 (sets
   defaults and auto-assigns palette colors to datasets that pick none) and
   `echartsTheme()` for ECharts. A page that wants a brand palette declares
   `--ds-chart-1..8`, `--ds-chart-text`, `--ds-chart-grid`, `--ds-font-body`
   in its own CSS and every chart follows, dark mode included.

## Element addressing

Every comment anchors to a **vdid**: the content-hash element id scheme the
design spec defined (`data-vdid`, sha-256 over tag + role + leading text,
truncated). This spec reuses the scheme, computed in the browser instead of
stamped into stored bytes:

- The comment runtime walks addressable elements (headings, paragraphs, list
  items, tables, sections, figures, images, `div`s with direct text) at load
  and assigns each a vdid. An element that already carries `data-vdid` — a
  published design revision — keeps it, so design comment anchors survive
  publishing verbatim.
- The hash is deterministic over the element's tag, its aria role, its
  leading text, and its occurrence index among identical hashes. The rendered
  bytes are stored, so every viewer of a version computes identical ids.
- On a republish, unchanged elements keep their vdid (content-hashed), so
  comments follow them. A comment whose element disappeared is **orphaned**:
  it stays in the thread list flagged "element no longer on the page," which
  is design's rule, and never silently dropped.

Computing at render time rather than publish time keeps the server free of an
HTML parser and keeps the stored source byte-identical to what the author
published. The cost — ids exist only while a real DOM exists — is no cost, because
the only consumer is the viewer.

## Comments

### Model

```sql
CREATE TABLE "artifact_comments" (
  "id" text PRIMARY KEY NOT NULL,
  "artifact_id" text NOT NULL,
  "version" bigint NOT NULL,
  "vdid" text,
  "parent_id" text,
  "body" text NOT NULL,
  "author_user_id" text NOT NULL,
  "sent_to_session" text,
  "resolved_at" bigint,
  "resolved_by" text,
  "created_at" bigint NOT NULL
);
CREATE INDEX "artifact_comments_artifact" ON "artifact_comments" ("artifact_id");
```

- `vdid` null means a page-level comment (no element selected).
- `parent_id` threads replies under a root comment. One level: a reply's
  parent is always a root.
- `version` records which version the commenter was looking at. Threads
  render on every later version (anchored while the vdid still resolves).
- `sent_to_session` records delivery to the agent, for audit.
- Resolve is a flag, not a delete. Roots resolve; replies do not.

### Who can comment

Commenting requires a logged-in user who can read the artifact under
`decideArtifactAccess` — an org member, in practice. Anonymous readers of a
`public` artifact get no comment surface: there is no author identity to
attach and no abuse boundary. This matches the source product, where publicly
shared artifacts do not take comments.

The comment routes live on the token-addressed public router (the page only
knows its token) but resolve the caller themselves and 401 without one:

- `GET /api/artifacts/:token/comments` — threads, plus each author's display
  name and `canSendToSession` for the caller.
- `POST /api/artifacts/:token/comments` — `{ body, vdid?, parentId?,
  sendToSession? }`.
- `POST /api/artifacts/:token/comments/:commentId/resolve` — commenter,
  sharer, or org admin.

### Send to the agent

A comment with `sendToSession: true` is delivered into the artifact's
`sourceSessionId` as a user prompt, attributed to the commenter:

```
[artifact comment] on "<title>" (<element|page>): <body>
```

Authorization is **session view access** (`canViewSession`), the same check
the messages route applies — if the commenter could open that session and
type into it, sending a comment to it grants nothing new. When the commenter
lacks session access, or the artifact has no source session, the comment
still saves and the response says it did not reach the agent, so the UI never
lies about delivery.

The comments response carries `canSendToSession` so the page shows the
"Send to Claude"-style control only to callers whose send would succeed.

### The picker

The comment UI lives in app chrome, outside the frame — the untrusted page
never hosts a text input and never sees comment text. The shell's **comment
runtime** (a Valet-authored inline script in the shell head, not part of the
artifact's bytes) bridges the boundary over `postMessage`:

frame → parent:
- `{ type: "valet-artifact:ready" }` on load.
- `{ type: "valet-artifact:pick", vdid, rect, label }` when the reader clicks
  an element in comment mode. `label` is the element's leading text, for the
  popover header.
- `{ type: "valet-artifact:rects", rects: { [vdid]: rect } }` on scroll,
  resize, and after anchor changes — only for the vdids the parent asked
  about.

parent → frame:
- `{ type: "valet-artifact:mode", picking: boolean }` toggles pick mode
  (hover outline via an injected style, click capture).
- `{ type: "valet-artifact:anchors", vdids: string[] }` names the anchors the
  parent wants tracked and marked.
- `{ type: "valet-artifact:theme", theme: "light" | "dark" | null }` restamps
  `data-theme` on the frame's document when the app theme changes. `null`
  removes the attribute, returning the page to the system default. The
  download builder passes no `theme` to `buildArtifactDocument`, so a saved
  file always follows the reader's system — there is no live frame to
  restamp.

Trust rules, enforced in `ArtifactFrame`: the parent accepts messages only
from the frame's own `contentWindow`, validates every payload shape, treats
`label` as text (never HTML), and clamps rects to the frame's box. The frame
side posts to `"*"` because an opaque origin has no name — that is safe
because the payloads contain nothing secret and the parent filters by source.
A hostile page can fabricate picks and rects; the worst it achieves is a
mispositioned pin on its own page, and the comment body a person then writes
is composed and stored entirely outside the frame. The runtime registers no
capability the page could not already fake — it is a convenience, not a
boundary.

## Versions

Every publish appends a row to `artifact_versions` and increments
`artifacts.version`. The current source, rendered body, title, and format
stay denormalized on `artifacts`, so the public read needs no join in the
default case.

```sql
CREATE TABLE "artifact_versions" (
  "id" text PRIMARY KEY NOT NULL,
  "artifact_id" text NOT NULL,
  "version" bigint NOT NULL,
  "title" text DEFAULT '' NOT NULL,
  "format" text DEFAULT 'markdown' NOT NULL,
  "content" text NOT NULL,
  "rendered" text NOT NULL,
  "actor_user_id" text NOT NULL,
  "created_at" bigint NOT NULL
);
CREATE UNIQUE INDEX "artifact_versions_unique" ON "artifact_versions" ("artifact_id","version");
```

`artifacts.shared_version` decides what a reader gets: `null` (default)
serves the newest publish; a number pins viewers to that version.

The public read serves exactly one version and accepts no version parameter.
This is a security property, not an omission: an older version can contain
something the publisher later removed, and a link holder must not be able to
walk the history. Choosing the shared version is a management action on
`PATCH /api/artifacts/:id`, gated on being the sharer or an org admin.

Revoke keeps the version rows. Re-publishing after a revoke mints a fresh
token, resets visibility to `org`, and continues the version counter, so
version numbers stay stable references for the publisher.

## Data model summary

`artifacts` gains six columns, all `NOT NULL DEFAULT` or nullable, so each is
repairable in place per the pre-1.0 rule:

```ts
format: text("format", { enum: ["markdown", "html"] }).notNull().default("markdown"),
rendered: text("rendered").notNull().default(""),
description: text("description").notNull().default(""),
icon: text("icon").notNull().default(""),
version: bigint("version", { mode: "number" }).notNull().default(1),
sharedVersion: bigint("shared_version", { mode: "number" }),
```

`rendered = ""` on a pre-existing row means "compile `content` on read" — the
read path falls back so old rows keep working without a backfill.

New tables: `artifact_versions` and `artifact_comments`, as above.

### The publish key

The existing unique index
`artifacts_owner_path_unique (owner_type, owner_id, source_memory_path)`
stays, and `source_memory_path` becomes the **publish key** for every
artifact, not only memory-sourced ones:

- A memory share stores the normalized memory path, exactly as today.
- An inline publish stores the caller's `key`, normalized by the same
  `normalizePath` rules.

The column is not renamed. A rename cannot be repaired safely on a deployed
database: `SCHEMA_REPAIRS` entries must survive a rollback, and an older
release would repair the old name and then fail on the new data. The name
records history; the doc comment on the column records the meaning.

An inline publish with the same key overwrites the same artifact and keeps
the URL, which is what makes "republish the dashboard" work.

## API

### Public read

`GET /api/artifacts/:token` is unchanged in auth, rate limiting, and
`X-Robots-Tag`. The response gains what the page renderer needs:

```ts
interface GetArtifactResponse {
  title: string;
  content: string;      // the source — downloads and copy
  rendered: string;     // the page body the frame renders
  format: ArtifactFormat;
  description: string;
  icon: string;
  version: number;
  visibility: ArtifactVisibility;
  updatedAt: number;
  sharedBy?: string;
  canComment: boolean;  // caller is a logged-in reader
}
```

When `shared_version` is set, the content fields come from that version row.

### Publish

`POST /api/artifacts/share` takes one of two request shapes, discriminated by
which field is present; carrying both is a 400.

```ts
// Memory share — unchanged.
{ path: string; revoke?: boolean }

// Inline publish.
{
  key: string;
  title?: string;
  content: string;
  format?: ArtifactFormat;   // default "markdown"
  description?: string;
  icon?: string;
  revoke?: boolean;
}
```

Both paths compile and store `rendered`, append a version row, and bump
`version`. Title resolution, in order: the explicit `title`, the `<title>`
element in the first 8 KiB for `html`, the first `#` heading for `markdown`,
then the key's basename.

A memory share now also carries the doc's `description` onto the artifact,
trimmed and capped at 1000 characters; title resolution is unchanged.

### Management

`PATCH /api/artifacts/:id` gains `sharedVersion?: number | null` alongside
`visibility`. A number that names no version row is a 400.

`GET /api/artifacts/:id/versions` lists a managed artifact's versions without
their content, newest first — sharer-or-admin gated like every management
route.

## Tool surface

`mem_share` is unchanged. A new sibling publishes inline content, or a file
already written in the sandbox:

```
artifact_publish { key?, content?, path?, title?, format?, description?, icon?, revoke? }
```

`content` and `path` are exclusive: pass exactly one. With `path`, the tool
reads the file through the session's sandbox handle, in-process — the read
never goes over HTTP. `format` defaults from the path's extension (`.html`
or `.htm` is `html`, anything else is `markdown`); `key` defaults to the
path, normalized the same way as an inline `key`. The size cap is checked
against `stat` before the read, so an oversized file is rejected without
loading its bytes; a failed read (the file moved, or is unreadable) returns a
`[artifact_error]` naming the corrective action, not a stack trace.

Once the tool has content, either passed inline or read from the sandbox,
both tools go through `POST /api/artifacts/share` over the same
internal-token transport, so the HTTP seam stays the single chokepoint.

The tool description states the audience rule verbatim, because the agent
relays it to the user: a link serves logged-in members of the user's org, and
only a human can widen it. `artifact_publish` also carries the format
guidance, because the model has to choose:

- Use `markdown` for prose a person will read.
- Use `html` when the output is easier to look at than to read: a chart, a
  diagram, an annotated diff, options side by side, an interactive control.
- Inline every stylesheet and script. Embed images as data URIs. Only two
  script CDNs load, and no other external host does.

## Web surfaces

`/artifacts` is the gallery of pages the caller published: a list of rows
(title, format, version, visibility, updated time), each linking in-app to
`/a/$token`, with a copy-link action and a revoke action per row. A revoked
artifact drops out of the list.

`/a/$token` keeps its standalone shell, the 401 path to `/login?next=`, and
the revoked-link copy. Inside it:

- A header: icon, title, description, version, sharer byline, download. The
  download serves the **source** — `.md` for markdown, `.html` (shelled, so
  it opens standalone) for html.
- The `ArtifactFrame`, full-width below the header.
- The comment layer: a "Comment" toggle enters pick mode; clicking an element
  opens the popover (as in the mock: avatar, textarea, **Send to Claude** and
  **Add comment** actions, with the send hint) pinned at the element's rect;
  a thread panel lists open and resolved threads, with orphaned anchors
  flagged. Pins render at the rects the frame reports and follow scroll.
  Anonymous readers see the page with no comment affordances.

`ShareControls` gains a version selector: "Viewers see" with `Latest` and
each published version, beside the existing visibility control, hidden while
only one version exists.

## How Valet Design uses this

Design does not grow a share route. Its Share control publishes the current
revision through the artifact publish route:

```
key:     design/{sessionId}
format:  html
content: the current revision's .dc.html bytes, tokens inlined
title:   the session title
```

Design keeps its own revision history, which is richer than the artifact
version counter and carries the fence and interleave detection the canvas
needs. Publishing is a projection of that history: one artifact version per
publish, not one per edit. Because published design bytes already carry
`data-vdid`, the comment runtime adopts those ids verbatim, and a published
page's comment anchors line up with the canvas's own comment anchors.

Two rules carry over from the design spec and are normative here:

1. **Token subset only.** The published bytes must go through
   `inlineDesignTokens` with the artifact-scoped subset
   (`GET /:id/design/tokens?subset=artifact`, the `var(--*)` scan) before
   publishing. The full design system maps component names to source paths in
   the customer's repository — the exfiltration surface a share link must
   never carry (design spec threat 2, resolved decision 3).
2. **The canvas renderer stays.** Authoring keeps the shadow root; only the
   published copy goes through the frame.

Wiring the Design Share button is not in this PR, because
`feat/valet-design-spec` has not merged. This section is the contract that PR
implements against.

## Security notes

- **Origin isolation is the boundary.** An artifact page runs in an opaque
  origin with no `allow-same-origin`. It cannot read app cookies, reach
  `window.parent`'s DOM, or send a credentialed request.
- **`connect-src 'none'` closes exfiltration.** A page that reads its own DOM
  cannot send what it reads anywhere.
- **The comment UI never enters the frame.** Composition, storage, and
  rendering of comment text happen in app chrome. The frame's runtime can be
  spoofed by a hostile page, and the worst outcome is a mispositioned pin on
  that page's own render.
- **"Send to Claude" grants nothing new.** Delivery requires `canViewSession`
  on the source session — the exact check the messages route already applies
  to typing into that session.
- **The token is the only capability for a `public` artifact.** 128 bits from
  `crypto.randomBytes`, base64url. No listing route is public.
- **`org` visibility is checked on every read**, and the `public` opt-in is
  live-checked, so an admin turning it off re-gates existing links with no
  sweep. Comments additionally require a resolved user on every call.
- **The publish path enforces the size cap** before the write.
- **Version history is not readable by link.** The public read serves one
  version and takes no version parameter.

## Out of scope, with re-entry seams

| What | Why | Re-entry |
|---|---|---|
| A dedicated artifact origin | Needs DNS, TLS, and an ingress rule per deployment | `VALET_ARTIFACT_ORIGIN`: when set, `ArtifactFrame` loads `src` from that origin instead of `srcDoc` |
| MCP connector calls at view time | Needs a viewer consent surface Valet does not have | A `capabilities` column declaring them per artifact |
| Binary assets (images, fonts, PDFs) | No blob-backed artifact storage yet | `BlobStore` port exists; an `artifact_assets` table keyed by artifact id |
| Agent auto-reply to comments | Needs a watch loop and a rate-limit story | `sent_to_session` already lands the comment in the session; a session-side subscription closes the loop |
| Editor roles on a share link | Valet sharing is read-only by design | Editing stays in the session |

## Implementation notes

- `0000_app.sql` is edited in place per the pre-1.0 rule. Every added column,
  both new tables, and their indexes need matching `SCHEMA_REPAIRS` entries
  in `packages/api/src/lib/drizzle.ts`, or the dev-v2 rollout sticks on the
  old image. Run `make dev-clean` in every worktree holding dev data.
- The shell builder and the comment runtime live in `@valet/shared` because
  both the api (publish validation, download) and the web (render) need the
  same CSP string and the same document. The module stays dependency-free and
  browser-safe; the runtime ships as a source string, not a bundled asset.
- The markdown compiler (`marked`, GFM) is an api dependency only. The web
  never compiles; it renders what the api stored.
- `ArtifactFrame` remounts on a `srcDoc` change — a republished page must not
  keep the previous document's script state.

### Reader management

The artifact reader exposes Revoke to its sharer or an organization admin when
that caller can access the artifact. The read API supplies this capability after
the existing organization and team checks. Anonymous readers and other viewers
receive no management capability. Revocation uses the existing endpoint and
confirmation dialog; the reader then shows that the link is revoked.

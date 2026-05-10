# Greenfield API + Web Implementation Plan

> **Supersedes:** `docs/plans/2026-05-06-worker-to-api-engine-integration.md` and `docs/plans/2026-05-08-node-first-api.md`. The first plan tried to convert the existing worker in place; abandoned because the legacy carries too much we don't want to bring forward (raw-D1 helpers, c.env-coupled services, DO-mediated everything). The second plan greenfielded the API at `packages/api` but kept the existing client and bridged engine events to its WS shape; superseded because we're now also greenfielding the client (`packages/web`) so we can design a clean wire shape end-to-end and own the primitive layer in the UI.

> **Existing scaffold to inherit:** the prior plan already shipped `packages/api` scaffolding, schema (orgs/users/sessions/threads/messages), Drizzle migrations, `FsBlobStore`, `EngineHost`, `buildNodeProviders`, `providersMiddleware`, and a stub `authMiddleware`. The wire bridge in `packages/api/src/engine/bridge.ts` targets the legacy client and gets *replaced* in this plan (we're greenfielding the client, so we design our own clean wire shape).

**Goal:** End-to-end agent dogfood in a browser. Open a session, type a prompt, see the engine drive Anthropic, run `bash` inside a Docker sandbox, and stream results back. Two new packages, agent-loop-only scope.

**Architecture:**
- `packages/api` — Node-first API. Hono + `@hono/node-server` + `@hono/node-ws`. Engine + Docker sandbox + sqlite providers wired at boot. ~10 routes, stub auth, no Durable Objects, no CF coupling. Schema, providers, EngineHost already scaffolded; this plan adds wire types, routes, main entry, and replaces the legacy-client bridge with a clean one.
- `packages/web` — Vite + React + Tailwind + Radix primitives + TanStack Router/Query. Agent-loop screens only. Intentional primitive layer (own components over Radix, *not* shadcn).
- `packages/worker` (legacy CF worker) and `packages/client` stay frozen. Production CF deploy keeps using them, untouched, until a future cutover plan.
- `@valet/engine`, `@valet/store-sqlite`, `@valet/sandbox-docker`, `@valet/sandbox-local`, plugin packages — shared & portable. No changes.

**Tech stack:**

Server:
- Hono `^4`
- `@hono/node-server`, `@hono/node-ws`
- Drizzle ORM (`better-sqlite3` driver)
- `@valet/engine`, `@valet/store-sqlite`, `@valet/sandbox-docker`, `@valet/sandbox-local`
- `@mariozechner/pi-ai` for Anthropic
- TypeScript, Vitest, `tsx`

Web:
- Vite 6, React 19
- TanStack Router (file-based), TanStack Query
- Tailwind 3 (v4 deferred — too new to fight ecosystem rough edges during a greenfield)
- Radix UI primitives (build our own thin wrappers; not shadcn)
- Lucide icons
- Zustand for ephemeral UI state only (selected session, draft prompt text, etc.)

**Wire protocol:**
- REST for queries/mutations (JSON, simple shapes)
- WebSocket for engine event stream (per-session subscription)
- Wire types defined in `packages/api/src/wire/types.ts`. The web package imports from `@valet/api/wire` directly via the workspace.

**Out of scope:**
- Real OAuth (GitHub/Google/Slack) — stub auth returns a single hardcoded local user.
- Workflows, integrations, dashboards, analytics, mailbox, channel-webhooks — return 501.
- CF deploy of the new server — Node-only for this plan. CF integration is a separate plan.
- Migrating production data into the new schema. New server uses fresh local sqlite under `~/.valet/`.
- Multi-user, orgs, RBAC.

**Out of scope but should still work:**
- The legacy worker's existing CF deploy — must not be touched.

---

## File structure

```
packages/api/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── main.ts                    # Node entry point
│   ├── app.ts                     # createApp(providers) — Hono app
│   ├── env.ts                     # config loader (env vars + defaults)
│   ├── auth/
│   │   └── stub.ts                # local user middleware
│   ├── providers/
│   │   ├── types.ts               # Providers interface
│   │   └── build.ts               # buildProviders()
│   ├── engine/
│   │   ├── host.ts                # EngineHost (Map<sessionId, Engine>)
│   │   └── event-bridge.ts        # BusEvent → wire event mapping
│   ├── routes/
│   │   ├── auth.ts
│   │   ├── sessions.ts
│   │   ├── threads.ts
│   │   ├── messages.ts
│   │   └── ws.ts
│   ├── wire/
│   │   └── types.ts               # REST + WS shapes (single source of truth)
│   └── shutdown.ts                # SIGINT/SIGTERM hook → destroy sandboxes
└── README.md

packages/web/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.ts
├── postcss.config.js
├── index.html
├── src/
│   ├── main.tsx
│   ├── routes/                    # TanStack Router file-based
│   │   ├── __root.tsx
│   │   ├── index.tsx              # / → redirects to first session or empty state
│   │   └── sessions/
│   │       └── $sessionId.tsx
│   ├── components/
│   │   ├── primitives/            # Our own Button, Input, Dialog, etc. over Radix
│   │   ├── layout/                # AppLayout, Sidebar, Topbar
│   │   ├── session/               # SessionListItem, MessageList, MessageItem,
│   │   │                          #   ToolCallCard, PromptComposer, etc.
│   │   └── new-session-dialog.tsx
│   ├── api/
│   │   ├── client.ts              # typed fetch wrapper
│   │   ├── queries.ts             # TanStack Query hooks
│   │   └── ws.ts                  # useSessionStream hook
│   ├── stores/
│   │   └── stream.ts              # Zustand: per-session live event log
│   ├── lib/
│   │   ├── tokens.ts              # design tokens (colors, spacing, radii, type)
│   │   └── cn.ts                  # tw-merge + clsx
│   └── styles/
│       └── globals.css            # Tailwind base + tokens as CSS vars
└── README.md
```

---

## Sequencing

The server comes first because it can be dogfooded standalone (curl + wscat). Once the server is solid, the web is consuming a known-good API rather than co-developing both blind.

### Server tasks (#75–#80)

**S1: Scaffold `packages/api`** — package.json with deps, tsconfig, vitest config, root tsconfig reference, vitest workspace entry. Hello-world route boots; pnpm install resolves clean.

**S2: Providers + EngineHost** — `buildProviders()` wires `SqliteSessionStore` (over better-sqlite3 with applied migrations), `DockerSandboxProvider`, `InMemoryEventBus`, `InMemoryCredentialStore`. `EngineHost` class caches one `Engine` per sessionId, restores from store on demand, destroys on session delete. SIGINT/SIGTERM hook destroys all live sandboxes (lesson from REPL).

**S3: Wire types + auth stub + sessions CRUD** — `src/wire/types.ts` defines REST + WS shapes. Auth middleware sets a single hardcoded local user. Routes: `GET /api/auth/me`, `GET /api/sessions`, `POST /api/sessions`, `GET /api/sessions/:id`, `DELETE /api/sessions/:id`.

**S4: Threads + messages routes** — `GET /api/sessions/:id/threads`, `POST /api/sessions/:id/threads`, `GET /api/threads/:tid/messages` (paged), `POST /api/threads/:tid/messages` (sends prompt, returns receipt; events stream over WS in S5).

**S5: WebSocket event stream** — `GET /api/sessions/:id/ws` upgrades. Subscribe to engine bus, map each `BusEvent` to a wire event, push to client. Heartbeat ping. Event sequence numbers for client-side dedupe on reconnection.

**S6: Server dogfood** — `curl` creates session + posts prompt. `wscat` subscribes to WS. Verify the streaming events arrive: `text_delta`, `tool_call` (bash), `tool_result`, `turn_end`. Real Anthropic call, real Docker round-trip.

### Web tasks (#81–#88)

**W1: Scaffold `packages/web`** — Vite + React 19 + Tailwind 3 + TanStack Router (file-based) + TanStack Query. Tailwind config with token CSS vars. Imports types from `@valet/api`. `pnpm dev` boots a hello-world page.

**W2: Primitive layer + design tokens** — Tailwind theme: color scale (neutral, accent, danger, success), spacing scale, radius scale, font stack (sans, mono), font sizes. Build primitives over Radix: `Button`, `Input`, `Textarea`, `Label`, `Dialog`, `DropdownMenu`, `Select`, `Tooltip`, `Card`, `Avatar`, `Badge`, `Spinner`, `Separator`, `ScrollArea`. Each primitive has its own variant/size API; Radix is an implementation detail.

**W3: API client + Query hooks + WS hook** — Typed fetch wrapper using wire types. TanStack Query hooks: `useSessions`, `useSession`, `useThreads`, `useMessages`, `useCreateSession`, `useDeleteSession`, `useSendPrompt`. `useSessionStream(sessionId)` subscribes to WS and pipes events into a Zustand store keyed by sessionId. Reconnects on disconnect with the last-seen seq number.

**W4: Layout + sessions list** — Sidebar + main pane layout. Sidebar lists sessions with selection state; "new session" button opens W5. Empty state when no sessions exist.

**W5: New session modal** — Dialog: workspace path input, optional initial prompt, "Create" button. POST to `/api/sessions`, navigate to `/sessions/:id`. Default workspace path is `~/.valet/workspaces/<sessionId>`.

**W6: Session detail + message list** — Main pane has session header (workspace path, sandbox status), scrolling message list, composer at bottom. `MessageItem` renders user / assistant / tool_call / tool_result variants. Streaming text deltas append in place.

**W7: Prompt composer + live stream** — Textarea + send button (Cmd+Enter). On submit, POST to messages endpoint. WS subscription is live for the open session; events stream into the message list. "Agent thinking" indicator while turn is in progress.

**W8: End-to-end browser dogfood** — Boot server + web. Open browser, create session with workspace `/tmp/dogfood`, prompt: *"use bash to write hello.txt with content 'hi' then read it back."* Verify Docker container created, file appears on host at `/tmp/dogfood/hello.txt`, content streamed back to browser, container destroyed when session deleted.

### Polish (#89)

**P1: Makefile + READMEs + follow-ups**
- `make dev-local` runs server + web together.
- README in each new package explaining boot, env vars, scope.
- Update root CLAUDE.md to reflect the new structure.
- Separate doc capturing follow-ups: real auth, integrations port, workflows port, CF cutover plan.

---

## Verification gates

1. **End of S6:** Server passes curl + wscat dogfood. Real Anthropic call, real Docker round-trip, events visible on the wire.
2. **End of W2:** Primitive layer renders cleanly in isolation (a tiny showcase route is fine, not Storybook).
3. **End of W7:** Web renders a session and shows real-time deltas against the running server.
4. **End of W8:** Full agent loop works in a browser with no manual intervention.

If a gate fails, fix here. Don't push past.

---

## Known wrinkles

1. **Per-session Engine instance lifetime.** Engines hold a sandbox handle. If the server restarts, sandboxes leak. Two mitigations: (a) destroy all on SIGTERM/SIGINT (S2); (b) on boot, list any running containers labeled `valet=true` and destroy them. The REPL learned this lesson; replicate.

2. **WebSocket reconnection.** Browsers will drop WS on tab background or network blip. The bridge needs to support resubscribing with a `lastSeq` query param so the server can replay missed events from the engine bus buffer (or at minimum, send a "missed events, please refetch" hint).

3. **Engine event → wire event mapping.** Engine emits typed `BusEvent`s; we keep them simple on the wire. Likely shape: `{ seq, type: 'text_delta' | 'tool_call_start' | 'tool_call_end' | 'message_start' | 'message_end' | 'turn_start' | 'turn_end' | 'decision_gate_open' | 'decision_gate_close' | 'error', payload: {...} }`. Pin this shape in `wire/types.ts` early.

4. **Decision gates in the UI.** Engine exposes them as first-class events. UI needs to render an approval prompt when a gate opens and POST a decision back. Out of scope for W7 if it's complex; can land in a follow-up. But scaffold the wire shape now so we don't have to break it later.

5. **Docker daemon required.** Server boots fail without Docker. Document clearly in README. Optionally fall back to `LocalSandboxProvider` via `VALET_SANDBOX=local`.

6. **Anthropic API key.** Required at boot. Read from `ANTHROPIC_API_KEY` env var. Server fails fast with a clear message if missing.

7. **Wire types as a workspace export.** `packages/api/package.json` should export a `./wire` subpath: `{ "exports": { "./wire": "./src/wire/types.ts" } }`. Web does `import type { ... } from '@valet/api/wire'`. No build step needed — Vite resolves source TS via Vite's TS support; the server consumes its own types directly.

8. **Tailwind v3 over v4.** v4 just landed. Two greenfield projects + bleeding-edge Tailwind = too many moving parts. Pin v3.4.x. Migrate later when both projects are stable.

9. **No shadcn.** Tempting because it's fast. But the user wants intentional primitives, and shadcn ships someone else's design choices. Build over Radix directly with our own variant API.

10. **Old packages stay frozen.** Do *not* edit `packages/api` (the renamed worker) or `packages/client` during this plan. Production CF deploy uses them. Cutover is a separate plan.

---

## Done criteria

- [ ] `packages/api` boots, serves the agent-loop routes against a local sqlite + Docker.
- [ ] Server passes the curl + wscat dogfood end-to-end (S6).
- [ ] `packages/web` boots, renders the agent loop with intentional primitives.
- [ ] Browser dogfood passes (W8): file written by Docker, content streamed back, container cleaned up.
- [ ] `make dev-local` boots both packages together.
- [ ] READMEs exist in each new package; CLAUDE.md updated.
- [ ] Existing CF prod deploy still works: `wrangler deploy --dry-run` on `packages/api` succeeds untouched.
- [ ] No regressions in shared packages: `pnpm test` passes.

When all checked: this work is mergeable as the new local-dev experience. CF cutover is a future plan.

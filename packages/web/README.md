# @valet/web

Greenfield client for the Valet agent loop. Vite + React 19 + Tailwind 3 + TanStack Router/Query + Radix primitives.

This is **not** the legacy `packages/client`. That stays as-is for the production Cloudflare deploy. This package targets the new Node API at `packages/api` and ships only the agent-loop screens.

## Run it

```bash
make dev-local         # starts API + web together
# or just web (with the API already running):
pnpm --filter @valet/web dev
```

Open `http://localhost:5173`. Vite proxies `/api` (HTTP and WebSocket) to the API on `:8788`.

If your API is somewhere else:

```bash
VITE_API_URL=http://localhost:9000 pnpm --filter @valet/web dev
```

## Stack

- **Vite 6** for dev/build, with the `@tanstack/router-plugin` generating `src/routeTree.gen.ts` from the file-based routes.
- **React 19** + **TanStack Router** (file-based) + **TanStack Query** for REST.
- **Tailwind 3** with our own design tokens (color/radius/type) in `tailwind.config.ts` and CSS vars in `src/styles/globals.css`. Light/dark via `prefers-color-scheme`.
- **Zustand** keys live event state per session id (`src/stores/stream.ts`).
- **Radix UI** primitives, wrapped intentionally in `src/components/primitives/` — own variant/size APIs, *not* shadcn.
- **Lucide** icons.

## Layout

```
src/
├── routes/
│   ├── __root.tsx                # AppShell + Sidebar + new-session dialog
│   ├── index.tsx                 # empty-state landing
│   ├── primitives.tsx            # internal showcase route
│   └── sessions.$sessionId.tsx   # session detail (header + list + composer)
├── components/
│   ├── primitives/               # Button, Input, Dialog, … over Radix
│   ├── layout/                   # AppShell, Sidebar
│   └── session/                  # MessageItem, MessageList, Composer, SessionHeader
├── api/
│   ├── client.ts                 # typed fetch wrapper using @valet/api/wire
│   ├── queries.ts                # TanStack Query hooks
│   └── ws.ts                     # useSessionWebSocket
├── stores/
│   └── stream.ts                 # Zustand: per-session live event log
└── lib/
    └── cn.ts                     # tailwind-merge + clsx
```

## Wire types

Imported directly from the workspace:

```ts
import type { Message, WireEvent, SessionDetail } from "@valet/api/wire";
```

No build step — Vite resolves the source TypeScript through the workspace package's `./wire` export.

## Design tokens

Single source of truth in `tailwind.config.ts`. Component code never hard-codes hex values or magic spacing — it uses Tailwind class names that map to the tokens.

Token families:
- `colors.neutral.{50..950}` — grayscale (OKLCH-tuned)
- `colors.accent.{50..700}`, `colors.danger.{500,600}`, `colors.success.{500,600}`
- `borderRadius.{sm,DEFAULT,md,lg}`
- font stacks: `sans` (system), `mono`

CSS vars in `globals.css` (`--bg`, `--fg`, `--border`, `--muted`) flip based on `prefers-color-scheme` so primitives can theme without prop drilling.

## What it doesn't do (yet)

- Multi-thread session UI (the wire carries `threadId`, but v1 renders the single default thread).
- Decision-gate prompts.
- Tool result formatting beyond a `<pre>` block.
- Markdown rendering of assistant text.
- Image / attachment parts.
- Cmd palette, search, settings.
- Mobile drawer for the sidebar.

## Showcase route

`/primitives` renders all primitives in isolation — useful when iterating on tokens or component variants.

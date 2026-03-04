# Project Structure

```
valet/
├── packages/
│   ├── client/                # React SPA
│   │   └── src/
│   │       ├── api/           # API client, React Query hooks
│   │       ├── components/    # UI components (chat, sessions, panels, etc.)
│   │       ├── hooks/         # Custom hooks (chat, websocket, SSE, theme)
│   │       ├── routes/        # TanStack file-based routes
│   │       └── stores/        # Zustand state (auth, UI)
│   ├── worker/                # Cloudflare Worker
│   │   ├── src/
│   │   │   ├── routes/        # Hono API routes
│   │   │   ├── durable-objects/  # SessionAgent, EventBus, APIKeys
│   │   │   ├── middleware/    # Auth middleware
│   │   │   └── lib/           # DB helpers, utilities
│   │   └── migrations/        # D1 SQL migrations
│   ├── runner/                # Sandbox runner
│   │   └── src/
│   │       ├── bin.ts         # Entry point
│   │       ├── agent-client.ts  # WebSocket client to DO
│   │       ├── prompt.ts      # OpenCode prompt handling
│   │       └── gateway.ts     # Auth proxy (port 9000)
│   └── shared/                # Shared types & errors
├── backend/                   # Modal Python backend
│   ├── app.py                 # Modal App, web endpoints
│   ├── session.py             # Session state tracking
│   ├── sandboxes.py           # Sandbox lifecycle
│   └── images/                # Sandbox image definitions
├── docker/                    # Sandbox container setup
│   ├── Dockerfile.sandbox
│   └── start.sh
├── docs/                      # Documentation
├── V1.md                      # Full architecture spec
├── Makefile                   # Dev, test, deploy commands
└── .beans/                    # Task tracking
```

## Tech Stack

| Layer | Tech | Key Files |
|-------|------|-----------|
| Frontend | React 19, Vite 6, TanStack Router/Query, Zustand, Tailwind, Radix UI | `packages/client/src/` |
| Worker | Cloudflare Workers, Hono 4, D1 (SQLite), R2, Durable Objects | `packages/worker/src/` |
| Shared | TypeScript types, error classes | `packages/shared/src/` |
| Runner | Bun, TypeScript, `@opencode-ai/sdk`, Hono | `packages/runner/src/` |
| Backend | Python 3.12, Modal SDK | `backend/` |
| Sandbox | OpenCode, code-server, Xvfb+VNC, TTYD | `docker/` |

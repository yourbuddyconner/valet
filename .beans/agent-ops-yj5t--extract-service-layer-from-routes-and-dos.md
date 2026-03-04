---
# valet-yj5t
title: Extract service layer from routes and DOs
status: done
type: epic
priority: medium
tags:
    - worker
    - architecture
    - refactor
created_at: 2026-02-23T18:00:00Z
updated_at: 2026-02-23T18:00:00Z
---

Extract a `packages/worker/src/services/` layer that owns all database reads/writes and business logic. Route handlers and Durable Objects become thin wrappers that validate input, call a service function, and return the result.

## Problem

Today, DB logic and business rules are spread across three locations:

1. **`packages/worker/src/lib/db.ts`** (3,390 lines) — a monolithic file containing every D1 query for every resource (users, sessions, messages, workflows, personas, channels, mailbox, tasks, orchestrator, memories, etc.). Functions are pure data access with no business logic.

2. **Route handlers** (`packages/worker/src/routes/*.ts`, 9,200+ lines across 24 files) — mix input validation, authorization checks, business logic, DB calls, DO coordination, and response formatting in the same function bodies. For example, `sessions.ts` (1,282 lines) constructs Modal URLs, builds spawn requests, calls DOs, updates DB state, and handles GitHub token lookups all inline.

3. **Durable Objects** (`session-agent.ts`, `workflow-executor.ts`) — contain their own internal state management plus direct D1 calls for things like session status updates and message persistence.

This creates several problems:

- **No single place to understand business rules.** Want to know what happens when a session is created? Read the route handler, then the DO `/start` endpoint, then `db.createSession()`, then the Modal backend call. The logic is split across 4 files.
- **DB swap is a full rewrite.** Moving from D1 to PostgreSQL means touching every route handler and DO, not just the data access layer. The `db.ts` functions use raw SQL strings with D1-specific APIs (`db.prepare().bind().first()`).
- **Hard to test.** Route handlers can't be unit tested without mocking Hono context, D1, DOs, and external services all at once. A service function with injected dependencies is straightforward to test.
- **Duplication.** Multiple routes query the same data in slightly different ways (e.g., session access checks are repeated across `sessions.ts`, `orchestrator.ts`, `agent.ts`).

## Design

### New Directory Structure

```
packages/worker/src/services/
├── sessions.ts        # Session CRUD, status transitions, access control
├── messages.ts        # Message persistence, parts handling, history queries
├── users.ts           # User CRUD, identity links, preferences
├── workflows.ts       # Workflow definitions, versioning, proposals
├── executions.ts      # Execution lifecycle, step tracking
├── triggers.ts        # Trigger CRUD, schedule management
├── integrations.ts    # OAuth tokens, provider connections
├── personas.ts        # Persona CRUD, file management, visibility
├── orchestrator.ts    # Orchestrator identity, memories, coordinator logic
├── channels.ts        # Channel CRUD, bindings, messaging
├── repos.ts           # GitHub repo operations, PR/issue proxying
├── admin.ts           # Org settings, roles, API keys, invites
├── dashboard.ts       # Aggregate metrics, adoption stats
└── index.ts           # Re-exports
```

### Service Function Signature Pattern

Each service function receives an explicit `D1Database` (or future `DrizzleDB`) instance and returns typed results:

```typescript
// packages/worker/src/services/sessions.ts
import type { D1Database } from '@cloudflare/workers-types';
import type { AgentSession } from '@valet/shared';

export async function createSession(
  db: D1Database,
  params: CreateSessionParams
): Promise<AgentSession> {
  // All business logic + DB writes here
}

export async function assertSessionAccess(
  db: D1Database,
  sessionId: string,
  userId: string
): Promise<AgentSession> {
  // Access control + fetch in one call
}
```

### Route Handler Pattern (After)

```typescript
// packages/worker/src/routes/sessions.ts
sessionsRouter.post('/', authMiddleware, zValidator('json', createSessionSchema), async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');

  const session = await sessionService.createSession(c.env.DB, {
    userId: user.id,
    ...body,
  });

  return c.json(session, 201);
});
```

### Migration Strategy

This is a refactor, not a rewrite. Migrate incrementally:

1. **Phase 1 — Move `db.ts` functions into domain-specific service files.** No logic changes; just split the monolith. Route handlers import from `services/sessions` instead of `lib/db`. `lib/db.ts` becomes a thin re-export layer for backwards compatibility (delete later).

2. **Phase 2 — Pull business logic out of route handlers into services.** Start with the largest routes: `sessions.ts`, `workflows.ts`, `orchestrator.ts`. Move authorization, DO coordination, and state machine transitions into service functions.

3. **Phase 3 — Pull business logic out of DOs.** The SessionAgentDO's D1 writes (session status updates, message persistence) should call service functions rather than doing raw SQL. The DO still owns its internal SQLite state and WebSocket management.

4. **Phase 4 — Introduce a DB abstraction.** Replace `D1Database` parameter type with a `DatabaseClient` interface. Provide a D1 implementation (current) and a Drizzle/PostgreSQL implementation (future). This is the payoff — swapping the backing store touches only the implementation, not the services or routes.

### What Stays in `lib/db.ts`

Low-level utilities that aren't domain-specific:
- `toCamelCase()` / `toSnakeCase()` helpers
- Cursor-based pagination helpers
- Any generic D1 wrapper functions

### What Stays in Route Handlers

- Zod validation
- Auth middleware calls
- Response formatting (`c.json()`, status codes)
- DO stub creation and HTTP calls to DOs

### What Stays in DOs

- Internal SQLite state (message ledger, prompt queue, questions)
- WebSocket connection management
- Runner ↔ Client message routing
- Alarm/scheduled handlers

## Acceptance Criteria

- [ ] `packages/worker/src/services/` directory exists with domain-specific modules
- [ ] `db.ts` monolith is split — each service file owns its domain's queries
- [ ] Route handlers for `sessions.ts` call service functions instead of `lib/db` directly
- [ ] Route handlers for `workflows.ts` call service functions instead of `lib/db` directly
- [ ] No business logic in route handlers (validation + service call + response only)
- [ ] `pnpm typecheck` passes with no regressions
- [ ] No functional changes — all existing API behavior is preserved
- [ ] Service functions have explicit `D1Database` parameter (ready for future abstraction)

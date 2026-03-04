---
# valet-cf0x
title: Decouple worker from Cloudflare primitives
status: in_progress
type: epic
priority: medium
tags:
    - worker
    - architecture
    - refactor
    - infrastructure
created_at: 2026-02-24T00:00:00Z
updated_at: 2026-02-27T00:00:00Z
---

## Completion Status

### Phase 0: Convert raw SQL to Drizzle — DONE

Deployed 2026-02-27 (`01fd86a`). All Drizzle-convertible queries in the 18 `lib/db/` files now use the Drizzle query builder. Functions that use Drizzle accept `AppDb` (`BaseSQLiteDatabase<any, any, any>` from `drizzle-orm/sqlite-core`); functions with legitimately raw SQL (FTS5, batch, complex dynamic SQL) retain `D1Database`.

What was done:
- Converted ~80 raw `.prepare()` queries to Drizzle across 18 db/ files
- Deduplicated cron handler queries in `index.ts` (calls db/ functions instead of inline SQL)
- `listWorkflowHistory` converted from raw SQL to Drizzle

What remains raw (intentional — ~12 queries):
- FTS5 search queries (`MATCH`, `bm25()`, rowid sync) — will be abstracted by SearchProvider
- `db.batch()` calls (D1-specific batching API)
- 2 dynamic SQL builders (`updateWorkflow`, `updateTrigger`) with dynamic SET clauses
- Recursive date CTE in dashboard
- Complex queries using `GROUP_CONCAT`, `NOT EXISTS` subqueries, or `rowid`

### Phase 1: Abstract database and search — PARTIAL

Deployed 2026-02-27 (same commit). The D1-side abstraction is complete. Postgres support and dual-dialect schema are not yet started.

What was done:
- `AppDb` type defined as `BaseSQLiteDatabase<any, any, any>` in `lib/drizzle.ts`
- `dbMiddleware` created — injects Drizzle instance per-request via `c.set('db', getDb(c.env.DB))`
- All 18 db/ files: Drizzle functions accept `AppDb`, raw SQL functions keep `D1Database`
- All 20 route files: pass `c.get('db')` for AppDb functions, `c.env.DB` for raw SQL
- All 11 service files: create `getDb(env.DB)` internally, pass to AppDb functions
- Both DOs: lazy `appDb` getter pattern (`private get appDb(): AppDb`)
- Cron handlers in `index.ts`: `const db = getDb(env.DB)` at top of each handler
- `SearchProvider` interface defined (`lib/search/types.ts`)
- `SqliteFts5SearchProvider` implementation (`lib/search/sqlite-fts5.ts`)
- `middleware/db.test.ts` added, `credentials.test.ts` assertions tightened
- 0 typecheck errors, 36/36 tests passing

What remains:
- [ ] `PgTextSearchProvider` implementation
- [ ] Postgres migration set (schema parity with SQLite)
- [ ] Dual-dialect Drizzle schema (or two schema dirs)
- [ ] Recursive date CTE dialect handling
- [ ] `D1Database` still imported in db/ files for raw SQL functions — needs elimination or isolation
- [ ] Wire `SearchProvider` into orchestrator (currently not used, just defined)

### Phase 2–7: Not started

- Phase 2: Abstract object storage (R2 → ObjectStorage interface)
- Phase 3: Abstract real-time / PubSub (EventBusDO → PubSub interface)
- Phase 4: Abstract scheduling (cron + alarms → Scheduler interface)
- Phase 5: Decompose SessionAgentDO
- Phase 6: Docker Compose local dev environment
- Phase 7: Rename `packages/worker` → `packages/gateway`

---

Introduce platform abstraction interfaces so the worker package can run on Cloudflare Workers (current) or a standard Node/Bun runtime on Kubernetes, with the door open for other deployment targets. Support both D1 (SQLite) and Postgres as switchable database backends via Drizzle ORM, with a search abstraction for the only queries that can't go through Drizzle. Rename `packages/worker` to `packages/gateway` to reflect its role as the API gateway regardless of host platform.

## Problem

The worker package is deeply coupled to Cloudflare through three fundamental choke points:

### 1. Durable Objects (~4,500 lines in SessionAgentDO alone)

Four DOs use CF-only APIs with no abstraction layer:

| DO | CF APIs Used |
|---|---|
| `SessionAgentDO` | `ctx.storage.sql.exec()`, `ctx.acceptWebSocket()` with hibernation, `ctx.setAlarm()`, `ctx.getWebSockets(tag)`, `WebSocketPair()`, `blockConcurrencyWhile()` |
| `EventBusDO` | `ctx.acceptWebSocket()`, `ctx.getWebSockets(tag)`, WebSocket hibernation hooks |
| `APIKeysDurableObject` | `state.storage.put/get/list/delete` (KV-style) |
| `WorkflowExecutorDO` | `DurableObjectState` + D1 access through `env.DB` |

DOs combine three concerns that are separate in other platforms:
- **Addressing** — `idFromName()` guarantees a single instance per key
- **Storage** — embedded SQLite or KV, colocated with compute
- **Compute** — WebSocket handling, alarms, request processing

There is no interface abstraction over any of these. The DO is the abstraction.

### 2. D1 Database (typed everywhere as `D1Database`, raw SQL bypasses Drizzle)

All 28 DB service files in `src/lib/db/*.ts` import `D1Database` from `@cloudflare/workers-types`. Used both through Drizzle ORM (`drizzle-orm/d1`) and as ~92 raw `.prepare()` calls that bypass Drizzle entirely.

**However, an audit found that the vast majority of raw SQL does NOT need to be raw:**

| Category | Count | Description |
|---|---|---|
| Easily Drizzle-able | **~50** | Simple CRUD, joins, ON CONFLICT — should have been Drizzle from the start. Code comments claiming "needs raw SQL" are wrong (e.g., "OR condition," "LEFT JOIN," "INSERT OR IGNORE" — all supported by Drizzle). |
| Drizzle-able with `sql` fragments | **~30** | Need raw expressions for specific parts (e.g., `datetime('now')` in a SET, `json_extract` in a WHERE, COALESCE patterns) but the query structure works in Drizzle's query builder. |
| Genuinely needs raw SQL | **~12** | Almost entirely FTS5/search-related: `MATCH` operator, `bm25()` ranking, `rowid` sync with virtual tables, plus 1 recursive date CTE and 2 dynamic SQL builder patterns. |

**Key insight:** Once the ~80 convertible queries are migrated to Drizzle, the database becomes switchable via driver swap. Drizzle generates dialect-appropriate SQL automatically — `drizzle-orm/d1` for SQLite, `drizzle-orm/node-postgres` for Postgres. The only abstraction needed is for the ~12 search-related queries that are inherently dialect-specific (FTS5 on SQLite vs. `tsvector`/`tsquery` on Postgres).

### 3. Platform Primitives (R2, Cron, WebSocketPair, Pages URL logic)

| Primitive | Where Used | Coupling Depth |
|---|---|---|
| R2 | `src/routes/files.ts` — list/get/put with `.writeHttpMetadata()` | Shallow, one file |
| Cron triggers | `index.ts` — `ExportedHandlerScheduledHandler<Env>` export | Medium, ~1000 lines of reconciliation logic |
| `WebSocketPair()` | SessionAgentDO, EventBusDO | Deep, integral to WS upgrade flow |
| `ctx.waitUntil()` | Cron handler, DOs | Medium, used for fire-and-forget |
| Pages preview CORS | `index.ts` — `*.pages.dev` origin matching | Shallow |
| Workers/Pages URL derivation | `src/lib/do-ws-url.ts` | Shallow |
| `nodejs_compat` flag | `wrangler.toml` | Config-only |

### Why this matters

1. **Deployment flexibility blocked.** Cannot deploy to Kubernetes, Fly.io, Railway, or any other platform without rewriting the worker.
2. **Self-hosted path blocked.** Users who want to run valet on their own infrastructure cannot do so.
3. **Testing difficulty.** Unit testing requires mocking CF globals (`D1Database`, `DurableObjectState`, `WebSocketPair`). Portable interfaces enable in-memory test implementations.
4. **Vendor risk.** Single-provider dependency for the entire API layer.
5. **Database flexibility blocked.** D1 is the only option. Operators deploying to k8s may prefer Postgres; CF deployments may want to use Postgres via Hyperdrive for features D1 lacks (e.g., real full-text search, jsonb operators, advisory locks).

## Current Architecture (What Exists)

### Hono Setup

Hono is used in generic mode (not `@hono/cloudflare-workers` adapter):

```typescript
const app = new Hono<{ Bindings: Env; Variables: Variables }>();
```

Hono itself is multi-runtime — it runs on Node, Bun, Deno, and Workers. The CF coupling is in the `Env` type threaded through as `Bindings`, not in Hono itself.

### Env Interface (the coupling surface)

```typescript
// src/env.ts
import type { D1Database, R2Bucket, DurableObjectNamespace } from '@cloudflare/workers-types';

export interface Env {
  API_KEYS: DurableObjectNamespace;
  SESSIONS: DurableObjectNamespace;
  EVENT_BUS: DurableObjectNamespace;
  WORKFLOW_EXECUTOR: DurableObjectNamespace;
  DB: D1Database;
  STORAGE: R2Bucket;
  ENCRYPTION_KEY: string;
  // ... other secrets/vars
}
```

Every route handler, service function, and DO constructor receives `Env` or individual bindings from it. This interface is the single point where all CF dependencies converge.

### DB Access Pattern

Two coexisting approaches:

1. **Drizzle ORM** — `getDb(d1: D1Database)` returns a Drizzle instance using `drizzle-orm/d1`. Used for simple CRUD.
2. **Raw D1 SQL** — `db.prepare(sql).bind(...args).all()/.first()/.run()`. Used for complex queries with dynamic conditions, joins, aggregations — but the audit shows most of these don't actually need to be raw.

Both take `D1Database` as parameter, not a generic interface.

### Entry Point Export

```typescript
// src/index.ts
export default {
  fetch: app.fetch,
  scheduled: scheduledHandler,
};
export { SessionAgentDO } from './durable-objects/session-agent';
// ... other DO exports
```

This is the CF Workers module format. A k8s deployment would use `Bun.serve({ fetch: app.fetch })` or equivalent.

## Design

### Database Strategy: Drizzle Everywhere, Both Dialects

Support both D1 (SQLite) and Postgres as switchable backends by making Drizzle the sole query interface, with a thin search abstraction for the ~12 queries that are inherently dialect-specific.

**How it works:**

1. **Convert all ~80 raw SQL queries to Drizzle query builder.** Drizzle generates the correct SQL per dialect automatically. No manual dialect branching needed for these.

2. **Drizzle schema files support both dialects.** Drizzle has separate schema packages (`drizzle-orm/sqlite-core` vs `drizzle-orm/pg-core`), but the table definitions are structurally identical. Use a shared schema definition that targets both:
   - Option A: Write schemas in `pg-core` and use Drizzle's SQLite compatibility mode
   - Option B: Write a thin schema factory that emits the correct types per dialect
   - Option C: Maintain two schema dirs (`schema/sqlite/`, `schema/pg/`) — most explicit, least magic

3. **`getDb()` becomes the dialect switch point:**

```typescript
// src/lib/drizzle.ts
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

export type AppDatabase = DrizzleD1Database | PostgresJsDatabase;

// CF Workers entry: getDb() wraps D1
// Node/Bun entry: getDb() wraps a Postgres connection
```

All DB service files accept `AppDatabase` instead of `D1Database`. Every query goes through Drizzle. The driver handles dialect differences transparently.

4. **Search abstraction for the ~12 genuinely dialect-specific queries:**

```typescript
// src/lib/search/types.ts
interface SearchProvider {
  searchMemories(params: {
    userId: string;
    query: string;
    category?: string;
    limit: number;
  }): Promise<ScoredMemory[]>;

  indexMemory(memory: { id: string; category: string; content: string }): Promise<void>;
  removeMemory(id: string): Promise<void>;
}

// src/lib/search/sqlite-fts5.ts — FTS5 MATCH + bm25() via raw SQL
// src/lib/search/pg-textsearch.ts — tsvector @@ tsquery + ts_rank() via raw SQL
```

The `SearchProvider` is the only place where raw dialect-specific SQL lives. Everything else goes through Drizzle.

**What this gives you:**

| Deployment | Database | Search | How |
|---|---|---|---|
| CF Workers | D1 (SQLite) | FTS5 | `drizzle-orm/d1` + `SqliteFts5SearchProvider` |
| CF Workers | Postgres via Hyperdrive | `tsvector` | `drizzle-orm/postgres-js` + `PgTextSearchProvider` |
| Kubernetes | Postgres | `tsvector` | `drizzle-orm/node-postgres` + `PgTextSearchProvider` |
| Kubernetes | D1 via HTTP API | FTS5 | `drizzle-orm/d1` + `SqliteFts5SearchProvider` (unusual but possible) |
| Local dev | Docker Postgres | `tsvector` | `drizzle-orm/postgres-js` + `PgTextSearchProvider` |
| Local dev | SQLite file | FTS5 | `drizzle-orm/better-sqlite3` + `SqliteFts5SearchProvider` |

**The ~12 genuinely raw queries breakdown:**

| Query cluster | Count | What it does | Abstraction |
|---|---|---|---|
| FTS5 `MATCH` + `bm25()` search | 3 | Full-text search with relevance ranking | `SearchProvider.searchMemories()` |
| FTS5 `rowid` sync (insert/delete) | 6 | Keep FTS5 virtual table in sync with main table | `SearchProvider.indexMemory()` / `removeMemory()` |
| Recursive date CTE | 1 | Generate date series for dashboard chart | `sql` tag with dialect check, or `DateSeriesProvider` |
| Dynamic SQL builder (`SET ${clauses}`) | 2 | `updateTrigger`, `updateWorkflow` | Refactor to typed partial-update with Drizzle `.set()` |

The dynamic SQL builders (2 queries) aren't dialect-specific at all — they're an architectural anti-pattern where callers build raw SQL strings. Refactoring them to use Drizzle's typed `.set()` with a conditionally constructed object eliminates them entirely.

The recursive date CTE (1 query) can be handled with a small `sql` fragment that checks the dialect, or factored into a tiny `DateSeriesProvider` with SQLite (`WITH RECURSIVE`) and Postgres (`generate_series()`) implementations.

**So the real abstraction surface is just `SearchProvider` — one interface, two implementations, ~9 raw queries total.**

### Dual Migration Strategy

Both databases need their own migration sets:

- **SQLite migrations** — the existing 41 files in `packages/worker/migrations/`. Continue to use for D1 deployments.
- **Postgres migrations** — new set in `packages/gateway/migrations/pg/`. Equivalent schema but with Postgres types (`TIMESTAMPTZ`, `jsonb`, `BOOLEAN`, `tsvector` + GIN index instead of FTS5 virtual table, explicit `GENERATED ALWAYS AS IDENTITY` where `rowid` was used).

Drizzle Kit can generate migrations from schema definitions for both dialects, reducing the maintenance burden of keeping them in sync.

### Portable Interface Layer

Introduce interfaces that abstract the remaining CF-specific capabilities:

#### 1. Object Storage Interface

```typescript
interface ObjectStorage {
  list(options: { prefix: string; limit?: number }): Promise<{ objects: StorageObject[] }>;
  get(key: string): Promise<StorageObjectBody | null>;
  put(key: string, body: ReadableStream | ArrayBuffer | string, options?: PutOptions): Promise<void>;
  delete(key: string): Promise<void>;
}
```

Implementations: R2 (current), S3/MinIO (k8s), filesystem (dev/test).

#### 2. PubSub / Real-Time Interface

```typescript
interface PubSub {
  publish(channel: string, event: unknown): Promise<void>;
  subscribe(channel: string, handler: (event: unknown) => void): Subscription;
}
```

This replaces the EventBusDO's role. Implementations: CF DO WebSockets (current), Redis Pub/Sub, or a dedicated WebSocket gateway (Soketi, Centrifugo).

#### 3. Scheduler Interface

```typescript
interface Scheduler {
  scheduleAt(timestamp: number, handler: string, payload: unknown): Promise<void>;
  scheduleCron(expression: string, handler: string): Promise<void>;
  cancel(id: string): Promise<void>;
}
```

Replaces DO alarms and cron triggers. Implementations: DO alarms (current), BullMQ delayed jobs, k8s CronJobs, Temporal.

### DO Decomposition Strategy

Each DO maps to a k8s-friendly replacement:

| Durable Object | What It Combines | K8s Replacement |
|---|---|---|
| **SessionAgentDO** | Single-writer state machine + embedded SQLite + WebSocket hub + alarms | Stateful service (1 pod per session) with external DB + native WS server + job queue for alarms |
| **EventBusDO** | Global WebSocket broadcast by userId tag | Redis Pub/Sub or dedicated WS gateway |
| **APIKeysDurableObject** | Per-user encrypted KV store | Encrypted columns in the main DB, or Vault/Sealed Secrets |
| **WorkflowExecutorDO** | Per-execution coordinator with DO state + D1 access | Job queue (BullMQ, Temporal) or a simple coordinator service |

The critical insight: DOs provide **single-writer guarantees** (one instance per key, serialized access). On k8s, this must be replicated via:
- Distributed locks (Redis/etcd) for short-lived operations
- Session affinity (consistent hashing) for WebSocket routing
- Actor frameworks (e.g., Temporal activities) for complex state machines
- Postgres advisory locks for per-session serialization

### Package Rename

Rename `packages/worker` → `packages/gateway` to reflect its platform-agnostic role:

- Update `package.json` name: `@valet/worker` → `@valet/gateway`
- Update all cross-package imports
- Update `CLAUDE.md`, `Makefile`, deploy scripts
- Update wrangler.toml (still needed for CF deployments)
- The CF-specific entry point (`export default { fetch, scheduled }`) becomes one of multiple entry points

### Entry Point Strategy

```
packages/gateway/
├── src/
│   ├── app.ts              # Hono app setup (platform-agnostic)
│   ├── entry-cloudflare.ts # CF Workers entry: export { fetch, scheduled }
│   ├── entry-node.ts       # Node/Bun entry: Bun.serve({ fetch })
│   ├── platform/
│   │   ├── types.ts        # Platform interfaces (Storage, PubSub, Scheduler, SearchProvider)
│   │   ├── cloudflare.ts   # CF implementations (D1 or Hyperdrive, R2, DO-backed PubSub, alarms)
│   │   └── node.ts         # Node implementations (Postgres or SQLite, S3, Redis, BullMQ)
│   ├── lib/
│   │   ├── search/
│   │   │   ├── types.ts          # SearchProvider interface
│   │   │   ├── sqlite-fts5.ts    # FTS5 implementation
│   │   │   └── pg-textsearch.ts  # tsvector implementation
│   │   └── ...existing lib/
│   └── ...existing src/
```

## Migration Strategy — Incremental, Not Big-Bang

### Phase 0: Convert raw SQL to Drizzle (no behavior changes)

**Goal:** Eliminate all unnecessary raw SQL so the database layer is dialect-agnostic via Drizzle.

This is the prerequisite for everything else. Convert ~80 raw `.prepare()` calls to Drizzle query builder:

1. **~50 easily Drizzle-able queries** — direct conversion. These use features Drizzle already supports: `or()`, `and()`, `notInArray()`, `.leftJoin()`, `.onConflictDoNothing()`, `.onConflictDoUpdate()`, `.groupBy()`, `.orderBy()`, `.limit()`. Many have incorrect code comments claiming they need raw SQL.

2. **~30 queries needing `sql` fragments** — convert to Drizzle with `sql` template literals for specific expressions: `sql\`datetime('now')\`` in `.set()` clauses, `sql\`json_extract(...)\`` in `.where()` conditions, `sql\`COALESCE(...)\`` in SELECT lists, `sql\`GROUP_CONCAT(...)\`` for aggregation.

3. **Refactor the 2 dynamic SQL builder patterns** (`updateTrigger`, `updateWorkflow`) into typed partial-update functions using Drizzle's `.set()` with conditionally constructed objects.

4. **Deduplicate cron handler queries** — the `index.ts` scheduled handler has ~20 raw SQL calls that duplicate functions already existing in the DB service layer. Replace with calls to those functions.

5. **Leave the ~12 search-related queries raw** — these are FTS5 virtual table operations that genuinely can't go through Drizzle. They will be abstracted in Phase 1.

**After this phase:** Every query except search goes through Drizzle. The codebase is ready for dialect switching.

**Estimated scope:** ~28 DB files + `index.ts` cron handler. Most conversions are mechanical. The cron handler deduplication is the largest single change.

**Dependency:** The [extract service layer bean (valet-yj5t)](#) makes this easier by first consolidating DB access into service files. Consider doing yj5t first or in parallel.

### Phase 1: Abstract database and search, support both dialects

**Goal:** Replace `D1Database` with Drizzle's `AppDatabase` type everywhere. Introduce `SearchProvider` interface.

1. Update `src/lib/drizzle.ts`:
   - Define `AppDatabase` as a union type (`DrizzleD1Database | PostgresJsDatabase`)
   - `getDb()` becomes configurable: accepts either a D1 binding or a Postgres connection string
   - All DB service files change their parameter type from `D1Database` to `AppDatabase`

2. Create `SearchProvider` interface and two implementations:
   - `SqliteFts5SearchProvider` — wraps the existing FTS5 queries (raw SQLite SQL)
   - `PgTextSearchProvider` — implements the same interface using `tsvector`, `@@`, `ts_rank()` (raw Postgres SQL)
   - Wire into `src/lib/db/orchestrator.ts` to replace the inline FTS5 calls

3. Handle the recursive date CTE:
   - SQLite: `WITH RECURSIVE dates(date) AS (SELECT date(?, '-N days') UNION ALL SELECT date(date, '+1 day') ...)`
   - Postgres: `SELECT generate_series(?::date, CURRENT_DATE, '1 day'::interval)::date`
   - Small dialect helper or `sql` fragment with runtime check

4. Write Postgres migration set (parity with the 41 SQLite migrations):
   - `TIMESTAMPTZ` for timestamps, `jsonb` for JSON, `BOOLEAN` for booleans
   - `tsvector` column + GIN index + trigger on `orchestrator_memories` (replaces FTS5 virtual table)
   - Explicit `GENERATED ALWAYS AS IDENTITY` column on `workflow_execution_steps` (replaces `rowid`)

5. Write Drizzle schema files that work for both dialects (or maintain two schema dirs).

6. Update the `Env` interface: `DB` becomes a generic database reference, not `D1Database`.

**After this phase:** You can deploy with D1 or Postgres. The choice is a configuration/entry-point decision, not a code change.

**Estimated scope:** ~28 files for the type change (mechanical), `SearchProvider` interface + 2 implementations (~200 lines each), Postgres migration set, schema updates.

### Phase 2: Abstract object storage

**Goal:** Remove `R2Bucket` from `Env`.

- Replace `c.env.STORAGE` usage in `src/routes/files.ts` with an `ObjectStorage` interface
- Remove `R2Bucket` from `Env`, replace with `ObjectStorage`
- CF implementation wraps R2; k8s implementation wraps S3 SDK

Estimated scope: 1 file (`files.ts`) + env type update. Smallest change in the whole plan.

### Phase 3: Abstract real-time / PubSub

**Goal:** Replace EventBusDO access pattern with a `PubSub` interface.

- Define `PubSub` interface
- Create CF implementation that internally does the current `EVENT_BUS.idFromName('global').get().fetch('/publish', ...)` pattern
- Routes and services call `pubsub.publish(channel, event)` instead of constructing DO stubs
- CF implementation: wraps EventBusDO (no change to the DO itself)
- K8s implementation: Redis Pub/Sub or Centrifugo

Estimated scope: ~10 call sites across routes and SessionAgentDO.

### Phase 4: Abstract scheduling

**Goal:** Replace cron triggers and DO alarms with a `Scheduler` interface.

- Extract the ~1000-line cron handler from `index.ts` into a `src/jobs/` directory with individual job functions
- Create CF implementation: cron trigger calls job functions; DO alarms for per-session timers
- K8s implementation: k8s CronJobs for periodic work; BullMQ delayed jobs for per-session timers
- This is where the cron handler's `ExportedHandlerScheduledHandler` export gets isolated behind the platform layer

Estimated scope: Large refactor of `index.ts` cron handler + SessionAgentDO alarm logic.

### Phase 5: Decompose SessionAgentDO

**Goal:** Extract SessionAgentDO's responsibilities into portable services.

This is the hardest phase. SessionAgentDO is a 4,500-line god object that combines:
- Per-session state machine (status transitions)
- Embedded SQLite tables (messages, questions, prompt_queue, etc.)
- WebSocket hub (runner + client connections, hibernation)
- Alarm-driven timers (idle timeout, question expiry, watchdog)
- D1 writes (session status, message persistence)
- EventBus publishing
- Runner proxy (`/proxy/*` → OpenCode HTTP)

Decomposition:

1. **SessionStateService** — State machine logic, status transitions. Uses Drizzle via `AppDatabase`. No WebSocket or timer dependencies.
2. **SessionMessageStore** — Message CRUD, parts handling, history queries. Currently in DO SQLite; moves to main DB (messages table already exists there, DO SQLite was a local cache).
3. **SessionWebSocketHub** — WebSocket upgrade, hibernation, message routing. This is the piece that needs platform-specific implementations (CF DO WS vs. native `ws` library).
4. **SessionTimerService** — Idle timeout, question expiry, watchdog. Uses `Scheduler` interface.

The CF implementation keeps the DO as the glue that wires these services together. The k8s implementation replaces the DO with a stateful pod or actor.

### Phase 6: Docker Compose local dev environment

**Goal:** Full local dev stack with zero CF dependencies via `docker compose up`.

Today the local dev story is split: the frontend runs natively, the worker runs via `wrangler dev` (which emulates D1/R2/DOs locally), and there's a minimal `docker-compose.yml` that only runs the OpenCode container. Once the gateway is decoupled from CF primitives, we can replace this with a complete Docker Compose environment that runs the entire stack without Wrangler or any CF tooling.

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_DB: agent_ops
      POSTGRES_USER: agent_ops
      POSTGRES_PASSWORD: dev
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./packages/gateway/migrations/pg:/docker-entrypoint-initdb.d  # auto-apply migrations

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports:
      - "9000:9000"   # S3 API
      - "9001:9001"   # Console
    volumes:
      - miniodata:/data

  gateway:
    build:
      context: .
      dockerfile: packages/gateway/Dockerfile
    depends_on: [postgres, redis, minio]
    ports:
      - "8787:8787"
    environment:
      DATABASE_URL: postgres://agent_ops:dev@postgres:5432/agent_ops
      DATABASE_DIALECT: postgres
      REDIS_URL: redis://redis:6379
      S3_ENDPOINT: http://minio:9000
      S3_BUCKET: valet-storage
      S3_ACCESS_KEY: minioadmin
      S3_SECRET_KEY: minioadmin
      # ... other env vars

  client:
    build:
      context: .
      dockerfile: packages/client/Dockerfile
    depends_on: [gateway]
    ports:
      - "5173:5173"
    environment:
      VITE_API_URL: http://localhost:8787/api

  opencode:
    build: .
    ports:
      - "4096:4096"
    environment:
      OPENCODE_SERVER_PASSWORD: ${OPENCODE_SERVER_PASSWORD}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
    volumes:
      - ./workspaces:/workspace

volumes:
  pgdata:
  miniodata:
```

**What this replaces:**
- `wrangler dev` (D1/R2 local emulation) → Postgres + MinIO containers
- Manual `make dev-worker` + `make dev-opencode` + `cd packages/client && pnpm dev` → single `docker compose up`
- CF-specific `.dev.vars` → standard `.env` file read by Compose

**What this enables:**
- **Onboarding in one command.** New contributors clone the repo, run `docker compose up`, and have the full stack running. No Wrangler, no CF account, no D1 setup.
- **CI integration testing.** GitHub Actions can spin up the Compose stack, run the test suite against real Postgres/Redis/MinIO, and tear down. No CF emulation flakiness.
- **Self-hosted preview.** The Compose file is also the starting point for self-hosted deployments — swap MinIO for real S3, point at a managed Postgres, and you have a production-like setup.

**Makefile targets:**

```makefile
dev:              ## Start full local stack
	docker compose up -d

dev-logs:         ## Tail all service logs
	docker compose logs -f

dev-down:         ## Stop and remove containers (keep volumes)
	docker compose down

dev-reset:        ## Stop, remove containers AND volumes (fresh start)
	docker compose down -v

dev-migrate:      ## Run Postgres migrations
	docker compose exec gateway bun run migrate

dev-seed:         ## Seed test data
	docker compose exec gateway bun run seed
```

### Phase 7: Rename and restructure

**Goal:** `packages/worker` → `packages/gateway` with multiple entry points.

- Rename package directory and `package.json`
- Create `entry-cloudflare.ts` (current behavior, using D1 or Hyperdrive + R2 + DOs) and `entry-node.ts` (new, using Postgres + S3 + Redis)
- Update all cross-package imports, `CLAUDE.md`, `Makefile`, deploy scripts
- CF deployment continues to use `wrangler deploy`
- K8s deployment uses a Dockerfile that runs `bun entry-node.ts`
- Docker Compose uses the same `entry-node.ts` path

## Relationship to Other Beans

- **valet-yj5t (Extract service layer)** — Should be done first or in parallel with Phase 0. Consolidating DB access into service files makes the Drizzle conversion cleaner — fewer files to touch, clearer boundaries, and the cron handler deduplication becomes obvious.
- **valet-k8rt (Multi-runtime sandbox abstraction)** — Complementary. That bean abstracts the sandbox runtime (Modal vs K8s). This bean abstracts the gateway runtime (CF Workers vs K8s). Together they fully decouple valet from any single cloud provider.
- **valet-xc0m (Plugin system)** — Plugin SDK interfaces should be defined against the portable interfaces, not CF-specific types, so plugins work regardless of deployment target.

## Open Questions

1. **Drizzle schema strategy for dual-dialect.** Three options: (a) single schema using `pg-core` with SQLite compatibility shims, (b) schema factory that emits both, (c) two schema directories. Option (c) is most explicit but doubles the schema maintenance. Option (a) needs investigation into how well Drizzle's pg-core maps to SQLite. Option (b) is the most DRY.

2. **Postgres provider for CF deployments.** Neon (serverless, generous free tier, CF Hyperdrive integration docs), Supabase (more features, slightly heavier), or RDS (AWS-native, most ops burden). Neon is the path of least resistance for Hyperdrive since CF has first-party Neon integration docs. Only relevant for CF+Postgres deployments.

3. **Data migration for existing D1 deployments.** Moving from D1 to Postgres requires a one-time ETL. Options: (a) migration script that reads D1 via Wrangler and inserts into Postgres, (b) export D1 as SQLite dump and load into Postgres via `pgloader`, (c) dual-write period. Not needed if staying on D1.

4. **SessionAgentDO embedded SQLite.** The DO has its own internal SQLite (via `ctx.storage.sql`) for messages, questions, prompt_queue — separate from D1. On k8s, this data needs to live elsewhere (main DB, Redis, or a per-session SQLite file on a PVC). The DO SQLite becomes a local write-ahead cache that flushes to the main DB, or is eliminated entirely in favor of direct writes.

5. **SessionAgentDO decomposition granularity.** Do we fully decompose into 4 services (Phase 5), or create a single `SessionManager` class that encapsulates all four concerns behind a clean interface? The latter is less work but still couples the four concerns.

6. **WebSocket hibernation equivalent.** CF DO hibernation lets WebSocket connections survive across DO sleep/wake cycles without holding memory. On k8s, WebSocket connections are tied to pod lifetime. Options: accept reconnection on pod restart (simpler), or use a WebSocket gateway that decouples connection lifetime from backend pods (more complex).

7. **Single-writer guarantee.** DOs guarantee serialized access per key. On k8s, concurrent requests to the same session could race. Options: Postgres advisory locks (`pg_advisory_lock(session_id_hash)`), Redis distributed locks, session-affinity routing, or an actor framework.

8. **Rename timing.** Renaming `worker` → `gateway` touches every import and deploy script. Should this happen first (clean break) or last (after all abstractions are in place)?

## Acceptance Criteria

- [x] All ~80 convertible raw SQL queries migrated to Drizzle query builder
- [~] `SearchProvider` interface defined with `SqliteFts5SearchProvider` and `PgTextSearchProvider` implementations — SQLite done, Postgres not started
- [x] `AppDatabase` type replaces `D1Database` in all DB service files (as `AppDb`)
- [ ] No `D1Database` import outside of `platform/cloudflare.ts` and `entry-cloudflare.ts`
- [ ] Drizzle schema files support both SQLite and Postgres
- [ ] SQLite migrations (existing 41 files) continue to work for D1 deployments
- [ ] Postgres migration set written and validated (schema parity with SQLite)
- [ ] Platform interfaces defined: `ObjectStorage`, `PubSub`, `Scheduler`
- [ ] Cloudflare implementations of all interfaces (D1 or Hyperdrive, R2, DO-backed PubSub, alarms)
- [ ] Node/Bun implementations of all interfaces (Postgres, S3, Redis, BullMQ)
- [ ] No `R2Bucket` import in any file outside `platform/cloudflare.ts`
- [ ] No `DurableObjectNamespace` import in any file outside `platform/cloudflare.ts` and DO files
- [ ] Cron handler logic extracted into portable job functions
- [ ] Node/Bun entry point exists and boots the Hono app with non-CF implementations
- [ ] `docker compose up` starts full local stack (Postgres, Redis, MinIO, gateway, client)
- [ ] Gateway boots and serves API requests against Docker Postgres
- [ ] Makefile targets for `dev`, `dev-down`, `dev-reset`, `dev-migrate`, `dev-seed`
- [ ] `packages/worker` renamed to `packages/gateway`
- [ ] All cross-package imports updated
- [x] `pnpm typecheck` passes
- [x] Existing CF + D1 deployment works unchanged (no regression)
- [ ] CF + Postgres (Hyperdrive) deployment works
- [ ] K8s + Postgres deployment works
- [ ] New contributors can onboard with `docker compose up` — no CF account or Wrangler required

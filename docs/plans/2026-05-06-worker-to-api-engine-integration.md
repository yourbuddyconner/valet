# Worker → API + Engine Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename `packages/worker/` to `packages/api/`, make it dual-target (Cloudflare Workers + Node), and on Node wire `@valet/engine` + `@valet/sandbox-docker` + `@valet/store-sqlite` to replace the SessionAgentDO + Runner + OpenCode chain. End state: chat with an agent in the existing UI against a local API that runs `bash` inside a Docker container.

**Architecture:**
- One package (`packages/api/`) with two entry points (`main-cf.ts`, `main-node.ts`).
- Routes share code; provider implementations are wired at boot per-platform.
- Engine runs in-process per session on Node (`Map<sessionId, Engine>`); the CF integration is **out of scope for this plan** — Node only.
- The existing CF deploy must keep working at every checkpoint.

**Tech stack:** Hono, Drizzle (D1 + better-sqlite3), `@valet/engine`, `@valet/store-sqlite`, `@valet/sandbox-docker`, `@hono/node-server`, `tsx`.

**Branch:** Create `worker-to-api` branched off the merged `portable-runtime-v1-spec` (or off `main` after merge).

---

## Background — read before starting

Skim, do not deep-read:

- `docs/specs/2026-05-02-portable-runtime-engine-design.md` — engine architecture, provider interfaces, API surface.
- `packages/engine/src/types.ts` — provider interfaces (`SessionStore`, `Sandbox`, `SandboxProvider`, `EventBus`, `BlobStore`, `CredentialStore`).
- `packages/engine/bin/repl.ts` — reference for wiring engine + providers + Anthropic; especially the `buildSession()` function. Replicate this pattern on the Node entry.
- `packages/worker/src/index.ts` — current entry; ~57 routes mounted under `/api/*`.
- `packages/worker/src/middleware/db.ts` + `lib/drizzle.ts` — existing dual-target groundwork.
- `packages/worker/src/test-utils/db.ts` — proves better-sqlite3 already runs the worker's full migration set.
- `CLAUDE.md` — house style, type-safety rules.

### What is already built and merged on this branch

- `@valet/engine` — agent loop (pi-agent-core), restart-safe decision gates, compaction, role/skill overlays, list_tools/call_tool plugin catalog.
- `@valet/store-sqlite` — `SessionStore` over better-sqlite3 with Drizzle migrations.
- `@valet/sandbox-docker` — long-running container per sandbox, host bind-mounted at `/workspace`, `docker exec` for shell. Path translation: agent paths under `/workspace/...` resolve to host paths. macOS `/tmp` → `/private/tmp` realpath fix included.
- `@valet/sandbox-local` — host fs/process sandbox.
- `@valet/engine/test-helpers` — `storeContractSuite` and `restartSafeGatesContractSuite`.
- The REPL has been dogfooded against real Anthropic + Docker sandbox; the round-trip works.

### What the survey already established about the worker

- 45 route files, 57 mounted routes; 37 service files (~10K lines); 3 DOs; 1153-line `index.ts`.
- 228 callsites already use `c.var.db` via `dbMiddleware`. **129 still bypass it** with `c.env.DB`. Migration pattern is established but unfinished.
- `AppDb` is already widened: `BaseSQLiteDatabase<any, any, any>` — accepts both D1 and better-sqlite3 via Drizzle.
- `createTestDb()` runs the full app migration set against in-memory sqlite. So sqlite + the worker's existing schema **already works**; this is not a research item.
- R2 is touched by exactly 3 files (`avatars.ts`, `orchestrator.ts`, `files.ts`).
- `c.env.SESSIONS` (DO): 30 callsites. **All replaced by engine** in Task 8.
- `c.env.EVENT_BUS` (DO): 2 callsites. Replaced by `InMemoryEventBus`.
- 23 routes pass `c.env` wholesale into services; ~18 service files reach into the env. This is the worst pattern and the bulk of Task 4.
- `c.env.ENCRYPTION_KEY`: 20 callsites. Stays as env-derived config (not abstracted into a provider) — see wrinkles.

---

## Verification gates

Do not bypass. Each gate is a checkpoint commit before moving on.

1. **End of Task 1** — Renamed package typechecks; CF `wrangler dev` still boots; existing tests green.
2. **End of Task 5** — Both `main-cf.ts` and `main-node.ts` typecheck. CF deploy `--dry-run` succeeds. Node entry boots, serves a stub route.
3. **End of Task 7** — Node entry serves the **existing non-engine routes** against sqlite. Auth is stubbed. Confirms dual-target works **before** any engine integration.
4. **End of Task 8** — Engine-backed session routes work in `curl`/`wscat` against Node entry. Real Anthropic call lands a tool result.
5. **End of Task 9** — Browser-based chat works end-to-end against Docker.

If a gate fails, **fix the underlying issue, do not push past**. Native-dep leakage in particular is silent until runtime.

---

## Tasks

### Task 1: Rename `packages/worker/` → `packages/api/`

**Files:**
- Rename: entire `packages/worker/` directory.
- Modify: `package.json` in api, root `pnpm-workspace.yaml` (no-op if glob), root `tsconfig.json`, `Makefile`, `wrangler.toml` (if package name leaks in), every `package.json` that depends on `@valet/worker`.

- [ ] **Step 1: Rename via git**

```bash
git mv packages/worker packages/api
```

- [ ] **Step 2: Rename the package**

`packages/api/package.json`:
- `"name": "@valet/worker"` → `"name": "@valet/api"`

- [ ] **Step 3: Find and update all `@valet/worker` consumers**

```bash
grep -rln "@valet/worker" --include="package.json" --include="*.ts" --include="*.tsx" --include="Makefile" .
```

Replace each occurrence with `@valet/api`. Don't blindly sed — read each first; some may be string identifiers that should not change.

- [ ] **Step 4: Update root tsconfig**

Root `tsconfig.json`: any `{ "path": "./packages/worker" }` → `{ "path": "./packages/api" }`.

- [ ] **Step 5: Update Makefile**

Replace target names and pnpm filters: `worker` → `api`. The `dev-worker`, `deploy-worker` targets become `dev-api`, `deploy-api`.

- [ ] **Step 6: Verify typecheck**

```bash
pnpm install
pnpm --filter @valet/api typecheck
```

- [ ] **Step 7: Verify CF dev still boots**

```bash
cd packages/api && pnpm dev
# In another terminal, hit a public route:
curl http://localhost:8787/api/health  # or whatever's wired
```

- [ ] **Step 8: Verify tests still pass**

```bash
pnpm --filter @valet/api test
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "rename: packages/worker → packages/api"
```

---

### Task 2: Eliminate raw `c.env.DB` from routes

The pattern already exists — `c.var.db` via `dbMiddleware` — but 129 routes still bypass it, mostly by passing `c.env.DB` into legacy `lib/db/` helpers that build their own Drizzle instance.

**Files:**
- Modify: `packages/api/src/lib/db/*.ts` (helper signatures).
- Modify: `packages/api/src/routes/*.ts` (callsites).

- [ ] **Step 1: Inventory legacy helpers**

```bash
grep -rn "D1Database" packages/api/src/lib/db/
```

Each function with `D1Database` in its signature is a candidate.

- [ ] **Step 2: Refactor each helper**

For a helper like:
```typescript
export async function getUserSessions(d1: D1Database, userId: string, opts?: ListOpts) {
  const db = drizzle(d1, { casing: 'snake_case' });
  // ... query
}
```

Change to:
```typescript
import type { AppDb } from '../drizzle.js';

export async function getUserSessions(db: AppDb, userId: string, opts?: ListOpts) {
  // ... query (no drizzle() call — db is already the instance)
}
```

- [ ] **Step 3: Update all callsites**

Mechanical:
```typescript
// Before:
await db.getUserSessions(c.env.DB, user.id, opts);
// After:
await db.getUserSessions(c.var.db, user.id, opts);
```

Be careful: `c.var.db` and `c.get('db')` are equivalent; don't mix forms in one file.

- [ ] **Step 4: Verify zero raw DB access in routes**

```bash
grep -rn "c\.env\.DB" packages/api/src/routes/
# Expected: no matches.
```

- [ ] **Step 5: Typecheck + test**

```bash
pnpm --filter @valet/api typecheck
pnpm --filter @valet/api test
```

- [ ] **Step 6: Commit**

```bash
git commit -am "refactor(api): eliminate raw D1 access from routes; everything goes through dbMiddleware"
```

---

### Task 3: Define `Providers` shape + add `BlobStore` middleware

Introduce a unified `Providers` context. CF and Node entries each populate it; routes only see typed providers.

**Files:**
- Create: `packages/api/src/providers/types.ts`
- Create: `packages/api/src/providers/blob-r2.ts`
- Create: `packages/api/src/providers/blob-fs.ts` (used by Node entry in Task 6)
- Modify: `packages/api/src/env.ts` (add to `Variables`)
- Modify: `packages/api/src/middleware/db.ts` (becomes `providersMiddleware`, or add a new providers middleware)
- Modify: `packages/api/src/routes/avatars.ts`, `orchestrator.ts`, `files.ts` (replace `c.env.STORAGE`)

- [ ] **Step 1: Define Providers**

`packages/api/src/providers/types.ts`:
```typescript
import type {
  SessionStore,
  SandboxProvider,
  EventBus,
  BlobStore,
  CredentialStore,
} from '@valet/engine';
import type { AppDb } from '../lib/drizzle.js';

export interface Providers {
  // Always populated.
  db: AppDb;                       // application schema (orgs, users, integrations, etc.)
  blobs: BlobStore;
  encryptionKey: string;

  // Populated only when engine is wired (Node entry today; CF later).
  // Routes that depend on these must check at startup, not per-request.
  engineStore?: SessionStore;
  sandboxProvider?: SandboxProvider;
  eventBus?: EventBus;
  engineCredentials?: CredentialStore;
}
```

- [ ] **Step 2: Add to context Variables**

`packages/api/src/env.ts`:
```typescript
import type { Providers } from './providers/types.js';

export interface Variables {
  user: { id: string; email: string; role: 'admin' | 'member' };
  requestId: string;
  db: AppDb;            // Keep for backwards-compat; alias to providers.db
  providers: Providers;
}
```

- [ ] **Step 3: Add BlobStore for R2**

`packages/api/src/providers/blob-r2.ts`:
```typescript
import type { BlobStore } from '@valet/engine';

export class R2BlobStore implements BlobStore {
  constructor(private bucket: R2Bucket) {}

  async put(key: string, data: Uint8Array | ReadableStream, opts?: { contentType?: string }) {
    await this.bucket.put(key, data, {
      httpMetadata: opts?.contentType ? { contentType: opts.contentType } : undefined,
    });
  }
  async get(key: string) {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return { data: obj.body as ReadableStream, contentType: obj.httpMetadata?.contentType };
  }
  async delete(key: string) {
    await this.bucket.delete(key);
  }
}
```

- [ ] **Step 4: Update providers middleware**

`packages/api/src/middleware/providers.ts` (new):
```typescript
import type { MiddlewareHandler } from 'hono';
import type { Providers } from '../providers/types.js';

export const providersMiddleware =
  (providers: Providers): MiddlewareHandler =>
  async (c, next) => {
    c.set('providers', providers);
    c.set('db', providers.db);  // backwards-compat alias
    await next();
  };
```

The existing `dbMiddleware` becomes redundant; either delete it or have it read from `providers`. Keep it as a thin wrapper if it's already mounted in many places — simpler diff.

- [ ] **Step 5: Migrate STORAGE-using routes**

For `routes/avatars.ts`, `routes/orchestrator.ts`, `routes/files.ts`:
- Replace `c.env.STORAGE.get(key)` with `c.var.providers.blobs.get(key)`.
- Adjust call shape: `BlobStore.get(key)` returns `{ data, contentType } | null`, not an R2Object. Update consumers.

- [ ] **Step 6: Verify zero `c.env.STORAGE` in routes**

```bash
grep -rn "c\.env\.STORAGE" packages/api/src/routes/
# Expected: no matches.
```

- [ ] **Step 7: Typecheck + test**

```bash
pnpm --filter @valet/api typecheck
pnpm --filter @valet/api test
```

- [ ] **Step 8: Commit**

---

### Task 4: Refactor services to take typed deps, not `c.env`

23 routes pass `c.env` wholesale into services; ~18 service files reach in. This is the worst tangle. Extract per-service `Deps` types so each service declares what it actually uses.

**Files:**
- Modify: every file in `packages/api/src/services/` that takes `Env`.
- Modify: every route file that calls those services with `c.env`.

- [ ] **Step 1: Inventory**

```bash
grep -rln "env: Env" packages/api/src/services/
grep -rohE "[a-zA-Z_]+Service\.[a-zA-Z]+\(c\.env" packages/api/src/routes/
```

- [ ] **Step 2: For each service, extract a Deps type**

Pattern:
```typescript
// Before:
import type { Env } from '../env.js';
export async function bulkDeleteSessions(env: Env, userId: string, ids: string[]) {
  const db = getDb(env.DB);
  const r2 = env.STORAGE;
  // ...
}

// After:
import type { Providers } from '../providers/types.js';
type Deps = Pick<Providers, 'db' | 'blobs'>;  // declare what you need
export async function bulkDeleteSessions(deps: Deps, userId: string, ids: string[]) {
  // use deps.db, deps.blobs
}
```

`Pick<Providers, ...>` keeps the dep set sharp — not every service gets the whole context.

- [ ] **Step 3: Update route callsites**

```typescript
// Before:
await sessionService.bulkDeleteSessions(c.env, user.id, ids);
// After:
await sessionService.bulkDeleteSessions(c.var.providers, user.id, ids);
```

`c.var.providers` is structurally compatible with any `Pick<Providers, ...>`.

- [ ] **Step 4: Services that need `ENCRYPTION_KEY`**

`encryptionKey` is on `Providers` (Task 3). Services like `credentials.ts` accept it via `Deps`:
```typescript
type Deps = Pick<Providers, 'db' | 'encryptionKey'>;
```

- [ ] **Step 5: Services that touch DOs**

The DO-touching services are `sessions.ts`, `session-cross.ts`, `session-workflows.ts`, `executions.ts`, `webhooks.ts`, `orchestrator.ts`. **Don't refactor their DO calls yet** — Task 8 replaces them with engine. For now, keep DO access tied to `Env` in those service functions; wrap them in routes so the DO call still goes through, but the rest of the function uses `Deps`.

The cleanest pattern: split service functions that mix DO calls + DB queries into two functions, one DO-only (stays using `Env`), one DB-only (uses `Deps`). If that's too invasive, leave them as-is — Task 8 deletes them.

- [ ] **Step 6: Verify zero `c.env` (other than the well-known config strings) in routes**

```bash
grep -rohE "c\.env\.[A-Z_]+" packages/api/src/routes/ | sort -u
# Expected remaining: SESSIONS, EVENT_BUS, WORKFLOW_EXECUTOR (DOs — Task 8 kills these), and possibly ANTHROPIC_API_KEY, FRONTEND_URL etc. as direct config reads.
```

DO bindings staying is fine for now. Direct string-config reads (`FRONTEND_URL`, `API_PUBLIC_URL`, etc.) are also fine — those become `process.env.X` on Node naturally.

- [ ] **Step 7: Typecheck + test**

- [ ] **Step 8: Commit**

---

### Task 5: Split entry point — `app.ts` + `main-cf.ts`

The current `index.ts` does CF-specific setup AND mounts routes. Split:
- `app.ts` — exports `createApp(providers)` returning a configured Hono app. **No CF imports.**
- `main-cf.ts` — CF entry. Builds providers from `c.env`, calls `createApp(providers)`, exports `default { fetch }`.

**Files:**
- Create: `packages/api/src/app.ts`
- Create: `packages/api/src/providers/cf.ts`
- Rename: `packages/api/src/index.ts` → `packages/api/src/main-cf.ts` (then update `wrangler.toml`)
- Modify: `packages/api/wrangler.toml` (`main = "src/main-cf.ts"`)

- [ ] **Step 1: Extract route mounting into `app.ts`**

`packages/api/src/app.ts`:
```typescript
import { Hono } from 'hono';
import { cors } from 'hono/cors';
// ... all existing imports

import type { Env, Variables } from './env.js';
import type { Providers } from './providers/types.js';
import { providersMiddleware } from './middleware/providers.js';
// ... all route imports

export function createApp(providers: Providers) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  // Global middleware
  app.use('*', requestId());
  app.use('*', logger());
  app.use('*', secureHeaders());
  app.use('*', cors({ /* ... existing config ... */ }));
  app.use('*', errorHandler);
  app.use('*', providersMiddleware(providers));
  app.use('/api/*', authMiddleware);

  // Mount all 57 routes (copy from existing index.ts).
  app.route('/api/auth', authRouter);
  // ...

  return app;
}
```

This file has **no `Env` type-narrowing logic** and **no `c.env.X` access at top level** — it just composes. CF-specific provider construction stays out.

- [ ] **Step 2: Build `providers/cf.ts`**

```typescript
import type { Env } from '../env.js';
import type { Providers } from './types.js';
import { getDb } from '../lib/drizzle.js';
import { R2BlobStore } from './blob-r2.js';

export function buildCloudflareProviders(env: Env): Providers {
  return {
    db: getDb(env.DB),
    blobs: new R2BlobStore(env.STORAGE),
    encryptionKey: env.ENCRYPTION_KEY,
    // engine providers not wired on CF in this plan — add in a future plan.
  };
}
```

- [ ] **Step 3: Create `main-cf.ts`**

```typescript
import type { Env } from './env.js';
import { createApp } from './app.js';
import { buildCloudflareProviders } from './providers/cf.js';

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const providers = buildCloudflareProviders(env);
    return createApp(providers).fetch(req, env, ctx);
  },
};

// Export DOs (currently re-exported from index.ts):
export { SessionAgentDO } from './durable-objects/session-agent.js';
export { EventBusDO } from './durable-objects/event-bus.js';
export { WorkflowExecutorDO } from './durable-objects/workflow-executor.js';
```

(Building providers per-request is fine for CF; they're lightweight wrappers over bindings. If perf matters later, cache.)

- [ ] **Step 4: Update wrangler.toml**

```toml
main = "src/main-cf.ts"
```

- [ ] **Step 5: Delete the old `index.ts`** (or leave a re-export shim if anything imports it directly)

- [ ] **Step 6: Verify CF build**

```bash
cd packages/api && pnpm wrangler deploy --dry-run
```

If this fails, the import graph is leaking something. Common offender: a route file imports from a service file that imports a Node-only dep. Trace and fix.

- [ ] **Step 7: Verify CF dev still boots**

```bash
pnpm --filter @valet/api dev
curl http://localhost:8787/api/health
```

- [ ] **Step 8: Commit**

---

### Task 6: Add `main-node.ts` + Node-flavored providers

**Files:**
- Create: `packages/api/src/main-node.ts`
- Create: `packages/api/src/providers/node.ts`
- Create: `packages/api/src/providers/blob-fs.ts`
- Create: `packages/api/src/providers/credentials-sqlite.ts` (or simpler — see step 5)
- Modify: `packages/api/package.json` — add deps + script

- [ ] **Step 1: Add deps**

`packages/api/package.json`:
```json
{
  "scripts": {
    "dev:node": "tsx watch src/main-node.ts"
  },
  "dependencies": {
    "@hono/node-server": "^1.0.0"
  },
  "devDependencies": {
    "@valet/engine": "workspace:*",
    "@valet/store-sqlite": "workspace:*",
    "@valet/sandbox-docker": "workspace:*",
    "@mariozechner/pi-ai": "0.73.0",
    "better-sqlite3": "^11.0.0",
    "tsx": "^4.0.0"
  }
}
```

(Engine deps in `devDependencies` keeps them out of CF bundles. The Node entry imports them at runtime; CF entry never does.)

```bash
pnpm install
```

- [ ] **Step 2: File-backed BlobStore**

`packages/api/src/providers/blob-fs.ts`:
```typescript
import type { BlobStore } from '@valet/engine';
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { dirname, join, resolve } from 'node:path';

export class FsBlobStore implements BlobStore {
  constructor(private root: string) {}

  private path(key: string) {
    // Reject absolute and traversal paths.
    if (key.startsWith('/') || key.includes('..')) {
      throw new Error(`FsBlobStore: invalid key ${key}`);
    }
    return resolve(this.root, key);
  }

  async put(key: string, data: Uint8Array | ReadableStream, opts?: { contentType?: string }) {
    const target = this.path(key);
    await fs.mkdir(dirname(target), { recursive: true });
    if (data instanceof Uint8Array) {
      await fs.writeFile(target, data);
      return;
    }
    // ReadableStream — drain to disk.
    const reader = (data as ReadableStream).getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    await fs.writeFile(target, Buffer.concat(chunks));
    if (opts?.contentType) {
      await fs.writeFile(target + '.contentType', opts.contentType);
    }
  }

  async get(key: string) {
    const target = this.path(key);
    try {
      await fs.access(target);
    } catch {
      return null;
    }
    let contentType: string | undefined;
    try {
      contentType = await fs.readFile(target + '.contentType', 'utf8');
    } catch {}
    const stream = Readable.toWeb(createReadStream(target)) as unknown as ReadableStream;
    return { data: stream, contentType };
  }

  async delete(key: string) {
    const target = this.path(key);
    await fs.rm(target, { force: true });
    await fs.rm(target + '.contentType', { force: true });
  }
}
```

- [ ] **Step 3: Build Node providers**

`packages/api/src/providers/node.ts`:
```typescript
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  InMemoryEventBus,
  InMemoryCredentialStore,
} from '@valet/engine';
import { createSqliteStore } from '@valet/store-sqlite';
import { DockerSandboxProvider } from '@valet/sandbox-docker';
import { FsBlobStore } from './blob-fs.js';
import type { Providers } from './types.js';

interface NodeProviderOpts {
  dbPath: string;            // app schema
  enginePath: string;        // engine schema (separate sqlite file is fine; same is also fine, table names don't collide)
  blobsRoot: string;
  workspaceRoot: string;     // default workspace for new sandboxes
  encryptionKey: string;
}

export async function buildNodeProviders(opts: NodeProviderOpts): Promise<Providers> {
  // 1. App schema (worker's existing migrations) over better-sqlite3
  fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
  const appSqlite = new Database(opts.dbPath);
  appSqlite.pragma('journal_mode = WAL');
  appSqlite.pragma('foreign_keys = ON');

  // Apply worker migrations from packages/api/migrations/
  const migrationsDir = path.resolve(import.meta.dirname, '../../migrations');
  for (const file of fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()) {
    appSqlite.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }

  const db = drizzle(appSqlite, { casing: 'snake_case' });

  // 2. Engine schema via @valet/store-sqlite
  const engineStore = await createSqliteStore({ path: opts.enginePath });

  // 3. Other providers
  const blobs = new FsBlobStore(opts.blobsRoot);
  const sandboxProvider = new DockerSandboxProvider();
  const eventBus = new InMemoryEventBus();
  const engineCredentials = new InMemoryCredentialStore();

  return {
    db,
    blobs,
    encryptionKey: opts.encryptionKey,
    engineStore,
    sandboxProvider,
    eventBus,
    engineCredentials,
  };
}
```

(`createSqliteStore` is the actual export — verify by reading `packages/store-sqlite/src/index.ts`.)

- [ ] **Step 4: Stub auth for local mode**

`packages/api/src/middleware/auth.ts` — the existing middleware reads JWTs. Add a branch at the top:
```typescript
if (process.env.VALET_LOCAL_AUTH === '1') {
  c.set('user', { id: 'local-user', email: 'local@dev', role: 'admin' });
  await next();
  return;
}
// ... existing JWT logic
```

This must not affect CF deploy: CF builds don't have `process.env.VALET_LOCAL_AUTH`; the existing JWT flow runs. (If `process.env` is unavailable in workerd, swap for a build-time flag — but workerd does expose `process.env` for env vars. Verify on dry-run.)

The local-user must exist as a row in the `users` and `org_members` tables, or admin-only routes 403. Easiest fix: on Node provider build, after migrations, insert seed rows if they don't exist:
```typescript
appSqlite.exec(`
  INSERT OR IGNORE INTO users (id, email, role) VALUES ('local-user', 'local@dev', 'admin');
  INSERT OR IGNORE INTO orgs (id, name) VALUES ('local-org', 'Local Dev');
  INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES ('local-org', 'local-user', 'admin');
`);
```
(Adjust column names by reading the actual schema in `packages/api/src/lib/schema/`.)

- [ ] **Step 5: Build the Node entry**

`packages/api/src/main-node.ts`:
```typescript
import { serve } from '@hono/node-server';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { buildNodeProviders } from './providers/node.js';

const port = parseInt(process.env.PORT ?? '8787', 10);
const dataDir = process.env.VALET_DATA_DIR ?? resolve(homedir(), '.valet');

const providers = await buildNodeProviders({
  dbPath: resolve(dataDir, 'app.db'),
  enginePath: resolve(dataDir, 'engine.db'),
  blobsRoot: resolve(dataDir, 'blobs'),
  workspaceRoot: process.env.VALET_WORKSPACE ?? process.cwd(),
  encryptionKey: process.env.VALET_ENCRYPTION_KEY ?? 'dev-key-not-secure-do-not-use-in-prod',
});

const app = createApp(providers);
serve({ fetch: app.fetch, port });
console.log(`@valet/api listening on http://localhost:${port}`);
console.log(`  data dir: ${dataDir}`);
```

- [ ] **Step 6: Native-dep hygiene**

`main-cf.ts` must not import (transitively):
- `@valet/store-sqlite`, `@valet/sandbox-docker`, `@valet/engine` runtime values, `better-sqlite3`, `node:*`, `@hono/node-server`, `dockerode`.

It's allowed to import **types** from `@valet/engine` (they're erased at build).

`main-node.ts` is allowed to import everything (it's Node).

`app.ts` and route files must not import either entry. They depend only on `@valet/engine` types (interfaces).

Verify:
```bash
cd packages/api && pnpm wrangler deploy --dry-run
```

If this fails with "cannot resolve 'better-sqlite3'" or similar, an import in the shared graph is the culprit. Find it:
```bash
grep -rn "better-sqlite3\|@valet/store-sqlite\|@valet/sandbox-docker" packages/api/src/ | grep -v providers/node.ts | grep -v main-node.ts
```

Move the offender into `providers/node.ts`.

- [ ] **Step 7: Boot Node entry**

```bash
VALET_LOCAL_AUTH=1 pnpm --filter @valet/api dev:node
```

In another terminal:
```bash
curl http://localhost:8787/api/auth/me  # should return local-user
curl http://localhost:8787/api/sessions  # should return [] (no sessions yet)
```

- [ ] **Step 8: Commit**

---

### Task 7: GATE — verify dual-target with no engine work

This is the verification gate that proves the dual-target shape works **before** engine integration introduces additional risk.

- [ ] **Step 1: Existing tests pass**

```bash
pnpm --filter @valet/api test
```

- [ ] **Step 2: CF dry-run deploy succeeds**

```bash
cd packages/api && pnpm wrangler deploy --dry-run
```

- [ ] **Step 3: Node entry boots, serves at least one full route**

Pick a route that touches `c.var.db` (e.g. `GET /api/sessions` returns user sessions list). Hit it. Expect empty array, not 500.

- [ ] **Step 4: CF dev still serves the same route**

```bash
pnpm --filter @valet/api dev
curl -H "Authorization: Bearer ${TOKEN}" http://localhost:8787/api/sessions
```

If anything is broken, fix here. Do not proceed to Task 8.

- [ ] **Step 5: Commit checkpoint**

```bash
git commit --allow-empty -m "checkpoint: dual-target shape verified, both CF and Node entries serve existing routes"
```

---

### Task 8: Engine integration — replace SessionAgentDO with engine

This is the actual engine work. Replace DO-mediated session orchestration with direct engine calls on the Node entry. **CF entry is unchanged** — it keeps the SessionAgentDO path until a future plan.

**Files:**
- Create: `packages/api/src/engine/host.ts` — per-process Engine cache (Map<sessionId, Engine>) and lifecycle.
- Create: `packages/api/src/engine/event-bridge.ts` — bridge `EventBus` events → existing client WebSocket protocol.
- Modify: `packages/api/src/routes/sessions.ts`, `threads.ts`, and any other DO-touching session route.
- Modify: `packages/api/src/middleware/auth.ts` or a new middleware to gate the engine routes on `c.var.providers.engineStore` being present.

The strategy: branch each session route by whether `c.var.providers.engineStore` is populated. On Node, use the engine path. On CF, fall through to the existing DO path.

- [ ] **Step 1: Read the existing DO contract**

```bash
cat packages/api/src/durable-objects/session-agent.ts | head -200
```

Identify the public RPC surface: what messages does the DO accept? (Probably: `prompt`, `abort`, `pause`, `resume`, plus `messages` reads.) This is the surface the engine must replicate behind the same HTTP routes.

- [ ] **Step 2: Read the existing client wire protocol**

```bash
grep -rn "WebSocket\|ws://\|new WebSocket" packages/client/src/api/
```

Find the message format the client expects on the WS stream. Likely a discriminated union with `{ type: 'message', ... }`, `{ type: 'tool_call', ... }`, etc.

- [ ] **Step 3: Build the host**

`packages/api/src/engine/host.ts`:
```typescript
import { Engine, type Session } from '@valet/engine';
import type { Providers } from '../providers/types.js';
// ... pi-ai imports

export class EngineHost {
  private sessions = new Map<string, { engine: Engine; session: Session }>();

  constructor(private providers: Required<Pick<Providers, 'engineStore' | 'sandboxProvider' | 'eventBus' | 'engineCredentials'>>) {}

  async sessionFor(sessionId: string, opts: { userId: string; orgId: string; workspace: string; model: ModelInfo; systemPrompt: string }): Promise<Session> {
    const cached = this.sessions.get(sessionId);
    if (cached) return cached.session;

    const engine = new Engine({
      providers: {
        store: this.providers.engineStore,
        bus: this.providers.eventBus,
        credentials: this.providers.engineCredentials,
        sandboxProvider: this.providers.sandboxProvider,
      },
    });

    // restoreSession if the engine has seen this id before, else createSession.
    const existing = await this.providers.engineStore.getSession(sessionId);
    const session = existing
      ? await engine.restoreSession(sessionId)
      : await engine.createSession({ id: sessionId, ...opts });

    this.sessions.set(sessionId, { engine, session });
    return session;
  }

  async destroy(sessionId: string) {
    const cached = this.sessions.get(sessionId);
    if (!cached) return;
    await cached.session.destroy();
    this.sessions.delete(sessionId);
  }
}
```

Cache `EngineHost` itself on `Providers` (or build it inside `buildNodeProviders` and add it as a field). The host is per-process; it must survive across requests.

- [ ] **Step 4: Wire the host into Providers**

Extend `Providers`:
```typescript
engineHost?: EngineHost;
```

Build it inside `buildNodeProviders` after the engine providers exist.

- [ ] **Step 5: Replace one route end-to-end**

Pick the simplest engine-relevant route — probably `POST /api/sessions/:id/messages` (send prompt). Branch:
```typescript
const { engineHost } = c.var.providers;
if (engineHost) {
  const session = await engineHost.sessionFor(resolvedId, { /* ... */ });
  const receipt = await session.prompt(body.content, { /* threadId? role? */ });
  return c.json({ ok: true, receipt });
}
// Else: existing DO-based path (unchanged).
```

Unit-test this path against a curl loop.

- [ ] **Step 6: Wire the WebSocket**

The existing route (probably `GET /api/sessions/:id/ws`) upgrades to WebSocket and pipes events. On Node:
```typescript
const { engineHost, eventBus } = c.var.providers;
if (!engineHost) { /* fall through to CF DO path */ }

// Subscribe to bus, relay over WS:
const unsub = eventBus.subscribe({ sessionId: resolvedId }, (busEvent) => {
  ws.send(JSON.stringify(toClientEvent(busEvent)));
});
ws.onclose = () => unsub();
```

`@hono/node-server` supports WebSocket via `@hono/node-ws`. Check the README; the API is `app.get('/path', upgradeWebSocket(...))`. **Add `@hono/node-ws` to deps if not already present.**

The `toClientEvent(busEvent)` mapper translates engine `BusEvent` → the wire format the client speaks. This is glue code, not architecture; write it as discovery shows what the client expects.

- [ ] **Step 7: Replace the rest of the session/thread routes**

Walk through every file from the survey: `sessions.ts`, `threads.ts`, `agent.ts`, `dashboard.ts`, plus services `sessions.ts`, `session-cross.ts`, `session-workflows.ts`. Each DO call gets a branch like step 5/6.

For routes the engine doesn't yet support (workflow steering, mailbox notifications, etc.), return 501 on the Node path: `if (!engineHost) { ... } else { return c.json({ error: 'not implemented in node mode' }, 501); }`.

- [ ] **Step 8: Confirm engine-backed dogfood via curl + wscat**

```bash
# Create session
curl -X POST http://localhost:8787/api/sessions -H "X-Local-Auth: 1" -d '{"workspace": "/tmp/dogfood"}'
# -> {"id": "sess_abc", ...}

# Open WS
wscat -c ws://localhost:8787/api/sessions/sess_abc/ws

# Send prompt (different terminal)
curl -X POST http://localhost:8787/api/sessions/sess_abc/messages \
  -d '{"content": "use bash to write hello.txt with contents ok then read it back"}'

# Watch wscat — you should see message_start, text_delta, tool_start (bash), tool_end (ok), turn_end.
```

- [ ] **Step 9: Commit**

---

### Task 9: UI integration

**Files:**
- Modify: `packages/client/.env` or `.env.local` — `VITE_API_URL`
- Modify: `packages/client/src/api/client.ts` (or wherever the base URL is read) if needed
- Possibly: `packages/client/src/api/auth.ts` to handle the local-user shape

- [ ] **Step 1: Point client at Node API**

```bash
cd packages/client
echo "VITE_API_URL=http://localhost:8787/api" > .env.local
echo "VITE_WS_URL=ws://localhost:8787/api" >> .env.local
pnpm dev
```

- [ ] **Step 2: Walk through the UI**

Open `http://localhost:5173`. Sign in (skip — `VALET_LOCAL_AUTH=1` returns a fake user, which the client might or might not handle).

If the client's auth flow expects an OAuth redirect: add a "skip auth in dev" branch in the client when `import.meta.env.VITE_LOCAL_AUTH === '1'` — bypasses the login screen and stuffs a fake user/token into the auth store.

- [ ] **Step 3: Create a session via the UI**

Use whatever button creates a session. Verify a row appears in `~/.valet/app.db` (or wherever).

- [ ] **Step 4: Open the session, send a prompt**

`use bash to write hello.txt with the contents "hello from valet" and then cat it back`

Watch the message render, the tool call render, the result render. Verify the file appears on disk under the session workspace.

If anything in the rendering pipeline breaks, debug specific shapes:
- Message shape mismatch: engine emits `MessageEntry` with `parts`; client may expect `content` as a string. Map at the route layer.
- Tool call rendering: client looks for a specific `type: 'tool_use' | 'tool_result'` discriminator.

- [ ] **Step 5: Pages that don't work yet are OK**

Workflows page, integrations page, etc. may 501 or render empty. Fine for this plan. Don't try to make them work.

- [ ] **Step 6: Commit**

---

### Task 10: Polish + documentation

- [ ] **Step 1: README in `packages/api/`**

Document:
- How to run on CF (existing flow): `pnpm dev`
- How to run on Node: `VALET_LOCAL_AUTH=1 pnpm dev:node`
- Required env vars
- Where data lives (`~/.valet/`)
- What works / doesn't work in Node mode (no workflows, no real OAuth, single hardcoded user)

- [ ] **Step 2: Makefile target**

```makefile
dev-api-node:
	cd packages/api && VALET_LOCAL_AUTH=1 pnpm dev:node

dev-local: dev-api-node
	cd packages/client && VITE_API_URL=http://localhost:8787/api pnpm dev
```

- [ ] **Step 3: Final smoke**

Boot everything, run through the dogfood prompt one more time. Confirm Docker container is created, used, and destroyed.

- [ ] **Step 4: Capture follow-ups**

Add a section to the engine spec or a new `docs/plans/2026-05-XX-cf-engine-integration.md` listing what's still needed for CF-side engine integration:
- `@valet/store-d1` (D1 SessionStore)
- `@valet/sandbox-modal` (Modal sandbox provider over HTTP)
- `@valet/bus-do` (EventBus over EventBusDO)
- A thin `SessionHostDO` that owns one engine instance per session on CF
- Provider contracts spec (semantics, lifecycle, error model) — write this **after** Node integration, informed by what we built

- [ ] **Step 5: Final commit + push**

---

## Known wrinkles

1. **Native deps in CF bundles.** workerd refuses anything from `node:*` (except a small allowlist) and refuses native modules. `main-cf.ts` and `main-node.ts` must be leaf files; nothing shared in `app.ts` / `routes/` / `services/` may import Node-only deps. Verify with `wrangler deploy --dry-run` after every major change.

2. **Drizzle dialect quirks.** `AppDb` is widened; both backends work via the same query builder. But D1's `prepare()` cache and better-sqlite3's transaction semantics differ. If a test passes on sqlite but fails on D1 (or vice versa), suspect this.

3. **`process.env` in workerd.** workerd exposes env vars but not all of `process` — be careful with code that reads `process.env.X` at module top-level. If module init runs in workerd, the `VALET_LOCAL_AUTH` check must be guarded (e.g. `typeof process !== 'undefined'`).

4. **WebSocket on Node vs CF.** CF uses Hibernatable WebSockets via DO. Node uses `@hono/node-ws` over `ws`. The wire payload is the same; the upgrade mechanism differs. Don't share upgrade code; just share the payload mapper.

5. **SessionStore vs app schema.** Two parallel schemas in two sqlite files (cleanest) or one file (also fine — table names don't collide). The plan above uses two files for clarity. If you choose one, add the engine schema migrations into the worker migration set or run them separately on the same connection.

6. **Auth stub must seed the DB.** Admin routes check for org membership rows. The local user must exist in `users`, `orgs`, and `org_members`. Seed in `buildNodeProviders` after migrations.

7. **Encryption key.** Stays env-driven on both targets. CF reads `env.ENCRYPTION_KEY`; Node reads `process.env.VALET_ENCRYPTION_KEY` with a hardcoded dev fallback. Anything encrypted on Node with the dev key cannot be moved to a prod env without re-encrypting.

8. **Client may have hardcoded assumptions.** OAuth-based login screens, org picker, etc. The cleanest fix is a `VITE_LOCAL_AUTH=1` branch in the auth store that mimics a logged-in state.

9. **Engine session ID = client session ID.** When the client creates a session via `POST /api/sessions`, the same ID must be passed to `engine.createSession({ id, ... })`. Don't let the engine generate its own ID and then have to map.

10. **Decision gates.** The engine exposes them as first-class events. The existing client code may render approval prompts in a different shape. If gates break, that's the most likely place to look.

11. **Docker container leakage.** The REPL had a sandbox-cleanup-on-exit hook (SIGINT). Replicate it on the Node entry — when the process exits, destroy any active sandboxes. Otherwise local dev leaks containers across restarts.

---

## Out of scope

- CF-side engine integration (the spec calls for `SessionHostDO`; that's a separate plan).
- `@valet/store-d1`, `@valet/sandbox-modal`, `@valet/bus-do` (CF providers — also next plan).
- Provider contracts spec doc + extra conformance suites — co-evolve with this work; document **after** as a separate pass.
- Deleting `SessionAgentDO`, `EventBusDO`, `WorkflowExecutorDO` source — they keep running for the CF deploy until the CF engine integration is done.
- Workflows on Node (return 501).
- Real OAuth flows on Node (use the stub user).

---

## Done criteria

- [ ] `git mv` rename complete; `@valet/api` is the package name everywhere.
- [ ] CF `wrangler deploy --dry-run` succeeds with no warnings about missing modules.
- [ ] CF dev mode (`pnpm dev`) serves the existing routes.
- [ ] Node mode (`pnpm dev:node`) serves the existing routes with sqlite + R2-stub.
- [ ] In Node mode, sending a prompt to a session triggers a real Anthropic call, runs `bash` inside Docker, and streams events to a connected WebSocket client.
- [ ] The existing UI, with `VITE_API_URL` pointed at Node, renders a session and shows a chat round-trip end-to-end.
- [ ] No regressions: existing tests still pass (`pnpm --filter @valet/api test`).
- [ ] Docs updated: `packages/api/README.md` explains the dual-target run modes.

When all checked: this work is mergeable.

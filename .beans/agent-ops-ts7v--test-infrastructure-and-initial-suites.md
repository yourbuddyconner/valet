---
# valet-ts7v
title: Test infrastructure and initial test suites
status: todo
type: task
priority: high
tags:
    - worker
    - shared
    - testing
    - infrastructure
created_at: 2026-02-25T00:00:00Z
updated_at: 2026-02-25T00:00:00Z
---

Set up Vitest across the monorepo and write initial test suites for the most critical service boundaries. The project currently has zero test files and no test framework configured.

## Problem

There are no tests anywhere in the codebase. No test framework is configured, no test scripts exist in any `package.json`, and there is no CI test step. This means:

- Refactors (like cf0x's Drizzle migration or the credential boundary) have no safety net
- Encryption round-trips are unverified — a subtle bug could silently corrupt stored credentials
- Service layer functions have clear input/output contracts that are easy to test but aren't
- Contributors can't validate changes locally before pushing

## Design

### Framework: Vitest

Vitest is the natural choice — it's Vite-native (the client already uses Vite), has first-class TypeScript support, and works well in monorepos with workspace configs.

### What to test first

Prioritize by blast radius and testability. Start with pure service functions that don't require mocking Cloudflare primitives:

**Tier 1 — Critical, easy to test (no CF mocking needed):**

1. **`lib/crypto.ts`** — PBKDF2 encrypt/decrypt round-trip, old padEnd encrypt/decrypt round-trip, verify different keys produce different ciphertext, verify wrong key fails decryption
2. **`services/credentials.ts`** — store/get/revoke/list lifecycle, upsert behavior, expiration detection, `not_found` result for missing credentials. Needs a mock DB (Drizzle with `better-sqlite3` or an in-memory D1 mock).
3. **`packages/shared/src/errors.ts`** — error classes serialize correctly, status codes are right

**Tier 2 — Important, moderate mocking:**

4. **`lib/db/*.ts` functions** — CRUD operations against an in-memory SQLite via Drizzle. Validates that Drizzle queries produce correct results. Good regression safety for cf0x's raw SQL → Drizzle conversion.
5. **`services/oauth.ts`** — OAuth callback handling (mock the external `fetch` to GitHub/Google token endpoints)
6. **`middleware/auth.ts`** — token validation, session expiry checks

**Tier 3 — Harder, needs CF primitives mocked:**

7. **Route handlers** — Hono request/response testing via `app.request()` (Hono has built-in test support)
8. **Durable Objects** — need `miniflare` or `@cloudflare/vitest-pool-workers` for DO testing

### Configuration

```
valet/
├── vitest.workspace.ts          # Monorepo workspace config
├── packages/
│   ├── shared/
│   │   ├── vitest.config.ts
│   │   └── src/__tests__/
│   │       └── errors.test.ts
│   ├── worker/
│   │   ├── vitest.config.ts
│   │   └── src/__tests__/
│   │       ├── crypto.test.ts
│   │       ├── credentials.test.ts
│   │       └── db/
│   │           └── sessions.test.ts
│   └── client/
│       └── vitest.config.ts     # (future — component tests)
```

### DB Testing Strategy

For testing DB helpers and services that need a database:

- Use `better-sqlite3` + `drizzle-orm/better-sqlite3` as an in-memory SQLite for tests
- Apply the existing migrations against the in-memory DB in a `beforeAll`
- Each test gets a transaction that rolls back after (or a fresh DB)
- This validates the actual SQL without needing D1 or Cloudflare tooling

This also directly supports cf0x — once we have DB tests running against SQLite, adding a Postgres test target is just a second Vitest config with a different Drizzle driver.

### Makefile / package.json

```jsonc
// root package.json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

```makefile
test:             ## Run all tests
	pnpm test

test-watch:       ## Run tests in watch mode
	pnpm test:watch
```

## Acceptance Criteria

- [ ] Vitest installed and configured (`vitest.workspace.ts` + per-package configs)
- [ ] `pnpm test` runs from the repo root and discovers tests across all packages
- [ ] `lib/crypto.ts` tests: PBKDF2 round-trip, wrong-key rejection
- [ ] `services/credentials.ts` tests: store/get/revoke/list lifecycle, upsert, not_found
- [ ] At least one `lib/db/*.ts` test running against in-memory SQLite with real migrations applied
- [ ] `packages/shared` error class tests
- [ ] Test scripts in root `package.json` and `Makefile`
- [ ] All tests pass in CI-compatible mode (`vitest run`, no interactive terminal needed)

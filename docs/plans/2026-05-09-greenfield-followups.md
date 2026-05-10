# Greenfield API + Web — Follow-Ups

Captured at the close of `2026-05-08-greenfield-server-and-web.md`. Each item below is *not* in scope for the agent-loop greenfield, but will need its own plan eventually.

## Server (`@valet/api`)

### Real auth
Replace the `VALET_LOCAL_AUTH=1` stub with real OAuth flows (GitHub, Google, Slack at minimum) and a session-cookie + JWT issuance pipeline. Probably crib heavily from `packages/worker/src/middleware/auth.ts` + `routes/oauth.ts` + `routes/auth.ts` since the OAuth dance is independent of the legacy worker's D1 storage.

### Cloudflare deploy of `@valet/api`
The CF integration is its own plan. What it needs:
- `@valet/store-d1` — `SessionStore` over D1 (mirrors store-sqlite contract)
- `@valet/sandbox-modal` — `SandboxProvider` over the existing Modal Python backend
- `@valet/bus-do` — `EventBus` over a new `EventBusDO` (or replace with a hub-and-spoke model)
- `SessionHostDO` — owns one `Engine` per session, takes the place of the existing `SessionAgentDO`
- A `main-cf.ts` entry that wires CF-flavored providers and replaces the legacy worker's deploy target

The wire shape stays the same; only the providers swap.

### Cutover from legacy worker
Once the new API has parity for the agent loop on CF, the legacy `packages/worker` can be deprecated. Sequence:
1. Stand up the new API on CF as a parallel deploy under a separate hostname.
2. Migrate D1 data into the new schema (or use the same schema and read both).
3. Cut the production hostname over.
4. Delete the legacy worker package.

Migration tooling and zero-downtime cutover plan needs writing.

### Multi-thread sessions in the wire
Engine supports multiple threads per session (`session.thread(key)`). The wire currently exposes only the default thread. Surface multi-thread through `POST /api/sessions/:id/threads` (with a key/title), thread-scoped message routes, and a `threadId` parameter on `POST /messages`.

### Decision gates in the wire
Engine emits `decision_gate`, `decision_gate_resolved`, etc. Surface these as wire events plus a new POST endpoint to resolve a gate. UI gets a corresponding approval-prompt component.

### Compaction events in the wire
Same: forward `compaction_start`/`compaction_end` so the UI can show a progress indicator when the engine is compacting.

### Multi-process scaling
`EngineHost` is a per-process `Map<sessionId, Engine>`. For >1 server instance, sessions need to be pinned to a node, or the cache needs distributed coordination. Think about this when we move beyond single-user local dev.

### WS replay buffer
The server currently doesn't keep a per-session ring buffer of wire events. When a client reconnects with `lastSeq`, we have nothing to replay — the client has to refetch via REST. That's fine for v1; for production, a small bounded ring buffer on `EngineHost` (last N events per session) would let us close the gap.

## pi-ai

### `disable_parallel_tool_use`
The dogfood consistently hits a parallel-tool-call race: the model issues `bash` + `read` simultaneously and `read` loses. `pi-ai` doesn't expose Anthropic's `disable_parallel_tool_use` flag. Either patch pi-ai or work around it in the engine (force serialization in the tool-bridge layer).

## Web (`@valet/web`)

### Markdown rendering
Assistant text currently renders as plain pre-wrap. Add markdown rendering for code blocks, lists, links. Don't pull in a full library if a small one will do — agent-loop-relevant subset is small.

### Tool result formatting
Tool results render as `<pre>`. Format better:
- `bash`: render as a terminal block (fixed-width, syntax-highlighted prompt/output split if possible)
- `read`/`write`/`edit`: file path + diff view (we already have `@pierre/diffs` from legacy client; consider porting)

### Multi-thread UI
When the wire exposes threads, render a thread switcher.

### Decision-gate UI
When a gate fires, render an inline approval card with allow/deny + reason input. Wire into the gate-resolution endpoint.

### Settings + cmd palette
Out of agent-loop scope but useful: theme override, model selector, session search.

### Mobile drawer
Sidebar collapses to a sheet on small viewports.

### Real auth UI
Login screen + OAuth callbacks once the server has real auth. Currently the app assumes `VALET_LOCAL_AUTH=1` and shows the local user.

## Cross-cutting

### Provider contracts spec
Co-evolve a `docs/specs/2026-XX-provider-contracts.md` documenting the formal semantics of `SessionStore`, `SandboxProvider`, `EventBus`, `BlobStore`, `CredentialStore` — lifecycle, error model, idempotency. Co-write *after* shipping the greenfield since the implementations now exercise the boundaries.

### Conformance suites
`@valet/engine/test-helpers` already has `storeContractSuite` and `restartSafeGatesContractSuite`. Add `sandboxProviderContractSuite`, `eventBusContractSuite`, `blobStoreContractSuite`. Run them in store-sqlite, sandbox-docker, sandbox-local — and against future CF impls (D1, Modal, EventBusDO).

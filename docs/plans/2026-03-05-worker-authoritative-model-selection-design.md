# Worker-Authoritative Model Selection

## Problem

When an orchestrator is refreshed, the UI auto-selects the wrong model (an OpenCode-discovered model instead of the org default GPT model). Additionally, unwanted providers (GitHub Copilot, OpenCode Zen) appear in the model picker because OpenCode auto-discovers them at runtime and there's no way to disable them.

Root causes:
1. The client has fallback logic that picks the first discovered model when preferences don't match
2. Model discovery is driven by OpenCode runtime, not by the Worker/DO
3. No mechanism to hide auto-discovered providers

## Design Principle

The Worker is the **single source of truth** for:
- Which providers/models are visible in the UI
- Which model is selected by default

OpenCode's runtime discovery is used only for making LLM calls, not for populating the UI.

## Changes

### A. DO sends `defaultModel` + `availableModels` in session init

The `init` WebSocket message gains two fields:

```typescript
{
  type: 'init',
  session: { ... },
  defaultModel: string | null,       // user prefs -> org prefs, pre-resolved
  availableModels: ProviderModels[],  // Worker-resolved catalog
}
```

The DO resolves these at session start:
- `defaultModel`: from `resolveModelPreferences()` (existing logic — user prefs first, org prefs fallback)
- `availableModels`: from `resolveAvailableModels()` (existing model-catalog.ts)

The DO caches the catalog for the session lifetime. On admin config changes, the DO can push an updated `models` message.

### B. Client trusts DO's `defaultModel` and `availableModels`

`autoSelectModel` in `use-chat.ts` simplifies:

1. If user has an in-session manual selection that's still valid -> keep it
2. Otherwise -> use `defaultModel` from init message
3. **No "first discovered model" fallback.** If `defaultModel` is null and user hasn't picked, show "Select a model" placeholder.

The `models` WebSocket message from the Runner (OpenCode discovery) is **not used for UI**. The model picker is populated exclusively from the Worker-resolved catalog sent in `init`.

### C. Runner stops forwarding discovered models to UI

The Runner still discovers models from OpenCode for its own failover/routing, but the DO does not forward `models` messages to WebSocket clients. The DO already has the authoritative catalog.

### D. Provider visibility controlled by D1 only

Only providers with entries in `org_api_keys` or `custom_providers` appear in the catalog. The `PROVIDER_ENV_KEYS` fallback in `model-catalog.ts` remains for initial setup convenience, but any provider can be hidden by admins.

Auto-discovered providers (GitHub Copilot, OpenCode Zen) do NOT appear unless explicitly added to D1.

### E. Runner failover uses DO-provided preferences only

`buildModelFailoverChain` in `prompt.ts`:
- Explicit model from user (per-message pick) takes priority
- Then `modelPreferences` from DO (user prefs -> org prefs)
- **No "discovered models" fallback** appended to the chain

## Data Flow

### Before
```
Client -> DO (init, no models)
Runner -> OpenCode (discover models)
Runner -> DO -> Client (models message)
Client auto-selects from discovered list (fallback: first model)
Client -> DO -> Runner (prompt with auto-selected model)
```

### After
```
Client -> DO (init with availableModels + defaultModel from Worker catalog)
Client shows catalog, pre-selects defaultModel
Client -> DO -> Runner (prompt with selected model)
```

## Files to Modify

### Worker/DO
- `packages/worker/src/durable-objects/session-agent.ts` — add `defaultModel` + `availableModels` to init message; stop forwarding Runner `models` messages to clients
- `packages/worker/src/services/orchestrator.ts` — pass resolved catalog/default to DO start

### Client
- `packages/client/src/hooks/use-chat.ts` — consume `defaultModel` + `availableModels` from init; remove client-side preference resolution and "first discovered" fallback; ignore Runner `models` messages
- `packages/client/src/components/chat/chat-input.tsx` — handle empty model state (placeholder)

### Runner
- `packages/runner/src/prompt.ts` — remove "discovered models" fallback from `buildModelFailoverChain`; stop sending `models` to DO for client forwarding (keep for internal use)

### Shared Types
- `packages/shared/src/types/index.ts` — add `defaultModel` and `availableModels` to init message type if typed

## Edge Cases

1. **Model ID format**: Both Worker catalog and OpenCode use `{provider}/{modelId}` from models.dev. IDs match.
2. **Stale catalog**: Worker caches models.dev for 1 hour. Model catalogs rarely change.
3. **Per-session override**: Users can still pick any model from the catalog per-message. `defaultModel` only controls initial selection.
4. **Orchestrator refresh**: New session init includes `defaultModel` from user/org prefs. No fallback.
5. **Model not in OpenCode**: If a catalog model isn't available in OpenCode runtime, the LLM call fails and Runner error handling kicks in (existing behavior).

## Impact on OpenCode

**No changes to OpenCode.** It still discovers providers, manages its own catalog, and routes LLM calls. We're only changing what the UI shows.

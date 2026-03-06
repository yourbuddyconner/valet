# Worker-Authoritative Model Selection — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the Worker/DO the single authority for model selection — the UI shows only Worker-resolved models and uses the DO-provided default, with no client-side fallbacks.

**Architecture:** The DO resolves the model catalog (from D1 org_api_keys + custom_providers + models.dev) and the default model (user prefs → org prefs) at session start, sending both in the `init` WebSocket message. The client trusts these values. The Runner's OpenCode-discovered models are no longer forwarded to the UI.

**Tech Stack:** Cloudflare Workers (Hono, Durable Objects, D1), React (TanStack, Zustand), Bun (Runner)

---

### Task 1: DO resolves and sends Worker catalog + default model in init message

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts:1-11` (imports)
- Modify: `packages/worker/src/durable-objects/session-agent.ts:895-949` (init message builder)

**Step 1: Add `resolveAvailableModels` import**

At `session-agent.ts` line 11, after the `assembleBuiltInProviderModelConfigs` import, add:

```typescript
import { resolveAvailableModels } from '../services/model-catalog.js';
```

**Step 2: Resolve catalog and default model in the init message builder**

Replace lines 904-905:
```typescript
const availableModelsRaw = this.getStateValue('availableModels');
const availableModels = availableModelsRaw ? JSON.parse(availableModelsRaw) : undefined;
```

With:
```typescript
// Resolve authoritative model catalog from D1 (not from Runner discovery)
let availableModels: import('@valet/shared').AvailableModels | undefined;
try {
  availableModels = await resolveAvailableModels(this.appDb, this.env);
} catch (err) {
  console.error('[SessionAgentDO] Failed to resolve available models for init:', err);
  // Fall back to Runner-discovered models if catalog resolution fails
  const availableModelsRaw = this.getStateValue('availableModels');
  availableModels = availableModelsRaw ? JSON.parse(availableModelsRaw) : undefined;
}

// Resolve default model: user prefs → org prefs
const initOwnerId = this.getStateValue('userId');
const initOwnerDetails = initOwnerId ? await this.getUserDetails(initOwnerId) : undefined;
const initModelPrefs = await this.resolveModelPreferences(initOwnerDetails);
const defaultModel = initModelPrefs?.[0] ?? null;
```

**Step 3: Add `defaultModel` to the init message**

At line 940 (inside the `data: {` object), after `availableModels,` add:

```typescript
defaultModel,
```

So the data block becomes:
```typescript
data: {
  sandboxRunning: !!sandboxId,
  runnerConnected: this.ctx.getWebSockets('runner').length > 0,
  runnerBusy: this.getStateValue('runnerBusy') === 'true',
  promptsQueued: this.getQueueLength(),
  connectedClients: this.getClientSockets().length + 1,
  connectedUsers,
  availableModels,
  defaultModel,
  auditLog: auditLogRows.map((row) => ({ ... })),
},
```

**Step 4: Typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS (no type errors — `defaultModel` is untyped JSON in the WS message)

**Step 5: Commit**

```
feat: DO resolves Worker catalog + default model in init message
```

---

### Task 2: DO stops forwarding Runner `models` messages to clients

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts:2578-2595` (models case in Runner message handler)

**Step 1: Stop broadcasting Runner models to clients**

Replace lines 2578-2595:
```typescript
case 'models':
  // Runner discovered available models — store and broadcast to clients
  if (msg.models) {
    this.setStateValue('availableModels', JSON.stringify(msg.models));
    this.broadcastToClients({
      type: 'models',
      models: msg.models,
    });
    // Persist to D1 so the settings typeahead works without a running session
    const userId = this.getStateValue('userId');
    if (userId) {
      updateUserDiscoveredModels(this.appDb, userId, JSON.stringify(msg.models))
        .catch((err: unknown) => console.error('[SessionAgentDO] Failed to cache models to D1:', err));
    }
  }
  // Queue drain is handled by `agentStatus: idle` which the Runner now sends
  // explicitly after model discovery (OpenCode doesn't emit idle on fresh start).
  break;
```

With:
```typescript
case 'models':
  // Runner discovered available models — store for internal use (failover, context limits)
  // but do NOT broadcast to clients. The UI uses the Worker-resolved catalog from init.
  if (msg.models) {
    this.setStateValue('availableModels', JSON.stringify(msg.models));
    // Persist to D1 so the settings typeahead works without a running session
    const userId = this.getStateValue('userId');
    if (userId) {
      updateUserDiscoveredModels(this.appDb, userId, JSON.stringify(msg.models))
        .catch((err: unknown) => console.error('[SessionAgentDO] Failed to cache models to D1:', err));
    }
  }
  break;
```

The only change is removing `this.broadcastToClients({ type: 'models', models: msg.models })`.

**Step 2: Typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS

**Step 3: Commit**

```
feat: DO stops forwarding Runner-discovered models to UI clients
```

---

### Task 3: Client consumes `defaultModel` from init and removes fallback logic

**Files:**
- Modify: `packages/client/src/hooks/use-chat.ts:405-413` (modelPreferences derivation)
- Modify: `packages/client/src/hooks/use-chat.ts:422-493` (selectedModel state + autoSelectModel)
- Modify: `packages/client/src/hooks/use-chat.ts:523-631` (init handler)
- Modify: `packages/client/src/hooks/use-chat.ts:840-848` (models case handler)

**Step 1: Remove client-side model preference resolution**

Delete or simplify lines 408-413. The client no longer needs to derive `modelPreferences` from the auth store for auto-selection. Replace:

```typescript
const userModelPreferences = useAuthStore((s) => s.user?.modelPreferences);
const userQueueMode = useAuthStore((s) => s.user?.uiQueueMode || 'followup');
const orgModelPreferences = useAuthStore((s) => s.orgModelPreferences);
const modelPreferences = (userModelPreferences && userModelPreferences.length > 0)
  ? userModelPreferences
  : orgModelPreferences ?? EMPTY_MODEL_PREFERENCES;
```

With:

```typescript
const userQueueMode = useAuthStore((s) => s.user?.uiQueueMode || 'followup');
```

**Step 2: Remove `findModelFromPreferences` function**

Delete lines 443-459 (the `findModelFromPreferences` function). It is no longer needed — the DO provides the default.

**Step 3: Simplify `autoSelectModel`**

Replace lines 461-493 with a simpler version that only validates the current selection is still in the available list:

```typescript
// Validate selected model is still in the available list.
// No fallback logic — the DO provides the default via init.
const validateSelectedModel = useCallback((models: ProviderModels[]) => {
  const allIds = models.flatMap((p) => p.models.map((m) => m.id));
  if (allIds.length === 0) return;

  // If current selection is still valid, keep it.
  if (selectedModel && allIds.includes(selectedModel)) return;

  // Check localStorage for a persisted session choice.
  try {
    const persisted = localStorage.getItem(`valet:model:${sessionId}`) || '';
    if (persisted && allIds.includes(persisted)) {
      if (selectedModel !== persisted) handleModelChange(persisted);
      return;
    }
  } catch {
    // ignore
  }

  // No valid selection — clear it. The init handler sets the default.
  if (selectedModel) handleModelChange('');
}, [sessionId, handleModelChange, selectedModel]);
```

Update the ref that stores this (around line 495):
```typescript
const autoSelectModelRef = useRef(validateSelectedModel);
useEffect(() => {
  autoSelectModelRef.current = validateSelectedModel;
}, [validateSelectedModel]);
```

Also remove the `EMPTY_MODEL_PREFERENCES` constant if it exists and is no longer used.

**Step 4: Simplify the init handler's model selection**

In the `case 'init':` handler (around lines 609-630), replace the model auto-selection logic:

```typescript
if (initModels.length > 0) {
  if (message.session.messages.length === 0) {
    try {
      localStorage.removeItem(`valet:model:${sessionIdRef.current}`);
    } catch { /* ignore */ }
    const allIds = initModels.flatMap((p: ProviderModels) => p.models.map((m: { id: string }) => m.id));
    const preferred = findModelFromPreferences(initModels, modelPreferences);
    if (preferred) {
      handleModelChange(preferred);
    } else if (allIds.length > 0) {
      handleModelChange(allIds[0]);
    }
  } else {
    autoSelectModelRef.current(initModels);
  }
}
```

With:

```typescript
if (initModels.length > 0) {
  // Use the DO-provided default model on fresh sessions or when no persisted choice
  const doDefaultModel = typeof message.data?.defaultModel === 'string' ? message.data.defaultModel : null;

  if (message.session.messages.length === 0) {
    // Fresh session — clear stale localStorage and apply DO default
    try {
      localStorage.removeItem(`valet:model:${sessionIdRef.current}`);
    } catch { /* ignore */ }
    if (doDefaultModel) {
      handleModelChange(doDefaultModel);
    }
  } else {
    // Existing session — validate current selection, fall back to DO default
    const allIds = initModels.flatMap((p: ProviderModels) => p.models.map((m: { id: string }) => m.id));
    try {
      const persisted = localStorage.getItem(`valet:model:${sessionIdRef.current}`) || '';
      if (persisted && allIds.includes(persisted)) {
        handleModelChange(persisted);
      } else if (doDefaultModel) {
        handleModelChange(doDefaultModel);
      }
    } catch {
      if (doDefaultModel) handleModelChange(doDefaultModel);
    }
  }
}
```

**Step 5: Neuter the `case 'models':` handler**

Replace lines 840-848:
```typescript
case 'models': {
  const modelsMsg = message as WebSocketModelsMessage;
  setState((prev) => ({
    ...prev,
    availableModels: modelsMsg.models,
  }));
  autoSelectModelRef.current(modelsMsg.models);
  break;
}
```

With:
```typescript
case 'models': {
  // Runner-discovered models are no longer used for UI.
  // The Worker-resolved catalog from init is authoritative.
  break;
}
```

**Step 6: Remove unused imports/types**

Remove `EMPTY_MODEL_PREFERENCES` if defined. The `WebSocketModelsMessage` interface can stay (harmless) or be removed.

**Step 7: Typecheck**

Run: `cd packages/client && pnpm typecheck`
Expected: PASS

**Step 8: Commit**

```
feat: client uses DO-provided default model, removes fallback logic
```

---

### Task 4: Runner removes discovered-models fallback from failover chain

**Files:**
- Modify: `packages/runner/src/prompt.ts:709-721` (buildModelFailoverChain)

**Step 1: Verify `buildModelFailoverChain` has no discovered-models fallback**

Read lines 709-721. The current implementation is:

```typescript
private buildModelFailoverChain(primaryModel?: string, modelPreferences?: string[]): string[] {
  const chain: string[] = [];
  const pushModel = (candidate: string | undefined) => {
    const normalized = typeof candidate === "string" ? candidate.trim() : "";
    if (!normalized) return;
    if (!chain.includes(normalized)) chain.push(normalized);
  };
  pushModel(primaryModel);
  for (const candidate of modelPreferences ?? []) {
    pushModel(candidate);
  }
  return chain;
}
```

This is already correct — it only uses `primaryModel` and `modelPreferences`, no discovered models. No change needed here.

**Step 2: Verify Runner still sends models for internal DO state (not UI)**

The Runner's `sendModels` calls in `bin.ts:453` and `prompt.ts:2217` remain. The DO stores them but no longer broadcasts to clients (done in Task 2). No change needed in the Runner.

**Step 3: Commit (skip if no changes)**

No changes needed — the Runner's failover chain is already clean.

---

### Task 5: Verify end-to-end behavior

**Step 1: Typecheck all packages**

Run: `pnpm typecheck`
Expected: PASS across all packages

**Step 2: Manual verification checklist**

After deploying, verify:
- [ ] New session init message includes `defaultModel` and `availableModels` from Worker catalog
- [ ] Model picker shows only providers configured in D1 (no GitHub Copilot, OpenCode Zen unless explicitly added)
- [ ] Orchestrator refresh selects the org default model (GPT-5 Chat)
- [ ] User can still manually pick a different model per-message
- [ ] Model failover works when a selected model errors (uses `modelPreferences` chain)

**Step 3: Commit**

```
feat: worker-authoritative model selection (valet-XXXX)
```

---

## Summary of Changes

| File | Change |
|------|--------|
| `packages/worker/src/durable-objects/session-agent.ts` | Import `resolveAvailableModels`; resolve catalog + default model in init message; stop broadcasting Runner `models` to clients |
| `packages/client/src/hooks/use-chat.ts` | Remove client-side preference resolution; consume `defaultModel` from init; remove "first discovered" fallback; ignore Runner `models` messages |
| `packages/runner/src/prompt.ts` | No changes needed (failover chain already clean) |

# New Thread Model Picker Design

**Date:** 2026-09-04
**Status:** Approved

## Problem

Valet uses a long-lived session for an assistant and creates each conversation as a thread. A new thread currently pins the session's historical model. A change to a personal, team, or assistant default does not reach that session after the session exists. The selected model can therefore disagree with the current default and tier map.

The model picker also uses a tier name as its closed label. A label such as `Large · medium` combines a model size with a reasoning level, but it does not name the model that will run. When an organization restricts members to approved models, an org admin can still reveal the complete catalog from the chat picker.

## Decisions

### New thread behavior

The API keeps a personal `newThreadBehavior` preference for explicit source-based continuation requests:

- `keep_current`: Copy the source thread's effective model and reasoning level.
- `use_defaults`: Resolve the current assistant, personal or team, host, and built-in model defaults. Resolve organization settings in the reasoning cascade.

The default value is `keep_current`. The preference applies to model and reasoning together. The Thread defaults settings page does not expose this API-only continuation preference.

The sidebar **New thread** action never sends `sourceThreadId`. It always creates a top-level conversation with current defaults. An explicit API caller that sends `sourceThreadId` gets the following behavior:

1. If the preference is `keep_current` and the source thread exists in the same session, copy its effective model and reasoning.
2. If `sourceThreadId` is omitted, use the current defaults.
3. If the preference is `use_defaults`, ignore the source thread and use the current defaults.

If `sourceThreadId` is supplied but does not name a thread in the session, the API returns `thread not found`. Existing threads never change.

For source-less requests and `use_defaults` source requests, the host resolves the same current cascade that applies when it first builds the session. It does not use the session's persisted historical model:

`assistant default -> personal default -> team default -> host default -> s`

A shared team assistant omits the actor's personal default, as it does during session creation. Reasoning uses the parallel assistant, personal, team, and organization cascade.

The new thread persists the selected model spec. A tier selection persists its tier token, not the current concrete target. This keeps tier remapping effective at run time. The new thread persists an explicit reasoning level only when the effective source or default supplies one.

### Channel thread defaults

Direct channel messages, mentions, and followed messages use fresh defaults when the target thread does not exist. They have no source thread, so `keep_current` does not copy the historical session model.

The host persists model and reasoning before prompt submission. Concurrent channel and event deliveries share one creation operation per session and thread key. Failed creation remains retryable.

Existing threads retain their pins after preference changes and session restore. Shared assistants keep owner-scoped defaults. Cleared reasoning persists as `off`.

### Selected model labels

Closed model controls show the resolved model name. They do not show the tier label as the selected value.

Examples:

- `s` that resolves to GPT-5.6 Luna displays `GPT-5.6 Luna`.
- With medium reasoning, it displays `GPT-5.6 Luna · medium`.

Tier names remain in the open picker as helper choices. Each tier row shows the tier name and its resolved model name. The shared web model-tier helper selects the first active target that exists in the catalog. If the client cannot resolve a target, it falls back to the tier label so the control never becomes blank.

This label rule applies to the chat picker and every settings `ModelCombobox` surface.

A thread-sidebar pin uses the same resolved model name. When the stored pin is a size tier, the row renders the concrete model name followed by a separate pill containing the human tier label, such as `Claude Sonnet 5` and `Large`.

### Approved-model restriction

When `approved_models` is non-null, the chat picker shows all approved models and no unapproved models. This rule applies to members and org admins.

The picker removes the `show more` action while the restriction is active. Tier rows remain available because every tier target must stay approved. Org admins manage the complete catalog only in **Settings -> Organization -> Models**.

`PUT /api/org/approved-models` rejects a restricted list that omits a current tier target. The error tells the admin to repoint that tier before removing the model. This reverse validation complements the existing model-tier validation and preserves the invariant from both settings surfaces.

When the restriction is off, the current curated catalog collapse and `show more` behavior remains.

Until the approved-model policy query resolves, concrete model options fail closed and the catalog reveal remains hidden. Approved-model and tier-map writes serialize on the org row so concurrent updates cannot break the tier-target invariant.

The current thread's selected model remains visible if an administrator removes its approval. This readmission is display-only. The user cannot select that model for another thread while the restriction is active.

## Data and API changes

Add `users.new_thread_behavior` as non-null text with the default `keep_current`. Follow the pre-1.0 schema rule:

- Edit `packages/api/migrations/pg/0000_app.sql`.
- Edit `packages/api/src/schema/index.ts`.
- Add a matching `SCHEMA_REPAIRS` entry in `packages/api/src/lib/drizzle.ts`.

Add `newThreadBehavior` to `MeResponse` and `PatchMeRequest`. `PATCH /api/me` accepts only `keep_current` or `use_defaults`.

Add optional `sourceThreadId` to `CreateThreadRequest`. `POST /api/sessions/:id/threads` returns the new thread after its model and reasoning settings are durable.

The host exposes a focused new-thread-default resolver. It reuses the existing model and reasoning cascade helpers without weakening restore-no-clobber behavior for existing sessions.

## Web changes

The thread tree creates a source-less request for sidebar **New thread**. The server resolves current defaults for that top-level conversation.

Centralize selected tier label resolution in `packages/web/src/lib/model-tiers.ts`. Both `ModelPicker` and `ModelCombobox` use the helper.

`ModelPicker` reads the approved-models setting. If the restriction is active, it removes the full-catalog reveal and limits the list to approved entries.

## Error handling

- Reject an unknown `newThreadBehavior` with a corrective 400 response.
- Reject a source thread from another session as `thread not found`.
- If current-default resolution cannot find an active tier target, return the existing corrective tier error.
- Do not create a partly configured thread. Resolve settings before creation or remove the new thread if persistence fails within the creation operation.

## Tests

Add regression coverage for:

- `PATCH /api/me` round trips both behavior values and rejects unknown values.
- Approved-model updates cannot remove a current tier target.
- `keep_current` copies the source thread's effective model and reasoning.
- `use_defaults` reads changed defaults instead of the session's historical model.
- A missing source falls back to defaults.
- A source thread from another session is rejected.
- Existing threads remain unchanged.
- The sidebar creates a source-less request even when another thread is active.
- Closed chat and settings controls show resolved model names for tier selections.
- Thinking remains a suffix on the chat trigger.
- Restricted pickers show all approved models, hide all unapproved models, and omit `show more` for admins and members.
- Unrestricted pickers retain the current reveal behavior.

Run the focused engine, API, and web suites during development. Run `make e2e` before completion, as required by `CLAUDE.md`.

## Implementation notes

The engine has an awaited thread factory. It writes initial settings before it exposes the thread in memory.

The API resolves fresh defaults without the persisted session row. It rejects an approved list that omits a configured tier target.

An explicit fresh default with no reasoning uses the engine's persisted `off` sentinel so it cannot inherit a historical session reasoning level after creation or restore.

The web app resolves closed labels and thread pins from the first active catalog target. A restricted picker renders approved options without a catalog reveal.

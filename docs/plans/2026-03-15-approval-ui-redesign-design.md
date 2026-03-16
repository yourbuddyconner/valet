# Action Approval UI Redesign

## Problem

The current approval card dumps raw JSON params into a flat string, making it nearly impossible to review what an action will actually do. Users end up blind-approving because the information is unreadable.

## Goal

Make approval cards reviewable at a glance by requiring the model to provide a human-readable summary of what the action does and why, and redesigning the UI to present that summary prominently with structured detail available on demand.

## Design

### Model-Provided Summary

The tool call framework adds a required `summary` parameter to action invocations that require approval. The model must provide a human-readable explanation of what the action does and why. If missing, the tool call errors — no fallback, no auto-generation.

The summary flows through the existing pipeline:

- Runner sends `call-tool` with new `summary` field
- SessionAgent stores it on the `action_invocations` row and in `InteractivePrompt.context.summary`
- Frontend receives it via the existing WebSocket `interactive_prompt` message
- The pre-formatted JSON dump `body` is replaced with the model's summary

### Frontend Approval Card

Card layout, top to bottom:

1. **Header row**: Action name on the left (e.g., `google-docs:docs.replace_document`), risk badge on the right (color-coded: green/yellow/red/dark-red for low/medium/high/critical). Countdown timer beside the risk badge.

2. **Summary**: The model's summary text as the primary content. Plain text, readable font size. This is what the user reads to make an approve/deny decision.

3. **Expandable detail toggle**: "Show details" collapsed by default. When expanded, shows parsed params as formatted key-value pairs:
   - Keys rendered as human-readable labels (camelCase → spaced)
   - Short string values rendered inline
   - Long strings (>~200 chars) that look like markdown get a rendered markdown preview
   - IDs and short technical strings get monospace styling
   - Arrays render as comma-separated or bulleted depending on length
   - Nested objects recurse with indentation
   - Generic heuristic-based rendering — no per-action custom renderers

4. **Action buttons**: Approve (primary/green) and Deny (danger/red) at the bottom.

### Channel Plugin Integration

Each channel plugin (Slack, Telegram, Discord) currently formats its own approval message. With this change:

- The model's summary becomes the primary text in all channel messages
- Action name + risk level stays in the header
- Raw params are not included in channel messages (too noisy for chat — users can expand details in the web UI)
- Channel plugins read `context.summary` instead of using the pre-formatted `body`

### Implementation Scope

1. **SDK/Shared types**: Add `summary` to the tool call request type. Required for approval-requiring actions.
2. **Runner/Tool framework**: Validate `summary` is present on approval-required invocations. Error if missing.
3. **SessionAgent DO**: Thread `summary` through to `InteractivePrompt.context.summary`. Use summary as body instead of JSON dump.
4. **Frontend**: Rewrite `interactive-prompt-card.tsx` — summary-first layout, expandable detail with generic param rendering.
5. **Channel plugins (Slack, Telegram, Discord)**: Update approval message formatting to use `context.summary`.
6. **System prompt**: Update tool descriptions so the model knows it must provide a meaningful summary.

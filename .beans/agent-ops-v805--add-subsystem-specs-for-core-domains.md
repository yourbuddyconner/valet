---
# valet-v805
title: Add subsystem specs for core domains
status: done
type: task
priority: low
tags:
    - docs
    - architecture
    - process
created_at: 2026-02-23T18:00:00Z
updated_at: 2026-02-23T18:00:00Z
---

Create focused specification documents for each core subsystem in `docs/specs/`. Each spec owns the authoritative definition for its subsystem's behavior, boundaries, and contracts.

## Problem

Valet has two high-level spec documents (`V1.md` — full architecture, `WORKFLOW_PLUGIN_SPEC.md` — workflow engine) and several general docs (`docs/architecture.md`, `docs/security-model.md`, etc.), but no per-subsystem specifications that define:

- What the subsystem does and doesn't do (boundary rules)
- The exact data model and state machine
- The contract between this subsystem and its neighbors
- Edge cases and failure modes
- Current implementation status vs. planned

This means the source of truth for "how do sessions work?" is scattered across `V1.md`, `CLAUDE.md`, route handlers, DO code, runner code, and the Modal backend. A developer (human or AI) working on sessions has to piece together behavior from 5+ files across 3 packages.

## Design

### Spec List

Create the following specs, prioritized by how often the subsystem is modified and how complex its behavior is:

**Tier 1 — Write first (highest churn, most complex):**

1. **`docs/specs/sessions.md`** — Session lifecycle state machine (initializing → running → idle → hibernating → hibernated → terminated → archived → error), sandbox spawn flow, prompt forwarding, hibernation/restore, idle timeout, message streaming, session access control, share links, child sessions. Boundary: does NOT cover workflow execution or orchestrator logic.

2. **`docs/specs/sandbox-runtime.md`** — Sandbox boot sequence (`start.sh` → services → Runner), auth gateway (port 9000), service ports, JWT validation, OpenCode lifecycle, Runner ↔ DO WebSocket protocol (all message types), tunnel URL management. Boundary: does NOT cover sandbox image building or warm pools.

3. **`docs/specs/real-time.md`** — EventBusDO design, user-tagged WebSocket connections, event types and payloads, SessionAgentDO ↔ Runner WebSocket protocol, client reconnection, message deduplication. Boundary: does NOT cover session state or business logic.

**Tier 2 — Write second (stable but underdocumented):**

4. **`docs/specs/workflows.md`** — Workflow definition schema, trigger types (webhook, cron, manual), execution lifecycle, step tracking, approval gates, proposals and versioning, WorkflowExecutorDO behavior. Boundary: does NOT cover the OpenCode tools that invoke workflows.

5. **`docs/specs/auth-access.md`** — OAuth flows (GitHub, Google), JWT issuance, API tokens, org model (roles, invites, settings), session-level access control, admin middleware, impersonation. Boundary: does NOT cover per-sandbox JWT (that's in `sandbox-runtime.md`).

6. **`docs/specs/orchestrator.md`** — Orchestrator identity, coordinator agent behavior, child session spawning, memory system (FTS, categories, relevance scoring), inter-session messaging (mailbox), channel system. Boundary: does NOT cover individual session behavior.

**Tier 3 — Write as needed:**

7. **`docs/specs/integrations.md`** — GitHub (OAuth, webhooks, PR/issue operations), Telegram bot, Slack (planned), Linear (planned), custom provider secrets.

8. **`docs/specs/sandbox-images.md`** — Base image definition, repo-specific images, image versioning, Modal image builder, Dockerfile structure. Covers the future K8s image path.

### Spec Template

Each spec follows a consistent structure:

```markdown
# [Subsystem Name]

> One-line description of what this subsystem does.

## Scope

What this spec covers.

### Boundary Rules

- This spec does NOT cover [X] (see [other-spec.md])
- This spec does NOT cover [Y]

## Data Model

Tables, types, and relationships owned by this subsystem.

## State Machine

For stateful subsystems: states, transitions, triggers.

## API Contract

Routes, WebSocket messages, or internal interfaces.

## Flows

Step-by-step walkthroughs of key operations.

## Edge Cases & Failure Modes

Known failure scenarios and how they're handled.

## Implementation Status

What's built, what's planned, what's deferred.
```

### Maintenance Rules

- When modifying a subsystem's behavior, update its spec in the same commit.
- Specs are the source of truth for AI agents working on the codebase. `CLAUDE.md` should reference specs rather than duplicating subsystem details.
- Boundary rules are enforced: if a spec says "does NOT cover X," don't add X to that spec. Create or update the correct spec instead.

## Acceptance Criteria

- [ ] `docs/specs/` directory exists
- [ ] Tier 1 specs written: `sessions.md`, `sandbox-runtime.md`, `real-time.md`
- [ ] Each spec follows the template structure (scope, boundary rules, data model, state machine, API contract, flows, edge cases, implementation status)
- [ ] Specs accurately reflect current implementation (not aspirational — document what exists today)
- [ ] `CLAUDE.md` updated to reference specs directory
- [ ] Tier 2 and 3 specs are tracked as follow-up work (can be separate beans or done as subsystems are next modified)

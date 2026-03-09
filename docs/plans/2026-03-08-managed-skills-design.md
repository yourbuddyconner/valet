# Managed Skills System — Design Document

**Date:** 2026-03-08
**Status:** Approved

## Problem

Skills (markdown instruction documents) are currently compiled into the worker at build time, synced to D1 as plugin artifacts, and all pushed to every sandbox at session start. This causes:

1. **Context bloat** — every skill is loaded into every session regardless of relevance
2. **No runtime creation** — agents cannot create or modify skills, limiting self-improvement
3. **No curation** — no way to attach specific skills to specific personas or control defaults

## Solution

A unified `skills` table that replaces skill entries in `org_plugin_artifacts`. All skills — regardless of origin — are first-class entities with the same schema, search, persona attachment, and delivery mechanics. Agents get tools to search, read, create, update, and delete skills at runtime.

## Key Decisions

1. **Unified abstraction** — A skill is a skill regardless of origin. No split between "plugin skills" and "managed skills" at the abstraction level.
2. **Three source types** — `builtin` (platform-shipped), `plugin` (from installed packages), `managed` (user/agent-created). Source determines editability, not behavior.
3. **Persona attachment** — Skills are explicitly linked to personas via a join table. All source types can be attached.
4. **Org defaults** — Org-level setting controls which skills auto-load when no persona specifies. Replaces today's "load everything" behavior.
5. **On-demand loading** — Skills not attached to the active persona are searchable via FTS and readable on demand. They enter context by being read, not by filesystem delivery.
6. **Medium risk CRUD** — Skill creation/editing/deletion defaults to requiring approval via the existing action policy system. Configurable per org.

## Data Model

### `skills` table

| Column | Type | Purpose |
|--------|------|---------|
| `id` | text PK | nanoid |
| `org_id` | text FK | owning org |
| `owner_id` | text FK, nullable | null = org-level, user_id = personal |
| `source` | text | `builtin`, `plugin`, or `managed` |
| `name` | text | human-readable name |
| `slug` | text | URL-safe identifier |
| `description` | text | what the skill teaches |
| `content` | text | full markdown with YAML frontmatter (tags, version) |
| `visibility` | text | `private` (owner only) or `shared` (whole org) |
| `status` | text | `active` or `disabled` |
| `created_at` | text | timestamp |
| `updated_at` | text | timestamp |

- Unique index on `(org_id, slug)` for builtin/plugin skills
- Unique index on `(org_id, owner_id, slug)` for managed skills
- `builtin` and `plugin` rows are read-only at runtime (upserted by plugin sync)
- `managed` rows support full CRUD by agents and users

### `skills_fts` virtual table

FTS5 over `name`, `description`, `content`. Full-text search across all skill fields.

### `persona_skills` join table

| Column | Type | Purpose |
|--------|------|---------|
| `id` | text PK | nanoid |
| `persona_id` | text FK | which persona |
| `skill_id` | text FK | which skill |
| `sort_order` | integer | ordering within persona |
| `created_at` | text | timestamp |

- Unique index on `(persona_id, skill_id)`

### `org_default_skills` table

| Column | Type | Purpose |
|--------|------|---------|
| `id` | text PK | nanoid |
| `org_id` | text FK | org |
| `skill_id` | text FK | skill |
| `created_at` | text | timestamp |

- Unique index on `(org_id, skill_id)`

## Skill Content Format

Markdown with optional YAML frontmatter:

```markdown
---
name: deploy-checklist
description: Step-by-step deployment checklist for production releases
tags: [devops, deployment, production]
version: 1
---

# Deploy Checklist

1. Run tests...
2. Check staging...
```

Frontmatter fields (`name`, `description`, `tags`, `version`) are parsed and stored in structured columns. The full markdown (including frontmatter) is stored in `content` for delivery to OpenCode.

## OpenCode Tools

Five tools exposed to the agent, all routed through the existing action invocation/policy system:

| Tool | Risk Level | Default Mode | Purpose |
|------|-----------|-------------|---------|
| `search_skills` | low | allow | FTS query, returns name/description/source/tags (not full content) |
| `read_skill` | low | allow | Fetch full markdown content by ID or slug |
| `create_skill` | medium | require_approval | Create a new managed skill (user-scoped by default) |
| `update_skill` | medium | require_approval | Edit a managed skill's content/metadata |
| `delete_skill` | medium | require_approval | Delete a managed skill |

Constraints:
- Only `managed` skills can be created/updated/deleted via tools
- `builtin` and `plugin` skills are read-only at runtime
- Visibility promotion (`private` → `shared`) goes through the same approval flow
- Policy overrides work via the existing `action_policies` cascade

## Worker REST API

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/skills` | GET | List skills (filter by visibility, source, persona, search query) |
| `/api/skills/:id` | GET | Get skill with full content |
| `/api/skills` | POST | Create managed skill |
| `/api/skills/:id` | PUT | Update managed skill |
| `/api/skills/:id` | DELETE | Delete managed skill |
| `/api/personas/:id/skills` | POST | Attach skill to persona |
| `/api/personas/:id/skills/:skillId` | DELETE | Detach skill from persona |
| `/api/orgs/:id/default-skills` | GET | Get org default skill set |
| `/api/orgs/:id/default-skills` | PUT | Update org default skill set |

## Delivery & Loading

### Session startup (core skills — pushed)

1. **SessionAgentDO** resolves which skills to push:
   - If session has a persona → fetch persona's attached skills via `persona_skills`
   - If no persona → fetch `org_default_skills`
2. Push via existing `plugin-content` WebSocket message to Runner
3. Runner writes to `~/.opencode/skills/` as today
4. OpenCode loads them at session start — but now it's a curated set, not everything

### On-demand (library skills — pulled)

1. Agent calls `search_skills` → worker FTS query → returns summaries
2. Agent calls `read_skill` → worker returns full markdown
3. Skill content enters context by being in the conversation (no filesystem write needed)

### Key insight

Core skills are pushed at boot (small, curated). Everything else is pulled on demand. The agent never has skills it doesn't need, and can always find skills it does need.

## Plugin Sync Changes

- `plugin-sync.ts` writes skill entries to the new `skills` table instead of `org_plugin_artifacts`
- Skills from plugin packages get `source='plugin'`
- Platform skills (browser, workflows, tunnels) get `source='builtin'`
- `org_plugin_artifacts` retains `type='tool'` and `type='persona'` — skills are removed from it
- `content-registry.ts` still generated at build time, but skill entries are used only as seed data for the `skills` table

## Migration & Backward Compatibility

### Data migration

1. New migration creates `skills`, `skills_fts`, `persona_skills`, `org_default_skills` tables
2. Existing skill artifacts from `org_plugin_artifacts` (where `type='skill'`) migrate to `skills` with appropriate source values
3. Migrated rows cleaned from `org_plugin_artifacts`

### Org bootstrapping

- On first sync after migration, all existing skills land in `skills` table
- All are added to `org_default_skills` so behavior is identical to today
- Orgs curate defaults down over time

### No breaking changes

- `plugin-content` WebSocket message shape unchanged (skills array with filename/content)
- Runner writes to same `~/.opencode/skills/` directory
- OpenCode reads skills the same way
- Only the source of truth changes (new table) and the set delivered (curated vs. all)

# Persona, Skills & Tool Whitelisting UI — Design Document

**Date:** 2026-03-08
**Status:** Approved
**Depends on:** `2026-03-08-managed-skills-design.md` (backend, implemented on `feature/managed-skills`)

## Problem

Personas are becoming the primary control surface for agent behavior, but the current UI doesn't reflect this. The persona editor is a cramped modal that only handles basic metadata and a system prompt. With the new managed skills system and the need for tool whitelisting, personas need a richer configuration experience. Skills need their own browsable library UI. And there's no way to control which integration tools a persona has access to.

## Solution

Three interconnected UI surfaces:
1. **Skills Library page** — browse, search, create, edit skills
2. **Persona editor full page** — replaces the modal with a multi-section page covering general settings, system prompt, skill attachments, and tool whitelisting
3. **Org default skills admin section** — manage which skills auto-load when no persona is specified

## Key Decisions

1. **Persona editor becomes a full page** at `/settings/personas/:id` — the configuration surface has outgrown a modal
2. **Tool whitelisting is explicit opt-in** — no tools specified = no server-side tools active, only built-in OpenCode tools (file editing, shell, etc.)
3. **Service-level with action overrides** — enable whole services, optionally exclude specific actions. Matches existing action enablement admin UI pattern.
4. **Tool picker respects org policies** — tools denied by org policy are hidden from the picker. Tools requiring approval show a badge.
5. **Skills use search-and-add** — search the library, click to attach, reorder attached skills. "Create new" link opens the skill editor.

## Skills Library Page

**Route:** `/settings/skills`

**Layout:**
- `PageHeader` with title "Skills" and "Create Skill" button
- Search input with source filter tabs: All | Builtin | Plugin | Managed
- Card grid displaying: name, source badge, visibility badge, description preview, updated date
- Click card navigates to skill detail/editor

**Skill Editor Page** (`/settings/skills/:id` or `/settings/skills/new`):
- Full page layout
- Fields: name, slug (auto-generated), description, visibility toggle (private/shared)
- Large markdown textarea for skill content body
- Builtin/plugin skills are read-only with source badge
- Delete button for managed skills with confirmation dialog

## Persona Editor — Full Page

**Route:** `/settings/personas/:id` (edit) and `/settings/personas/new` (create)

The personas list page stays at `/settings/personas` with cards. Clicking "Edit" or a card navigates to the detail page. "Create Persona" navigates to `/settings/personas/new`.

### Section 1: General

Icon, name, slug, description, default model, visibility. Same fields as today, laid out in a full-page form.

### Section 2: System Prompt

Large markdown editor for the primary `instructions.md`. Below it, the existing "Additional Files" section for supplementary instruction files (filename, content, sort order).

### Section 3: Skills

Search-and-add skill picker:
- Search input querying the skill library API (`GET /api/skills?q=...`)
- Dropdown results showing skill name, source badge, description
- Click to attach — skill appears in the attached list below
- Attached skills shown as a reorderable list (drag handle + remove button)
- Sort order determines load priority at session start
- "Create new skill" link at bottom of dropdown (opens `/settings/skills/new` in new tab)
- Empty state: "No skills attached. This persona will use org defaults."

### Section 4: Tools

Service-level toggles with action-level overrides:
- Lists available integration services with toggle switches
- Each service expandable to show individual actions with their own toggles
- Service toggle on = all actions enabled; individual action toggles override within the service
- Risk level badges on each action (low/medium/high/critical)
- Empty state: "No tools enabled. This persona will only have built-in coding tools."

**Policy filtering:**
- Tools denied by org policy are hidden from the picker entirely
- Tools with `require_approval` policy show an approval badge
- If an admin denies a tool already attached to a persona, a warning surfaces in the editor

## Tool Whitelisting Backend

### `persona_tools` table

| Column | Type | Purpose |
|--------|------|---------|
| `id` | text PK | nanoid |
| `persona_id` | text FK | which persona |
| `service` | text | integration service name (e.g., "github") |
| `action_id` | text, nullable | null = whole service, specific ID = individual override |
| `enabled` | integer (boolean) | true = allowed, false = blocked within enabled service |
| `created_at` | text | timestamp |

- Unique index on `(persona_id, service, action_id)`
- Row with `service='github', action_id=NULL, enabled=true` = enable all GitHub tools
- Row with `service='github', action_id='delete_branch', enabled=false` = except delete_branch
- No rows for a service = that service is unavailable to this persona

### Delivery

SessionAgentDO reads `persona_tools` at session startup alongside `persona_skills`. Sends the tool whitelist to the Runner, which configures OpenCode to only expose allowed tools via `list_tools`/`call_tool`.

### Layering with policies

Persona whitelist controls **availability** (what tools exist for this persona). Action policies control **approval gates** (what happens when a tool is invoked). A tool must pass both: whitelisted by persona AND allowed by policy.

### API routes

- `GET /api/personas/:id/tools` — list enabled services/actions for a persona
- `PUT /api/personas/:id/tools` — bulk replace tool configuration

## Org Default Skills Admin UI

New section in `/settings/admin` alongside existing Plugins section.

**"Default Skills" section:**
- Same search-and-add pattern as persona skill picker (reusable component)
- Controls which skills auto-load for sessions without a persona or with a persona that has no skills attached
- Shows current defaults as a list with remove buttons
- On migration, all existing builtin/plugin skills are added as defaults (backward compatible)

## Component Reuse

| Component | Used In |
|-----------|---------|
| Skill search-and-add picker | Persona editor (Skills section), Admin default skills |
| Service/action toggle list | Persona editor (Tools section) — adapted from existing action enablement section in admin |
| Markdown textarea | Persona editor (System Prompt), Skill editor |
| Source/visibility badges | Skills library cards, skill picker dropdowns |

## New Frontend Files

| File | Purpose |
|------|---------|
| `routes/settings/skills.tsx` | Skills library list page |
| `routes/settings/skills.$id.tsx` | Skill detail/editor page |
| `routes/settings/personas.$id.tsx` | Persona editor full page |
| `components/skills/skill-card.tsx` | Skill card for grid display |
| `components/skills/skill-picker.tsx` | Search-and-add skill attachment picker |
| `components/personas/persona-tool-picker.tsx` | Service/action toggle picker |
| `api/skills.ts` | Skills API hooks (list, get, create, update, delete, search) |

## New Backend Files

| File | Purpose |
|------|---------|
| `packages/worker/migrations/0063_persona_tools.sql` | persona_tools table |
| `packages/worker/src/lib/schema/persona-tools.ts` | Drizzle schema |
| `packages/worker/src/lib/db/persona-tools.ts` | Query helpers |

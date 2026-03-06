---
# agent-ops-pm4d
title: Plugin Management UI
status: todo
type: task
priority: medium
tags:
    - plugins
    - client
    - admin
created_at: 2026-03-06T00:00:00Z
updated_at: 2026-03-06T00:00:00Z
---

Build an admin UI for managing installed plugins, viewing their capabilities and artifacts, and toggling the `allowRepoContent` setting.

## Context

The plugin API routes exist (`GET/PUT /api/plugins`, `GET/PUT /api/plugins/settings`, `POST /api/plugins/sync`) but there is no frontend to interact with them. Currently plugins can only be managed via API calls.

## Scope

1. **Plugin list page** (`/admin/plugins`) — shows all installed plugins with name, icon, version, capabilities badges, status (active/disabled)
2. **Plugin detail view** — shows artifacts (skills, personas, tools) with content preview
3. **Enable/disable toggle** — admin can disable a plugin (PUT `/api/plugins/:id`)
4. **Force sync button** — admin can trigger re-sync (POST `/api/plugins/sync`)
5. **Plugin settings** — toggle `allowRepoContent` (PUT `/api/plugins/settings`)
6. Add React Query hooks in `packages/client/src/api/plugins.ts`
7. Add route and sidebar navigation

## Files

- Create: `packages/client/src/api/plugins.ts`
- Create: `packages/client/src/routes/admin/plugins.tsx`
- Create: `packages/client/src/components/plugins/` (list, detail, settings components)
- Modify: `packages/client/src/components/layout/sidebar.tsx` — add nav link

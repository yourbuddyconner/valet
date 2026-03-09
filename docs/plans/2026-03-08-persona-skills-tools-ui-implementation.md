# Persona, Skills & Tool Whitelisting UI — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a skills library page, full-page persona editor with skill attachments and tool whitelisting, and org default skills admin UI.

**Architecture:** New TanStack Router routes for skills library and persona editor. Reusable skill picker component shared between persona editor and admin defaults. Tool picker adapted from existing action enablement pattern. New `persona_tools` D1 table for tool whitelisting. Frontend API hooks for skills and persona tools.

**Tech Stack:** React 19, TanStack Router/Query, Tailwind CSS, Radix UI, Hono routes, D1/Drizzle

---

### Task 1: Backend — persona_tools Table and API

**Files:**
- Create: `packages/worker/migrations/0063_persona_tools.sql`
- Create: `packages/worker/src/lib/schema/persona-tools.ts`
- Modify: `packages/worker/src/lib/schema/index.ts`
- Create: `packages/worker/src/lib/db/persona-tools.ts`
- Modify: `packages/worker/src/lib/db.ts`
- Modify: `packages/worker/src/routes/personas.ts`
- Modify: `packages/shared/src/types/index.ts`

**Step 1: Write the migration**

Create `packages/worker/migrations/0063_persona_tools.sql`:

```sql
CREATE TABLE persona_tools (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  service TEXT NOT NULL,
  action_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_persona_tools_unique ON persona_tools(persona_id, service, action_id);
CREATE INDEX idx_persona_tools_persona ON persona_tools(persona_id);
```

**Step 2: Write the Drizzle schema**

Create `packages/worker/src/lib/schema/persona-tools.ts`. Read existing schema files like `packages/worker/src/lib/schema/skills.ts` and `packages/worker/src/lib/schema/personas.ts` to match conventions (column naming style, imports).

```typescript
import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const personaTools = sqliteTable('persona_tools', {
  id: text().primaryKey(),
  personaId: text().notNull(),
  service: text().notNull(),
  actionId: text(),
  enabled: integer({ mode: 'boolean' }).notNull().default(true),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_persona_tools_unique').on(table.personaId, table.service, table.actionId),
  index('idx_persona_tools_persona').on(table.personaId),
]);
```

Add to `packages/worker/src/lib/schema/index.ts`:
```typescript
export * from './persona-tools.js';
```

**Step 3: Write DB query helpers**

Create `packages/worker/src/lib/db/persona-tools.ts`. Read `packages/worker/src/lib/db/skills.ts` for patterns.

Functions needed:
- `getPersonaTools(db, personaId)` — returns all rows for a persona
- `setPersonaTools(db, personaId, tools)` — delete-all-then-insert replacement. `tools` is `Array<{ service: string; actionId?: string; enabled: boolean }>`
- `getPersonaToolWhitelist(db, personaId)` — returns the resolved whitelist as `{ services: string[]; excludedActions: Array<{ service: string; actionId: string }> }` for delivery to the Runner

Add to `packages/worker/src/lib/db.ts`:
```typescript
export * from './db/persona-tools.js';
```

**Step 4: Add shared types**

Add to `packages/shared/src/types/index.ts` after the `PersonaSkillAttachment` interface:

```typescript
export interface PersonaToolConfig {
  id: string;
  personaId: string;
  service: string;
  actionId: string | null;
  enabled: boolean;
  createdAt: string;
}

export interface PersonaToolWhitelist {
  services: string[];
  excludedActions: Array<{ service: string; actionId: string }>;
}
```

**Step 5: Add API routes**

Add to `packages/worker/src/routes/personas.ts` (read existing routes for auth pattern):

```typescript
// GET /api/personas/:id/tools
// Returns persona tool configuration
// Auth: persona owner or admin

// PUT /api/personas/:id/tools
// Body: { tools: Array<{ service: string; actionId?: string; enabled: boolean }> }
// Replaces all tool config for the persona
// Auth: persona owner or admin
```

Follow the same auth pattern as the persona-skill attachment routes (fetch persona, check `createdBy === user.id || user.role === 'admin'`).

**Step 6: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS

**Step 7: Commit**

```bash
git add packages/worker/migrations/0063_persona_tools.sql \
  packages/worker/src/lib/schema/persona-tools.ts \
  packages/worker/src/lib/schema/index.ts \
  packages/worker/src/lib/db/persona-tools.ts \
  packages/worker/src/lib/db.ts \
  packages/worker/src/routes/personas.ts \
  packages/shared/src/types/index.ts
git commit -m "feat(personas): add persona_tools table, schema, DB helpers, and API routes"
```

---

### Task 2: Backend — Tool Whitelist Delivery to Runner

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts`
- Modify: `packages/runner/src/types.ts`
- Modify: `packages/runner/src/bin.ts`

**Step 1: Read current delivery flow**

Read `packages/worker/src/durable-objects/session-agent.ts` — find `sendPluginContent()` method. Read `packages/runner/src/types.ts` for the `PluginContentPayload` type.

**Step 2: Add tool whitelist to the plugin-content message**

In `session-agent.ts` `sendPluginContent()`:
1. Import `getPersonaToolWhitelist` from `../lib/db.js`
2. If session has a personaId, call `getPersonaToolWhitelist(db, personaId)`
3. Add the whitelist to the `plugin-content` message payload

In `packages/runner/src/types.ts`, extend the plugin content payload type to include:
```typescript
toolWhitelist?: {
  services: string[];
  excludedActions: Array<{ service: string; actionId: string }>;
};
```

In `packages/runner/src/bin.ts`, in the `onPluginContent` handler:
1. If `content.toolWhitelist` is present, store it for use when the agent calls `list_tools` or `call_tool`
2. The Runner should filter tool results based on the whitelist

**Step 3: Read how list_tools and call_tool work in the Runner**

Read `packages/runner/src/bin.ts` or `packages/runner/src/agent-client.ts` to understand how tools are listed and called. The filtering should happen at the Runner level — when OpenCode asks for available tools, only return whitelisted ones.

**Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts \
  packages/runner/src/types.ts \
  packages/runner/src/bin.ts
git commit -m "feat(personas): deliver tool whitelist to Runner and filter available tools"
```

---

### Task 3: Frontend — Skills API Hooks

**Files:**
- Create: `packages/client/src/api/skills.ts`

**Step 1: Read existing API hook patterns**

Read `packages/client/src/api/personas.ts` and `packages/client/src/api/client.ts` to understand the exact patterns for query keys, hooks, and mutations.

**Step 2: Write skills API hooks**

Create `packages/client/src/api/skills.ts`:

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { Skill, SkillSummary } from '@valet/shared';

export const skillKeys = {
  all: ['skills'] as const,
  list: (filters?: Record<string, string>) => [...skillKeys.all, 'list', filters] as const,
  search: (query: string) => [...skillKeys.all, 'search', query] as const,
  detail: (id: string) => [...skillKeys.all, 'detail', id] as const,
};

export function useSkills(filters?: { source?: string; visibility?: string }) {
  const params = new URLSearchParams();
  if (filters?.source) params.set('source', filters.source);
  if (filters?.visibility) params.set('visibility', filters.visibility);
  const qs = params.toString();
  return useQuery({
    queryKey: skillKeys.list(filters),
    queryFn: () => api.get<{ skills: SkillSummary[] }>(`/skills${qs ? `?${qs}` : ''}`),
  });
}

export function useSearchSkills(query: string) {
  return useQuery({
    queryKey: skillKeys.search(query),
    queryFn: () => api.get<{ skills: SkillSummary[] }>(`/skills?q=${encodeURIComponent(query)}`),
    enabled: query.length > 0,
  });
}

export function useSkill(id: string) {
  return useQuery({
    queryKey: skillKeys.detail(id),
    queryFn: () => api.get<{ skill: Skill }>(`/skills/${id}`),
    enabled: !!id,
  });
}

export function useCreateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; slug?: string; description?: string; content: string; visibility?: string }) =>
      api.post<{ skill: Skill }>('/skills', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  });
}

export function useUpdateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; name?: string; description?: string; content?: string; visibility?: string }) =>
      api.put<{ skill: Skill }>(`/skills/${id}`, data),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: skillKeys.all });
      qc.invalidateQueries({ queryKey: skillKeys.detail(vars.id) });
    },
  });
}

export function useDeleteSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/skills/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  });
}
```

**Step 3: Run typecheck**

Run: `cd packages/client && pnpm typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/client/src/api/skills.ts
git commit -m "feat(skills): add frontend API hooks for skills CRUD and search"
```

---

### Task 4: Frontend — Persona Tools API Hooks

**Files:**
- Modify: `packages/client/src/api/personas.ts`

**Step 1: Add persona tools hooks**

Add to the existing `packages/client/src/api/personas.ts`:

```typescript
export function usePersonaTools(personaId: string) {
  return useQuery({
    queryKey: personaKeys.detail(personaId),  // reuse detail key, tools are part of persona config
    queryFn: () => api.get<{ tools: PersonaToolConfig[] }>(`/personas/${personaId}/tools`),
    enabled: !!personaId,
  });
}

export function useUpdatePersonaTools() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ personaId, tools }: { personaId: string; tools: Array<{ service: string; actionId?: string; enabled: boolean }> }) =>
      api.put(`/personas/${personaId}/tools`, { tools }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: personaKeys.detail(vars.personaId) });
    },
  });
}
```

Also add hooks for persona skills (the attachment API):

```typescript
export function usePersonaSkills(personaId: string) {
  return useQuery({
    queryKey: [...personaKeys.detail(personaId), 'skills'],
    queryFn: () => api.get<{ skills: Array<{ filename: string; content: string }> }>(`/personas/${personaId}/skills`),
    enabled: !!personaId,
  });
}

export function useAttachSkillToPersona() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ personaId, skillId, sortOrder }: { personaId: string; skillId: string; sortOrder?: number }) =>
      api.post(`/personas/${personaId}/skills`, { skillId, sortOrder }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: personaKeys.detail(vars.personaId) });
    },
  });
}

export function useDetachSkillFromPersona() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ personaId, skillId }: { personaId: string; skillId: string }) =>
      api.delete(`/personas/${personaId}/skills/${skillId}`),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: personaKeys.detail(vars.personaId) });
    },
  });
}
```

**Step 2: Run typecheck**

Run: `cd packages/client && pnpm typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/client/src/api/personas.ts
git commit -m "feat(personas): add frontend API hooks for persona tools and skill attachments"
```

---

### Task 5: Frontend — Skill Picker Component

**Files:**
- Create: `packages/client/src/components/skills/skill-picker.tsx`

**Step 1: Read related components**

Read `packages/client/src/components/personas/persona-picker.tsx` for the dropdown search pattern. Read `packages/client/src/components/ui/search-input.tsx` for the search input. Read `packages/client/src/components/ui/badge.tsx` for badge styling.

**Step 2: Build the skill picker**

Create `packages/client/src/components/skills/skill-picker.tsx`:

A reusable search-and-add component. Props:
```typescript
interface SkillPickerProps {
  attachedSkillIds: string[];
  onAttach: (skillId: string) => void;
  onDetach: (skillId: string) => void;
  onReorder?: (skillIds: string[]) => void;
}
```

Structure:
1. Search input at top — queries `useSearchSkills(query)` with debounce
2. Dropdown results showing: skill name, source badge (builtin/plugin/managed), description preview
3. Already-attached skills are dimmed/disabled in results
4. "Create new skill" link at bottom of dropdown (navigates to `/settings/skills/new`)
5. Below the search: attached skills list showing name, source badge, drag handle for reorder, remove button
6. Empty state: "No skills attached. This persona will use org defaults."

Use source badge colors:
- `builtin` → `default` variant
- `plugin` → `secondary` variant
- `managed` → `success` variant

**Step 3: Run typecheck**

Run: `cd packages/client && pnpm typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/client/src/components/skills/skill-picker.tsx
git commit -m "feat(skills): add reusable skill picker component with search-and-add"
```

---

### Task 6: Frontend — Persona Tool Picker Component

**Files:**
- Create: `packages/client/src/components/personas/persona-tool-picker.tsx`

**Step 1: Read the action enablement section**

Read `packages/client/src/components/settings/action-enablement-section.tsx` carefully. This is the pattern to adapt. Also read `packages/client/src/api/action-catalog.ts` to understand how the action catalog is fetched.

**Step 2: Build the tool picker**

Create `packages/client/src/components/personas/persona-tool-picker.tsx`:

Props:
```typescript
interface PersonaToolPickerProps {
  tools: Array<{ service: string; actionId?: string; enabled: boolean }>;
  onChange: (tools: Array<{ service: string; actionId?: string; enabled: boolean }>) => void;
}
```

Structure:
1. Fetch available services/actions from `useActionCatalog()`
2. Fetch org action policies to filter denied tools from `useDisabledActions()`
3. Group actions by service (reuse or adapt `groupByService()` from action-enablement-section)
4. For each service:
   - Toggle switch to enable/disable the whole service
   - Expandable section showing individual actions
   - Each action: name, description, risk badge, toggle (only when service is enabled)
   - Actions denied by org policy: hidden entirely
   - Actions requiring approval: show approval badge
5. Empty state: "No tools enabled. This persona will only have built-in coding tools."
6. When a service is toggled on, add `{ service, enabled: true }` (no actionId = whole service)
7. When an individual action is toggled off within an enabled service, add `{ service, actionId, enabled: false }`

**Step 3: Run typecheck**

Run: `cd packages/client && pnpm typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/client/src/components/personas/persona-tool-picker.tsx
git commit -m "feat(personas): add persona tool picker with service toggles and action overrides"
```

---

### Task 7: Frontend — Skills Library Page

**Files:**
- Create: `packages/client/src/routes/settings/skills.tsx`
- Create: `packages/client/src/components/skills/skill-card.tsx`

**Step 1: Read existing page patterns**

Read `packages/client/src/routes/settings/personas.tsx` for the grid card layout pattern. Read `packages/client/src/components/layout/page-container.tsx` for PageContainer/PageHeader.

**Step 2: Build the skill card**

Create `packages/client/src/components/skills/skill-card.tsx`:

Displays: name, source badge, visibility badge, description preview (truncated), updated date. Click navigates to `/settings/skills/${id}`.

**Step 3: Build the skills list page**

Create `packages/client/src/routes/settings/skills.tsx`:

```typescript
// Route: /settings/skills
// TanStack Router will auto-generate route tree entry
```

Structure:
1. `PageContainer` with `PageHeader` — title "Skills", "Create Skill" button linking to `/settings/skills/new`
2. Search bar (`SearchInput`) with debounce
3. Source filter tabs: All | Builtin | Plugin | Managed (use button group, not real tabs)
4. Grid of `SkillCard` components (`grid gap-4 sm:grid-cols-2 lg:grid-cols-3`)
5. Loading skeleton, empty state
6. Uses `useSkills(filters)` for listing, `useSearchSkills(query)` when search is active

**Step 4: Add sidebar navigation**

Modify `packages/client/src/components/layout/sidebar.tsx`: Add a "Skills" nav item pointing to `/settings/skills`. Place it near "Settings" or as a sub-item. Read the current sidebar to decide placement — it may be better as a top-level nav item or within the settings section.

**Step 5: Run typecheck and dev server**

Run: `cd packages/client && pnpm typecheck`
Run: `cd packages/client && pnpm dev` — verify the page renders at `/settings/skills`
Expected: Page loads with skill list

**Step 6: Commit**

```bash
git add packages/client/src/routes/settings/skills.tsx \
  packages/client/src/components/skills/skill-card.tsx \
  packages/client/src/components/layout/sidebar.tsx
git commit -m "feat(skills): add skills library page with search, filter, and card grid"
```

---

### Task 8: Frontend — Skill Editor Page

**Files:**
- Create: `packages/client/src/routes/settings/skills.$id.tsx`

**Step 1: Read existing page patterns**

Read the persona editor component `packages/client/src/components/personas/persona-editor.tsx` for form patterns (slug generation, form state, submission). This will be a full page, not a dialog.

**Step 2: Build the skill editor page**

Create `packages/client/src/routes/settings/skills.$id.tsx`:

```typescript
// Route: /settings/skills/$id
// $id can be "new" for creation or an actual skill ID for editing
```

Structure:
1. Back link to `/settings/skills`
2. If editing: fetch skill with `useSkill(id)`, show loading skeleton
3. If builtin/plugin: read-only view with source badge, content displayed but not editable
4. If managed or new: editable form with:
   - Name input (triggers auto-slug generation)
   - Slug input (pattern: `^[a-z0-9\-]+$`)
   - Description textarea (2-3 rows)
   - Visibility toggle (private/shared) — button group like persona editor
   - Content: large markdown textarea (12-20 rows)
5. Save button (top-right or bottom)
6. Delete button for existing managed skills (with confirmation dialog)
7. Uses `useCreateSkill()` for new, `useUpdateSkill()` for editing
8. On save, navigate back to `/settings/skills`

**Step 3: Run typecheck**

Run: `cd packages/client && pnpm typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/client/src/routes/settings/skills.\$id.tsx
git commit -m "feat(skills): add skill editor page with create/edit/view modes"
```

---

### Task 9: Frontend — Persona Editor Full Page

**Files:**
- Create: `packages/client/src/routes/settings/personas.$id.tsx`
- Modify: `packages/client/src/routes/settings/personas.tsx`

**Step 1: Read existing persona components**

Read `packages/client/src/components/personas/persona-editor.tsx` for all form fields and logic. Read `packages/client/src/routes/settings/personas.tsx` for how the list page works.

**Step 2: Build the full-page persona editor**

Create `packages/client/src/routes/settings/personas.$id.tsx`:

```typescript
// Route: /settings/personas/$id
// $id can be "new" for creation or an actual persona ID
```

Structure — four vertical sections with clear headings:

**Section 1: General**
- Back link to `/settings/personas`
- Icon picker (emoji, 4-char max) + Name input (triggers slug) side by side
- Slug input
- Description textarea
- Model selector (using existing `useAvailableModels()` pattern)
- Visibility toggle (shared/private)

**Section 2: System Prompt**
- Large markdown textarea for primary instructions (12+ rows)
- "Additional Files" section below with add/remove file controls
- Each additional file: filename input, sort order number, content textarea
- Same pattern as existing persona editor but with more vertical space

**Section 3: Skills**
- `SkillPicker` component (from Task 5)
- Wired to `usePersonaSkills()`, `useAttachSkillToPersona()`, `useDetachSkillFromPersona()`

**Section 4: Tools**
- `PersonaToolPicker` component (from Task 6)
- Wired to `usePersonaTools()`, `useUpdatePersonaTools()`

**Save/Delete:**
- Save button at top-right (saves all sections)
- Delete button (existing personas only, with confirmation)

**Step 3: Update the personas list page**

Modify `packages/client/src/routes/settings/personas.tsx`:
- "Create Persona" button now navigates to `/settings/personas/new` instead of opening modal
- Card "Edit" button navigates to `/settings/personas/${id}` instead of opening modal
- Remove the `PersonaEditor` dialog import and usage
- Keep the card grid and delete confirmation

**Step 4: Run typecheck**

Run: `cd packages/client && pnpm typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/client/src/routes/settings/personas.\$id.tsx \
  packages/client/src/routes/settings/personas.tsx
git commit -m "feat(personas): add full-page persona editor with skills and tools sections"
```

---

### Task 10: Frontend — Org Default Skills Admin Section

**Files:**
- Modify: `packages/client/src/routes/settings/admin.tsx`
- Create: `packages/client/src/api/org-default-skills.ts`

**Step 1: Read admin page structure**

Read `packages/client/src/routes/settings/admin.tsx` to understand section patterns. Find where the Plugins section lives.

**Step 2: Add API hooks for org default skills**

Create `packages/client/src/api/org-default-skills.ts`:

```typescript
export function useOrgDefaultSkills() {
  return useQuery({
    queryKey: ['org-default-skills'],
    queryFn: () => api.get<{ skills: Array<{ filename: string; content: string }> }>('/admin/default-skills'),
  });
}

export function useUpdateOrgDefaultSkills() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skillIds: string[]) =>
      api.put('/admin/default-skills', { skillIds }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org-default-skills'] }),
  });
}
```

**Step 3: Add Default Skills section to admin page**

Add a new section to admin.tsx near the Plugins section:

```typescript
function DefaultSkillsSection() {
  // Uses SkillPicker component (from Task 5) wired to org default skills API
  // Search-and-add pattern, same as persona editor skills section
  // Shows current defaults as a list with remove buttons
}
```

**Step 4: Run typecheck**

Run: `cd packages/client && pnpm typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/client/src/api/org-default-skills.ts \
  packages/client/src/routes/settings/admin.tsx
git commit -m "feat(skills): add org default skills admin section"
```

---

### Task 11: Backend — Update persona_skills API to Return Rich Data

**Files:**
- Modify: `packages/worker/src/lib/db/skills.ts`
- Modify: `packages/worker/src/routes/personas.ts`

**Step 1: Add a richer persona skills query**

The current `getPersonaSkills()` returns `{ filename, content }` (delivery format). The frontend needs richer data. Add a new function `getPersonaSkillsForApi()` that returns full skill metadata:

```typescript
export async function getPersonaSkillsForApi(db: AppDb, personaId: string) {
  return db
    .select({
      id: skills.id,
      name: skills.name,
      slug: skills.slug,
      description: skills.description,
      source: skills.source,
      visibility: skills.visibility,
      sortOrder: personaSkills.sortOrder,
    })
    .from(personaSkills)
    .innerJoin(skills, eq(personaSkills.skillId, skills.id))
    .where(and(eq(personaSkills.personaId, personaId), eq(skills.status, 'active')))
    .orderBy(personaSkills.sortOrder);
}
```

**Step 2: Update the GET /api/personas/:id/skills route**

Use `getPersonaSkillsForApi()` instead of `getPersonaSkills()` for the API response.

**Step 3: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/worker/src/lib/db/skills.ts \
  packages/worker/src/routes/personas.ts
git commit -m "feat(personas): return rich skill metadata from persona skills API"
```

---

### Task 12: End-to-End Verification

**Step 1: Full typecheck**

Run: `pnpm typecheck`
Expected: PASS across all packages

**Step 2: Run tests**

Run: `pnpm test`
Expected: No regressions

**Step 3: Dev server smoke test**

Run: `cd packages/client && pnpm dev`

Verify:
- [ ] `/settings/skills` loads with skill list
- [ ] `/settings/skills/new` shows create form
- [ ] `/settings/skills/:id` shows edit/view form
- [ ] `/settings/personas` shows card grid, edit links to detail page
- [ ] `/settings/personas/new` shows full-page editor with all 4 sections
- [ ] `/settings/personas/:id` shows populated editor
- [ ] Skill picker search works
- [ ] Tool picker shows services and actions
- [ ] Admin default skills section works

**Step 4: Commit (if any fixes needed)**

```bash
git commit -m "fix(ui): address smoke test issues"
```

---

## File Summary

| File | Action | Purpose |
|------|--------|---------|
| `packages/worker/migrations/0063_persona_tools.sql` | Create | persona_tools D1 table |
| `packages/worker/src/lib/schema/persona-tools.ts` | Create | Drizzle schema |
| `packages/worker/src/lib/schema/index.ts` | Modify | Add export |
| `packages/worker/src/lib/db/persona-tools.ts` | Create | Query helpers |
| `packages/worker/src/lib/db/skills.ts` | Modify | Add getPersonaSkillsForApi |
| `packages/worker/src/lib/db.ts` | Modify | Add export |
| `packages/worker/src/routes/personas.ts` | Modify | Tools API + rich skills API |
| `packages/worker/src/durable-objects/session-agent.ts` | Modify | Deliver tool whitelist |
| `packages/runner/src/types.ts` | Modify | toolWhitelist type |
| `packages/runner/src/bin.ts` | Modify | Filter tools by whitelist |
| `packages/shared/src/types/index.ts` | Modify | PersonaToolConfig, PersonaToolWhitelist |
| `packages/client/src/api/skills.ts` | Create | Skills API hooks |
| `packages/client/src/api/personas.ts` | Modify | Persona tools/skills hooks |
| `packages/client/src/api/org-default-skills.ts` | Create | Org default skills hooks |
| `packages/client/src/components/skills/skill-picker.tsx` | Create | Search-and-add picker |
| `packages/client/src/components/skills/skill-card.tsx` | Create | Skill card for grid |
| `packages/client/src/components/personas/persona-tool-picker.tsx` | Create | Tool whitelist picker |
| `packages/client/src/routes/settings/skills.tsx` | Create | Skills library page |
| `packages/client/src/routes/settings/skills.$id.tsx` | Create | Skill editor page |
| `packages/client/src/routes/settings/personas.$id.tsx` | Create | Full-page persona editor |
| `packages/client/src/routes/settings/personas.tsx` | Modify | Link to detail page |
| `packages/client/src/routes/settings/admin.tsx` | Modify | Default skills section |
| `packages/client/src/components/layout/sidebar.tsx` | Modify | Skills nav item |

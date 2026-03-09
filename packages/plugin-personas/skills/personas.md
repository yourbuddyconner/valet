---
name: personas
description: Create and configure agent personas with attached skills. Manage the skill library and understand skill sources.
---

# Persona & Skill Management

## Concepts

### Skills

Skills are markdown documents that teach agents how to perform specific tasks. Every skill has a **source** that determines where it came from and whether you can edit it:

| Source | What it is | Editable? | Example |
|--------|-----------|-----------|---------|
| `builtin` | Platform-shipped skills | No | browser, workflows |
| `plugin` | Skills from installed extensions | No | custom org plugins |
| `managed` | Skills created by users or agents | Yes (owner only) | "deploy-checklist", "code-review-frontend" |

Skills also have **visibility**:
- `private` — only the creator can see and use it
- `shared` — visible to the entire org

### Personas

Personas are instruction sets that customize agent behavior. A persona has:
- **Name and icon** — human-readable identity
- **Instructions** — system prompt markdown that defines the agent's role and behavior
- **Attached skills** — skills that auto-load when a session starts with this persona

### How skills reach an agent session

When a session starts, the system loads skills in this order:
1. If the session has a **persona** → load skills attached to that persona
2. If no persona → load **org default skills**
3. Agent can always **search and read** additional skills on demand from the full library

This means attaching a skill to a persona guarantees it's in the agent's context from the first message — no searching needed.

## Common Workflows

### Creating a specialized agent

1. **Create skills** for the agent's domain knowledge:
   ```
   create_skill(name: "Frontend Code Review", content: "# Frontend Review Standards\n\n...")
   ```

2. **Create a persona** with role instructions:
   ```
   create_persona(name: "Frontend Reviewer", icon: "🔍", instructions: "You are a frontend code reviewer...")
   ```

3. **Attach skills** to the persona:
   ```
   attach_skill_to_persona(personaId: "<persona-id>", skillId: "<skill-id>")
   ```

4. **Spawn a session** with the persona (from orchestrator):
   ```
   spawn_session(task: "Review PR #42", persona_id: "<persona-id>", ...)
   ```

### Inspecting a persona's configuration

```
list_persona_skills(personaId: "<persona-id>")
```

Returns all attached skills with their source, description, and sort order.

### Reusing existing skills

Before creating a new skill, search the library:
```
search_skills(query: "code review")
```

You can attach builtin or plugin skills to personas — they don't need to be managed. Any skill from any source can be attached.

### Updating a persona's skill set

- **Add a skill:** `attach_skill_to_persona(personaId, skillId)`
- **Remove a skill:** `detach_skill_from_persona(personaId, skillId)`
- **Reorder:** Detach and re-attach with a different `sortOrder` (lower = loaded first)

## Tool Reference

| Tool | Purpose |
|------|---------|
| `create_persona` | Create a new persona with name, icon, instructions |
| `update_persona` | Update persona metadata or instructions |
| `delete_persona` | Remove a persona |
| `list_personas` | List all available personas |
| `create_skill` | Create a managed skill |
| `update_skill` | Update a managed skill's content |
| `delete_skill` | Delete a managed skill |
| `search_skills` | Search the skill library by keyword |
| `read_skill` | Read a skill's full content |
| `attach_skill_to_persona` | Attach a skill to a persona |
| `detach_skill_from_persona` | Detach a skill from a persona |
| `list_persona_skills` | List skills attached to a persona |

## Tips

- **Visibility defaults differ:** Skills default to `private`, personas default to `shared`. Set visibility explicitly when creating.
- **Sort order matters:** Skills load in sort order. Put foundational skills (coding standards, conventions) at lower sort orders so they appear first in context.
- **Managed skills only:** You can only edit/delete skills with `source: managed`. Builtin and plugin skills are read-only, but you can still attach them to personas.
- **Skill content format:** Use YAML frontmatter for metadata (tags, version) followed by markdown content. The content is what gets loaded into the agent's context.

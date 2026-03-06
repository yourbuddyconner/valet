---
# agent-ops-rc5p
title: Per-Repo Plugin Content Scanning
status: todo
type: task
priority: medium
tags:
    - plugins
    - runner
    - content-delivery
created_at: 2026-03-06T00:00:00Z
updated_at: 2026-03-06T00:00:00Z
---

When `allowRepoContent` is enabled for an org, the Runner should scan the cloned repo's `.valet/` directory at boot and merge any discovered content on top of the plugin-delivered content.

## Context

The unified plugin system delivers skills, personas, and tools from D1 to the sandbox via the Runner WebSocket `plugin-content` message. The `allowRepoContent` flag is already stored in `org_plugin_settings`, delivered to the Runner, and written to the sandbox — but the Runner does not yet act on it.

## Scope

1. After writing plugin content to the filesystem, scan the workspace for:
   - `.valet/personas/*.md` → copy to `.opencode/personas/` (prefixed with `repo-`)
   - `.valet/skills/*.md` → copy to `.opencode/skills/repo-<name>/SKILL.md`
   - `.valet/tools/*.ts` or `*.json` → copy to `.opencode/plugins/valet/repo-<name>`
2. Only scan if `allowRepoContent` is `true`
3. Repo content should layer on top of (not replace) plugin-delivered content
4. Handle missing `.valet/` directory gracefully (common case)

## Files

- `packages/runner/src/bin.ts` — add scanning logic after plugin content is written
- Could also live in a dedicated `packages/runner/src/repo-content.ts` module

## Notes

- This must run after the git clone completes and after plugin content is written
- Timing matters: the Runner receives `plugin-content` early in boot, but the repo clone may not be done yet. May need to defer scanning until after clone.
- The `allowRepoContent` setting is admin-controlled as a security gate — orgs can disable it if they don't trust repo-provided agent content

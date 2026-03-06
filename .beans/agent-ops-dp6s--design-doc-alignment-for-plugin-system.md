---
# agent-ops-dp6s
title: Update Plugin System Design Doc to Match Implementation
status: done
type: chore
priority: low
tags:
    - plugins
    - docs
created_at: 2026-03-06T00:00:00Z
updated_at: 2026-03-06T00:00:00Z
---

The design doc and implementation plan reference `plugins/<name>/` as the directory structure, but the actual implementation uses `packages/plugin-<name>/` (npm workspace packages). Update both docs to reflect reality.

## Files

- `docs/plans/2026-03-05-unified-plugin-system-design.md` — update directory references from `plugins/` to `packages/plugin-*/`
- `docs/plans/2026-03-06-unified-plugin-system.md` — update directory references, note completed status

## Also consider

- Document the filesystem paths used by the Runner (`/root/.opencode/personas/`, `/root/.opencode/skills/`, `/root/.opencode/plugins/valet/`) since these differ from what the design doc described
- Add a note about the superpowers OpenCode plugin remaining in the Docker image (not part of the valet plugin system)

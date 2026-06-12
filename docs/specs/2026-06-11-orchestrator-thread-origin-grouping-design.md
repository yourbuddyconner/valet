# Orchestrator Thread Origin Grouping

## Context

The orchestrator thread sidebar groups threads by `SessionThread.channelType` and `SessionThread.channelId`. The thread list API currently derives those fields from `channel_thread_mappings`, which are routing records for external replies.

That makes UI grouping unstable. A thread that originally started in Web can later gain a Slack DM mapping when the agent sends an approval, DM, or follow-up message. Once that happens, the thread can appear under Slack instead of Web. Scheduled and manual triggers that target the orchestrator also have no durable UI origin, so automation-created threads fall into whichever routing metadata happens to be present.

## Goals

- Keep orchestrator thread grouping based on where the thread originally came from.
- Add an Automations group for orchestrator-targeted manual and scheduled triggers.
- Keep Slack and Web groups limited to threads that originally originated from those platforms.
- Preserve existing routing behavior for Slack replies, approval prompts, and follow-ups.
- Leave workflow executions out of scope.

## Non-Goals

- No changes to workflow execution sessions or workflow execution history.
- No changes to Slack reply routing semantics.
- No broad redesign of the thread sidebar UI.
- No backfill job for historical threads beyond safe fallback behavior.

## Design

Persist display origin directly on `session_threads` instead of deriving it from `channel_thread_mappings`.

Add nullable origin fields to `session_threads`:

- `origin_type`: coarse UI grouping source. Expected values are `web`, `slack`, `automation`, and future channel types as needed.
- `origin_channel_type`: original platform channel type when applicable.
- `origin_channel_id`: original platform channel identifier when applicable. For Slack, store the raw Slack conversation id (`C...` or `D...`), not a composite dispatch id that includes team id or thread timestamp.
- `origin_trigger_id`: trigger id for orchestrator-targeted manual or scheduled trigger threads.
- `origin_trigger_type`: trigger type for automation threads, such as `manual` or `schedule`.

Thread creation sets these fields once:

- Web-created orchestrator threads set `origin_type = 'web'`.
- Slack-created orchestrator threads set `origin_type = 'slack'`, with original Slack channel data.
- Orchestrator-targeted manual and scheduled triggers set `origin_type = 'automation'`, with trigger metadata when available.

`channel_thread_mappings` remains the routing table. It can continue to record Slack DM and Slack thread bindings for replies, approvals, and follow-ups, but those mappings no longer decide sidebar grouping.

The thread list API returns the new origin fields while keeping the legacy `channelType/channelId` response fields for compatibility. The client groups by origin fields first and falls back to legacy `channelType/channelId` when origin fields are absent, so older rows still render.

## Data Flow

1. A user, Slack event, or orchestrator-targeted trigger creates or selects an orchestrator thread.
2. The creation path writes immutable origin metadata to `session_threads`.
3. Later outbound Slack messages may create channel bindings and channel thread mappings.
4. `GET /api/sessions/:sessionId/threads` reads thread origin from `session_threads`.
5. The thread sidebar groups by origin metadata:
   - `automation` renders as Automations.
   - `web` renders as Web.
   - `slack` renders as Slack or the resolved Slack label.
   - missing origin falls back to existing channel grouping.

## Compatibility

Existing threads have null origin fields. The list API and sidebar must keep the current fallback path for those rows. This avoids a risky data migration and keeps historical threads visible.

When old web-origin threads have only Slack mapping metadata, they may continue to appear under Slack until they are touched by a path that can set origin safely. The primary guarantee is for new and newly-created orchestrator threads after this change.

## Testing

- Unit test thread listing so `origin_*` fields are returned from `session_threads` and take precedence over channel mappings.
- Unit test channel thread pre-registration so adding a Slack mapping does not change a thread's origin metadata.
- Unit test orchestrator prompt dispatch for `forceNewThread` with trigger metadata to verify automation origin is persisted.
- Unit test client grouping to ensure Automations, Web, and Slack grouping use origin fields before legacy channel metadata.

## Rollout

1. Add D1 migration and Drizzle schema fields.
2. Update thread creation/update helpers to accept origin metadata.
3. Thread origin is written at creation time for web, Slack, and orchestrator-targeted trigger paths.
4. Update shared/client thread types and sidebar grouping.
5. Keep fallback grouping for legacy rows.

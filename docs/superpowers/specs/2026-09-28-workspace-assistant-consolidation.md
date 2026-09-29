# Workspace assistant and automation controls

Status: user-approved direction, local implementation in progress. Full automated validation remains deferred.

## Local implementation checkpoint

The app shell now docks Ask Valet beside the page. Workflows and Events use this entry point for assisted creation, with manual setup retained. App and workflow-editor entry points reuse the same durable `app-assistant:<viewerId>` Thread within the server-authorized owner runtime. Repeated opens and page reloads do not create new Threads. Team conversations remain team-readable, but each viewer has their own assistance Thread. These utility Threads are excluded from the regular sidebar, search, and implicit default selection; Ask Valet resumes them. Existing workflow-specific conversations remain stored.

Starter actions fill only empty drafts, or collapse identical legacy repetitions; they preserve other draft text. The shared dock does not mount on Chat or workflow-editor routes, avoiding duplicate composers. Late opens cannot navigate after close or to a different current page/workspace. The desktop dock takes real layout space; narrow screens use an overlay.

Team settings group home-channel routing, Slack reply setup, subscription management, and the link to personal DM preferences. Event subscriptions display workspace and organization rules separately. Organization rules retain an explicit management view. Personal thread settings label fallback as Organization default only when organizations are enabled, otherwise Valet default.

Not implemented from the target design below: enforced draft/review/enable for agent-created automation; channel-name selection and a full notification-policy editor; unified diagnostic timeline across all subsystems; server-synced project folders and pins. The workflow editor still saves tool changes immediately. Do not describe the conversational starter as an activation gate.

Visual checks confirmed the dock, page-navigation continuity, search filtering/selection, pin actions, six-image intake without text, automatic browser preview, and single starter text after repeated clicks. Local sandbox browser support is unavailable, so the live feed remains unverified. Full tests, build, and typecheck were not run. A read-only review found a stray prop, stale-navigation risk, collapsed approval indicators, and duplicate composers/draft overwrites; these were corrected.


## Intent

Valet accompanies users through the app. Events and workflows use one assisted setup flow. Related Slack controls appear together. Personal and team resources remain separate. The homepage remains a briefing. Full automated validation remains deferred during the visual iteration.

## Assistant surface

Add one workspace-scoped assistant panel to the signed-in app shell. A Valet button opens it from any page. On desktop it is a right column; on small screens it is a drawer. Closing the panel preserves its conversation. Navigating between pages preserves it within the same workspace. Changing workspace clears visible context immediately and loads a separately owned conversation only after access is confirmed.

Reuse SessionView, transcript, composer, and decision controls. Do not introduce a second messaging implementation. Replace the workflow editor's separate assistant host with this surface, preserving its existing conversation and saved-change behavior. Threads use their current conversation instead of mounting two composers for the same thread.

Show the workspace name and a visible context chip such as “Workflow: NDA intake” or “Event: receipt reference”. Context contains authorized resource identifiers and the page purpose, not an automatic dump of rendered page content. The server checks access when resolving each referenced resource. A workspace change must not move drafts, attachments, or context to another owner.

## Automation creation

Workflows and Events offer Create with Valet. Keep manual setup as a secondary action. Events retain Activity, Subscriptions, and Event Logs; a subscription row reads “When [event/filter], [action], owned by [workspace]”. Scheduled remains the workflow schedule surface.

New automation starts as a draft. The assistant gathers missing fields and presents a structured review card:

- Owner: Personal or the selected team, fixed for this draft.
- When: service, event or schedule, channels, and matching conditions.
- Do: workflow or assistant action.
- Approvers: actual authorized audience.
- Notify: origin thread, home channel, and optional personal copies.
- Effects: what enabling the rule will do.

Enable is a user action. A prompt telling the agent to wait is not sufficient enforcement. Draft creation must not call live subscription or schedule enablement. Validate access, matching conflicts, credentials, and current draft revision at activation. Show failures without discarding the draft. Repeated submission must not create duplicate live rules.

Existing workflow edits currently save immediately through workflows.patch_workflow. Preserve and label that behavior until a separate draft-edit mechanism exists. Do not describe these edits as awaiting review.

## Consolidated Slack controls

Within selected team settings, use one “Slack” section:

1. Connection status, with organization connection setup linked for authorized administrators.
2. Home channel, selected by channel name with ID shown as secondary information.
3. Respond to messages: mention channels, who may invoke the team assistant, and followed-thread behavior. Reuse the existing Slack replies wizard.
4. Team notices: approvals, questions, failures, and completion notices, with their destination visible.
5. Approval permissions shown separately from delivery choices. Do not imply that setting a notification recipient grants approval rights.

Selecting a home channel does not silently subscribe to all channel messages. Offer an explicit choice to configure replies there. Existing Slack conversations retain their origin. New notices use the configured home channel. A personal notification preference controls optional DM copies; it does not edit a team's channel or permissions.

Recommended defaults: team notices enabled after explicit channel selection; personal team DM copies off. Keep sensitive approval content in Valet unless destination audience and authorization support an actionable Slack card.

## Scope and default labels

Personal pages list personal resources only. Team pages list that team's resources only. Move organization-wide subscriptions to an explicit organization administration surface before excluding them from workspace lists, so existing rules remain manageable. Enforce scope server-side as well as in query keys and UI filters.

Personal model and reasoning preferences never inherit team defaults. Return effective defaults and their provenance from the server. Display the configured organization name and resolved value when organization mode applies. Otherwise display “Valet default” and the resolved value. Do not use the presence of an internal org ID as proof of a user-facing organization. Loading or inaccessible defaults must say unavailable, not guess a model.

## Delivery sequence

1. Consolidate Slack controls using existing mutations; retain current authorization.
2. Add the shared assistant host and contextual entry points without enabling new automation.
3. Implement draft review and explicit activation; then make assisted creation primary.
4. Move org rules to administration and enforce workspace-only lists.
5. Expose effective personal default provenance and update labels.

For each step, visually review desktop and narrow screens, workspace switching, recovery, and empty states. Do not send Slack messages during this review. Before release, resume automated authorization, draft activation, duplicate submission, routing, and regression checks.

## Incomplete features and disposition

| Finding | Evidence | Recommendation |
| --- | --- | --- |
| Workflow assistant writes immediately | packages/web/src/components/workflows/editor/assistant-panel.tsx; workflows.patch_workflow | Keep existing editing with explicit saved-change wording. Do not reuse it as a pretend draft review. |
| Project folders exist only in browser storage | packages/web/src/lib/thread-projects.ts | Keep for local review; exclude claims of shared or cross-device projects until server persistence exists. |
| Background processes shows running tool calls only | packages/web/src/components/session/thread-context-panel.tsx | Rename to Active tools or hide until detached processes are tracked. |
| Sources is extracted from loaded user messages | packages/web/src/components/session/thread-context-panel.tsx | Label as sources from loaded messages; do not imply complete provenance. |
| PR/merged status has no durable thread association | packages/web/src/components/session/thread-status-icon.tsx | Exclude PR status icons until real association and provider state exist. |
| Slack approval callback references are process-local maps | packages/api/src/channels/host.ts: gateRefs, gatePrompts, gateActions | Keep web approval as the reliable destination; persist and reconcile references before claiming restart-safe Slack approval controls. |
| Home-channel notices are generic, best-effort links | packages/api/src/channels/host.ts: attentionDeliverer; packages/api/src/orchestrator/attention.ts | Keep honestly labeled; add durable retry and deduplication before claiming reliable delivery. |
| Workspace subscription lists include org-owned rules | packages/api/src/routes/events.ts: GET /event-subscriptions | Move org rules to their own administration surface, then tighten workspace lists. Do not delete records. |
| Event Logs still has two independent searches and pagers | packages/web/src/routes/events.index.tsx | Accept for first pass; later unify with a server-backed cursor across both stores. Do not merge only the currently loaded pages. |
| Receipt diagnostic action is not yet exercised | packages/api/src/events/actions.ts | Keep behind existing admin/private-session authorization; validate before release. Not a unified chat/skill diagnostic tool. |
| Unused compact home branch survives earlier iteration | packages/web/src/components/dashboard/workspace-catch-up.tsx | Remove after confirming all callers use the full briefing. |

Do not delete legacy subsystems, stored workflows, event logs, or subscriptions as part of this UI consolidation. This is a focused inspection of the touched areas, not an exhaustive codebase audit.

### Thread-first workflow creation checkpoint

The Workflows empty state now hosts SessionView with its standard composer and a short introduction. On first send it saves a minimal unscheduled workflow, sends the request in the durable workspace helper Thread, then opens the existing editor. The existing assistant panel and patch watcher drive real saved canvas updates. No parallel chat or canvas implementation was added. Manual setup no longer maintains presets; import/manual entry points moved to overflow.

The shell save is not an enforced draft lifecycle: there is still no server-side prohibition on a later agent enabling a schedule. First-send instructions ask the agent to wait for explicit activation. A failed send can leave an unscheduled shell in the list, available to resume. Creation retries retain the shell id while the creation view stays mounted; reloading does not recover that transient association. Visual validation passed for the first-send handoff and actual node updates; full validation is deferred.

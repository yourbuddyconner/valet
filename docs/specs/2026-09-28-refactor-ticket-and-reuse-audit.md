# Threads refactor: related tickets and reuse audit

Linear review on 2026-09-28. Issue status does not establish implementation completeness in this branch.

| Issue | Status | Relationship |
| --- | --- | --- |
| [TKAI-559](https://linear.app/turnkey/issue/TKAI-559) | Triage | Umbrella for conversation, event routing, notifications; preserves execution/security boundaries and separates delivery from approval authority. |
| [TKAI-557](https://linear.app/turnkey/issue/TKAI-557) | Triage | Thread-first routing and configuration model. |
| [TKAI-535](https://linear.app/turnkey/issue/TKAI-535) | Backlog | Remove session concepts from user-facing surfaces while preserving internal execution boundaries. |
| [TKAI-564](https://linear.app/turnkey/issue/TKAI-564) | Triage | Child approval requests fail to reach parent/Slack. Requires end-to-end routing validation, not just new cards. |
| [TKAI-539](https://linear.app/turnkey/issue/TKAI-539) | Backlog | Surface permission requests in team orchestrator replies. |
| [TKAI-537](https://linear.app/turnkey/issue/TKAI-537) | In Review | Subscription delivery precedence, implemented as a local checkpoint in the previous commit. |
| [TKAI-363](https://linear.app/turnkey/issue/TKAI-363) | Backlog | Notification preferences, home channel, and personal team-DM preference. |
| [TKAI-558](https://linear.app/turnkey/issue/TKAI-558) | Backlog | Outcome-oriented subscriptions and Subscribe to thread preset. |
| [TKAI-155](https://linear.app/turnkey/issue/TKAI-155) | Canceled | Earlier request for context-specific permanent approval. Relevant product evidence, but its implementation pointers are legacy. |

## Reuse opportunities grounded in current code

1. **Assistant panel shell.** components/layout/workspace-assistant.tsx and components/workflows/editor/assistant-panel.tsx already reuse SessionView. Their opening/error/retry shell can share a small component. Keep different thread lifetimes explicit: workspace helper versus per-workflow conversation. Do not introduce another transcript or composer.
2. **Approval presentation.** ApprovalCard, PolicyGateCard, and DecisionGateCard repeat note inputs, busy/error presentation, parameters, and confirmation framing. Share those visual pieces; preserve separate decision adapters because human checkpoints and reusable permissions have different authority and persistence.
3. **Subscription forms.** AutomationWizard and EditSubscriptionDialog already share EventMatchStep, filter editing, prompt fields, and now DeliveryPreferences. Consolidate remaining form layout and collision-feedback presentation around those components rather than merging their different create/update contracts.
4. **Permission analysis.** The current change reuses workflows/permissions.ts, its routes, and the existing policy resolver for both preview and execution. It replaces broad pre-approval behavior rather than adding a second endpoint family. Revoke is the one new mutation needed for workflow-scoped grants.

## Keep out of this cleanup

Do not migrate or expand packages/worker, client, runner, or backend: CLAUDE.md marks them frozen. Deleting them is a separate production cutover, not safe cosmetic cleanup. Do not claim child-to-parent/Slack approval delivery is fixed by compact cards. Do not describe a static permission report as a guarantee that dynamic or nested work cannot pause.

The local briefing also displayed a generation error during this pass, and its journal summary included a model request for missing input. These are observed product defects to investigate separately; this audit does not establish their causes.

## Shared assistant panel checkpoint

Workspace Ask Valet and the workflow editor now use `components/session/assistant-panel.tsx` for header, loading, errors, retry, and summary placement. Both retain the shared SessionView transcript and composer. The host still selects the durable conversation: one workspace helper or one conversation per workflow. Opening a panel does not create a new conversation.

The panel header spans the column and keeps controls at its right edge. Custom headers remain available during session loading and errors. Workflow graph cards have a common minimum height so short adjacent steps align their connectors. Saved graph positions and viewport remain unchanged.

Local browser inspection covered desktop rendering and the compact assistant tab. Read-only review found a missing Close control during session loading/error; that was corrected. Automated validation remains deferred.

PR #818 is attached to TKAI-537, TKAI-535, TKAI-557, and TKAI-558. Only TKAI-537 moved to In Review. The other three have explicit partial-coverage notes and retain their statuses. CLI/API flattening, the full routing-spec acceptance matrix, and structured subscription presets remain outside the completed scope.

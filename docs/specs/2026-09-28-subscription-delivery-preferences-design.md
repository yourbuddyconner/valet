# Personal subscription delivery preferences

Personal assistant subscriptions can defer to an enabled team assistant subscription that matches the actual event. Existing subscriptions retain fan-out behavior unless their owner changes this preference.

## Behavior

- `always`: deliver normally (the default).
- `ignoreIfMyTeamSubscribed`: skip when a matching team subscription belongs to a team the personal owner currently belongs to.
- `ignoreIfAnyTeamSubscribed`: skip when a matching team subscription exists in the same organization.
- `pauseOnOverlap`: additionally disable the personal subscription on the first actual overlap. The UI warns that it stays paused until manually enabled. Choosing an ignore policy in the UI offers this option checked; choosing always preserves normal delivery.

Creation and editing share one preference component. These controls apply only to personal assistant targets. The subscription list displays the pause reason, and Event Logs distinguish skipped delivery from failure. Re-enabling clears the pause marker but preserves the policy; a later overlap can pause it again. Choose always to explicitly receive overlapping events.

## Dispatch and concurrency

Coverage is checked immediately before dispatch, including retries and explicit redelivery. Candidates must be enabled, team-owned assistant subscriptions in the same organization, with an existing team. Event keys, filters, and existing Slack sender authorization checks must match. Disabled, unrelated, and cross-organization subscriptions do not suppress delivery. No private team identifiers or names are exposed in skip reasons.

Skipped deliveries are terminal and do not retry automatically. A team match does not guarantee that the team's subsequent processing succeeds; this feature does not provide failover. Changes after the dispatch coverage check cannot recall work already in flight. Previously followed Slack threads are independent routing bindings and are not retroactively removed by this preference.

Automatic pause uses a version-checked update. Subscription PATCH also checks the version read before validation, so a concurrent edit cannot silently undo the pause. A stale edit receives a refresh-and-retry conflict.

The delivery status column is text; adding skipped to its TypeScript enum does not require a database enum migration.

## Related issues

- [TKAI-537](https://linear.app/turnkey/issue/TKAI-537): exact delivery precedence request.
- [TKAI-363](https://linear.app/turnkey/issue/TKAI-363): simpler notification preferences.
- [TKAI-558](https://linear.app/turnkey/issue/TKAI-558): subscription UI and thread preset.
- [TKAI-292](https://linear.app/turnkey/issue/TKAI-292) and [TKAI-294](https://linear.app/turnkey/issue/TKAI-294): earlier overlap analysis and write-time collision detection; neither supplies this runtime suppression.

## Validation checkpoint

Regression cases added for policy selection, membership, disabled teams, organization isolation, persistent pause, terminal skips, and redelivery after coverage changes. Automated tests, builds, typecheck, and full end-to-end validation remain deferred per the current visual-first workflow. Local UI save inspected using a disabled preview subscription; no live subscription was activated.

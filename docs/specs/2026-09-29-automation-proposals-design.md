# Automation proposals

Ask Valet can save a disabled subscription or schedule for human review.
The proposal uses the existing event subscription or workflow schedule row.
No separate proposal store or activation endpoint exists.

The tools are `events.propose_subscription`, `workflows.propose_trigger`, and
`workflows.propose_schedule`. Each requires a stable `proposal_key` and its
normal configuration fields. Assistant subscription ownership follows the
current personal or team assistant. Workflow ownership checks still apply.
Team writes use the existing ownership lock and membership checks.
Subscription proposals accept optional `follow` for personal and team targets.
`follow: true` requires only `slack.app_mention`; message subscriptions already
deliver matching replies and must not also create a follow binding.
Personal proposals also accept `delivery_policy` and `pause_on_overlap`.
These map to the existing target fields. Team proposals reject the delivery preferences. Omitted fields keep the existing delivery defaults.

Each result has this structure:

```json
{
  "success": true,
  "data": {
    "proposal": {
      "kind": "subscription",
      "id": "proposal-...",
      "enabled": false,
      "reviewUrl": "/events?tab=subscriptions&review=proposal-...",
      "config": {}
    }
  }
}
```

`config` contains the stored configuration. Workflow trigger results include
their workflow target. Schedule results use `kind: "schedule"` and link to
`/workflows?tab=scheduled&review=ID`.

The ID derives from the proposal kind, organization, owner scope, and key.
The database primary key serializes concurrent retries. A repeated key returns
the existing row without changing its configuration or enabled state.
A caller must use a new key for a different proposal.

The review page fetches the stored row by ID. It uses the existing edit and
enable endpoints, including their validation and collision checks.
The proposal tools never enable a row. Explicit create APIs keep their current behavior.

## Review interaction

The existing Events and Scheduled pages accept a `review` ID. They read the
saved record in the selected workspace. A link does not enable anything.
The existing edit dialog combines changes and `enabled: true` in one PATCH.
Cancel leaves the record paused. Reopening an enabled proposal edits that same
record rather than creating another automation. Collision and authority checks
remain in the existing mutation handlers.

One shared review component presents When, Scope, Result, Destination, and
Permissions. It also shows explicit follow behavior and team audience. Workflow
proposals link to the existing permission report. The tool preview displays
filter operators and builds local review links from validated IDs; it does not
navigate to a URL supplied by tool output.

Subscribe to thread is a preset in the existing outcome picker. A Slack Copy
link supplies the channel and parent timestamp. The resulting `slack.message`
subscription matches those two fields and sets `follow: false`: the subscription
already matches future replies, so an additional follow binding would duplicate
work. Only future human replies match. The preset does not backfill history or
grant channel access.

Manual setup and assistant proposals share the review vocabulary and edit
controls. No second transcript, workflow executor, proposal table, or activation
endpoint was introduced.

## Interaction checks

- Opening or canceling a proposal does not mutate it.
- Editing and enabling preserves its ID and uses one existing mutation.
- Invalid Slack links cannot advance. Reply links select their parent thread.
- The final preset payload has exact channel/timestamp filters and no additional
  follow binding. No create call occurs before final confirmation.
- Tool previews show operators, follow behavior, audience, and only local links.
- A proposal outside the selected workspace shows a scope error, not its details.

Targeted UI run: 7 files, 80 tests passed. Slack trigger catalog suite passed.

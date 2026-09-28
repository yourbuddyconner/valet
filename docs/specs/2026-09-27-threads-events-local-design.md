# Threads and Events local iteration

Status: workspace routing foundation implemented locally. Broader event diagnostics and discovery work remain.

## Confirmed direction

Each personal or team workspace has one assistant. The assistant is an internal
runtime identity. Users work with workspace-owned threads, workflows, subscriptions,
and memory. Assistant selection and profile customization are not product features.

This is a development environment. Backward compatibility and production migration
are not required. Keep session internals where they enforce execution, sandbox,
credential, or authorization boundaries. Do not replace those boundaries with labels.

Sources:

- TKAI-559: https://linear.app/turnkey/issue/TKAI-559
- TKAI-557: https://linear.app/turnkey/issue/TKAI-557
- TKAI-558: https://linear.app/turnkey/issue/TKAI-558
- TKAI-535: https://linear.app/turnkey/issue/TKAI-535
- TKAI-363: https://linear.app/turnkey/issue/TKAI-363
- September 25 proposal: https://turnkeycrypto.slack.com/archives/D0BA9F58SRM/p1790389511254639
- Xiangan's September 27 clarification: singleton workspace assistants, no customization,
  no backward compatibility, and local verification before further iteration.

## Implemented foundation

- Threads replaces Chat in navigation. Sessions and Artifacts leave primary navigation.
- Existing runtime detail routes remain until Threads provides their replacement surface.
- Problems shows recorded explanations, references, and accurate coverage limitations.
- Personal and team initialization uses the existing atomic default resolver.
- Custom profile creation, editing, deletion, and avatar writes are refused.
- Agent tools cannot create or modify assistant profiles.
- Chat URLs use workspace and thread identity. Both rail and page share an owner-addressed ensure.
- The workflow editor resolves its owning workspace and adopts that scope in navigation.
- Event, follow, and scheduled-prompt delivery uses the workspace singleton.
- Workflow definitions and subscription writes reject assistant overrides.
- Notification links and attention sounds identify the destination workspace and thread.
- Seeded examples use the actual REST history, workflow, and diagnostics surfaces.

## Reuse map

| Concern | Existing implementation | Decision |
| --- | --- | --- |
| Transcript, composer, thread tree | Web session components | Reuse |
| Durable history, submissions, thread creation | Engine Thread and SessionStore | Reuse |
| Workspace scope and resource adoption | Web workspace-scope | Reuse |
| Singleton runtime | API atomic default-assistant resolver | Reuse |
| Child execution and sandboxes | Engine sessions and providers | Preserve isolation |
| Workflow execution | DAG interpreter and run checkpoints | Reuse |
| Event delivery | Matcher, dispatcher, retries, deduplication | Reuse |
| Problem records | event_drop_log and Events UI | Improve coverage and presentation |

## Invariants

- Personal and team authorization comes from the server, never from the URL alone.
- A failed team lookup must not open personal history.
- Session credentials, sandbox ownership, transcript ancestry, and gate authority remain intact.
- A notification preference changes delivery, not authorization.
- Local fixtures do not establish whether Slack delivered a production message.
- Do not connect local Slack or send external notifications during this review.

## Next iteration

- Make standalone and child execution discoverable through Threads.
- Place artifacts beside their originating work.
- Add outcome-oriented event presets while retaining the advanced subscription editor.
- Distinguish event receipt, classification, matching, delivery, and workflow outcomes.
- Record bounded explanations for currently silent classifier rejections.
- Add a team home channel and personal notification preferences after confirming semantics.
- Remove unused assistant routing columns and remaining internal selection types.

Recommended home-channel rule: default new team notifications to that channel.
Keep replies in the originating Slack thread. Choosing a home channel does not
subscribe to every message in it. Personal DM copies should be opt-in and should
not affect team access or approval authority.

## Verification

Verify singleton initialization under concurrency, cross-owner denial, workspace
switching, deep links, workflow origins, retries, and persistence after restart.
Run the canonical scorecard and identify each environmental failure separately.
Exercise the actual browser and a local workflow with a real model response.
Live Slack ingress remains unverified in this local environment.

## Structure review and next decisions

The current structures already separate ownership, execution, and conversation:

| Structure | Current responsibility | Recommended role |
| --- | --- | --- |
| Personal or team owner | Authorization, credentials, resource visibility | Own threads, workflows, subscriptions, and memory |
| Assistant row | Runtime identity and default resolution | One internal identity per workspace; no selectable profiles |
| Session | Runtime resources, sandbox, credentials, gates, child execution | Keep as an execution boundary below the Threads UI |
| Thread | Transcript, queued submissions, activity, cancellation | Primary conversation visible to the user |
| Workflow definition | DAG configuration and owner | Reusable workspace-owned automation |
| Workflow run | Immutable definition snapshot, checkpoints, outcomes | One execution with links to its working threads |
| Event subscription | Matching, authorized owner, delivery target | Route by workspace; keep delivery diagnostics separate from conversation history |

### Workflow thread node recommendation

Build a future thread node from the existing orchestrator node. It already
uses durable submissions, dispatch deduplication, checkpointing, waiting, and
output-schema repair. The API already chooses an attended origin thread or
a thread associated with the workflow run.

Keep the LLM node for a single model completion. It does not have a transcript
or the durable submission lifecycle. Converting it to a conversational node
would change cost, context, retries, and tool behavior.

Before adding a general thread node, decide these behaviors:

- Use one shared thread per workflow run by default, or isolate each node.
  The current implementation shares a run thread, including loop iterations.
- Keep completed workflow threads visible, or archive them automatically.
  The current implementation archives run-created threads after settlement.
- Return `threadId` with node outputs so later steps can address the same
  conversation. The current settled node result does not expose this value.
- Keep output delivery separate from execution context. A team home channel
  should not silently move an existing Slack conversation or broaden access.

The workflow editor currently remembers its conversation in browser session
storage. A server-side workflow-to-thread relation would let team members
share that conversation and recover it across browsers. Reuse the existing
thread store rather than create a separate chat-message table.

### Cutover implemented in this iteration

Workspace URLs now govern chat and workflow-editor routing. Assistant editor
and list pages, identity forms, and assistant-selection hooks were removed.
Event and scheduled-prompt routing resolves the owner's default runtime.
Writes reject assistant overrides on subscriptions, schedules, and workflows.
Notification links address the workspace and thread. Attention sounds compare
both so an approval in another conversation is not silently suppressed.

Internal assistant rows, runtime session IDs, and some stored routing fields
still exist. They are not a reason to add compatibility UI. A later schema
cleanup can remove unused columns after all internal producers stop writing them.

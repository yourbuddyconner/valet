# Workflow permissions and compact approvals

Approval inbox entries begin collapsed. Their workflow identity, workspace, time, and request remain visible; each expands independently. A focused deep link may open its requested approval. Workflow human-review nodes remain per-run decisions.

Tool permission approval offers Allow for this workflow. The existing pre-approval endpoint now writes workflow_action_grants, not broad personal overrides. The legacy workflow approval scope always is narrowed to workflow; organization-wide permission changes remain in organization settings. Existing unrelated user and organization policies are not migrated or deleted.

Grants bind organization, workflow, current owner, and exact action. They survive subsequent runs and are not copied to another workflow or chat. They authorize the action across its parameters within that workflow until reset; newly introduced actions still need review. Explicit organization, team, and personal policy restrictions remain authoritative. Only a personal workflow's owner or the team's administrator can manage grants. A team API key does not inherit its creator's authority to grant permissions.

The editor polls its existing permission analysis during creation and shows approval, blocked, and runtime-unknown counts. The report lists directly declared tool actions, including supported foreach tool bodies. Dynamic agent actions and nested workflow requirements cannot be guaranteed from this static report. Human approval nodes always remain separate.

The confirmation snapshots reviewed action IDs and submits that list. Concurrent additions cannot silently expand consent. Reset saved permissions removes the workflow's durable grants. Pending workflow approvals commit their resolution signal, grant, audit update, and durable wake flag in one database transaction. A competing resolution writes no grant.

Validation checkpoint: local API boots with the additive schema repair; collapsed notifications and the editor summary were inspected. Regression cases were updated/added for workflow isolation, later runs, chats, reset, and policy precedence. Automated tests, typecheck, and full end-to-end validation remain deferred under the visual-first workflow.

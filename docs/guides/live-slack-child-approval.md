# Live Slack child approval validation

This procedure reuses the running API, child session tools, Slack transport, and Slack webhook.
It does not need a second Slack harness.
The automated `host-outbound.test.ts` case uses a fake transport and cannot prove live Slack delivery.

## Preconditions

Stop before sending a prompt unless all conditions below hold:

- The operator authorized the Slack workspace, app, and recipient for this run.
- The API runs the candidate revision with a working model and sandbox provider.
- The organization has a Slack bot credential with its signing secret and matching workspace metadata.
- Slack interactivity targets this API at `/api/channels/slack/webhook` through a reachable HTTPS URL.
- The parent owner has a linked Slack identity with attention notifications enabled.
- The bot can open that user's DM, post a message, and update its own message.
- That user can click the approval button during the run.

Use a dedicated test installation when possible.
Do not redirect another installation's webhook for this test.
Enter credentials through the existing integration settings.
Do not paste tokens or signing secrets into evidence files.

Parent audience routing sends approval controls to the linked owner's Slack DM.
A team home channel receives a generic notification with a Valet link.
Channel membership does not grant approval authority.
A test channel alone therefore cannot validate this DM approval path.

## Exercise the real path

1. Record the candidate commit, API URL, Slack workspace ID, and authorized recipient ID.
2. Open the personal parent conversation for the linked user.
3. Record its session ID and current decision gates.
4. Send the following prompt with a unique run marker:

   > Use the task tool to create one child for a harmless Slack approval check.
   > Tell the child to call ask_approval with title "SLACK-LIVE-REPLACE-WITH-RUN-ID".
   > The approval authorizes only returning the text "Slack approval check complete".
   > The child must wait for approval before returning that text.
   > Do not edit files, call external action tools, or create additional children.

5. Record the child session ID from the task result.
6. Confirm that its persisted `purpose` is `child` and its `parent_session_id` matches the recorded parent.
7. Confirm that the child has one pending gate with the unique title.
8. Record that gate's ID and saved Slack message reference.
9. Inspect the real Slack card in the authorized recipient's DM.
10. Save its permalink and a screenshot with approval controls visible.
11. Confirm that the parent gate snapshot remains unchanged.
12. Ask the linked user to click **Approve** on that card.
13. Confirm the webhook receipt shows verified signature, accepted workspace, and completed channel processing.
14. Confirm the recorded child gate becomes resolved with the expected actor and action.
15. Confirm the parent gate snapshot remains unchanged.
16. Confirm the child resumes and returns the expected completion text.
17. Confirm Slack updates the original card to show its resolution.

Do not resolve the gate through the web UI, CLI, or a fabricated callback.
Those paths do not prove Slack interactivity.
A `channel: completed` receipt alone does not prove resolution; the handler can decline a callback.
Correlate the receipt, saved message reference, and exact gate resolution.

If the model does not create the specified child and gate, record an incomplete run.
Do not substitute manually inserted gate rows as live evidence.

## Read-only evidence

Use the existing CLI against the test instance to inspect pending gates:

```sh
valet gates list --session "$PARENT_SESSION_ID" --json
valet gates list --session "$CHILD_SESSION_ID" --json
```

The CLI lists pending gates only.
Use the persisted rows to distinguish resolution from disappearance.
For Postgres, run these queries with bound parameters through the existing database connection:

```sql
SELECT id, purpose, owner_type, owner_id, parent_session_id, parent_thread_id
FROM engine_sessions
WHERE id IN ($1, $2);

SELECT id, session_id, thread_id, status, title, resolution, updated_at
FROM engine_decision_gates
WHERE session_id IN ($1, $2)
ORDER BY session_id, created_at, id;

SELECT gate_id, channel_type, ref
FROM engine_decision_gate_refs
WHERE gate_id = $1 AND channel_type = 'slack';

SELECT id, external_id, metadata, stages, created_at
FROM event_receipts
WHERE service = 'slack' AND created_at >= $1
ORDER BY created_at, id;
```

The first two queries take parent and child session IDs.
The third query takes the child gate ID.
The last query takes the run start time in Unix milliseconds.
Limit receipt evidence to the recorded interaction and authorized test workspace.
For embedded PGlite, stop the API before opening its database directory for inspection.
Record pending state before stopping, then restart the same API before clicking the Slack button.
This also checks durable callback references across restart.

## Cleanup and reporting

Keep the resolved card until evidence capture finishes.
This procedure does not delete Slack messages automatically.
If deletion is requested, delete only the exact messages identified by this run's saved references.
Do not delete other messages or clear the recipient's conversation.
Archive only this run's test conversation after capturing its evidence.

Report `PASS` only when every live-path assertion above has evidence.
Report `BLOCKED` when credentials, authorization, webhook reachability, or a human click are unavailable.
Report the automated contract test separately from this live result.

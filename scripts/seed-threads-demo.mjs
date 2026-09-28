/** Local review fixtures. Never connects to Slack or sends a model prompt.
 * Run bootstrap against the local API, stop it, then run offline. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const dataDir = `${root}.valet-dev`;
const manifestPath = `${dataDir}/threads-demo.json`;
const base = 'http://localhost:8788';
const mode = process.argv[2];
const scenarios = [
  { title: '[Demo] Plan the weekly release', scope: 'personal', question: 'What should I check before the next release?', answer: 'This is a seeded local example. Review the checks, outstanding approvals, and release notes. Start a new thread to try a live conversation.' },
  { title: '[Demo] NDA request received', scope: 'team', question: 'Review the NDA request from the intake form.', answer: 'This is a seeded local example of a successful intake conversation. The real thread history API serves this transcript. No Slack event or legal review was executed.' },
  { title: '[Demo] Investigate a missed form', scope: 'team', question: 'Why did the workflow not run for the next form?', answer: 'Open Events → Problems to compare the recorded explanations. Those examples are fixtures; an absent log entry does not establish that Slack delivered the message.' },
];
async function request(path, method = 'GET', body, headers = {}) {
  const response = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}
if (mode === 'bootstrap') {
  const me = await request('/me');
  if (me.id !== 'local-user' || me.orgId !== 'local-org') throw new Error('Seed requires the local stub identity.');
  await mkdir(dataDir, { recursive: true });
  let previous;
  try { previous = JSON.parse(await readFile(manifestPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous) { console.log('Seed manifest already exists. Reuse it for offline seeding.'); process.exit(0); }
  const teams = await request('/teams');
  let team = teams.teams.find(row => row.name === 'Threads Demo');
  if (!team) team = (await request('/teams', 'POST', { name: 'Threads Demo' })).team;
  const personal = await request('/workspaces/user/runtime', 'POST', {});
  const teamSession = await request(`/workspaces/${team.id}/runtime`, 'POST', {});
  const records = [];
  for (const scenario of scenarios) {
    const sessionId = scenario.scope === 'team' ? teamSession.sessionId : personal.sessionId;
    const thread = await request(`/sessions/${encodeURIComponent(sessionId)}/threads`, 'POST', { title: scenario.title });
    records.push({ ...scenario, sessionId, threadId: thread.id });
  }
  await writeFile(manifestPath, JSON.stringify({ teamId: team.id, records }, null, 2));
  console.log('Created local personal/team threads. Stop the API before offline seeding.');
 } else if (mode === 'workflow') {
  const me = await request('/me');
  if (me.id !== 'local-user' || me.orgId !== 'local-org') throw new Error('Seed requires the local stub identity.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const name = '[Demo] Workspace routing check';
  const existing = await request(`/workflows?ownerType=team&ownerId=${encodeURIComponent(manifest.teamId)}`);
  let workflow = existing.workflows.find(row => row.name === name);
  const payload = {
    name, teamId: manifest.teamId,
    definition: {
      version: 'dag/v1',
      nodes: [
        { id: 'start', type: 'trigger' },
        { id: 'check', type: 'thread', prompt: 'Local workspace routing check. Reply exactly: team-workflow-check-ok. Do not call tools.', wait: { mode: 'until_idle' } },
        { id: 'done', type: 'stop', outcome: 'success' },
      ],
      edges: [{ from: 'start', to: 'check' }, { from: 'check', to: 'done' }],
    },
  };
  workflow = workflow
    ? await request(`/workflows/${workflow.id}`, 'PUT', payload)
    : await request('/workflows', 'POST', payload);
  manifest.workflowId = workflow.id;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Team-owned workflow, with no assistant selection: http://localhost:5173/workflows/${workflow.id}`);
} else if (mode === 'review') {
  const me = await request('/me');
  if (me.id !== 'local-user' || me.orgId !== 'local-org') throw new Error('Seed requires the local stub identity.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!manifest.workSessionId) {
    const work = await request('/sessions', 'POST', {
      workspace: `${dataDir}/demo-work`, title: '[Demo] Standalone work retained in Threads', teamId: manifest.teamId,
    });
    manifest.workSessionId = work.id;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }
  const origin = manifest.records.find(record => record.scope === 'team');
  if (!origin) throw new Error('Run bootstrap before review seeding.');
  const artifact = await request(`/artifacts/share?ownerType=team&ownerId=${encodeURIComponent(manifest.teamId)}`, 'POST', {
    key: 'threads-demo/nda-review.md', title: '[Demo] NDA review artifact', format: 'markdown',
    content: '# Local review fixture\n\nThis seeded artifact belongs to the NDA demo thread. It is not a legal review. Use its source link to return to that conversation.',
  }, { 'x-valet-session-id': origin.sessionId, 'x-valet-thread-id': origin.threadId });
  manifest.artifactId = artifact.id;
  if (manifest.workflowId) {
    const editor = await request(`/workflows/${manifest.workflowId}/conversation`, 'POST', {});
    manifest.editorThreadId = editor.threadId;
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Results: http://localhost:5173/chat?workspace=${encodeURIComponent(manifest.teamId)}&view=work`);
  console.log(`Thread artifact: http://localhost:5173/chat?workspace=${encodeURIComponent(manifest.teamId)}&thread=${encodeURIComponent(origin.threadId)}`);
} else if (mode === 'catch-up') {
  const me = await request('/me');
  if (me.id !== 'local-user' || me.orgId !== 'local-org') throw new Error('Seed requires the local stub identity.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const origin = manifest.records.find(record => record.scope === 'team');
  if (!origin || !manifest.workSessionId) throw new Error('Run bootstrap and review before catch-up seeding.');
  const teams = await request('/teams');
  const team = teams.teams.find(row => row.id === manifest.teamId);
  if (!team || team.slackHomeChannelId) throw new Error('Use a demo team without a Slack home channel.');
  manifest.catchUp ??= {};
  const examples = [
    { key: 'approval', name: '[Demo] TKAI-559 · Review Threads rollout', node: { id: 'review', type: 'approval', prompt: '[Demo] Review the Threads rollout checklist. Approving only completes this local fixture.', summary: 'Remaining: review the seeded PR and rollout checklist.', timeout: '7d' } },
    { key: 'waiting', name: '[Demo] TKAI-557 · Wait for intake window', node: { id: 'wait', type: 'wait', mode: 'duration', duration: '24h' } },
    { key: 'completed', name: '[Demo] TKAI-558 · Publish routing report' },
  ];
  const existing = await request(`/workflows?ownerType=team&ownerId=${encodeURIComponent(manifest.teamId)}`);
  for (const example of examples) {
    const middle = example.node ? [example.node] : [];
    const nodes = [{ id: 'start', type: 'trigger' }, ...middle, { id: 'done', type: 'stop' }];
    const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id }));
    const workflow = existing.workflows.find(row => row.name === example.name)
      ?? await request('/workflows', 'POST', { name: example.name, teamId: manifest.teamId, definition: { version: 'dag/v1', nodes, edges } });
    const previous = manifest.catchUp[example.key];
    const run = previous?.runId ? { runId: previous.runId } : await request(`/workflows/${workflow.id}/runs`, 'POST', {});
    manifest.catchUp[example.key] = { workflowId: workflow.id, runId: run.runId };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }
  const artifact = await request(`/artifacts/share?ownerType=team&ownerId=${encodeURIComponent(manifest.teamId)}`, 'POST', {
    key: 'threads-demo/rollout-checklist.md', title: '[Demo] TKAI-559 · Threads rollout checklist', format: 'markdown',
    content: '# Threads rollout checklist\n\nLocal demo fixture. No PR or external change was made.\n\n## Recorded results\n\n- PR example: workspace-owned Threads and Events.\n- Routing report published.\n\n## Remaining\n\n- Review the seeded PR example.\n- Verify live Slack ingress in a connected environment.\n- Check team home-channel delivery and DM preferences.\n',
  }, { 'x-valet-session-id': manifest.workSessionId });
  manifest.catchUp.artifactId = artifact.id;
  await request(`/artifacts/share?ownerType=team&ownerId=${encodeURIComponent(manifest.teamId)}`, 'POST', {
    key: 'threads-demo/nda-review.md', title: '[Demo] Kushki NDA · Review findings', format: 'markdown',
    content: '# Kushki NDA review findings\n\nLocal demo fixture, not an actual legal review.\n\nThe example review flags changes to affiliate scope, AI restrictions, permitted recipients, compelled disclosure, retention, liability, and indemnification. The document appears already signed.\n\nThe review step is finished. The request remains blocked on legal assessment of those changes and the signing status before sending. The requester is preparing for a customer meeting.\n',
  }, { 'x-valet-session-id': origin.sessionId, 'x-valet-thread-id': origin.threadId });
  manifest.briefingThreads ??= [];
  const briefs = [
    { key: 'threads-build', sessionId: manifest.workSessionId, title: '[Demo] TKAI-559 · Threads implementation',
      question: '[Local demo] Goal: make Threads the single place for team work. TKAI-559 removes assistant customization and gives each personal or team workspace one runtime. Conner needs to review the resulting change before rollout.',
      answer: '[Local demo] Workspace ownership now drives routing, and singleton runtime resolution prevents duplicate assistants. The PR example and rollout checklist cover this change. The implementation is ready for review; it has not been merged or deployed. Remaining: review the PR, then verify live Slack ingress and team notification routing before rollout.' },
    { key: 'threads-validation', sessionId: origin.sessionId, title: '[Demo] TKAI-559 · Rollout verification',
      question: '[Local demo] Continuing the Threads rollout goal from the implementation conversation. What still blocks rolling out TKAI-559? The checklist and PR example belong to that same effort.',
      answer: '[Local demo] The local workspace and routing checks passed. The rollout is still waiting on Conner’s review and live Slack verification by someone with integration access. Xiangan cannot reconnect the organization’s Slack integration. Next: Conner reviews the PR and checklist; an organization administrator verifies a workflow-authored Slack message and team notification delivery. Do not treat local checks as proof that Slack delivery works.' },
    { key: 'nda-decision', sessionId: origin.sessionId, title: '[Demo] Kushki NDA · Legal follow-up',
      question: '[Local demo] Continue the Kushki NDA review started in the NDA request conversation. The request is for the upcoming customer meeting. What did the review conclude and what decision is still needed?',
      answer: '[Local demo] The NDA review flagged changes to affiliate scope, AI restrictions, permitted recipients, compelled disclosure, retention, liability, and indemnification. The document also appears already signed. The review is complete, but the request is not cleared for sending. Legal needs to assess the flagged changes and signing status before the requester can proceed. The NDA review artifact contains the findings. No actual legal decision was made in this demo.' },
    { key: 'intake-results', sessionId: origin.sessionId, title: '[Demo] Intake reliability · Findings',
      question: '[Local demo] Goal: understand why automated NDA intake sometimes misses a Slack form. TKAI-557 waits for an intake window; TKAI-558 produces the routing report. These are parts of one investigation, not separate user goals.',
      answer: '[Local demo] The routing report now distinguishes messages that reached Valet but were filtered from those without a receipt. That improves the next investigation, but it does not explain the original missing message. We are waiting for the next intake window to capture a real example. No decision is needed from the team right now. Next: compare the next workflow-authored message against the recorded receipt and subscription decision.' },
  ];
  for (const brief of briefs) {
    if (manifest.briefingThreads.some(row => row.key === brief.key)) continue;
    const thread = await request(`/sessions/${encodeURIComponent(brief.sessionId)}/threads`, 'POST', { title: brief.title });
    manifest.briefingThreads.push({ ...brief, threadId: thread.id });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log('Created local approval, timer, completed workflow, and checklist fixtures. Stop the API, then run offline for labeled outcome records.');
} else if (mode === 'child-work') {
  const me = await request('/me');
  if (me.id !== 'local-user' || me.orgId !== 'local-org') throw new Error('Seed requires the local stub identity.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.childWorkSessionIds ??= [];
  while (manifest.childWorkSessionIds.length < 27) {
    const number = manifest.childWorkSessionIds.length + 1;
    const child = await request('/sessions', 'POST', {
      workspace: `${dataDir}/demo-child-${number}`, teamId: manifest.teamId,
      title: `[Demo fixture] Child work ${number} — no task executed`,
    });
    manifest.childWorkSessionIds.push(child.id);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }
  console.log('Created 27 empty execution fixtures. Stop the API, then run offline to attach their child-work records.');
} else if (mode === 'offline') {
  // PGlite permits one owner. Do not open the data directory while the API runs.
  try {
    const listeners = execFileSync('lsof', ['-nP', '-iTCP:8788', '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    if (listeners.trim()) throw new Error('Stop the local API before offline seeding.');
  } catch (error) { if (error.status !== 1) throw error; }
  const require = createRequire(new URL('../packages/api/package.json', import.meta.url));
  const { PGlite } = await import(require.resolve('@electric-sql/pglite'));
  const db = new PGlite(`${dataDir}/pg`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  try {
    const now = Date.now();
    await db.transaction(async tx => {
      for (const [index, record] of [...manifest.records, ...(manifest.briefingThreads ?? [])].entries()) {
        const created = now - (manifest.records.length + (manifest.briefingThreads?.length ?? 0) - index) * 60_000;
        await tx.query('INSERT INTO session_threads (id,session_id,title,created_at,last_user_activity_at) VALUES ($1,$2,$3,$4,$4) ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,last_user_activity_at=EXCLUDED.last_user_activity_at', [record.threadId,record.sessionId,record.title,created]);
        const userId = `threads-demo-${record.threadId}-user`;
        const replyId = `threads-demo-${record.threadId}-reply`;
        for (const [id,parent,role,content,time] of [[userId,null,'user',record.question,created],[replyId,userId,'assistant',record.answer,created+1000]]) {
          await tx.query('INSERT INTO engine_entries (id,session_id,thread_id,parent_id,entry_type,role,content,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING', [id,record.sessionId,record.threadId,parent,'message',role,content,time]);
        }
        await tx.query('UPDATE engine_threads SET active_leaf_entry_id=$1 WHERE id=$2 AND session_id=$3 AND (active_leaf_entry_id IS NULL OR active_leaf_entry_id=$4)', [replyId,record.threadId,record.sessionId,userId]);
      }
      const origin = manifest.records.find(record => record.scope === 'team');
      for (const [index, childId] of (manifest.childWorkSessionIds ?? []).entries()) {
        await tx.query('INSERT INTO child_watches (child_session_id,queue_item_id,parent_session_id,parent_thread_id,actor_user_id,org_id,settled,created_at,settled_at) VALUES ($1,$2,$3,$4,$5,$6,true,$7,$7) ON CONFLICT (child_session_id) DO NOTHING', [childId,`demo-child-${childId}`,origin.sessionId,origin.threadId,'local-user','local-org',now-index*1000]);
      }
      if (manifest.catchUp && manifest.workSessionId) {
        await tx.query('UPDATE agent_sessions SET title=$1, updated_at=$2 WHERE id=$3 AND org_id=$4', ['[Demo] TKAI-559 · Threads and Events', now, manifest.workSessionId, 'local-org']);
        const examples = [
          ['pr','github','github.create_pull_request',{ title: '[Demo] TKAI-559 · Workspace-owned Threads', html_url: 'https://example.com/demo/pull/482' },manifest.workSessionId,null],
          ['review','github','github.create_review',{ state: 'COMMENTED', html_url: 'https://example.com/demo/pull/482#review', title: '[Demo] Threads rollout review' },manifest.workSessionId,null],
          ['message','slack','slack.send_message',{ channel: 'C_DEMO_CONTRACT_REVIEW', permalink: 'https://example.com/demo/slack/routing-report' },null,manifest.catchUp.completed.runId],
        ];
        for (const [index, [key, service, action, data, session, run]] of examples.entries()) {
          await tx.query(`INSERT INTO action_invocations (invocation_id,org_id,session_id,workflow_execution_id,user_id,service,action_id,status,result,params,duration_ms,created_at,started_at)
            VALUES ($1,'local-org',$2,$3,'local-user',$4,$5,'completed',$6::jsonb,'{}'::jsonb,1,$7,$7)
            ON CONFLICT (invocation_id) DO UPDATE SET result=EXCLUDED.result,created_at=EXCLUDED.created_at,started_at=EXCLUDED.started_at`,
            [`threads-demo-outcome-${key}`,session,run,service,action,JSON.stringify({ success: true, data }),now-(index+1)*60000]);
        }
      }
      const receiptExamples = [
        ['no-subscription','slack.bot_message','subscription_match','no_subscription','[Demo fixture] No enabled subscription names slack.bot_message.'],
        ['filter','slack.bot_message','subscription_match','filtered','[Demo fixture] The text prefix filter excluded this form.'],
        ['disabled','slack.bot_message','subscription_match','no_subscription','[Demo fixture] The named subscription is disabled.'],
        ['self',null,'classification','rejected',"[Demo fixture] Valet's own message was rejected to prevent a reply loop."],
        ['identity',null,'classification','rejected','[Demo fixture] Bot message classification needs the installation bot identity.'],
        ['failure','slack.bot_message','ingestion','failed','[Demo fixture] Processing failed during event and delivery persistence.'],
      ];
      for (const [index, [suffix, eventKey, stage, outcome, detail]] of receiptExamples.entries()) {
        const at = now - index * 60000;
        const subscriptions = suffix === 'filter' || suffix === 'disabled' ? [{ id: 'demo-nda-intake', name: '[Demo] NDA intake', ownerType: 'team', ownerId: manifest.teamId, target: 'workflow', targetId: manifest.workflowId, outcome: suffix === 'filter' ? 'filter_excluded' : 'disabled', ...(suffix === 'filter' ? { failedFilters: [{ field: 'text', op: 'prefix' }] } : {}) }] : [];
        const stages = [{ stage: 'verification', outcome: 'verified', detail: '[Demo fixture] Simulated verified receipt. No Slack delivery occurred.', at }, { stage, outcome, detail, at: at + 1 }];
        await tx.query('INSERT INTO event_receipts (id,org_id,service,external_id,metadata,stages,event_key,subscriptions,created_at,updated_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9,$9) ON CONFLICT (id) DO UPDATE SET stages=EXCLUDED.stages, subscriptions=EXCLUDED.subscriptions, created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at', [`threads-demo-receipt-${suffix}`,'local-org','slack',`DEMO_EVENT_${suffix}`,JSON.stringify({ channelId: 'C_DEMO_CONTRACT_REVIEW', rawType: 'message', rawSubtype: 'bot_message', botIdentityAvailable: suffix !== 'identity', botUserIdentityAvailable: true, configuredTriggerCount: 3 }),JSON.stringify(stages),eventKey,JSON.stringify(subscriptions),at]);
      }
      const problems = [
        ['filter_excluded', '[Demo] An NDA form event arrived, but its text did not match the subscription. Compare the raw message text with the configured filter, including leading emoji.'],
        ['unknown_org', '[Demo] The Slack connection is unavailable. Ask an organization administrator to inspect the integration settings.'],
        ['slack_interaction_unmatched', '[Demo] A Slack button interaction arrived. Button interactions do not start message-triggered workflows. Check the subscription event type.'],
      ];
      for (const [index,[reason,detail]] of problems.entries()) {
        await tx.query('INSERT INTO event_drop_log (id,org_id,reason,detail,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET detail=EXCLUDED.detail', [`threads-demo-problem-${index}`,'local-org',reason,detail,now-index*120000]);
      }
    });
    console.log('Seeded transcripts, child work, outcome fixtures, and receipt/problem examples.');
    for (const row of manifest.records) console.log(`${row.title}: http://localhost:5173/chat?workspace=${encodeURIComponent(row.scope === 'team' ? manifest.teamId : 'user')}&thread=${encodeURIComponent(row.threadId)}`);
  } finally { await db.close(); }
} else {
  throw new Error('Use bootstrap, workflow, review, catch-up, or child-work with the API running, or offline after stopping it.');
}

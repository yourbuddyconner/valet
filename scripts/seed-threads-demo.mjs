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
async function request(path, method = 'GET', body) {
  const response = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
  const personal = await request('/orchestrator', 'POST', {});
  const teamSession = await request(`/teams/${team.id}/orchestrator`, 'POST', {});
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
  if (!workflow) workflow = await request('/workflows', 'POST', {
    name, teamId: manifest.teamId,
    definition: {
      version: 'dag/v1',
      nodes: [
        { id: 'start', type: 'trigger' },
        { id: 'check', type: 'orchestrator', prompt: 'Local workspace routing check. Reply exactly: team-workflow-check-ok. Do not call tools.', wait: { mode: 'until_idle' } },
        { id: 'done', type: 'stop', outcome: 'success' },
      ],
      edges: [{ from: 'start', to: 'check' }, { from: 'check', to: 'done' }],
    },
  });
  manifest.workflowId = workflow.id;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Team-owned workflow, with no assistant selection: http://localhost:5173/workflows/${workflow.id}`);
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
      for (const [index, record] of manifest.records.entries()) {
        const created = now - (index + 1) * 60_000;
        await tx.query('INSERT INTO session_threads (id,session_id,title,created_at,last_user_activity_at) VALUES ($1,$2,$3,$4,$4) ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title', [record.threadId,record.sessionId,record.title,created]);
        const userId = `threads-demo-${record.threadId}-user`;
        const replyId = `threads-demo-${record.threadId}-reply`;
        for (const [id,parent,role,content,time] of [[userId,null,'user',record.question,created],[replyId,userId,'assistant',record.answer,created+1000]]) {
          await tx.query('INSERT INTO engine_entries (id,session_id,thread_id,parent_id,entry_type,role,content,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING', [id,record.sessionId,record.threadId,parent,'message',role,content,time]);
        }
        await tx.query('UPDATE engine_threads SET active_leaf_entry_id=$1 WHERE id=$2 AND session_id=$3 AND (active_leaf_entry_id IS NULL OR active_leaf_entry_id=$4)', [replyId,record.threadId,record.sessionId,userId]);
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
    console.log('Seeded three persisted transcripts and three recorded problem examples.');
    for (const row of manifest.records) console.log(`${row.title}: http://localhost:5173/chat?workspace=${encodeURIComponent(row.scope === 'team' ? manifest.teamId : 'user')}&thread=${encodeURIComponent(row.threadId)}`);
  } finally { await db.close(); }
} else {
  throw new Error('Use bootstrap or workflow with the API running, or offline after stopping it.');
}

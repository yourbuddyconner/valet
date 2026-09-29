import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { applyAppMigrations, buildAppDb } from '__SOURCE__/packages/api/src/lib/drizzle.ts';
import { PgSessionStore, pgDbFromPglite } from '__SOURCE__/packages/store-postgres/src/index.ts';
import { findDefaultAssistant } from '__SOURCE__/packages/api/src/assistants/service.ts';
import { findFollowedThread } from '__SOURCE__/packages/api/src/events/followed-threads.ts';
const [directory, phase] = process.argv.slice(2);
const pglite = new PGlite(directory);
const pg = pgDbFromPglite(pglite);
try {
  await applyAppMigrations(pg);
  const db = buildAppDb(pglite);
  const store = new PgSessionStore(pg);
  if (phase === 'seed') {
    await pg.query(`INSERT INTO assistants(id,org_id,owner_type,owner_id,session_id,is_default,name,personality,created_at)
      VALUES ('rollback-assistant','rollback-org','user','rollback-user','rollback-session',true,'Retained name','Retained personality',1)`);
    await pg.query(`INSERT INTO agent_sessions(id,user_id,org_id,workspace,owner_type,owner_id,created_at,updated_at)
      VALUES ('rollback-session','rollback-user','rollback-org','Rollback','user','rollback-user',1,1)`);
    await pg.query(`INSERT INTO session_threads(id,session_id,title,created_at) VALUES ('rollback-thread','rollback-session','Retained thread',1)`);
    await pg.query(`INSERT INTO followed_threads(id,org_id,channel_type,channel_id,thread_ts,owner_type,owner_id,created_by,created_at,last_activity_at,assistant_id)
      VALUES ('rollback-follow','rollback-org','slack','C-ROLLBACK','123.4','user','rollback-user','rollback-user',1,1,'rollback-assistant')`);
    await pg.query(`INSERT INTO workflow_schedules(id,org_id,owner_type,owner_id,target_kind,name,cron,next_fire_at,created_by,created_at,updated_at,assistant_id)
      VALUES ('rollback-schedule','rollback-org','user','rollback-user','orchestrator','Retained schedule','0 0 * * *',9999999999999,'rollback-user',1,1,'rollback-assistant')`);
    await store.appendEntries('rollback-session','rollback-thread',[{id:'old-history',sessionId:'rollback-session',threadId:'rollback-thread',parentId:null,type:'message',role:'user',content:'History from old binary',createdAt:1}]);
    await store.saveDecisionGate('rollback-session','rollback-thread',{id:'rollback-gate',sessionId:'rollback-session',threadId:'rollback-thread',queueItemId:'rollback-queue',resumeKey:'approval',ordinal:0,type:'approval',title:'Retained decision',actions:[],status:'pending',createdAt:1,updatedAt:1});
  }
  assert.equal((await findDefaultAssistant(db,'rollback-org',{type:'user',id:'rollback-user'}))?.sessionId,'rollback-session');
  assert.equal((await findFollowedThread(db,{orgId:'rollback-org',channelType:'slack',channelId:'C-ROLLBACK',threadTs:'123.4'}))?.ownerId,'rollback-user');
  assert.equal((await store.getEntries('rollback-session','rollback-thread'))[0]?.content,'History from old binary');
  assert.equal((await store.getDecisionGate('rollback-session','rollback-gate'))?.status,'pending');
  assert.equal((await pg.query("SELECT title FROM session_threads WHERE id='rollback-thread'")).rows[0]?.title,'Retained thread');
  assert.equal((await pg.query("SELECT name FROM assistants WHERE id='rollback-assistant'")).rows[0]?.name,'Retained name');
  assert.equal((await pg.query("SELECT assistant_id FROM followed_threads WHERE id='rollback-follow'")).rows[0]?.assistant_id,'rollback-assistant');
  assert.equal((await pg.query("SELECT assistant_id FROM workflow_schedules WHERE id='rollback-schedule'")).rows[0]?.assistant_id,'rollback-assistant');
  if (phase === 'upgrade' || phase === 'rollback') {
    await store.appendEntries('rollback-session','rollback-thread',[{id:`${phase}-history`,sessionId:'rollback-session',threadId:'rollback-thread',parentId:null,type:'message',role:'user',content:`History from ${phase} binary`,createdAt:phase==='upgrade'?2:3}]);
  }
  if (phase === 'rollback' || phase === 'verify') assert.ok((await store.getEntries('rollback-session','rollback-thread')).some(e=>e.id==='upgrade-history'));
  if (phase === 'verify') assert.ok((await store.getEntries('rollback-session','rollback-thread')).some(e=>e.id==='rollback-history'));
  console.log(`${phase}: retained identity, thread, history, pending decision, assistant profile, follow and schedule routing`);
} finally { await pglite.close(); }

import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { JSDOM } from 'jsdom';
import { build } from 'vite';
import { newIntent } from '../src/rooms.ts';
import { participantOnline, fetchParticipants } from '../src/participants.ts';

const config = { url: 'https://example.supabase.co', publicKey: 'sb_publishable_test' };
const db = new PGlite();
let bundle;
before(async () => {
  await db.exec('create role anon; create role authenticated;');
  for (const file of ['202610210001_create_room.sql','202610220001_room_membership.sql','202610220003_participant_list.sql']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url),'utf8'));
  }
  const result = await build({ configFile:false, logLevel:'silent', build: { write:false,
    lib:{ entry:'src/participants-ui.ts',formats:['iife'],name:'ParticipantTest' } } });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === 'chunk').code;
});
after(async () => { await db.close(); });

async function create(nickname = '作成者') {
  const intent = newIntent(nickname);
  const result = (await db.query('select public.create_room($1::uuid,$2::text,$3::text) as result', [intent.roomId,intent.resumeToken,intent.nickname])).rows[0].result;
  return { membership:{ roomId:result.room.id,participantId:result.participant.id,resumeToken:intent.resumeToken },
    nickname,snapshot:result,pendingLeave:false,inactive:false };
}
async function join(owner, nickname = '友達') {
  const intent = newIntent(nickname);
  const result = (await db.query("select public.room_action('join',$1::uuid,$2::text,$3::uuid,$4::text,$5::text) as result",
    [owner.membership.roomId,owner.snapshot.invitation.token,intent.roomId,intent.resumeToken,nickname])).rows[0].result;
  assert.equal(result.status,'ok');
  return { membership:{ roomId:owner.membership.roomId,participantId:result.participant.id,resumeToken:intent.resumeToken },
    nickname,snapshot:result,pendingLeave:false,inactive:false };
}
async function roster(session, arrived = null) {
  return (await db.query('select public.room_participants($1::uuid,$2::uuid,$3::text,$4::boolean) as result',
    [session.membership.roomId,session.membership.participantId,session.membership.resumeToken,arrived])).rows[0].result;
}
async function leave(session) {
  return db.query("select public.room_action('leave',$1::uuid,null,$2::uuid,$3::text) as result",
    [session.membership.roomId,session.membership.participantId,session.membership.resumeToken]);
}

test('参加者の名前と3種類の状態だけを返し、位置や秘密値を漏らさない', async () => {
  const owner = await create(); const friend = await join(owner);
  const reply = await roster(owner);
  assert.equal(reply.status,'ok'); assert.equal(reply.participants.length,2);
  assert.deepEqual(Object.keys(reply).sort(),['participants','serverTime','status']);
  const member = reply.participants.find((p) => p.id === friend.membership.participantId);
  assert.equal(member.nickname,'友達'); assert.equal(member.arrived,false);
  assert.equal(member.online,true); assert.equal(member.locationSharing,false);
  assert.deepEqual(Object.keys(member).sort(),['arrived','id','lastSeenAt','locationSharing','nickname','online','roomId']);
  const raw = JSON.stringify(reply);
  assert.equal(raw.includes(owner.membership.resumeToken),false);
  assert.equal(raw.includes(friend.membership.resumeToken),false);
  assert.equal(raw.includes(owner.snapshot.invitation.token),false);
});

test('自分だけの到着状態を指定値で更新し、再送でも反転せず他の参加者に伝わる', async () => {
  const owner = await create(); const friend = await join(owner);
  await roster(friend,true); await roster(friend,true);
  let reply = await roster(owner);
  assert.equal(reply.participants.find((p) => p.id === friend.membership.participantId).arrived,true);
  assert.equal(reply.participants.find((p) => p.id === owner.membership.participantId).arrived,false);
  await roster(friend,false);
  reply = await roster(owner);
  assert.equal(reply.participants.find((p) => p.id === friend.membership.participantId).arrived,false);
});

test('29秒はオンライン、30秒はオフラインとし、5分までは枠を保持する', async () => {
  const owner = await create(); const friend = await join(owner);
  await db.query("update app_private.participants set last_seen_at=clock_timestamp()-interval '29 seconds' where id=$1",[friend.membership.participantId]);
  assert.equal((await roster(owner)).participants.find((p) => p.id === friend.membership.participantId).online,true);
  await db.query("update app_private.participants set last_seen_at=clock_timestamp()-interval '30 seconds' where id=$1",[friend.membership.participantId]);
  let reply = await roster(owner);
  assert.equal(reply.participants.length,2);
  assert.equal(reply.participants.find((p) => p.id === friend.membership.participantId).online,false);
  await db.query("update app_private.participants set last_seen_at=clock_timestamp()-interval '300 seconds' where id=$1",[friend.membership.participantId]);
  reply = await roster(owner); assert.equal(reply.participants.length,1);
  assert.equal((await roster(friend)).status,'membership_expired');
});

test('参加・退出・位置公開状態の変更を次の取得で反映する', async () => {
  const owner = await create(); const friend = await join(owner);
  const newcomer = await join(owner,'途中参加');
  assert.equal((await roster(owner)).participants.length,3);
  await db.query('update app_private.participants set location_sharing=true where id=$1',[friend.membership.participantId]);
  assert.equal((await roster(owner)).participants.find((p) => p.id === friend.membership.participantId).locationSharing,true);
  await leave(newcomer);
  assert.equal((await roster(owner)).participants.length,2);
  assert.equal((await roster(newcomer)).status,'membership_expired');
  await leave(owner); await leave(friend);
  assert.equal((await roster(friend)).status,'ended');
});

test('招待URLだけ・別ルーム・別人の秘密値で一覧や到着状態を操作できない', async () => {
  const owner = await create(); const other = await create('別室');
  const wrongSecret = { ...owner,membership:{ ...owner.membership,resumeToken:'0'.repeat(64) } };
  assert.equal((await roster(wrongSecret,true)).status,'unauthorized');
  assert.equal((await roster({ ...owner,membership:{ ...owner.membership,roomId:other.membership.roomId } })).status,'unauthorized');
  assert.equal((await roster({ ...owner,membership:{ ...owner.membership,resumeToken:owner.snapshot.invitation.token } })).status,'unauthorized');
  assert.equal((await roster(owner)).participants[0].arrived,false);
  await db.exec('set role anon');
  try {
    await assert.rejects(db.exec('select * from app_private.participants'));
    assert.equal((await roster(owner)).status,'ok');
  } finally { await db.exec('reset role'); }
});

test('端末の時計に依存せず、取得後も30秒の境界で表示を変える', () => {
  const time = Date.parse('2026-10-22T00:00:00Z');
  const member = { lastSeenAt:'2026-10-22T00:00:00Z' };
  assert.equal(participantOnline(member,time,29999),true);
  assert.equal(participantOnline(member,time,30000),false);
  assert.equal(participantOnline(member,time,-100),true);
});

async function backendFetch(_url, options) {
  const p = JSON.parse(options.body);
  return new Response(JSON.stringify((await db.query('select public.room_participants($1::uuid,$2::uuid,$3::text,$4::boolean) as result',
    [p.p_room_id,p.p_participant_id,p.p_resume_token,p.p_arrived])).rows[0].result));
}
function page(session, fetcher = backendFetch) {
  const dom = new JSDOM('<div id="app"></div>',{ url:'https://app.example/#/guide',runScripts:'outside-only' });
  dom.window.AbortSignal = AbortSignal; dom.window.fetch = fetcher;
  const timers = new Map(); dom.window.setInterval = (callback,ms) => { timers.set(ms,callback); return ms; };
  const store = (value) => {
    dom.window.localStorage.setItem(`syu-go:${config.url}:membership:${value.membership.roomId}`,JSON.stringify(value));
    dom.window.localStorage.setItem(`syu-go:${config.url}:active-room`,value.membership.roomId);
  };
  store(session); dom.window.eval(bundle);
  const terminal = [];
  const ui = new dom.window.ParticipantTest.ParticipantsUI(config,() => render(),(status)=>terminal.push(status));
  function render() { dom.window.document.querySelector('#app').innerHTML = ui.content(); ui.mount(); }
  render(); return { dom,timers,ui,render,store,terminal };
}
async function until(predicate) {
  for(let i=0;i<200;i++){if(predicate())return; await new Promise((resolve)=>setTimeout(resolve,10));}
  assert.fail('画面更新がタイムアウトしました');
}

test('一覧で名前を安全に表示し、自分の到着ボタンで更新・取消できる', async () => {
  const owner = await create('<img src=x>'); const friend = await join(owner);
  const {dom} = page(owner);
  try {
    await until(()=>dom.window.document.querySelectorAll('.participant-row').length===2);
    assert.equal(dom.window.document.querySelectorAll('img').length,0);
    assert.match(dom.window.document.body.textContent,/あなた/);
    assert.match(dom.window.document.body.textContent,/位置公開OFF/);
    const button = dom.window.document.querySelector('#arrival-toggle');
    button.click(); button.click();
    await until(()=>button.textContent==='未到着に戻す');
    assert.equal((await roster(friend)).participants.find((p)=>p.id===owner.membership.participantId).arrived,true);
    button.click(); await until(()=>button.textContent==='到着');
    assert.equal(button.getAttribute('aria-pressed'),'false');
  } finally {dom.window.close();}
});

test('他人の参加・到着・退出をポーリングで反映し、失敗時も古いオンライン表示を固定しない',async()=>{
  const owner = await create(); const friend = await join(owner);
  let online = true; let elapsed = 100;
  const {dom,timers} = page(owner,async(...args)=>{if(!online)throw new Error('offline');return backendFetch(...args);});
  Object.defineProperty(dom.window.performance,'now',{value:()=>elapsed});
  try{
    await until(()=>dom.window.document.querySelectorAll('.participant-row').length===2);
    await roster(friend,true); await join(owner,'追加の友達'); timers.get(5000)();
    await until(()=>dom.window.document.querySelectorAll('.participant-row').length===3);
    assert.equal(dom.window.document.querySelectorAll('.is-arrived').length,1);
    await leave(friend); timers.get(5000)();
    await until(()=>dom.window.document.querySelectorAll('.participant-row').length===2);
    online=false; timers.get(5000)();
    await until(()=>dom.window.document.querySelector('#participants-status').textContent.includes('最新の一覧'));
    elapsed+=31000; timers.get(1000)();
    assert.equal(dom.window.document.querySelectorAll('.is-online').length,0);
    online=true; timers.get(5000)();
    await until(()=>dom.window.document.querySelector('#participants-status').textContent.includes('約5秒'));
  }finally{dom.window.close();}
});

test('到着更新の応答が消えても再試行は同じ指定値を送り、反転させない',async()=>{
  const owner = await create(); let lost = false; const targets=[];
  const {dom} = page(owner,async(url,options)=>{
    const p=JSON.parse(options.body);
    if(p.p_arrived!==null){ targets.push(p.p_arrived);const response=await backendFetch(url,options);if(!lost){lost=true;throw new Error('lost');}return response;}
    return backendFetch(url,options);
  });
  try{
    await until(()=>!dom.window.document.querySelector('#arrival-toggle').disabled);
    dom.window.document.querySelector('#arrival-toggle').click();
    await until(()=>dom.window.document.querySelector('#arrival-toggle').textContent.includes('再試行'));
    dom.window.document.querySelector('#arrival-toggle').click();
    await until(()=>dom.window.document.querySelector('#arrival-toggle').textContent==='未到着に戻す');
    assert.deepEqual(targets,[true,true]);
  }finally{dom.window.close();}
});

test('ルーム切替や退出後は古い取得結果で一覧を復活させない',async()=>{
  const former = await create('前のルーム'); const current = await create('今のルーム');
  let release; const gate = new Promise((resolve)=>{release=resolve;}); let first=true;
  const {dom,store,render,timers}=page(former,async(...args)=>{const response=await backendFetch(...args);if(first){first=false;await gate;}return response;});
  try{
    await until(()=>!first);store(current);render();release();
    await new Promise((resolve)=>setTimeout(resolve,20));timers.get(5000)();
    await until(()=>dom.window.document.body.textContent.includes('今のルーム'));
    assert.equal(dom.window.document.body.textContent.includes('前のルーム'),false);
    store({...current,pendingLeave:true});render();
    assert.equal(dom.window.document.querySelectorAll('.participant-row').length,0);
    assert.equal(dom.window.document.querySelector('#arrival-control').hidden,true);
  }finally{dom.window.close();}
});

test('別ルームの不正な取得結果や通信失敗を受け入れない',async()=>{
  const owner=await create();const valid=await roster(owner);
  const invalid = { ...valid, participants: valid.participants.map((p) => ({ ...p, roomId: crypto.randomUUID() })) };
  await assert.rejects(fetchParticipants(config,owner,null,async()=>new Response(JSON.stringify(invalid))));
  await assert.rejects(fetchParticipants(config,owner,null,async()=>new Response('{}',{status:500})));
});

test('一覧取得でルーム終了を検出しても既存の終了案内を失わない',async()=>{
  const owner=await create();
  const {dom,timers,terminal}=page(owner);
  try{
    await until(()=>dom.window.document.querySelectorAll('.participant-row').length===1);
    await leave(owner);timers.get(5000)();
    await until(()=>terminal.length===1);
    assert.deepEqual(terminal,['ended']);
    assert.equal(dom.window.document.querySelectorAll('.participant-row').length,0);
  }finally{dom.window.close();}
});

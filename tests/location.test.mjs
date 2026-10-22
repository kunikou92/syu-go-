import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { JSDOM } from 'jsdom';
import { build } from 'vite';
import { newIntent } from '../src/rooms.ts';
import { locationAction, locationFresh } from '../src/location.ts';
import { writeSession } from '../src/membership.ts';

const config={url:'https://example.supabase.co',publicKey:'sb_publishable_test'};
const db=new PGlite(); let bundle;
before(async()=>{
  await db.exec('create role anon; create role authenticated;');
  for(const name of ['202610210001_create_room.sql','202610220001_room_membership.sql','202610220003_participant_list.sql','202610220004_location_sharing.sql'])
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8'));
  const result=await build({configFile:false,logLevel:'silent',build:{write:false,lib:{entry:'src/location-ui.ts',formats:['iife'],name:'LocationTest'}}});
  bundle=(Array.isArray(result)?result[0]:result).output.find(x=>x.type==='chunk').code;
});
after(async()=>db.close());
async function create(name='位置確認'){
  const i=newIntent(name); const r=(await db.query('select public.create_room($1::uuid,$2::text,$3::text) r',[i.roomId,i.resumeToken,name])).rows[0].r;
  return {membership:{roomId:r.room.id,participantId:r.participant.id,resumeToken:i.resumeToken},snapshot:r,nickname:name,pendingLeave:false,inactive:false};
}
async function join(s){
  const i=newIntent('友達');const r=(await db.query("select public.room_action('join',$1::uuid,$2::text,$3::uuid,$4::text,$5::text) r",
    [s.membership.roomId,s.snapshot.invitation.token,i.roomId,i.resumeToken,'友達'])).rows[0].r;
  return {...s,membership:{roomId:r.room.id,participantId:r.participant.id,resumeToken:i.resumeToken},snapshot:r,nickname:'友達'};
}
async function rpc(s,action='read',version=null,loc=null){
  return (await db.query('select public.room_location($1::text,$2::uuid,$3::uuid,$4::text,$5::bigint,$6::double precision,$7::double precision,$8::double precision,$9::timestamptz) r',
    [action,s.membership.roomId,s.membership.participantId,s.membership.resumeToken,version,loc?.latitude??null,loc?.longitude??null,loc?.accuracyMeters??null,loc?.updatedAt??null])).rows[0].r;
}
const sample=()=>({latitude:35,longitude:139,accuracyMeters:12,updatedAt:new Date().toISOString()});
const member=(r,s)=>r.participants.find(p=>p.id===s.membership.participantId);
async function fetcher(_url,options){const p=JSON.parse(options.body);return new Response(JSON.stringify((await db.query(
  'select public.room_location($1::text,$2::uuid,$3::uuid,$4::text,$5::bigint,$6::double precision,$7::double precision,$8::double precision,$9::timestamptz) r',
  [p.p_action,p.p_room_id,p.p_participant_id,p.p_resume_token,p.p_version,p.p_latitude,p.p_longitude,p.p_accuracy,p.p_observed_at])).rows[0].r));}
test('初期OFFでは座標なし、公開中の最新1件だけを同室に共有し、OFFで物理的に削除',async()=>{
  const s=await create(),f=await join(s);let r=await rpc(s);assert.equal(r.sharing,false);assert.equal(member(r,s).location,null);
  r=await rpc(s,'enable',r.version);const version=r.version;
  await rpc(s,'publish',version,sample());let read=await rpc(f);assert.equal(member(read,s).location.latitude,35);
  await rpc(s,'publish',version,{...sample(),latitude:36});read=await rpc(f);assert.equal(member(read,s).location.latitude,36);
  await rpc(s,'disable');read=await rpc(f);assert.equal(member(read,s).location,null);assert.equal(member(read,s).locationSharing,false);
  assert.equal((await db.query('select location from app_private.participants where id=$1',[s.membership.participantId])).rows[0].location,null);
  assert.equal(JSON.stringify(read).includes(s.membership.resumeToken),false);
  assert.equal(JSON.stringify(read).includes(s.snapshot.invitation.token),false);
});
test('OFFより遅れた公開・ON要求と、前のタブの世代による送信を拒否',async()=>{
  const s=await create();const initial=await rpc(s);const on=await rpc(s,'enable',initial.version);
  await rpc(s,'disable');assert.equal((await rpc(s,'publish',on.version,sample())).status,'conflict');
  assert.equal((await rpc(s,'enable',initial.version)).status,'conflict');
  const off=await rpc(s);const newer=await rpc(s,'enable',off.version);
  assert.equal((await rpc(s,'publish',on.version,sample())).status,'conflict');
  assert.equal((await rpc(s,'publish',newer.version,sample())).status,'ok');
});
test('30秒の鮮度、古い座標の逆順到着、更新再開をサーバーで処理',async()=>{
  const s=await create(),f=await join(s);const on=await rpc(s,'enable',0);await rpc(s,'publish',on.version,sample());
  await db.query("update app_private.participants set location=jsonb_set(location,'{updatedAt}',to_jsonb((clock_timestamp()-interval '29 seconds')::text)) where id=$1",[s.membership.participantId]);
  assert.ok(member(await rpc(f),s).location);
  await db.query("update app_private.participants set location=jsonb_set(location,'{updatedAt}',to_jsonb((clock_timestamp()-interval '30 seconds')::text)) where id=$1",[s.membership.participantId]);
  assert.equal(member(await rpc(f),s).location,null);
  await rpc(s,'publish',on.version,{...sample(),latitude:37});
  await rpc(s,'publish',on.version,{...sample(),latitude:38,updatedAt:new Date(Date.now()-1000).toISOString()});
  assert.equal(member(await rpc(f),s).location.latitude,37);
});
test('範囲外・NaN・無限値・古い時刻・遠い未来を保存しない',async()=>{
  const s=await create();const on=await rpc(s,'enable',0);
  for(const loc of [{...sample(),latitude:91},{...sample(),longitude:181},{...sample(),latitude:NaN},{...sample(),accuracyMeters:Infinity},
    {...sample(),updatedAt:new Date(Date.now()-31000).toISOString()},{...sample(),updatedAt:new Date(Date.now()+60000).toISOString()}])
    assert.equal((await rpc(s,'publish',on.version,loc)).status,'invalid_request');
  assert.equal(member(await rpc(s),s).location,null);
});
test('別ルーム、別人、招待トークン、退出後の取得や送信を拒否し、直接閲覧は禁止',async()=>{
  const s=await create(),other=await create('別室'),f=await join(s);
  for(const membership of [{...s.membership,roomId:other.membership.roomId},{...f.membership,resumeToken:s.membership.resumeToken},
    {...s.membership,resumeToken:s.snapshot.invitation.token}])
    assert.equal((await rpc({...s,membership},'enable',0)).status,'unauthorized');
  await db.exec('set role anon');try{await assert.rejects(db.exec('select location from app_private.participants'));assert.equal((await rpc(s)).status,'ok');}finally{await db.exec('reset role');}
  await db.query("select public.room_action('leave',$1::uuid,null,$2::uuid,$3::text)",[s.membership.roomId,s.membership.participantId,s.membership.resumeToken]);
  assert.equal((await rpc(s)).status,'membership_expired');
});
test('端末で時間が経過した場合も30秒で案内対象外、再取得で復帰',()=>{
  const loc=sample(),time=Date.parse(loc.updatedAt);
  assert.equal(locationFresh(loc,time,29999),true);assert.equal(locationFresh(loc,time,30000),false);
  assert.equal(locationFresh(null,time,0),false);
});
test('別ルームの応答、不正座標、公開OFFの座標を受け入れない',async()=>{
  const s=await create(),r=await rpc(s);
  for(const p of [{...r.participants[0],roomId:crypto.randomUUID()},
    {...r.participants[0],locationSharing:true,location:{...sample(),longitude:Infinity}},
    {...r.participants[0],location:sample()}])
    await assert.rejects(locationAction(config,s,'read',null,null,async()=>new Response(JSON.stringify({...r,participants:[p]}))));
});

function page(s,request=fetcher){
  const dom=new JSDOM('<div id="app"></div>',{url:'https://app.example/#/guide',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window;Object.defineProperty(w,'isSecureContext',{value:true});w.AbortSignal=AbortSignal;w.fetch=request;
  let elapsed=100;Object.defineProperty(w.performance,'now',{value:()=>elapsed});
  const timers=new Map();w.setInterval=(fn,ms)=>{timers.set(ms,fn);return ms;};
  const fixes=[];Object.defineProperty(w.navigator,'geolocation',{value:{getCurrentPosition:(ok,fail,opts)=>fixes.push({ok,fail,opts})}});
  const store=(v)=>writeSession(w.localStorage,config.url,v);store(s);w.eval(bundle);
  const ui=new w.LocationTest.LocationUI(config);function render(){w.document.querySelector('#app').innerHTML=ui.content();ui.mount();}render();
  return {dom,w,timers,fixes,store,render,advance:(n)=>{elapsed+=n;},button:(id)=>w.document.querySelector('#location-'+id)};
}
async function until(fn){for(let i=0;i<300;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('画面更新タイムアウト');}
const fix=(f,lat=35)=>f.ok({coords:{latitude:lat,longitude:139,accuracy:12},timestamp:Date.now()});

test('ONで初めて許可・取得し、5秒の更新と現在位置・精度・取得時刻、OFFで停止する',async()=>{
  const s=await create('<b>名前</b>');const p=page(s);
  try{await until(()=>!p.button('start').disabled);assert.equal(p.fixes.length,0);assert.equal(p.w.document.querySelector('b'),null);
    p.button('start').click();await until(()=>p.fixes.length===1);assert.equal(p.fixes[0].opts.maximumAge,0);fix(p.fixes[0]);
    await until(()=>p.w.document.querySelector('#my-location').textContent.includes('位置を更新しました'));
    assert.equal(member(await rpc(s),s).location.latitude,35);
    assert.doesNotMatch(p.w.document.querySelector('#my-location').textContent,/緯度|経度/);
    assert.equal(p.w.document.querySelector('.location-details').open,false);
    await p.timers.get(5000)();await until(()=>p.fixes.length===2);fix(p.fixes[1],36);
    await until(async()=>member(await rpc(s),s).location.latitude===36);
    assert.equal(p.button('start').getAttribute('aria-pressed'),'true');
    p.button('stop').click();await until(()=>p.w.document.querySelector('#location-status').textContent.includes('削除しました'));
    assert.equal(member(await rpc(s),s).location,null);await p.timers.get(5000)();assert.equal(p.fixes.length,2);
  }finally{p.w.close();}
});
test('位置取得中にOFFやルーム切替をした場合、遅いコールバックを送信しない',async()=>{
  const s=await create(),other=await create('別のルーム');const p=page(s);
  try{await until(()=>!p.button('start').disabled);p.button('start').click();await until(()=>p.fixes.length===1);
    p.button('stop').click();fix(p.fixes[0]);await until(()=>!p.button('start').disabled);assert.equal(member(await rpc(s),s).location,null);
    p.button('start').click();await until(()=>p.fixes.length===2);p.store(other);p.render();fix(p.fixes[1]);await p.timers.get(5000)();
    assert.equal(member(await rpc(s),s).location,null);assert.equal(member(await rpc(other),other).location,null);
  }finally{p.w.close();}
});
test('許可拒否ではOFFへ戻し、タイムアウトや取得失敗は再試行する',async()=>{
  const s=await create();const p=page(s);
  try{await until(()=>!p.button('start').disabled);p.button('start').click();await until(()=>p.fixes.length===1);p.fixes[0].fail({code:3});
    assert.match(p.w.document.querySelector('#location-status').textContent,/タイムアウト/);await p.timers.get(5000)();await until(()=>p.fixes.length===2);
    p.fixes[1].fail({code:2});assert.match(p.w.document.querySelector('#location-status').textContent,/取得できません/);
    await p.timers.get(5000)();await until(()=>p.fixes.length===3);p.fixes[2].fail({code:1});await until(()=>!p.button('start').disabled);
    assert.match(p.w.document.querySelector('#location-status').textContent,/許可されていません/);assert.equal((await rpc(s)).sharing,false);
  }finally{p.w.close();}
});
test('通信失敗中のOFFを保存し、再読込後に座標取得せず削除要求を再送する',async()=>{
  const s=await create();let online=true;const p=page(s,(...args)=>{if(!online)throw new Error('offline');return fetcher(...args);});
  try{await until(()=>!p.button('start').disabled);p.button('start').click();await until(()=>p.fixes.length===1);fix(p.fixes[0]);await until(()=>p.w.document.querySelector('#my-location').textContent);
    online=false;p.button('stop').click();await until(()=>p.w.document.querySelector('#location-status').textContent.includes('未確定'));
    const saved=Array.from({length:p.w.localStorage.length},(_,i)=>p.w.localStorage.key(i));assert.ok(saved.some(x=>x.includes('location-stop:')));
    const q=page(s);try{for(const k of saved)q.w.localStorage.setItem(k,p.w.localStorage.getItem(k));await q.timers.get(5000)();
      await until(()=>!q.button('start').disabled);assert.equal((await rpc(s)).sharing,false);assert.equal(q.fixes.length,0);
    }finally{q.w.close();}
  }finally{p.w.close();}
});
test('通信が止まっても古い共有位置は端末側で30秒後に案内対象から外れる',async()=>{
  const s=await create(),f=await join(s);const on=await rpc(f,'enable',0);await rpc(f,'publish',on.version,sample());let online=true;
  const p=page(s,(...a)=>{if(!online)throw new Error();return fetcher(...a);});
  try{await until(()=>p.w.document.querySelector('#location-members').textContent.includes('共有中'));
    online=false;p.advance(31000);p.timers.get(1000)();assert.equal(p.w.document.querySelector('#location-members').textContent.includes('共有中'),false);
    assert.match(p.w.document.querySelector('#location-members').textContent,/案内対象外/);
  }finally{p.w.close();}
});
test('再読み込み時に位置は自動取得せず、参加情報に座標を保存しない',async()=>{
  const s=await create();await rpc(s,'enable',0);const p=page(s);
  try{await until(()=>p.button('start').getAttribute('aria-label')?.includes('再開'));assert.equal(p.fixes.length,0);
    writeSession(p.w.localStorage,config.url,{...s,snapshot:{...s.snapshot,participant:{...s.snapshot.participant,location:sample()}}});
    assert.equal(JSON.parse(p.w.localStorage.getItem(`syu-go:${config.url}:membership:${s.membership.roomId}`)).snapshot.participant.location,null);
  }finally{p.w.close();}
});
test('別タブのONで公開世代が変わると古いタブは取得を止める',async()=>{
  const s=await create();const p=page(s);
  try{await until(()=>!p.button('start').disabled);p.button('start').click();await until(()=>p.fixes.length===1);fix(p.fixes[0]);
    await until(()=>p.w.document.querySelector('#my-location').textContent);const read=await rpc(s);await rpc(s,'enable',read.version);
    await p.timers.get(5000)();await until(()=>!p.button('start').disabled);assert.equal(p.fixes.length,1);
    assert.match(p.w.document.querySelector('#location-status').textContent,/ほかの操作/);
  }finally{p.w.close();}
});
test('ONの応答より先にOFFが届いても、公開開始や位置取得を復活させない',async()=>{
  const s=await create();let release;const gate=new Promise(r=>release=r);let started=false;
  const p=page(s,async(url,opts)=>{const body=JSON.parse(opts.body);if(body.p_action==='enable'){started=true;await gate;}return fetcher(url,opts);});
  try{await until(()=>!p.button('start').disabled);p.button('start').click();await until(()=>started);
    p.button('stop').click();await until(()=>!p.button('start').disabled);release();await new Promise(r=>setTimeout(r,30));
    assert.equal((await rpc(s)).sharing,false);assert.equal(p.fixes.length,0);
  }finally{release();p.w.close();}
});

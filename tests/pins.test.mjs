import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {JSDOM} from 'jsdom';
import {build} from 'vite';
import {newIntent} from '../src/rooms.ts';
import {writeSession} from '../src/membership.ts';
import {pinAction,pinFields} from '../src/pins.ts';
const db=new PGlite(),config={url:'https://example.supabase.co',publicKey:'sb_publishable_test'};let bundle;
before(async()=>{
  await db.exec('create role anon;create role authenticated;');
  for(const name of ['202610210001_create_room.sql','202610220001_room_membership.sql','202610220003_participant_list.sql','202610220004_location_sharing.sql','202610220005_pins.sql'])
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8'));
  const result=await build({configFile:false,logLevel:'silent',build:{write:false,lib:{entry:'src/pins-ui.ts',formats:['iife'],name:'PinTest'}}});
  bundle=(Array.isArray(result)?result[0]:result).output.find(x=>x.type==='chunk').code;
});
after(async()=>db.close());
async function create(nickname='ピン確認'){
  const i=newIntent(nickname),r=(await db.query('select public.create_room($1::uuid,$2::text,$3::text) r',[i.roomId,i.resumeToken,nickname])).rows[0].r;
  return {membership:{roomId:r.room.id,participantId:r.participant.id,resumeToken:i.resumeToken},nickname,snapshot:r,pendingLeave:false,inactive:false};
}
async function join(s){const i=newIntent('友達');const r=(await db.query("select public.room_action('join',$1::uuid,$2::text,$3::uuid,$4::text,$5::text) r",
  [s.membership.roomId,s.snapshot.invitation.token,i.roomId,i.resumeToken,'友達'])).rows[0].r;
  return {...s,membership:{roomId:r.room.id,participantId:r.participant.id,resumeToken:i.resumeToken},snapshot:r};}
async function backend(_url,options){const p=JSON.parse(options.body);const r=(await db.query('select public.room_pins($1::text,$2::uuid,$3::uuid,$4::text,$5::uuid,$6::uuid,$7::text,$8::double precision,$9::double precision,$10::bigint) r',
  [p.p_action,p.p_room_id,p.p_participant_id,p.p_resume_token,p.p_request_id,p.p_pin_id,p.p_name,p.p_latitude,p.p_longitude,p.p_version])).rows[0].r;
  return new Response(JSON.stringify(r));}
const call=(s,c=null)=>pinAction(config,s,c,backend);
const add=(name='駅前',latitude=35,longitude=139)=>({action:'create',requestId:crypto.randomUUID(),pinId:crypto.randomUUID(),name,latitude,longitude});
const mutate=(action,pinId,version)=>({action,pinId,version,requestId:crypto.randomUUID()});

test('全参加者が追加・変更・削除・メイン変更でき、最初の地点がメインになる',async()=>{
  const s=await create(),f=await join(s);const a=add('駅前'),b=add('広場');
  let r=await call(s,a);assert.equal(r.mainPinId,a.pinId);assert.equal(r.pins.length,1);
  r=await call(f,b);assert.equal(r.mainPinId,a.pinId);assert.equal(r.pins.length,2);
  r=await call(f,{...mutate('update',a.pinId,1),name:'東口',latitude:36,longitude:140});
  assert.equal(r.pins.find(p=>p.id===a.pinId).name,'東口');
  r=await call(f,mutate('main',b.pinId,r.revision));assert.equal(r.mainPinId,b.pinId);
  r=await call(s,mutate('delete',b.pinId,1));assert.equal(r.mainPinId,a.pinId);
  r=await call(f,mutate('delete',a.pinId,2));assert.equal(r.mainPinId,null);assert.deepEqual(r.pins,[]);
});
test('操作再送で二重登録・削除後の復活・変更の巻き戻りを起こさない',async()=>{
  const s=await create(),a=add();let r=await call(s,a);const rev=r.revision;
  r=await call(s,a);assert.equal(r.revision,rev);assert.equal(r.pins.length,1);
  const edit={...mutate('update',a.pinId,1),name:'改名',latitude:34,longitude:138};await call(s,edit);await call(s,edit);
  const del=mutate('delete',a.pinId,2);await call(s,del);r=await call(s,del);assert.equal(r.pins.length,0);
  r=await call(s,a);assert.equal(r.pins.length,0);
  assert.equal((await call(s,{...a,name:'別の操作'})).status,'invalid_request');
  const raw=(await db.query('select * from app_private.pin_operations where room_id=$1',[s.membership.roomId])).rows;
  assert.equal(raw[0].payload,undefined);assert.equal(typeof raw[0].payload_hash,'string');
});
test('同時追加でメインは1つ、古い更新・削除・メイン変更は衝突として返す',async()=>{
  const s=await create(),f=await join(s),a=add('一つ目'),b=add('二つ目');await Promise.all([call(s,a),call(f,b)]);
  let r=await call(s);assert.equal(r.pins.length,2);assert.ok([a.pinId,b.pinId].includes(r.mainPinId));
  const oldRevision=r.revision;await call(f,{...mutate('update',a.pinId,1),name:'最新版',latitude:0,longitude:0});
  assert.equal((await call(s,{...mutate('update',a.pinId,1),name:'旧版',latitude:1,longitude:1})).status,'conflict');
  assert.equal((await call(s,mutate('delete',a.pinId,1))).status,'conflict');
  assert.equal((await call(s,mutate('main',b.pinId,oldRevision))).status,'conflict');
  r=await call(s);assert.equal(r.pins.find(p=>p.id===a.pinId).name,'最新版');
});
test('名前・座標を検査し、別ルーム・秘密値不一致・招待だけ・退出後の操作を拒否',async()=>{
  const s=await create(),f=await join(s),other=await create('別室');
  for(const c of [add(''),add('a'.repeat(41)),add('a\nb'),add('範囲外',91),add('範囲外',0,181)])assert.equal((await call(s,c)).status,'invalid_request');
  for(const membership of [{...s.membership,roomId:other.membership.roomId},{...s.membership,resumeToken:'0'.repeat(64)},{...s.membership,resumeToken:s.snapshot.invitation.token}])
    assert.equal((await call({...s,membership})).status,'unauthorized');
  const foreign=add();await call(other,foreign);assert.equal((await call(s,mutate('delete',foreign.pinId,1))).status,'pin_missing');
  await db.exec('set role anon');try{await assert.rejects(db.exec('select * from app_private.pins'));assert.equal((await call(s)).status,'ok');}finally{await db.exec('reset role');}
  await db.query("select public.room_action('leave',$1::uuid,null,$2::uuid,$3::text)",[s.membership.roomId,s.membership.participantId,s.membership.resumeToken]);
  assert.equal((await call(s,add())).status,'membership_expired');
  await db.query("select public.room_action('leave',$1::uuid,null,$2::uuid,$3::text)",[f.membership.roomId,f.membership.participantId,f.membership.resumeToken]);
  assert.equal((await call(f)).status,'ended');
});
test('入力検査と不正な応答（他室・存在しないメイン）を拒否',async()=>{
  assert.deepEqual(pinFields(' 駅 ','0','0'),{name:'駅',latitude:0,longitude:0});
  for(const args of [['','0','0'],['駅','','0'],['駅','Infinity','0']])assert.throws(()=>pinFields(...args));
  const s=await create(),r=await call(s,add());
  await assert.rejects(pinAction(config,s,null,async()=>new Response(JSON.stringify({...r,mainPinId:crypto.randomUUID()}))));
  await assert.rejects(pinAction(config,s,null,async()=>new Response(JSON.stringify({...r,pins:r.pins.map(p=>({...p,roomId:crypto.randomUUID()}))}))));
});

function page(s,request=backend,mapLoader){
  const dom=new JSDOM('<div id="app"></div>',{url:'https://app.example/#/guide',runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window;
  w.AbortSignal=AbortSignal;w.fetch=request;let elapsed=100;Object.defineProperty(w.performance,'now',{value:()=>elapsed});
  const timers=new Map();w.setInterval=(fn,ms)=>{timers.set(ms,fn);return ms;};
  const store=v=>writeSession(w.localStorage,config.url,v);store(s);w.eval(bundle);
  const source={self:{latitude:35,longitude:139,accuracyMeters:5,updatedAt:new Date().toISOString()},selfId:s.membership.participantId,roomId:s.membership.roomId,members:[],serverTime:Date.now(),elapsed:0};
  const compass={heading:()=>0,status:()=> '方角取得済み',busy:()=>false,start:async()=>{}};
  const terminal=[];const ui=new w.PinTest.PinsUI(config,()=>source,()=>render(),compass,status=>terminal.push(status),mapLoader);
  function render(){w.document.querySelector('#app').innerHTML=ui.content();ui.mount();}render();
  const field=(id,v)=>{const e=w.document.querySelector('#'+id);e.value=v;e.dispatchEvent(new w.Event('input',{bubbles:true}));};
  return {w,ui,render,timers,store,source,field,terminal,advance:n=>{elapsed+=n;},button:id=>w.document.querySelector('#'+id)};
}
async function until(fn){for(let n=0;n<300;n++){if(fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('画面更新タイムアウト');}
function submit(p){p.w.document.querySelector('#pin-form').dispatchEvent(new p.w.Event('submit',{bubbles:true,cancelable:true}));}
test('画面から登録・選択・変更・メイン変更・削除でき、名前を安全に表示する',async()=>{
  const s=await create(),p=page(s);try{
    await until(()=>!p.button('pin-save').disabled);p.field('pin-name','<b>駅</b>');p.field('pin-latitude','35.001');p.field('pin-longitude','139');submit(p);
    await until(()=>p.w.document.querySelectorAll('#pin-select option').length===1);assert.equal(p.w.document.querySelector('b'),null);
    assert.match(p.w.document.querySelector('#pin-guidance').textContent,/約111m/);assert.ok(p.w.document.querySelector('.pin-direction'));
    p.field('pin-name','広場');p.field('pin-latitude','35');p.field('pin-longitude','139.002');submit(p);
    await until(()=>p.w.document.querySelectorAll('#pin-select option').length===2);const second=p.w.document.querySelector('#pin-select').value;
    p.button('pin-main').click();await until(()=>p.w.document.querySelector('#pins-status').textContent.includes('メイン集合地点を変更'));
    assert.equal((await call(s)).mainPinId,second);
    p.button('pin-edit').click();p.field('pin-name','広場の入口');submit(p);await until(()=>p.w.document.querySelector('#pin-guidance').textContent.includes('広場の入口'));
    p.button('pin-delete').click();assert.equal(p.w.document.querySelector('#pin-delete-confirm').hidden,false);
    p.button('pin-delete-yes').click();await until(()=>p.w.document.querySelectorAll('#pin-select option').length===1);
    assert.notEqual((await call(s)).mainPinId,second);
  }finally{p.w.close();}
});
test('途中のフォーム入力を保ち、他の参加者の変更・削除を反映し、再入場でメインを選ぶ',async()=>{
  const s=await create(),f=await join(s),a=add('駅'),b=add('広場');await call(s,a);await call(s,b);const p=page(s);
  try{await until(()=>p.w.document.querySelectorAll('#pin-select option').length===2);assert.equal(p.w.document.querySelector('#pin-select').value,a.pinId);
    p.field('pin-name','入力中');const select=p.w.document.querySelector('#pin-select');select.value=b.pinId;select.dispatchEvent(new p.w.Event('change'));
    let r=await call(f,{...mutate('update',b.pinId,1),name:'西の広場',latitude:35,longitude:138.99});p.timers.get(5000)();
    await until(()=>p.w.document.querySelector('#pin-guidance').textContent.includes('西の広場'));
    assert.equal(p.w.document.querySelector('#pin-name').value,'入力中');assert.match(p.w.document.querySelector('#pin-guidance').textContent,/西の広場/);
    p.ui.enter();p.render();assert.equal(p.w.document.querySelector('#pin-select').value,a.pinId);
    await call(f,mutate('main',b.pinId,r.revision));p.timers.get(5000)();await until(()=>p.w.document.querySelector('#pin-select').value===b.pinId);
    await call(f,mutate('delete',b.pinId,2));p.timers.get(5000)();await until(()=>p.w.document.querySelector('#pin-select').value===a.pinId);
  }finally{p.w.close();}
});
test('応答消失・再読み込み後も同じ操作を再送して重複させない',async()=>{
  const s=await create();let lost=false;const p=page(s,async(url,opts)=>{const r=await backend(url,opts);if(JSON.parse(opts.body).p_action==='create'&&!lost){lost=true;throw new Error('lost');}return r;});
  try{await until(()=>!p.button('pin-save').disabled);p.field('pin-name','再試行');p.field('pin-latitude','0');p.field('pin-longitude','0');submit(p);
    await until(()=>p.w.document.querySelector('#pins-status').textContent.includes('未確定'));assert.equal((await call(s)).pins.length,1);
    assert.match(p.w.document.querySelector('#pin-form-status').textContent,/未確定/);assert.equal(p.button('pin-form-retry').hidden,false);
    const saved={};for(let i=0;i<p.w.localStorage.length;i++){const k=p.w.localStorage.key(i);saved[k]=p.w.localStorage.getItem(k);}
    const q=page(s);try{for(const [k,v]of Object.entries(saved))q.w.localStorage.setItem(k,v);
      // 復帰時と同じく新しいUIを作成する。
      const other=await create('切替');q.store(other);q.render();q.store(s);q.render();
      await until(()=>!q.button('pin-retry').hidden);q.button('pin-retry').click();await until(()=>q.button('pin-retry').hidden);
      assert.equal((await call(s)).pins.length,1);
    }finally{q.w.close();}
  }finally{p.w.close();}
});

test('登録ボタンの近くで未入力・場所未選択・保存結果を表示し、エラーへフォーカスする',async()=>{
  const s=await create();let changes=0;
  const p=page(s,(url,opts)=>{if(JSON.parse(opts.body).p_action!=='read')changes++;return backend(url,opts);});
  try{
    await until(()=>!p.button('pin-save').disabled);p.button('pin-save').click();
    assert.match(p.w.document.querySelector('#pin-form-status').textContent,/地点名/);
    assert.equal(p.w.document.activeElement.id,'pin-form-status');assert.equal(changes,0);
    p.field('pin-name','広場');p.button('pin-save').click();
    assert.match(p.w.document.querySelector('#pin-form-status').textContent,/場所が未選択.*地図をタップ/);assert.equal(changes,0);
    p.field('pin-latitude','35');p.field('pin-longitude','139');p.button('pin-save').click();
    assert.match(p.button('pin-save').textContent,/確認しています/);assert.equal(p.button('pin-save').disabled,true);
    await until(()=>p.w.document.querySelector('#pin-form-status').textContent.includes('保存しました'));
    assert.equal(changes,1);assert.equal((await call(s)).pins.length,1);
  }finally{p.w.close();}
});
test('自分の位置・ピンの同期が古い場合やルーム切替後は古い矢印を出さない',async()=>{
  const s=await create();await call(s,add('北側',35.001,139));const p=page(s);try{
    await until(()=>p.w.document.querySelector('.pin-direction'));p.source.elapsed=30000;p.ui.paint();assert.equal(p.w.document.querySelector('.pin-direction'),null);
    p.source.elapsed=0;p.advance(30000);p.ui.paint();assert.equal(p.w.document.querySelector('.pin-direction'),null);
    p.timers.get(5000)();await until(()=>p.w.document.querySelector('.pin-direction'));
    const other=await create('別室');p.store(other);p.render();assert.equal(p.w.document.querySelector('.pin-direction'),null);
  }finally{p.w.close();}
});
test('編集開始後の競合を検出し、最新内容を読み直すまで上書きしない',async()=>{
  const s=await create(),f=await join(s),a=add();await call(s,a);const p=page(s);
  try{await until(()=>!p.button('pin-edit').disabled);p.button('pin-edit').click();
    await call(f,{...mutate('update',a.pinId,1),name:'他の人の変更',latitude:33,longitude:137});
    p.field('pin-name','古い画面');submit(p);await until(()=>p.w.document.querySelector('#pins-status').textContent.includes('ほかの参加者'));
    assert.equal(p.button('pin-save').disabled,true);assert.equal((await call(s)).pins[0].name,'他の人の変更');
    p.button('pin-edit').click();assert.equal(p.w.document.querySelector('#pin-name').value,'他の人の変更');assert.equal(p.button('pin-save').disabled,false);
  }finally{p.w.close();}
});
test('保存不可では送信せず、現在位置の入力は位置を新たに取得しない',async()=>{
  const s=await create();let changes=0;const p=page(s,(url,opts)=>{if(JSON.parse(opts.body).p_action!=='read')changes++;return backend(url,opts);});
  try{await until(()=>!p.button('pin-save').disabled);p.field('pin-name','現在地');p.button('pin-use-location').click();
    assert.equal(p.w.document.querySelector('#pin-latitude').value,'35');assert.equal(p.w.document.querySelector('#pin-longitude').value,'139');assert.equal(changes,0);
    const original=p.w.Storage.prototype.setItem;p.w.Storage.prototype.setItem=()=>{throw new Error('quota');};
    submit(p);await until(()=>p.w.document.querySelector('#pins-status').textContent.includes('保存できません'));assert.equal(changes,0);
    p.w.Storage.prototype.setItem=original;
  }finally{p.w.close();}
});
test('ルームを切り替えた後に前のルームの遅い応答を受け取っても表示しない',async()=>{
  const s=await create(),other=await create('別室');await call(s,add('前の地点'));
  let release,started=false;const gate=new Promise(r=>release=r);let first=true;
  const p=page(s,async(...args)=>{const response=await backend(...args);if(first){first=false;started=true;await gate;}return response;});
  try{await until(()=>started);p.store(other);p.render();release();p.timers.get(5000)();
    await until(()=>!p.button('pin-save').disabled);assert.equal(p.w.document.querySelectorAll('#pin-select option').length,0);
  }finally{release();p.w.close();}
});
test('ピン取得で終了を検出したときも既存の終了案内へ理由を伝える',async()=>{
  const s=await create(),p=page(s);try{await until(()=>!p.button('pin-save').disabled);
    await db.query("select public.room_action('leave',$1::uuid,null,$2::uuid,$3::text)",[s.membership.roomId,s.membership.participantId,s.membership.resumeToken]);
    p.timers.get(5000)();await until(()=>p.terminal.length===1);assert.deepEqual(p.terminal,['ended']);assert.equal(p.button('pin-save').disabled,true);
  }finally{p.w.close();}
});
test('Demo Keyを保存して地図を開き、タップした地点は登録するまで共有しない',async()=>{
  const s=await create();const maps=[],markers=[];let loads=0;
  class View{constructor(){this.events={};maps.push(this);}addListener(name,fn){this.events[name]=fn;return{remove(){}};}panTo(){}}
  class Marker{constructor(opts){Object.assign(this,opts);this.events={};markers.push(this);}addListener(name,fn){this.events[name]=fn;return{remove(){}};}append(){}}
  const sdk={Map:View,marker:{AdvancedMarkerElement:Marker},event:{trigger(){},clearInstanceListeners(){}}};
  const p=page(s,backend,async()=>{loads++;return sdk;});try{
    await until(()=>!p.button('pin-save').disabled);assert.equal(loads,0);assert.match(p.w.document.querySelector('#pin-map-status').textContent,/Demo Key/);
    const key='AIza'+'a'.repeat(35);p.field('google-demo-key',key);
    p.w.document.querySelector('#demo-key-form').dispatchEvent(new p.w.Event('submit',{bubbles:true,cancelable:true}));
    await until(()=>maps.length===1);assert.equal(p.w.localStorage.getItem('syu-go:google-maps-demo-key'),key);
    assert.equal(p.w.document.querySelector('#google-demo-key').value,'');
    maps[0].events.click({latLng:{lat:()=>35.123,lng:()=>139.456},stop(){}});
    assert.equal(p.w.document.querySelector('#pin-latitude').value,'35.123');assert.equal((await call(s)).pins.length,0);
    p.field('pin-name','地図で選択');submit(p);await until(()=>p.w.document.querySelectorAll('#pin-select option').length===1);
    const pins=(await call(s)).pins;assert.equal(pins[0].latitude,35.123);assert.equal(pins[0].longitude,139.456);assert.equal(loads,1);
    p.button('pin-edit').click();assert.equal(loads,1);assert.equal(maps.length,1);
    p.button('demo-key-remove').click();assert.equal(p.w.localStorage.getItem('syu-go:google-maps-demo-key'),null);
  }finally{p.w.close();}
});

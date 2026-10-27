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

function fakeMaps(){const views=[],markers=[];class View{constructor(host,options){this.options=options;this.events={};this.pans=[];views.push(this);}addListener(name,fn){this.events[name]=fn;return{remove(){}};}panTo(p){this.pans.push(p);}}class Marker{constructor(opts){Object.assign(this,opts);this.events={};markers.push(this);}addListener(name,fn){this.events[name]=fn;return{remove(){}};}append(){}}return{views,markers,api:{Map:View,marker:{AdvancedMarkerElement:Marker},event:{trigger(){},clearInstanceListeners(){}}}};}
function page(s,request=backend,mapLoader,options={}){
  const dom=new JSDOM('<div id="app"></div>',{url:'https://app.example/#/guide',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
  w.AbortSignal=AbortSignal;w.fetch=request;let elapsed=100;Object.defineProperty(w.performance,'now',{value:()=>elapsed});Object.defineProperty(w,'isSecureContext',{value:true});
  if(options.geo)Object.defineProperty(w.navigator,'geolocation',{value:{getCurrentPosition:options.geo}});
  if(options.legacyKey)w.localStorage.setItem('syu-go:google-maps-demo-key','AIza'+'a'.repeat(35));
  const timers=new Map();w.setInterval=(fn,ms)=>{timers.set(ms,fn);return ms;};
  const store=v=>writeSession(w.localStorage,config.url,v);store(s);w.eval(bundle);
  const source={self:options.noSelf?null:{latitude:35,longitude:139,accuracyMeters:5,updatedAt:new Date().toISOString()},selfId:s.membership.participantId,roomId:s.membership.roomId,members:[],serverTime:Date.now(),elapsed:0};
  const compass={heading:()=>0,status:()=> '方角取得済み',busy:()=>false,start:async()=>{},ensureStarted:async()=>{}},terminal=[];
  const ui=new w.PinTest.PinsUI(config,()=>source,()=>render(),compass,status=>terminal.push(status),mapLoader,options.key?{apiKey:'AIza'+'a'.repeat(35),mapId:'configured-map'}:null);
  function render(){w.document.querySelector('#app').innerHTML=ui.content();ui.mount();}render();
  const field=(id,v)=>{const e=w.document.querySelector('#'+id);e.value=v;e.dispatchEvent(new w.Event('input',{bubbles:true}));};
  return {w,ui,render,timers,store,source,field,terminal,advance:n=>{elapsed+=n;},button:id=>w.document.querySelector('#'+id)};
}
async function until(fn){for(let n=0;n<300;n++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('画面更新タイムアウト');}
function submit(p){p.button('pin-save').click();}
function point(p,lat=35.001,lng=139){p.field('pin-latitude',String(lat));p.field('pin-longitude',String(lng));}

test('名前は任意で1つのピンを登録・更新し、旧選択・編集・削除・座標入力UIを表示しない',async()=>{
 const s=await create(),p=page(s);try{await until(()=>!p.button('pin-save').disabled);point(p);submit(p);await until(()=>p.w.document.querySelector('#pins-status').textContent.includes('保存しました'));
 let r=await call(s);assert.equal(r.pins.length,1);assert.equal(r.pins[0].name,'集合地点');assert.equal(r.pins[0].id,s.membership.roomId);const id=r.pins[0].id;
 for(const name of ['pin-select','pin-edit','pin-main','pin-delete'])assert.equal(p.button(name),null);
 assert.doesNotMatch(p.w.document.body.textContent,/座標を直接入力する|向かう集合地点/);assert.equal(p.button('pin-latitude').type,'hidden');
 p.field('pin-name','<b>駅</b>');point(p,35.002);submit(p);await until(async()=>(await call(s)).pins[0].version===2);
 r=await call(s);assert.equal(r.pins.length,1);assert.equal(r.pins[0].id,id);assert.equal(r.pins[0].name,'<b>駅</b>');assert.equal(p.w.document.querySelector('b'),null);
 }finally{p.w.close();}
});
test('同時に空のルームへ登録しても1つだけ作り、後の画面には競合を案内する',async()=>{
 const s=await create(),f=await join(s),p=page(s),q=page(f);try{await until(()=>!p.button('pin-save').disabled&&!q.button('pin-save').disabled);point(p);point(q,36);submit(p);submit(q);
 await until(()=>[p,q].some(x=>x.w.document.querySelector('#pins-status').textContent.includes('ほかの参加者')));assert.equal((await call(s)).pins.length,1);
 }finally{p.w.close();q.w.close();}
});
test('既存の複数地点は消さずメイン1地点だけを表示し、他の人の更新と削除を同期する',async()=>{
 const s=await create(),f=await join(s),a=add('駅'),b=add('広場');await call(s,a);await call(s,b);const p=page(s);try{
 await until(()=>p.w.document.querySelector('#pin-guidance').textContent.includes('駅'));assert.doesNotMatch(p.w.document.querySelector('#pin-guidance').textContent,/広場/);
 p.field('pin-name','入力中');await call(f,{...mutate('update',a.pinId,1),name:'西の駅',latitude:35.01,longitude:139});p.timers.get(5000)();
 await until(()=>p.w.document.querySelector('#pin-guidance').textContent.includes('西の駅'));assert.equal(p.button('pin-name').value,'入力中');
 await call(f,mutate('delete',a.pinId,2));p.timers.get(5000)();await until(()=>p.w.document.querySelector('#pin-guidance').textContent.includes('広場'));assert.equal((await call(s)).pins.length,1);
 }finally{p.w.close();}
});
test('応答が消えて再読み込みしても同じ操作を再送し、ピンを増やさない',async()=>{
 const s=await create();let lost=false;const p=page(s,async(url,opts)=>{const r=await backend(url,opts);if(JSON.parse(opts.body).p_action==='create'&&!lost){lost=true;throw new Error('lost');}return r;});
 try{await until(()=>!p.button('pin-save').disabled);point(p);submit(p);await until(()=>p.w.document.querySelector('#pins-status').textContent.includes('未確定'));
 const saved=Object.fromEntries(Object.entries(p.w.localStorage)),q=page(s);try{for(const [k,v]of Object.entries(saved))q.w.localStorage.setItem(k,v);const other=await create();q.store(other);q.render();q.store(s);q.render();
 await until(()=>!q.button('pin-retry').hidden);q.button('pin-retry').click();await until(()=>q.button('pin-retry').hidden);assert.equal((await call(s)).pins.length,1);
 }finally{q.w.close();}}finally{p.w.close();}
});
test('場所未選択の理由を登録ボタンの近くへ表示し、保存中・保存成功を案内する',async()=>{
 const s=await create(),p=page(s);try{await until(()=>!p.button('pin-save').disabled);submit(p);assert.match(p.w.document.querySelector('#pin-form-status').textContent,/場所が未選択/);assert.equal(p.w.document.activeElement.id,'pin-form-status');
 point(p);submit(p);assert.match(p.button('pin-save').textContent,/保存を確認中/);assert.equal(p.button('pin-save').disabled,true);await until(()=>p.w.document.querySelector('#pin-form-status').textContent.includes('保存しました'));assert.equal((await call(s)).pins[0].name,'集合地点');
 }finally{p.w.close();}
});
test('自分の位置・ピン同期の鮮度切れとルーム切替後に以前の矢印を出さない',async()=>{
 const s=await create();await call(s,add('北側',35.001,139));const p=page(s);try{await until(()=>p.w.document.querySelector('.pin-direction'));p.source.elapsed=30000;p.ui.paint();assert.equal(p.w.document.querySelector('.pin-direction'),null);
 p.source.elapsed=0;p.advance(30000);p.ui.paint();assert.equal(p.w.document.querySelector('.pin-direction'),null);p.timers.get(5000)();await until(()=>p.w.document.querySelector('.pin-direction'));
 p.store(await create());p.render();assert.equal(p.w.document.querySelector('.pin-direction'),null);
 }finally{p.w.close();}
});
test('入力中に他の人が更新した古い版で上書きせず、場所を選び直して再送できる',async()=>{
 const s=await create(),f=await join(s),a=add();await call(s,a);const p=page(s);try{await until(()=>!p.button('pin-save').disabled);p.field('pin-name','自分の変更');point(p);
 await call(f,{...mutate('update',a.pinId,1),name:'ほかの人',latitude:36,longitude:140});submit(p);await until(()=>p.w.document.querySelector('#pins-status').textContent.includes('ほかの参加者'));assert.equal((await call(s)).pins[0].name,'ほかの人');
 p.button('pin-use-location').click();submit(p);await until(async()=>(await call(s)).pins[0].version===3);assert.equal((await call(s)).pins.length,1);
 }finally{p.w.close();}
});
test('保存不可では送信しない。新しい公開位置を使う場合は再測位しない',async()=>{
 const s=await create();let changes=0;const p=page(s,(url,opts)=>{if(JSON.parse(opts.body).p_action!=='read')changes++;return backend(url,opts);});try{await until(()=>!p.button('pin-save').disabled);p.button('pin-use-location').click();assert.equal(p.button('pin-latitude').value,'35');assert.equal(changes,0);
 const original=p.w.Storage.prototype.setItem;p.w.Storage.prototype.setItem=()=>{throw new Error('quota');};submit(p);assert.match(p.w.document.querySelector('#pins-status').textContent,/保存できません/);assert.equal(changes,0);p.w.Storage.prototype.setItem=original;
 }finally{p.w.close();}
});
test('キー設定済みなら地図を自動で現在地中心に開き、選択・登録・再描画で地図を再利用する',async()=>{
 const s=await create(),maps=fakeMaps();let loads=0;const p=page(s,backend,async()=>{loads++;return maps.api;},{key:true});try{await until(()=>maps.views.length===1&&!p.button('pin-save').disabled);assert.equal(maps.views[0].options.center.lat,35);assert.equal(loads,1);
 maps.views[0].events.click({latLng:{lat:()=>35.123,lng:()=>139.456}});assert.equal((await call(s)).pins.length,0);submit(p);await until(async()=>(await call(s)).pins.length===1);assert.equal((await call(s)).pins[0].latitude,35.123);
 p.render();assert.equal(maps.views.length,1);assert.equal(loads,1);assert.equal(maps.views[0].options.mapId,'configured-map');
 }finally{p.w.close();}
});

test('公開側の地図設定がなければ保存済みの旧キーを使わず、測位・SDK取得を始めない',async()=>{
 const s=await create();let loads=0,geoCalls=0;
 const p=page(s,backend,async()=>{loads++;return fakeMaps().api;},{legacyKey:true,noSelf:true,geo:()=>{geoCalls++;}});
 try{await until(()=>!p.button('pin-save').disabled);assert.equal(loads,0);assert.equal(geoCalls,0);
  assert.match(p.w.document.querySelector('#pin-map-status').textContent,/準備中/);assert.equal(p.button('pin-map-slot').hidden,true);
  assert.doesNotMatch(p.w.document.body.textContent,/Demo Key|確認用の地図設定|ブラウザーに保存/);
  assert.equal(p.button('google-demo-key'),null);assert.equal(p.button('pin-map-open').hidden,true);
 }finally{p.w.close();}
});

test('地図の直下に名前とボタンを置き、位置の変更は名前をリセットし、名前だけでも更新できる',async()=>{
 const s=await create(),maps=fakeMaps();await call(s,add('元の場所',35.1,139.1));
 const p=page(s,backend,async()=>maps.api,{key:true});try{
  await until(()=>maps.views.length===1&&!p.button('pin-save').disabled);
  const ids=[...p.w.document.querySelectorAll('#pin-map-slot, #pin-name, #pin-use-location, #pin-save')].map(e=>e.id);
  assert.deepEqual(ids,['pin-map-slot','pin-name','pin-use-location','pin-save']);
  assert.match(p.button('pin-name').placeholder,/入力したら更新/);
  assert.equal(p.w.document.querySelector('#pin-location-status').textContent,'');
  p.field('pin-name','名前だけ変更');submit(p);
  await until(async()=>(await call(s)).pins[0].version===2);
  await until(()=>p.button('pin-name').value==='');
  assert.equal((await call(s)).pins[0].name,'名前だけ変更');assert.equal((await call(s)).pins[0].latitude,35.1);
  p.field('pin-name','前の位置用の名前');maps.views[0].events.click({latLng:{lat:()=>36,lng:()=>140}});
  assert.equal(p.button('pin-name').value,'');submit(p);
  await until(async()=>(await call(s)).pins[0].version===3);
  assert.equal((await call(s)).pins[0].name,'集合地点');assert.equal((await call(s)).pins[0].latitude,36);
 }finally{p.w.close();}
});
test('位置共有OFFでも地図用に測位でき、取得だけではルームに送信・ピン保存しない',async()=>{
 const s=await create(),maps=fakeMaps();let geoCalls=0,changes=0;
 const p=page(s,(url,opts)=>{if(JSON.parse(opts.body).p_action!=='read')changes++;return backend(url,opts);},async()=>maps.api,{key:true,noSelf:true,geo:ok=>{geoCalls++;ok({timestamp:Date.now(),coords:{latitude:34.5,longitude:135.5}});}});
 try{await until(()=>maps.views.length===1);assert.equal(geoCalls,1);assert.equal(maps.views[0].options.center.lat,34.5);assert.equal(changes,0);assert.equal((await call(s)).pins.length,0);assert.equal(p.button('pin-latitude').value,'');
 await until(()=>!p.button('pin-use-location').disabled);p.button('pin-use-location').click();await until(()=>p.button('pin-latitude').value==='34.5');assert.equal(changes,0);
 }finally{p.w.close();}
});
test('位置許可拒否でも地図を開き、理由を案内する',async()=>{
 const s=await create(),maps=fakeMaps(),p=page(s,backend,async()=>maps.api,{key:true,noSelf:true,geo:(_ok,fail)=>fail({code:1})});try{await until(()=>maps.views.length===1);assert.match(p.w.document.querySelector('#pin-location-status').textContent,/許可されていません/);assert.equal((await call(s)).pins.length,0);}finally{p.w.close();}
});
test('退出・ルーム切替・友達モードへ移動後の遅い測位結果を使わない',async()=>{
 const s=await create(),maps=fakeMaps();let finish;const p=page(s,backend,async()=>maps.api,{key:true,noSelf:true,geo:ok=>{finish=ok;}});
 try{await until(()=>finish);p.ui.leave();p.w.document.querySelector('#app').replaceChildren();finish({timestamp:Date.now(),coords:{latitude:1,longitude:2}});await new Promise(r=>setTimeout(r,20));assert.equal(maps.views.length,0);assert.equal((await call(s)).pins.length,0);
 }finally{p.w.close();}
});
test('ピン取得で終了を検出した際に終了理由を引き継ぐ',async()=>{
 const s=await create(),p=page(s);try{await until(()=>!p.button('pin-save').disabled);await db.query("select public.room_action('leave',$1::uuid,null,$2::uuid,$3::text)",[s.membership.roomId,s.membership.participantId,s.membership.resumeToken]);p.timers.get(5000)();await until(()=>p.terminal.length===1);assert.deepEqual(p.terminal,['ended']);assert.equal(p.button('pin-save').disabled,true);}finally{p.w.close();}
});

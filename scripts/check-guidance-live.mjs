// 2つの独立した画面・保存領域と実際のSupabaseを使う統合確認。
// センサーは人工の座標・方角だけを与える。実端末の測位・Safariの代替ではない。
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {build} from 'vite';
import {JSDOM} from 'jsdom';
import {backendConfig} from '../src/rooms.ts';
import {activeSession,roomAction} from '../src/membership.ts';
import {pinAction} from '../src/pins.ts';
const config=backendConfig(process.env.VITE_SUPABASE_URL,process.env.VITE_SUPABASE_PUBLISHABLE_KEY);
if(!config)throw new Error('.env.localの公開用接続設定が必要です。');
const result=await build({configFile:false,logLevel:'silent',define:{'import.meta.env.VITE_SUPABASE_URL':JSON.stringify(config.url),'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':JSON.stringify(config.publicKey)},
  build:{write:false,lib:{entry:'src/main.ts',formats:['iife'],name:'GuidanceLive'}}});
const bundle=(Array.isArray(result)?result[0]:result).output.find(x=>x.type==='chunk').code;
const sessions=[],pages=[],checks=[];
const journal=()=>writeFile('.task10-live-check.local',JSON.stringify({sessions}));
const ok=name=>{checks.push(name);console.log('確認: '+name);};
async function until(check,label,timeout=16000){const end=Date.now()+timeout;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,100));}throw new Error('確認待ちがタイムアウト: '+label);}
function page(hash,longitude){
  const dom=new JSDOM('<div id="app"></div>',{url:'https://integration.example/'+hash,runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
  const state={offline:false,paused:false,denied:false,longitude,requests:0,sensorCalls:0};
  w.fetch=(...args)=>state.offline?Promise.reject(new Error('検証用の通信中断')):fetch(...args);w.AbortSignal=AbortSignal;
  Object.defineProperty(w,'isSecureContext',{value:true});w.HTMLElement.prototype.scrollIntoView=()=>{};
  Object.defineProperty(w.navigator,'geolocation',{value:{getCurrentPosition(success,error){state.requests++;if(state.denied){error({code:1});return;}if(state.paused){error({code:2});return;}
    success({timestamp:Date.now(),coords:{latitude:0,longitude:state.longitude,accuracy:1}});}}});
  w.DeviceOrientationEvent=class{};w.DeviceOrientationEvent.requestPermission=async()=>{state.sensorCalls++;return 'granted';};
  w.eval(bundle);const p={w,state,get:id=>w.document.getElementById(id),click:id=>{const e=w.document.getElementById(id);assert.ok(e,'操作対象: '+id);assert.equal(e.disabled,false,'ボタンが有効: '+id);e.click();},
    field:(id,value)=>{const e=w.document.getElementById(id);e.value=value;e.dispatchEvent(new w.Event('input',{bubbles:true}));},
    go:async hash=>{w.location.hash=hash;await until(()=>w.location.hash==='#'+hash&&w.document.title.includes(hash==='/guide'?'案内':'ルーム'),'画面移動');await new Promise(r=>setTimeout(r,30));}};
  pages.push(p);return p;
}
async function remember(p){const s=activeSession(p.w.localStorage,config.url);assert.ok(s?.snapshot);sessions.push(s);await journal();return s;}
async function manual(p,angle){p.click('heading-manual');p.w.document.querySelector(`[data-heading="${angle}"]`).click();}
try{
  const a=page('#/create',0);a.field('nickname','統合確認A');a.w.document.querySelector('#create-form').dispatchEvent(new a.w.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>a.get('invite-url'),'作成');const owner=await remember(a);const invite=a.get('invite-url').value;
  const b=page(new URL(invite).hash,.001);await until(()=>b.w.document.querySelector('#join-form button:not(:disabled)'),'招待確認');b.field('join-nickname','統合確認B');
  b.w.document.querySelector('#join-form').dispatchEvent(new b.w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>b.get('leave-room'),'参加');await remember(b);await a.go('/guide');
  await until(()=>a.get('participants-list')?.textContent.includes('統合確認B'),'2画面の参加者同期');assert.equal(a.state.requests+b.state.requests,0);ok('ルーム作成→招待→独立した2画面で参加、位置取得は初期OFF');
  await until(()=>!a.get('location-start').disabled&&!b.get('location-start').disabled,'位置準備');
  b.state.denied=true;b.click('location-start');await until(()=>b.get('location-status').textContent.includes('許可されていません'),'位置許可拒否');assert.equal(b.w.document.querySelector('.friend-row-arrow'),null);b.state.denied=false;
  await until(()=>!b.get('location-start').disabled,'拒否後OFF');a.click('location-start');b.click('location-start');await manual(a,0);await manual(b,0);
  await until(()=>a.w.document.querySelector('.friend-row-arrow')&&b.w.document.querySelector('.friend-row-arrow'),'相互方向と距離');assert.match(a.w.document.querySelector('.friend-row-arrow').style.transform,/90/);ok('許可拒否から再開、人工位置の相互共有と手動方角で合流案内');
  b.click('location-stop');await until(()=>!a.w.document.querySelector('.friend-row-arrow'),'OFFの他画面反映');assert.equal(a.w.document.querySelector('.friend-distance'),null);ok('公開OFFで他画面の矢印・距離を削除');
  await until(()=>!b.get('location-start').disabled,'再開準備');b.click('location-start');await until(()=>a.w.document.querySelector('.friend-row-arrow'),'公開再開');
  b.state.paused=true;await until(()=>!a.w.document.querySelector('.friend-row-arrow'),'30秒無更新で矢印削除',45000);b.state.paused=false;await until(()=>a.w.document.querySelector('.friend-row-arrow'),'位置更新の復帰');ok('位置取得停止→30秒後の非表示→更新再開');
  a.click('mode-pins');await until(()=>!a.get('pin-save').disabled,'ピン準備');a.click('pin-save');assert.match(a.get('pin-form-status').textContent,/地点名/);
  a.field('pin-name','人工地点1');a.click('pin-save');assert.match(a.get('pin-form-status').textContent,/場所が未選択/);
  a.field('pin-latitude','.001');a.field('pin-longitude','0');a.click('pin-save');await until(()=>a.get('pin-form-status').textContent.includes('保存しました'),'ピン保存');
  assert.ok(a.w.document.querySelector('.pin-direction'));assert.match(a.get('heading-status').textContent,/手動調整中/);
  b.click('mode-pins');await until(()=>b.get('pin-select').options.length===1,'ピン共有');ok('登録時の未入力案内・登録成功をボタン付近に表示、ピンを相互同期');
  a.field('pin-name','人工地点2');a.field('pin-latitude','0');a.field('pin-longitude','.002');a.click('pin-save');await until(()=>a.get('pin-select').options.length===2,'2地点目');
  const main=(await pinAction(config,owner)).mainPinId;assert.notEqual(a.get('pin-select').value,main);a.click('mode-friends');a.click('mode-pins');assert.equal(a.get('pin-select').value,main);ok('ピン選択と入り直した際のメイン初期選択、手動設定の保持');
  b.state.offline=true;b.w.dispatchEvent(new b.w.Event('online'));await until(()=>/確認できません|送信できません/.test(b.get('location-status').textContent),'通信中断の案内');
  b.state.offline=false;b.w.dispatchEvent(new b.w.Event('online'));await until(()=>b.get('location-status').textContent.includes('共有しています')&&b.w.document.querySelector('.pin-direction'),'通信復帰');ok('通信中断の案内と接続回復後の案内再開');
  a.click('heading-auto');await until(()=>a.get('heading-manual')&&!a.get('heading-manual').hidden,'自動復帰');assert.equal(a.w.document.querySelector('.pin-direction'),null);ok('自動復帰時は古い手動値の矢印を消してセンサー待ち');
  for(const p of (await pinAction(config,owner)).pins??[])await pinAction(config,owner,{action:'delete',requestId:crypto.randomUUID(),pinId:p.id,version:p.version});
  a.click('leave-room');await until(()=>!a.get('leave-room'),'作成者退出');await until(()=>b.get('participants-list').textContent.includes('統合確認B')&&!b.get('participants-list').textContent.includes('統合確認A'),'残り1人');
  assert.equal((await roomAction(config,'heartbeat',sessions[1].membership.roomId,{session:sessions[1]})).status,'ok');
  b.click('leave-room');await until(()=>!b.get('leave-room'),'全員退出');assert.equal((await roomAction(config,'inspect',owner.membership.roomId,{invitation:owner.snapshot.invitation})).status,'ended');ok('作成者退出後・残り1人の継続、全員退出後の終了');
  console.log(JSON.stringify({passed:true,checks,syntheticSensorsOnly:true,independentScreenStores:2,physicalDeviceTested:false}));
}finally{
  pages.forEach(p=>{p.state.paused=true;p.w.close();});
  for(const s of sessions){try{const r=await pinAction(config,s);for(const p of r.pins??[])await pinAction(config,s,{action:'delete',requestId:crypto.randomUUID(),pinId:p.id,version:p.version});}catch{}}
  const cleanup=await Promise.allSettled(sessions.map(session=>roomAction(config,'leave',session.membership.roomId,{session})));
  assert.ok(cleanup.every(r=>r.status==='fulfilled'),'検証用参加者の退出');
}

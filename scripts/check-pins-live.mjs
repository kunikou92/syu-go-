// 人工の集合地点だけを使う実接続テスト。
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {backendConfig,createRoom,newIntent} from '../src/rooms.ts';
import {roomAction} from '../src/membership.ts';
import {pinAction} from '../src/pins.ts';
const config=backendConfig(process.env.VITE_SUPABASE_URL,process.env.VITE_SUPABASE_PUBLISHABLE_KEY);
if(!config)throw new Error('.env.localに接続情報を設定してください。');
async function create(name){const i=newIntent(name),r=await createRoom(config,i);return {membership:{roomId:r.room.id,participantId:r.participant.id,resumeToken:i.resumeToken},nickname:name,snapshot:r,pendingLeave:false,inactive:false};}
const owner=await create('ピン確認PC'),other=await create('別ルーム確認'),i=newIntent('ピン確認スマホ');
const guest={...owner,membership:{roomId:owner.membership.roomId,participantId:i.roomId,resumeToken:i.resumeToken},nickname:i.nickname,snapshot:null};
await writeFile('.task8-live-check.local',JSON.stringify({owner,guest,other}));
const call=(s,c=null)=>pinAction(config,s,c);
const change=(action,pinId,version)=>({action,pinId,version,requestId:crypto.randomUUID()});
const a={...change('create',crypto.randomUUID()),name:'人工地点A',latitude:0,longitude:0};
const b={...change('create',crypto.randomUUID()),name:'人工地点B',latitude:.001,longitude:0};
try{
  assert.equal((await roomAction(config,'join',owner.membership.roomId,{session:guest,invitation:owner.snapshot.invitation})).status,'ok');
  let r=await call(owner,a);assert.equal(r.mainPinId,a.pinId);await call(owner,a);assert.equal((await call(guest)).pins.length,1);
  r=await call(guest,b);assert.equal(r.pins.length,2);assert.equal(r.mainPinId,a.pinId);
  r=await call(guest,{...change('update',a.pinId,1),name:'人工地点A更新',latitude:.002,longitude:0});
  assert.equal((await call(owner)).pins.find(p=>p.id===a.pinId).latitude,.002);
  assert.equal((await call(owner,change('delete',a.pinId,1))).status,'conflict');
  r=await call(owner,change('main',b.pinId,r.revision));assert.equal((await call(guest)).mainPinId,b.pinId);
  assert.equal((await call({...owner,membership:{...owner.membership,roomId:other.membership.roomId}})).status,'unauthorized');
  assert.equal((await call({...owner,membership:{...owner.membership,resumeToken:owner.snapshot.invitation.token}})).status,'unauthorized');
  r=await call(guest,change('delete',b.pinId,1));assert.equal(r.mainPinId,a.pinId);
  r=await call(owner,change('delete',a.pinId,2));assert.equal(r.mainPinId,null);assert.equal(r.pins.length,0);
  r=await call(owner,a);assert.equal(r.pins.length,0);
  console.log(JSON.stringify({shared:true,allMembersCanEdit:true,firstPinMain:true,mainChange:true,mainDeletionFallback:true,lastPinClearsMain:true,retryNoDuplicateOrResurrection:true,staleWriteRejected:true,crossRoomRejected:true,inviteOnlyRejected:true},null,2));
}finally{
  for(const s of [owner,other]){try{for(const p of (await call(s)).pins??[])await call(s,change('delete',p.id,p.version));}catch{}}
  await Promise.allSettled([owner,guest,other].map(session=>roomAction(config,'leave',session.membership.roomId,{session})));
}

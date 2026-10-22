// 実際の端末位置を取得せず、人工の座標だけで接続を検証する。
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { backendConfig, createRoom, newIntent } from '../src/rooms.ts';
import { roomAction } from '../src/membership.ts';
import { locationAction } from '../src/location.ts';
const config=backendConfig(process.env.VITE_SUPABASE_URL,process.env.VITE_SUPABASE_PUBLISHABLE_KEY);
if(!config)throw new Error('公開用の接続情報を.env.localに設定してください。');
const i=newIntent('位置共有テスト');const created=await createRoom(config,i);
const owner={membership:{roomId:created.room.id,participantId:created.participant.id,resumeToken:i.resumeToken},nickname:i.nickname,snapshot:created,pendingLeave:false,inactive:false};
const j=newIntent('共有受信テスト');const guest={...owner,membership:{roomId:created.room.id,participantId:j.roomId,resumeToken:j.resumeToken},nickname:j.nickname,snapshot:null};
const k=newIntent('別ルーム確認');const otherCreated=await createRoom(config,k);
const other={...owner,membership:{roomId:otherCreated.room.id,participantId:otherCreated.participant.id,resumeToken:k.resumeToken},snapshot:otherCreated};
await writeFile('.task6-live-check.local',JSON.stringify({owner,guest,other}));
const action=(s,a,v=null,loc=null)=>locationAction(config,s,a,v,loc);
const self=r=>r.participants.find(p=>p.id===owner.membership.participantId);
let version;
const synthetic=()=>({latitude:0,longitude:0,accuracyMeters:10,updatedAt:new Date().toISOString()});
try{
  assert.equal((await roomAction(config,'join',created.room.id,{session:guest,invitation:created.invitation})).status,'ok');
  assert.equal((await action(owner,'read')).sharing,false);
  const on=await action(owner,'enable',0);version=on.version;assert.equal(on.sharing,true);
  assert.equal((await action(owner,'publish',version,synthetic())).status,'ok');
  assert.equal(self(await action(guest,'read')).location.latitude,0);
  assert.equal((await action({...owner,membership:{...owner.membership,roomId:other.membership.roomId}},'read')).status,'unauthorized');
  assert.equal((await action({...owner,membership:{...owner.membership,resumeToken:created.invitation.token}},'read')).status,'unauthorized');
  let stale=false;
  for(let n=0;n<8;n++){
    await new Promise(r=>setTimeout(r,5000));
    await action(owner,'read');
    if(self(await action(guest,'read')).location===null){stale=true;break;}
  }
  assert.equal(stale,true);
  await action(owner,'publish',version,synthetic());assert.ok(self(await action(guest,'read')).location);
  await action(owner,'disable');assert.equal(self(await action(guest,'read')).location,null);
  assert.equal((await action(owner,'publish',version,synthetic())).status,'conflict');
  assert.equal((await action(owner,'enable',0)).status,'conflict');
  console.log(JSON.stringify({syntheticCoordinatesOnly:true,shared:true,staleAfter30Seconds:true,resumed:true,offDeleted:true,delayedPublishRejected:true,crossRoomRejected:true,inviteOnlyRejected:true},null,2));
}finally{
  await action(owner,'disable').catch(()=>{});
  await Promise.allSettled([owner,guest,other].map(session=>roomAction(config,'leave',session.membership.roomId,{session})));
}

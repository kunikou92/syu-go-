// 明示的に実行する接続テスト。検証用ルーム内の参加者だけを操作する。
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { backendConfig, createRoom, newIntent } from '../src/rooms.ts';
import { roomAction } from '../src/membership.ts';
import { fetchParticipants } from '../src/participants.ts';

const config = backendConfig(process.env.VITE_SUPABASE_URL,process.env.VITE_SUPABASE_PUBLISHABLE_KEY);
if(!config) throw new Error('公開用の接続情報を.env.localに設定してください。');
const intent = newIntent('一覧確認PC');
const created = await createRoom(config,intent);
const owner = { membership:{ roomId:created.room.id,participantId:created.participant.id,resumeToken:intent.resumeToken },
  nickname:intent.nickname,snapshot:created,pendingLeave:false,inactive:false };
const guestIntent = newIntent('一覧確認スマホ');
const guest = { membership:{ roomId:created.room.id,participantId:guestIntent.roomId,resumeToken:guestIntent.resumeToken },
  nickname:guestIntent.nickname,snapshot:null,pendingLeave:false,inactive:false };
await writeFile('.task5-live-check.local',JSON.stringify({owner,guest}));
const call = (action,session) => roomAction(config,action,created.room.id,{session,invitation:created.invitation});
try{
  assert.equal((await call('join',guest)).status,'ok');
  const first=await fetchParticipants(config,owner);
  assert.equal(first.participants.length,2);
  await fetchParticipants(config,guest,true);
  assert.equal((await fetchParticipants(config,owner)).participants.find(p=>p.id===guest.membership.participantId).arrived,true);
  await fetchParticipants(config,guest,false);
  assert.equal((await fetchParticipants(config,owner)).participants.find(p=>p.id===guest.membership.participantId).arrived,false);
  const forged={...owner,membership:{...owner.membership,resumeToken:'0'.repeat(64)}};
  assert.equal((await fetchParticipants(config,forged,true)).status,'unauthorized');
  // この間ゲストから通信せず、所有者だけが一覧を更新する。
  let offline=false;
  for(let i=0;i<8;i++){
    await new Promise(resolve=>setTimeout(resolve,5000));
    const list=await fetchParticipants(config,owner);
    const member=list.participants.find(p=>p.id===guest.membership.participantId);
    if(!member.online){offline=true;break;}
  }
  assert.equal(offline,true);
  const resumed=await fetchParticipants(config,guest);
  assert.equal(resumed.participants.find(p=>p.id===guest.membership.participantId).online,true);
  await call('leave',guest);
  assert.equal((await fetchParticipants(config,owner)).participants.length,1);
  assert.equal((await fetchParticipants(config,guest)).status,'membership_expired');
  console.log(JSON.stringify({participants:2,arrivalSync:true,arrivalReset:true,
    unauthorizedRejected:true,offlineAfter30Seconds:true,reconnect:true,departureSync:true},null,2));
}finally{
  await Promise.allSettled([owner,guest].map(session=>call('leave',session)));
}

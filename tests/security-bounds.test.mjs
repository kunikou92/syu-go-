import {before,beforeEach,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {newIntent,newRoomId,createRoom,CreationExpiredError} from '../src/rooms.ts';
import {pinAction} from '../src/pins.ts';

const base=['202610210001_create_room.sql','202610220001_room_membership.sql','202610220003_participant_list.sql','202610220004_location_sharing.sql','202610220005_pins.sql'];
let migration;const db=new PGlite();
async function setup(d){
  await d.exec('create role anon;create role authenticated;create role service_role;');
  for(const file of base)await d.exec(await readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
}
before(async()=>{
  const file=(await readdir(new URL('../supabase/migrations/',import.meta.url))).find(f=>/^\d+_security_bounds_and_retention\.sql$/.test(f));
  migration=await readFile(new URL(file?`../supabase/migrations/${file}`:'../supabase/security-bounds.sql',import.meta.url),'utf8');
  await setup(db);await db.exec(migration);
});
beforeEach(async()=>{await db.exec('truncate app_private.rooms cascade;');});
after(async()=>db.close());
async function create(i=newIntent('確認'),d=db,core=false){
  const r=(await d.query(`select ${core?'app_private.create_room_core':'public.create_room'}($1::uuid,$2::text,$3::text) r`,[i.roomId,i.resumeToken,i.nickname])).rows[0].r;
  return {i,r};
}
async function pins(s,action='read',pinId=null,requestId=null,version=null,d=db){
  return (await d.query("select public.room_pins($1,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,'集合',35::double precision,139::double precision,$7::bigint) r",[action,s.r.room.id,s.r.participant.id,s.i.resumeToken,requestId,pinId,version])).rows[0].r;
}
const add=s=>pins(s,'create',crypto.randomUUID(),crypto.randomUUID());

test('UUIDv7に要求時刻を含め、削除後の古い作成要求を拒否する',async()=>{
  const now=Date.now(),id=newRoomId(now);assert.equal(id[14],'7');
  assert.equal(parseInt(id.replaceAll('-','').slice(0,12),16),now);
  for(const roomId of [crypto.randomUUID(),newRoomId(now-25*3600000),newRoomId(now+10*60000)])
    assert.equal((await create({...newIntent('期限'),roomId})).r.status,'creation_expired');
  assert.ok((await create()).r.room);
});
test('1分10件で新規作成を止め、同じ要求の再送は許可する',async()=>{
  const first=await create();for(let n=1;n<10;n++)assert.ok((await create()).r.room);
  assert.equal((await create()).r.status,'rate_limited');
  assert.deepEqual((await create(first.i)).r,first.r);
});
test('24時間100件・有効50室・保持1000室の上限をDBで強制する',async()=>{
  for(const [count,created,expires,ended] of [[100,"1 hour","23 hours",true],[50,"1 hour","23 hours",false],[1000,"2 days","-1 day",true]]){
    await db.exec('truncate app_private.rooms cascade;');
    await db.query(`insert into app_private.rooms(id,created_at,expires_at,ended_at) select gen_random_uuid(),now()-$1::interval,now()+$2::interval,case when $3 then now()-interval '30 minutes' else null end from generate_series(1,$4::int)`,[created,expires,ended,count]);
    assert.equal((await create()).r.status,'capacity_reached');
  }
});
test('旧UUIDv4ルームは資格付きで再送でき、別の資格は拒否する',async()=>{
  const old=await create({...newIntent('旧形式'),roomId:crypto.randomUUID()},db,true);
  assert.deepEqual((await create(old.i)).r,old.r);
  await assert.rejects(create({...old.i,resumeToken:'0'.repeat(64)}),/credential/);
});
test('任意IDの旧APIでも有効ピンは1つまで、読取は継続する',async()=>{
  const s=await create();const r=await add(s);assert.equal(r.pins.length,1);
  assert.equal((await add(s)).status,'limit_reached');assert.equal((await pins(s)).pins.length,1);
  await assert.rejects(db.query("insert into app_private.pins(id,room_id,name,latitude,longitude,created_at,updated_at) values(gen_random_uuid(),$1,'直接',0,0,now(),now())",[s.r.room.id]),/unique/);
});
test('操作上限に達しても同じ要求の再送・読取は成功し、退会に化けない',async()=>{
  const s=await create(),id=crypto.randomUUID(),requestId=crypto.randomUUID();
  const first=await pins(s,'create',id,requestId);assert.equal(first.status,'ok');
  await db.query("insert into app_private.pin_operations(room_id,request_id,participant_id,payload_hash,created_at) select $1,gen_random_uuid(),$2,'fixture',now()-interval '2 minutes' from generate_series(1,299)",[s.r.room.id,s.r.participant.id]);
  assert.equal((await pins(s,'create',id,requestId)).status,'ok');
  assert.equal((await pins(s,'update',id,crypto.randomUUID(),1)).status,'limit_reached');
  assert.equal((await pins(s)).pins.length,1);
  assert.equal((await db.query('select count(*)::int n from app_private.pin_operations')).rows[0].n,300);
});
test('1分20回の更新制限は既存の操作記録を削除せず、再送に対応する',async()=>{
  const s=await create();const first=await add(s),id=first.mainPinId;
  await db.query("insert into app_private.pin_operations(room_id,request_id,participant_id,payload_hash) select $1,gen_random_uuid(),$2,'fixture' from generate_series(1,19)",[s.r.room.id,s.r.participant.id]);
  assert.equal((await pins(s,'update',id,crypto.randomUUID(),1)).status,'rate_limited');
  assert.equal((await pins(s)).pins[0].version,1);
});
test('累計参加者100人で再参加の蓄積を止め、既存メンバーは利用できる',async()=>{
  const s=await create(),i=newIntent('新規');
  await db.query("insert into app_private.participants(id,room_id,nickname,left_at) select gen_random_uuid(),$1,'退出済',now()-interval '1 minute' from generate_series(1,99)",[s.r.room.id]);
  const r=(await db.query("select public.room_action('join',$1,$2,$3,$4,$5) r",[s.r.room.id,s.r.invitation.token,i.roomId,i.resumeToken,i.nickname])).rows[0].r;
  assert.equal(r.status,'membership_limit');assert.equal((await pins(s)).status,'ok');
});
test('保持期限後に関連行を削除し、削除済みIDの再送からルームを復活させない',async()=>{
  const old=await create({...newIntent('古い室'),roomId:newRoomId(Date.now()-9*86400000)},db,true);await add(old);
  await db.query("update app_private.rooms set created_at=now()-interval '9 days',expires_at=now()-interval '8 days',ended_at=now()-interval '8 days' where id=$1",[old.r.room.id]);
  const recent=await create();await add(recent);
  await db.exec('select app_private.maintain_room_data();');
  assert.equal((await db.query('select count(*)::int n from app_private.rooms')).rows[0].n,1);
  for(const table of ['participants','participant_credentials','creation_credentials','invitations','pins','pin_operations'])
    assert.equal((await db.query(`select count(*)::int n from app_private.${table} where room_id=$1`,[old.r.room.id])).rows[0].n,0,table);
  assert.equal((await create(old.i)).r.status,'creation_expired');assert.equal((await pins(recent)).status,'ok');
});
test('終了後7日未満の退出IDと操作記録は保持する',async()=>{
  const s=await create();await add(s);
  await db.query("update app_private.rooms set ended_at=now()-interval '1 day' where id=$1",[s.r.room.id]);
  await db.exec('select app_private.maintain_room_data();');
  assert.equal((await db.query('select count(*)::int n from app_private.pin_operations')).rows[0].n,1);
});
test('旧複数ピンを消さず、メイン以外は非表示の保管行へ移行する',async()=>{
  const d=new PGlite();try{
    await setup(d);const s=await create(newIntent('移行'),d);await addLegacy(d,s);await addLegacy(d,s);
    const before=(await d.query('select main_pin_id from app_private.rooms')).rows[0].main_pin_id;
    await d.exec(migration);
    const r=await pins(s,'read',null,null,null,d);assert.equal(r.pins.length,1);assert.equal(r.mainPinId,before);
    assert.equal((await d.query('select count(*)::int n from app_private.pins where retired_at is not null')).rows[0].n,1);
  }finally{await d.close();}
});
async function addLegacy(d,s){return pins(s,'create',crypto.randomUUID(),crypto.randomUUID(),null,d);}
test('内部関数を公開せず、新しいpublicテーブル・関数は明示GRANTなしで利用できない',async()=>{
  await db.exec('create table public.future_table(id int); alter table public.future_table enable row level security; create function public.future_function() returns int language sql as $$ select 1 $$;');
  for(const role of ['anon','authenticated']){
    const r=(await db.query("select has_table_privilege($1,'public.future_table','SELECT') t,has_function_privilege($1,'public.future_function()','EXECUTE') f,has_function_privilege($1,'app_private.maintain_room_data()','EXECUTE') m,has_function_privilege($1,'app_private.create_room_core(uuid,text,text)','EXECUTE') c",[role])).rows[0];
    assert.deepEqual(r,{t:false,f:false,m:false,c:false});
  }
});
test('新しい制限応答を利用者向けの案内に変換する',async()=>{
  const cfg={url:'https://example.supabase.co',publicKey:'sb_publishable_test'},i=newIntent('案内');
  await assert.rejects(createRoom(cfg,i,async()=>new Response(JSON.stringify({status:'rate_limited'}))),/1分/);
  await assert.rejects(createRoom(cfg,i,async()=>new Response(JSON.stringify({status:'capacity_reached'}))),/利用上限/);
  await assert.rejects(createRoom(cfg,i,async()=>new Response(JSON.stringify({status:'creation_expired'}))),CreationExpiredError);
  const s={membership:{roomId:i.roomId,participantId:crypto.randomUUID(),resumeToken:i.resumeToken}};
  assert.equal((await pinAction(cfg,s,null,async()=>new Response(JSON.stringify({status:'limit_reached'})))).status,'limit_reached');
});

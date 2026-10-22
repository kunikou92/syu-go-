// 明示的に実行するSupabase接続テスト。検証用ルームだけを作成し、最後に退出する。
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { backendConfig, createRoom, newIntent } from '../src/rooms.ts';
import { roomAction } from '../src/membership.ts';

const config = backendConfig(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_PUBLISHABLE_KEY);
if (!config) throw new Error('公開用の接続情報を.env.localに設定してください。');
const intent = newIntent('タスク4接続検証');
const created = await createRoom(config, intent);
const owner = { membership: { roomId: created.room.id, participantId: created.participant.id, resumeToken: intent.resumeToken },
  nickname: 'タスク4接続検証', snapshot: created, pendingLeave: false, inactive: false };
const candidates = [];
const invitation = created.invitation;
const call = (action, session) => roomAction(config, action, created.room.id, { invitation, session });
const journal = () => writeFile('.task4-live-check.local', JSON.stringify({ owner, candidates }, null, 2));
await journal();
try {
  for (let i = 0; i < 8; i++) {
    const pending = newIntent(`検証${i + 1}`);
    const session = { membership: { roomId: created.room.id, participantId: pending.roomId, resumeToken: pending.resumeToken },
      nickname: pending.nickname, snapshot: null, pendingLeave: false, inactive: false };
    candidates.push(session);
    await journal();
    assert.equal((await call('join', session)).status, 'ok');
  }
  const racers = Array.from({ length: 12 }, (_, index) => {
    const pending = newIntent(`同時参加${index + 1}`);
    return { membership: { roomId: created.room.id, participantId: pending.roomId, resumeToken: pending.resumeToken },
      nickname: pending.nickname, snapshot: null, pendingLeave: false, inactive: false };
  });
  candidates.push(...racers);
  await journal();
  const replies = await Promise.all(racers.map((session) => call('join', session)));
  assert.equal(replies.filter((reply) => reply.status === 'ok').length, 1);
  assert.equal(replies.filter((reply) => reply.status === 'full').length, 11);
  const winner = racers[replies.findIndex((reply) => reply.status === 'ok')];
  const retried = await call('join', winner);
  assert.equal(retried.status, 'ok');
  assert.equal(retried.participant.id, winner.membership.participantId);
  assert.equal((await call('inspect', owner)).status, 'full');
  assert.equal((await call('leave', owner)).status, 'left');
  assert.equal((await call('heartbeat', winner)).status, 'ok');
  for (const session of candidates) await call('leave', session);
  assert.equal((await call('inspect', owner)).status, 'ended');
  console.log(JSON.stringify({ capacity: 10, concurrentRequestsForLastSlot: 12, accepted: 1, rejectedAsFull: 11,
    retrySameParticipant: true, survivesCreatorLeaving: true, endsAfterEveryoneLeaves: true }, null, 2));
} finally {
  await Promise.allSettled([owner, ...candidates].map((session) => call('leave', session)));
}

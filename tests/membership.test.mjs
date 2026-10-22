import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { JSDOM } from 'jsdom';
import { build } from 'vite';
import { newIntent, invitationUrl } from '../src/rooms.ts';
import { parseInvitation, prepareJoin, readSession, writeSession, requestLeave, acceptReply } from '../src/membership.ts';

const db = new PGlite();
const config = { url: 'https://example.supabase.co', publicKey: 'sb_publishable_test' };
let bundle;
let migratedCreator;
before(async () => {
  await db.exec('create role anon; create role authenticated;');
  await db.exec(await readFile(new URL('../supabase/migrations/202610210001_create_room.sql', import.meta.url), 'utf8'));
  migratedCreator = await create('移行前の作成者');
  await db.exec(await readFile(new URL('../supabase/migrations/202610220001_room_membership.sql', import.meta.url), 'utf8'));
  const result = await build({ configFile: false, logLevel: 'silent', define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(config.url),
    'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(config.publicKey),
  }, build: { write: false, lib: { entry: 'src/main.ts', formats: ['iife'], name: 'SyuGo' } } });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === 'chunk').code;
});
after(async () => { await db.close(); });

async function create(nickname = '作成者') {
  const intent = newIntent(nickname);
  const result = (await db.query('select public.create_room($1::uuid,$2::text,$3::text) as result', [intent.roomId, intent.resumeToken, intent.nickname])).rows[0].result;
  return { membership: { roomId: result.room.id, participantId: result.participant.id, resumeToken: intent.resumeToken }, snapshot: result,
    nickname, pendingLeave: false, inactive: false };
}
function candidate(roomId, nickname = '参加者') {
  const intent = newIntent(nickname);
  return { membership: { roomId, participantId: intent.roomId, resumeToken: intent.resumeToken },
    snapshot: null, nickname, pendingLeave: false, inactive: false };
}
async function action(kind, session, invitation = session.snapshot?.invitation) {
  return (await db.query('select public.room_action($1::text,$2::uuid,$3::text,$4::uuid,$5::text,$6::text) as result',
    [kind, session.membership.roomId, invitation?.token ?? null, session.membership.participantId, session.membership.resumeToken, session.nickname])).rows[0].result;
}
async function join(owner, nickname = '参加者') {
  const session = candidate(owner.membership.roomId, nickname);
  const reply = await action('join', session, owner.snapshot.invitation);
  assert.equal(reply.status, 'ok');
  return { ...session, snapshot: reply };
}

test('既存の作成者が同じ参加者として復帰できる', async () => {
  const reply = await action('heartbeat', migratedCreator);
  assert.equal(reply.status, 'ok');
  assert.equal(reply.participant.id, migratedCreator.membership.participantId);
});

test('10人までの参加と上限付近の複数要求を制御し、再送では増えない', async () => {
  const owner = await create();
  for (let i = 0; i < 8; i++) await join(owner, `友達${i}`);
  const contenders = Array.from({ length: 6 }, () => candidate(owner.membership.roomId));
  const replies = await Promise.all(contenders.map((session) => action('join', session, owner.snapshot.invitation)));
  assert.equal(replies.filter((reply) => reply.status === 'ok').length, 1);
  assert.equal(replies.filter((reply) => reply.status === 'full').length, 5);
  const winner = contenders[replies.findIndex((reply) => reply.status === 'ok')];
  assert.equal((await action('join', winner, owner.snapshot.invitation)).status, 'ok');
  assert.equal((await db.query('select count(*)::int as n from app_private.participants where room_id=$1 and left_at is null', [owner.membership.roomId])).rows[0].n, 10);
  assert.equal((await action('inspect', owner)).status, 'full');
});

test('作成者が退出しても1人なら継続し、最後の人の退出で終了する', async () => {
  const owner = await create();
  const friend = await join(owner);
  assert.equal((await action('leave', owner)).status, 'left');
  assert.equal((await action('heartbeat', friend)).status, 'ok');
  assert.equal((await action('inspect', friend)).status, 'open');
  assert.equal((await action('join', owner, friend.snapshot.invitation)).status, 'membership_expired');
  assert.equal((await action('leave', friend)).status, 'left');
  assert.equal((await action('leave', friend)).status, 'left');
  assert.equal((await action('inspect', friend)).status, 'ended');
  assert.equal((await action('join', candidate(friend.membership.roomId), friend.snapshot.invitation)).status, 'ended');
});

test('5分未満では復帰でき、期限を延長せず、5分以降は復活しない', async () => {
  const owner = await create();
  const friend = await join(owner);
  const expiresAt = friend.snapshot.room.expiresAt;
  await db.query("update app_private.participants set last_seen_at=clock_timestamp()-interval '299 seconds' where id=$1", [friend.membership.participantId]);
  const resumed = await action('heartbeat', friend);
  assert.equal(resumed.status, 'ok');
  assert.equal(resumed.participant.id, friend.membership.participantId);
  assert.equal(resumed.room.expiresAt, expiresAt);
  await db.query("update app_private.participants set last_seen_at=clock_timestamp()-interval '300 seconds', location_sharing=true, location='{}' where id=$1", [friend.membership.participantId]);
  assert.equal((await action('heartbeat', friend)).status, 'membership_expired');
  const record = (await db.query('select left_at,location,location_sharing from app_private.participants where id=$1', [friend.membership.participantId])).rows[0];
  assert.ok(record.left_at);
  assert.equal(record.location, null);
  assert.equal(record.location_sharing, false);
  assert.equal((await action('join', friend, owner.snapshot.invitation)).status, 'membership_expired');
  assert.equal((await action('join', candidate(owner.membership.roomId), owner.snapshot.invitation)).status, 'ok');
});

test('通信なしで全員が自動退出し、24時間の終了もサーバーで処理する', async () => {
  const owner = await create();
  await db.query("update app_private.participants set last_seen_at=clock_timestamp()-interval '5 minutes' where room_id=$1", [owner.membership.roomId]);
  await db.exec('select app_private.sweep_rooms()');
  assert.equal((await action('inspect', owner)).status, 'ended');
  const expiring = await create();
  await db.query("update app_private.rooms set created_at=now()-interval '25 hours', expires_at=now()-interval '1 hour' where id=$1", [expiring.membership.roomId]);
  assert.equal((await action('heartbeat', expiring)).status, 'ended');
  assert.equal((await action('join', candidate(expiring.membership.roomId), expiring.snapshot.invitation)).status, 'ended');
});

test('不明・不正な招待・別人・別ルームの秘密値を拒否し、他人の情報を返さない', async () => {
  const owner = await create();
  const other = await create();
  assert.equal((await action('inspect', candidate(crypto.randomUUID()), owner.snapshot.invitation)).status, 'missing');
  assert.equal((await action('inspect', owner, { ...owner.snapshot.invitation, token: '0'.repeat(64) })).status, 'invalid_invitation');
  assert.equal((await action('leave', { ...owner, membership: { ...owner.membership, resumeToken: '0'.repeat(64) } })).status, 'unauthorized');
  assert.equal((await action('heartbeat', { ...owner, membership: { ...owner.membership, roomId: other.membership.roomId } })).status, 'unauthorized');
  const invalid = candidate(owner.membership.roomId);
  invalid.nickname = 'a'.repeat(21);
  assert.equal((await action('join', invalid, owner.snapshot.invitation)).status, 'invalid_nickname');
  const reply = await action('inspect', owner);
  assert.deepEqual(Object.keys(reply).sort(), ['expiresAt', 'status']);
  await db.exec('set role anon');
  try {
    await assert.rejects(db.exec('select * from app_private.participant_credentials'));
    await assert.rejects(db.exec('select app_private.sweep_rooms()'));
    assert.equal((await action('heartbeat', owner)).status, 'ok');
  } finally { await db.exec('reset role'); }
});

function page(hash, fetcher = backendFetch, storage = {}) {
  const dom = new JSDOM('<div id="app"></div>', { url: `https://app.example/${hash}`, runScripts: 'outside-only' });
  Object.defineProperty(dom.window, 'crypto', { value: webcrypto });
  dom.window.AbortSignal = AbortSignal;
  dom.window.fetch = fetcher;
  for (const [key, value] of Object.entries(storage)) dom.window.localStorage.setItem(key, value);
  dom.window.eval(bundle);
  return dom;
}
async function backendFetch(url, options) {
  const p = JSON.parse(options.body);
  assert.ok(url.endsWith('/rpc/room_action'));
  const reply = (await db.query('select public.room_action($1::text,$2::uuid,$3::text,$4::uuid,$5::text,$6::text) as result',
    [p.p_action,p.p_room_id,p.p_invite,p.p_participant_id,p.p_resume_token,p.p_nickname])).rows[0].result;
  return new Response(JSON.stringify(reply));
}
async function until(predicate) {
  for (let i=0;i<200;i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve,10)); }
  assert.fail('画面更新がタイムアウトしました');
}
const submit = (dom) => dom.window.document.querySelector('#join-form').dispatchEvent(new dom.window.Event('submit', { bubbles:true,cancelable:true }));

test('招待URLを検査し、参加送信の再試行には同じIDを使う', async () => {
  const owner = await create();
  const hash = new URL(invitationUrl('https://app.example', owner.snapshot.invitation)).hash;
  assert.deepEqual(parseInvitation(hash), owner.snapshot.invitation);
  assert.equal(parseInvitation('#/join?room=nope&invite=bad'), null);
  assert.equal(parseInvitation(`${hash}&room=${owner.membership.roomId}`), null);
  const dom = page('#/join');
  try {
    const first = prepareJoin(dom.window.localStorage, config.url, owner.snapshot.invitation, '友達');
    assert.deepEqual(prepareJoin(dom.window.localStorage, config.url, owner.snapshot.invitation, '友達'), first);
    assert.throws(() => prepareJoin(dom.window.localStorage, config.url, owner.snapshot.invitation, '別名'));
  } finally { dom.window.close(); }
});

test('招待画面から入力検査・参加・再読み込みで同じ参加者に復帰する', async () => {
  const owner = await create();
  const hash = new URL(invitationUrl('https://app.example', owner.snapshot.invitation)).hash;
  const dom = page(hash);
  try {
    await until(() => dom.window.document.querySelector('#join-form button')?.disabled === false);
    submit(dom);
    assert.match(dom.window.document.querySelector('#join-status').textContent, /ニックネーム/);
    dom.window.document.querySelector('#join-nickname').value = '途中参加';
    submit(dom); submit(dom);
    await until(() => dom.window.document.querySelector('#leave-room'));
    const session = readSession(dom.window.localStorage, config.url, owner.membership.roomId);
    assert.equal(session.snapshot.participant.nickname, '途中参加');
    const restored = page('#/guide', backendFetch, Object.fromEntries(Object.entries(dom.window.localStorage)));
    try {
      await until(() => restored.window.document.querySelector('#connection-status')?.textContent === '参加中です。');
      assert.equal(readSession(restored.window.localStorage, config.url, owner.membership.roomId).membership.participantId, session.membership.participantId);
    } finally { restored.window.close(); }
    assert.equal((await db.query('select count(*)::int as n from app_private.participants where room_id=$1 and left_at is null', [owner.membership.roomId])).rows[0].n, 2);
  } finally { dom.window.close(); }
});

test('退出の応答が消えても要求を保持し、再読み込み後に退出を優先する', async () => {
  const owner = await create();
  const friend = await join(owner);
  const dom = page('#/guide', async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.p_action === 'leave') {
      await backendFetch(_url, options); // サーバーで退出した後で応答だけ消失する。
      throw new Error('response lost');
    }
    return backendFetch(_url, options);
  });
  try {
    writeSession(dom.window.localStorage, config.url, friend);
    dom.window.dispatchEvent(new dom.window.Event('storage'));
    await until(() => dom.window.document.querySelector('#leave-room'));
    dom.window.document.querySelector('#leave-room').click();
    await until(() => dom.window.document.querySelector('#connection-status')?.textContent.includes('まだ確定していません'));
    assert.equal(readSession(dom.window.localStorage, config.url, owner.membership.roomId).pendingLeave, true);
    const observed = [];
    const restored = page('#/guide', async (url, options) => {
      observed.push(JSON.parse(options.body).p_action);
      return backendFetch(url, options);
    }, Object.fromEntries(Object.entries(dom.window.localStorage)));
    try {
      await until(() => restored.window.document.body.textContent.includes('ルームから退出しました'));
      assert.equal(observed[0], 'leave');
      assert.equal(readSession(restored.window.localStorage, config.url, owner.membership.roomId).inactive, true);
    } finally { restored.window.close(); }
  } finally { dom.window.close(); }
});

test('10人目の参加応答が消えて満員になっても同じ参加結果を再取得できる', async () => {
  const owner = await create();
  for (let i = 0; i < 8; i++) await join(owner);
  const session = candidate(owner.membership.roomId, '10人目');
  assert.equal((await action('join', session, owner.snapshot.invitation)).status, 'ok');
  const hash = new URL(invitationUrl('https://app.example', owner.snapshot.invitation)).hash;
  const dom = page(hash, backendFetch, {
    [`syu-go:${config.url}:membership:${owner.membership.roomId}`]: JSON.stringify(session),
  });
  try {
    await until(() => dom.window.document.querySelector('#join-form button')?.disabled === false);
    assert.match(dom.window.document.body.textContent, /満員/);
    submit(dom);
    await until(() => dom.window.document.querySelector('#leave-room'));
    assert.equal(readSession(dom.window.localStorage, config.url, owner.membership.roomId).membership.participantId, session.membership.participantId);
    assert.equal((await db.query('select count(*)::int as n from app_private.participants where room_id=$1 and left_at is null', [owner.membership.roomId])).rows[0].n, 10);
  } finally { dom.window.close(); }
});

test('退出要求の保存不可では送信せず、確定後の古い状態からは復帰しない', async () => {
  const owner = await create();
  const dom = page('#/join');
  try {
    writeSession(dom.window.localStorage, config.url, owner);
    const blocked = { setItem() { throw new Error('quota'); } };
    assert.throws(() => requestLeave(blocked, config.url, owner));
    const inactive = acceptReply(dom.window.localStorage, config.url, owner, { status: 'left' });
    assert.equal(inactive.snapshot, null);
    assert.equal(readSession(dom.window.localStorage, config.url, owner.membership.roomId).inactive, true);
  } finally { dom.window.close(); }
});

test('他タブの通信時刻更新だけではheartbeatを連鎖送信しない', async () => {
  const owner = await create();
  const key = `syu-go:${config.url}:membership:${owner.membership.roomId}`;
  let calls = 0;
  const dom = page('#/guide', async (url, options) => { calls++; return backendFetch(url, options); }, {
    [key]: JSON.stringify(owner), [`syu-go:${config.url}:active-room`]: owner.membership.roomId,
  });
  try {
    await until(() => dom.window.document.querySelector('#connection-status')?.textContent === '参加中です。');
    const before = calls;
    const updated = { ...owner, snapshot: { ...owner.snapshot, participant: { ...owner.snapshot.participant, lastSeenAt: new Date().toISOString() } } };
    dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key, oldValue: JSON.stringify(owner), newValue: JSON.stringify(updated) }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls, before);
  } finally { dom.window.close(); }
});

test('別ルームへ切り替えても保存済みの退出要求を再送する', async () => {
  const former = await create('以前のルーム');
  const current = await create('現在のルーム');
  const dom = page('#/guide', backendFetch, {
    [`syu-go:${config.url}:membership:${former.membership.roomId}`]: JSON.stringify({ ...former, pendingLeave: true }),
    [`syu-go:${config.url}:membership:${current.membership.roomId}`]: JSON.stringify(current),
    [`syu-go:${config.url}:active-room`]: current.membership.roomId,
  });
  try {
    await until(() => readSession(dom.window.localStorage, config.url, former.membership.roomId).inactive);
    await until(() => dom.window.document.querySelector('#connection-status')?.textContent === '参加中です。');
    assert.equal(dom.window.localStorage.getItem(`syu-go:${config.url}:active-room`), current.membership.roomId);
    assert.equal((await action('inspect', former)).status, 'ended');
  } finally { dom.window.close(); }
});

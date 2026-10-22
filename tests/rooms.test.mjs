import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { JSDOM } from 'jsdom';
import { build } from 'vite';
import { backendConfig, normalizeNickname, newIntent, createRoom, invitationUrl, pendingCreation } from '../src/rooms.ts';

const config = { url: 'https://example.supabase.co', publicKey: 'sb_publishable_test' };
const db = new PGlite();
let bundle;
before(async () => {
  await db.exec('create role anon; create role authenticated;');
  await db.exec(await readFile(new URL('../supabase/migrations/202610210001_create_room.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/202610220001_room_membership.sql', import.meta.url), 'utf8'));
  const result = await build({
    configFile: false, logLevel: 'silent',
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(config.url),
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(config.publicKey),
    },
    build: { write: false, lib: { entry: 'src/main.ts', formats: ['iife'], name: 'SyuGo' } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === 'chunk').code;
});
after(async () => { await db.close(); });

async function rpc(intent) {
  const result = await db.query('select public.create_room($1::uuid, $2::text, $3::text) as result', [intent.roomId, intent.resumeToken, intent.nickname]);
  return result.rows[0].result;
}

test('名前の空白・文字数・制御文字を検査する', () => {
  assert.equal(normalizeNickname('　 さくら　'), 'さくら');
  assert.equal(normalizeNickname('😀'.repeat(20)), '😀'.repeat(20));
  for (const value of ['', '　 ', 'a'.repeat(21), 'a\nb', 'a\u0085b']) {
    assert.throws(() => normalizeNickname(value));
  }
});

test('設定に公開キーのみを許可する', () => {
  assert.deepEqual(backendConfig(config.url, config.publicKey), config);
  assert.equal(backendConfig(undefined, undefined), null);
  assert.equal(backendConfig(config.url, 'sb_secret_example'), null);
  const jwt = `header.${btoa(JSON.stringify({ role: 'service_role' }))}.signature`;
  assert.equal(backendConfig(config.url, jwt), null);
});

test('サーバーでルームと作成者を保存し、再送しても1件になる', async () => {
  const intent = newIntent('さくら');
  const first = await rpc(intent);
  const second = await rpc(intent);
  assert.deepEqual(second, first);
  assert.equal(first.participant.nickname, 'さくら');
  assert.equal(first.participant.locationSharing, false);
  assert.equal(first.participant.location, null);
  assert.equal(first.participant.arrived, false);
  assert.equal(Date.parse(first.room.expiresAt) - Date.parse(first.room.createdAt), 86400000);
  assert.equal((await db.query('select count(*)::int as n from app_private.participants where room_id=$1', [intent.roomId])).rows[0].n, 1);
  assert.equal(JSON.stringify(first).includes(intent.resumeToken), false);
  const other = await rpc(newIntent('りん'));
  assert.notEqual(first.invitation.token, other.invitation.token);
  const url = invitationUrl('https://app.example/sub/?old=secret#/create', first.invitation);
  assert.equal(new URL(url).search, '');
  assert.ok(url.includes('#/join?room='));
  assert.equal(url.includes(intent.resumeToken), false);
});

test('不正な入力と別の秘密値による再取得を拒否する', async () => {
  for (const nickname of ['　 ', 'a'.repeat(21), 'a\nb', 'a\u0085b']) {
    await assert.rejects(rpc({ ...newIntent('valid'), nickname }));
  }
  const intent = newIntent('valid');
  await rpc(intent);
  await assert.rejects(rpc({ ...intent, resumeToken: 'b'.repeat(64) }));
  await db.query("update app_private.rooms set created_at=now()-interval '25 hours', expires_at=now()-interval '1 hour' where id=$1", [intent.roomId]);
  assert.equal((await rpc(intent)).status, 'ended');
});

test('公開ロールは直接テーブルを読めず、作成RPCだけを実行できる', async () => {
  const intent = newIntent('公開API');
  await db.exec('set role anon');
  try {
    await assert.rejects(db.query('select * from app_private.rooms'));
    await assert.rejects(db.query('select * from app_private.creation_credentials'));
    assert.equal((await rpc(intent)).participant.nickname, '公開API');
  } finally { await db.exec('reset role'); }
});

test('API呼び出しと通信エラーを処理する', async () => {
  const intent = newIntent('API');
  const result = await createRoom(config, intent, async (url, options) => {
    assert.equal(url, `${config.url}/rest/v1/rpc/create_room`);
    assert.equal(options.headers.apikey, config.publicKey);
    const params = JSON.parse(options.body);
    assert.equal(params.p_resume_token, intent.resumeToken);
    return new Response(JSON.stringify(await rpc(intent)));
  });
  assert.equal(result.room.id, intent.roomId);
  await assert.rejects(createRoom(config, intent, async () => { throw new Error('offline'); }), /通信を確認/);
  await assert.rejects(createRoom(config, intent, async () => new Response('{}', { status: 500 })), /作成できません/);
  await assert.rejects(createRoom(config, intent, async () => new Response('{}')), /作成結果/);
});

function page(hash, fetcher, storage = {}) {
  const dom = new JSDOM('<div id="app"></div>', { url: `https://app.example/${hash}`, runScripts: 'outside-only' });
  Object.defineProperty(dom.window, 'crypto', { value: webcrypto });
  dom.window.AbortSignal = AbortSignal;
  dom.window.fetch = fetcher;
  for (const [key, value] of Object.entries(storage)) dom.window.localStorage.setItem(key, value);
  dom.window.eval(bundle);
  return dom;
}
const submit = (dom) => dom.window.document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('画面更新がタイムアウトしました');
}

test('画面で入力検査、二重送信防止、作成結果の復元、コピーを確認する', async () => {
  let calls = 0;
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const dom = page('#/create', async (_url, options) => {
    calls++;
    await gate;
    const data = JSON.parse(options.body);
    return new Response(JSON.stringify(await rpc({ roomId: data.p_room_id, resumeToken: data.p_resume_token, nickname: data.p_nickname })));
  });
  try {
    const input = dom.window.document.querySelector('#nickname');
    submit(dom);
    assert.match(dom.window.document.querySelector('#create-status').textContent, /入力してください/);
    assert.equal(calls, 0);
    input.value = '<img src=x>';
    submit(dom);
    submit(dom);
    assert.equal(calls, 1);
    assert.equal(dom.window.document.querySelector('button').disabled, true);
    finish();
    await until(() => dom.window.document.querySelector('#invite-url'));
    assert.equal(dom.window.document.querySelectorAll('img').length, 0);
    assert.equal(dom.window.document.querySelector('#location-controls'), null);
    assert.equal(dom.window.document.querySelector('#participants-list'), null);
    assert.equal(dom.window.document.querySelector('#mode-friends'), null);
    let copied;
    Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async (value) => { copied = value; } } });
    dom.window.document.querySelector('#copy-invite').click();
    await until(() => dom.window.document.querySelector('#copy-status').textContent.includes('コピーしました'));
    assert.equal(copied, dom.window.document.querySelector('#invite-url').value);
    const saved = Object.fromEntries(Object.entries(dom.window.localStorage));
    const restored = page('#/created', undefined, saved);
    try {
      assert.equal(restored.window.document.querySelector('#invite-url').value, copied);
      restored.window.document.querySelector('#copy-invite').click();
      await until(() => restored.window.document.querySelector('#copy-status').textContent.includes('自動コピーが使えません'));
      assert.equal(restored.window.document.querySelector('#invite-url').selectionEnd, copied.length);
      restored.window.location.hash = '/guide';
      await until(() => restored.window.document.querySelector('#mode-friends'));
      assert.ok(restored.window.document.querySelector('#location-controls'));
      assert.ok(restored.window.document.querySelector('#heading-manual'));
      assert.doesNotMatch(restored.window.document.querySelector('#main').textContent, /合流しよう/);
    } finally { restored.window.close(); }
  } finally { dom.window.close(); }
});

test('通信失敗後も同じ作成情報で再試行し、保存不可なら送信しない', async () => {
  const dom = page('#/create', async () => { throw new Error('offline'); });
  try {
    dom.window.document.querySelector('#nickname').value = '再試行';
    submit(dom);
    await until(() => dom.window.document.querySelector('#create-status').textContent.includes('通信を確認'));
    const pending = pendingCreation(dom.window.localStorage, config.url, '再試行');
    assert.deepEqual(pendingCreation(dom.window.localStorage, config.url, '再試行'), pending);
    assert.throws(() => pendingCreation(dom.window.localStorage, config.url, '別名'), /同じニックネーム/);
    Object.defineProperty(dom.window, 'localStorage', { get() { throw new Error('blocked'); } });
    submit(dom);
    assert.match(dom.window.document.querySelector('#create-status').textContent, /保存できません/);
  } finally { dom.window.close(); }
});

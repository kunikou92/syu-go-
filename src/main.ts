import './style.css';
import { ROOM_POLICY } from './domain';
import { backendConfig, createRoom, CreationExpiredError, invitationUrl, loadCreation, normalizeNickname, pendingCreation, saveCreation } from './rooms';
import { RoomUI } from './room-ui';
import { readSession } from './membership';
import { ParticipantsUI } from './participants-ui';
import { LocationUI } from './location-ui';
import { FriendsUI } from './friends-ui';
import { PinsUI } from './pins-ui';
import { Compass } from './compass';
import { CompassUI } from './compass-ui';
import { googleMapsConfig } from './google-maps';

const config = backendConfig(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
const mapsConfig = googleMapsConfig(import.meta.env.VITE_GOOGLE_MAPS_API_KEY, import.meta.env.VITE_GOOGLE_MAPS_MAP_ID);
let creating = false;
const roomUI = new RoomUI(config, () => render());
const participantsUI = new ParticipantsUI(config, () => render(), (status) => roomUI.notifyTerminal(status));
const locationUI = new LocationUI(config);
const compass = new Compass(() => {friendsUI.paint();pinsUI.paint();compassUI.paint();});
const compassUI = new CompassUI(compass);
const friendsUI = new FriendsUI(() => locationUI.guidance(),compass);
const pinsUI = new PinsUI(config,() => locationUI.guidance(),() => render(),compass,status => roomUI.notifyTerminal(status),undefined,mapsConfig);
let mode: 'friends' | 'pin' = 'friends';
let modeScope = '';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('表示先が見つかりません。');

const views = {
  '/': {
    label: 'HOME',
    title: '',
    body: `<p class="lead home-description">友達や集合場所の方向と距離を確かめながら、みんなで合流するためのアプリです。ルームを作って招待URLを共有すれば、一緒に使えます。</p>
      <section class="home-modes" aria-label="2つの案内モード">
        <article class="home-mode-card">
          <h2>①友達モード</h2>
          <figure><img src="/images/friends-compass.png" width="320" height="410" alt="友達のいる方向を丸いコンパスと矢印で示し、距離を表示する画面"><figcaption>コンパスの表示イメージ</figcaption></figure>
          <p>友達がいる方向と距離を確認。矢印を頼りに、お互いの場所へ合流できます。</p>
        </article>
        <article class="home-mode-card">
          <h2>②ピンモード</h2>
          <figure><img src="/images/pin-compass.png" width="320" height="410" alt="集合地点までの距離と、向かう方向の矢印を表示する画面"><figcaption>コンパスの表示イメージ</figcaption></figure>
          <p>地図で集合地点を決めて共有。ピンの方向と距離を矢印で確認しながら向かえます。</p>
        </article>
      </section>
      <a class="button home-create" href="#/create">ルームを作る <span aria-hidden="true">→</span></a>`,
  },
  '/create': {
    label: 'CREATE ROOM',
    title: '集合のきっかけを<br>つくろう。',
    body: `<p class="lead">ルームを作って、友達に招待URLを共有します。</p>
      <section class="card"><h2>ルーム作成</h2>
      <form id="create-form" novalidate>
        <label for="nickname">このルームで使うニックネーム</label>
        <input id="nickname" name="nickname" type="text" autocomplete="nickname" required aria-describedby="nickname-help create-status">
        <p id="nickname-help" class="hint">1〜20文字で入力してください。位置公開はOFFで始まります。</p>
        ${!config ? '<p class="notice">現在ルームを作成できません。時間をおいて再度お試しください。</p>' : ''}
        <button class="button" type="submit" ${!config || creating ? 'disabled' : ''}>${creating ? '作成しています…' : 'ルームを作る'} <span aria-hidden="true">→</span></button>
        <p id="create-status" role="status" aria-live="polite"></p>
      </form>
      <dl><div><dt>参加人数</dt><dd>最大${ROOM_POLICY.maxParticipants}人</dd></div><div><dt>有効期限</dt><dd>作成から24時間</dd></div></dl></section>`,
  },
  '/join': {
    label: 'JOIN ROOM',
    title: '友達の待つ<br>ルームへ。',
    body: '',
  },
  '/guide': {
    label: 'GUIDANCE',
    title: '',
    body: '',
  },
} as const;

function render() {
  const scope=roomUI.session()?.membership.roomId ?? '';
  if(scope!==modeScope){modeScope=scope;mode='friends';}
  const path = (window.location.hash.slice(1) || '/').split('?')[0];
  const view = views[path as keyof typeof views];
  let content = view
    ? `<p class="eyebrow">${view.label}</p><h1>${view.title}</h1>${view.body}`
    : `<p class="eyebrow">NOT FOUND</p><h1>ページが<br>見つかりません。</h1><a class="button" href="#/">ホームに戻る →</a>`;
  if (path === '/') content = views['/'].body;
  if (path === '/created') content = createdContent();
  if (path === '/join') content = `<p class="eyebrow">JOIN ROOM</p><h1 class="join-title">友達の待つルームへ。</h1>${roomUI.joinContent()}`;
  if (path === '/guide') content = `${locationUI.content()}
    <div class="mode-switch" role="group" aria-label="案内モード"><button id="mode-friends" class="button secondary" type="button" aria-pressed="${mode==='friends'}">合流モード</button><button id="mode-pins" class="button secondary" type="button" aria-pressed="${mode==='pin'}">ピンモード</button></div>
    ${mode==='friends'?friendsUI.content(compassUI.content()):pinsUI.content(compassUI.content())}${participantsUI.content()}${roomUI.guideContent()}`;
  const simple = path === '/' || path === '/created';
  app!.innerHTML = `<div class="shell"><header><a class="brand" href="#/" aria-label="しゅーごー ホーム">しゅーごー</a></header>
    <main id="main" tabindex="-1">${content}</main>
    ${simple?'':`<footer><p>方向と距離は目安としてお使いください。</p><a href="#/">← ホームに戻る</a></footer>`}</div>`;
  document.title = `${path === '/created' ? 'ルーム作成完了' : view?.label === 'HOME' ? 'ホーム' : view?.label === 'CREATE ROOM' ? 'ルーム作成' : view?.label === 'JOIN ROOM' ? 'ルーム参加' : view?.label === 'GUIDANCE' ? '案内' : 'ページが見つかりません'} | しゅーごー（集合！）`;
  document.querySelector<HTMLFormElement>('#create-form')?.addEventListener('submit', handleCreate);
  document.querySelector<HTMLButtonElement>('#copy-invite')?.addEventListener('click', copyInvitation);
  roomUI.mount();
  participantsUI.mount();
  locationUI.mount();
  friendsUI.mount();
  compassUI.mount();
  if(mode==='pin')pinsUI.mount();
  document.querySelector('#mode-friends')?.addEventListener('click',() => {pinsUI.leave();mode='friends';render();});
  document.querySelector('#mode-pins')?.addEventListener('click',() => {if(mode!=='pin')pinsUI.enter();mode='pin';render();});
  const input = document.querySelector<HTMLInputElement>('#nickname');
  if (input && config) {
    try {
      const pending = localStorage.getItem(`syu-go:${config.url}:pending-creation`);
      if (pending) input.value = (JSON.parse(pending) as { nickname: string }).nickname;
    } catch { /* 保存の可否は送信前に案内する。 */ }
    input.readOnly = creating;
    const button = document.querySelector<HTMLButtonElement>('#create-form button')!;
    button.disabled = creating;
    if (creating) button.textContent = '作成しています…';
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function createdContent(): string {
  let saved;
  try { saved = config && loadCreation(localStorage, config.url); } catch { saved = null; }
  if (!saved) return '<h1>作成結果を表示できません。</h1><p>同じブラウザーで、前回と同じ名前を使って再試行してください。</p><a class="button" href="#/create">ルーム作成へ</a>';
  try {
    const session = config && readSession(localStorage, config.url, saved.room.id);
    if (session?.inactive || session?.pendingLeave) return '<h1>このルームの参加は終了しています。</h1><p>退出処理中の場合は通信の回復をお待ちください。</p><a class="button" href="#/guide">参加状態を確認する</a>';
  } catch { /* 作成結果自体の読み込みができた場合は引き続き表示する。 */ }
  if (Date.parse(saved.room.expiresAt) <= Date.now() || saved.room.endedAt) {
    return '<h1>このルームの有効期限は終了しました。</h1><a class="button" href="#/create">新しいルームを作る</a>';
  }
  const url = invitationUrl(window.location.href, saved.invitation);
  const expires = new Date(saved.room.expiresAt).toLocaleString('ja-JP');
  return `<section class="card"><h2>友達への招待URL</h2><label class="hint" for="invite-url">URLをコピーして共有できます。</label>
      <input id="invite-url" type="text" readonly value="${escapeHtml(url)}">
      <button id="copy-invite" class="button" type="button">招待URLをコピー</button>
      <p id="copy-status" role="status" aria-live="polite"></p>
      <p class="hint">有効期限：${escapeHtml(expires)}<br>URLを知っている人が参加できます。共有先を確かめて送ってください。</p>
    </section>
    <a class="button secondary" href="#/guide">案内画面へ <span aria-hidden="true">→</span></a>`;
}

async function handleCreate(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (creating || !config) return;
  const form = event.currentTarget as HTMLFormElement;
  const input = form.querySelector<HTMLInputElement>('#nickname')!;
  const status = form.querySelector<HTMLElement>('#create-status')!;
  const button = form.querySelector<HTMLButtonElement>('button')!;
  let nickname;
  try { nickname = normalizeNickname(input.value); }
  catch (error) {
    input.setAttribute('aria-invalid', 'true');
    status.textContent = (error as Error).message;
    input.focus();
    return;
  }
  input.removeAttribute('aria-invalid');
  let intent;
  try { intent = pendingCreation(localStorage, config.url, nickname); }
  catch (error) {
    status.textContent = error instanceof Error && error.message.startsWith('前回') ? error.message : 'ブラウザーに作成情報を保存できません。保存を許可してから再試行してください。';
    return;
  }
  creating = true;
  button.disabled = true;
  input.readOnly = true;
  button.textContent = '作成しています…';
  status.textContent = '';
  try {
    const result = await createRoom(config, intent);
    try { saveCreation(localStorage, config.url, result, intent); }
    catch { throw new Error('作成結果をブラウザーに保存できません。同じ名前でもう一度お試しください。'); }
    roomUI.created(result, intent.resumeToken);
    window.location.hash = '/created';
  } catch (error) {
    if (error instanceof CreationExpiredError) localStorage.removeItem(`syu-go:${config.url}:pending-creation`);
    status.textContent = error instanceof Error ? error.message : 'ルームを作成できませんでした。再試行してください。';
  } finally {
    creating = false;
    button.disabled = false;
    button.textContent = 'ルームを作る →';
    input.readOnly = false;
  }
}

async function copyInvitation(): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('#invite-url')!;
  const status = document.querySelector<HTMLElement>('#copy-status')!;
  try {
    await navigator.clipboard.writeText(input.value);
    status.textContent = '招待URLをコピーしました。';
  } catch {
    input.focus();
    input.select();
    input.setSelectionRange(0, input.value.length);
    status.textContent = '自動コピーが使えません。選択したURLを長押し、またはコピー操作でコピーしてください。';
  }
}

window.addEventListener('hashchange', () => {
  render();
  document.querySelector<HTMLElement>('#main')?.focus();
});
render();

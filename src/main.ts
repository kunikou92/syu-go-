import './style.css';
import { ROOM_POLICY } from './domain';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('表示先が見つかりません。');

const views = {
  '/': {
    label: 'HOME',
    title: 'みんなの「どこ？」を、<br>ひとつの方向へ。',
    body: `<p class="lead">友達や集合場所の方向を確かめながら、<br>みんなで合流するためのアプリ。</p>
      <div class="compass" aria-hidden="true"><span>N</span><b>↗</b></div>
      <a class="button" href="#/create">ルームを作る <span>→</span></a>
      <a class="button secondary" href="#/join">ルームに参加する <span>↗</span></a>
      <p class="hint">招待URLを受け取ったら、そこから参加できます。</p>`,
  },
  '/create': {
    label: 'CREATE ROOM',
    title: '集合のきっかけを<br>つくろう。',
    body: `<p class="lead">ルームを作って、友達に招待URLを共有します。</p>
      <section class="card"><h2>ルーム作成</h2><p>ニックネームの入力と招待URLの発行は、これから追加します。</p>
      <dl><div><dt>参加人数</dt><dd>最大${ROOM_POLICY.maxParticipants}人</dd></div><div><dt>有効期限</dt><dd>作成から24時間</dd></div></dl></section>
      <a class="button secondary" href="#/guide">案内画面のひな形を見る <span>→</span></a>`,
  },
  '/join': {
    label: 'JOIN ROOM',
    title: '友達の待つ<br>ルームへ。',
    body: `<p class="lead">友達から届いた招待URLで、ルームに参加します。</p>
      <section class="card"><h2>ルーム参加</h2><p>招待URLの確認とニックネームの設定は、これから追加します。</p><p class="hint">この画面から実際のルームにはまだ参加できません。</p></section>
      <a class="button secondary" href="#/guide">案内画面のひな形を見る <span>→</span></a>`,
  },
  '/guide': {
    label: 'GUIDANCE',
    title: 'さあ、<br>合流しよう。',
    body: `<p class="lead">友達や集合地点への案内を表示する画面です。</p>
      <section class="card"><h2>友達・集合地点の案内</h2><div class="empty-arrow" aria-hidden="true">↑</div><p>案内はまだ始まっていません。</p><p class="hint">方向・距離とモード切り替えは、これから追加します。</p></section>
      <section class="card"><h2>参加者</h2><p>参加者はまだ表示されていません。</p></section>
      <p class="privacy">位置公開の初期状態はOFFです。</p>`,
  },
} as const;

function render() {
  const path = window.location.hash.slice(1) || '/';
  const view = views[path as keyof typeof views];
  const content = view
    ? `<p class="eyebrow">${view.label}</p><h1>${view.title}</h1>${view.body}`
    : `<p class="eyebrow">NOT FOUND</p><h1>ページが<br>見つかりません。</h1><a class="button" href="#/">ホームに戻る →</a>`;
  app!.innerHTML = `<div class="shell"><header><a class="brand" href="#/" aria-label="しゅーごー ホーム">しゅーごー<span>集合！</span></a><span class="badge">開発中</span></header>
    <main id="main" tabindex="-1">${content}</main>
    <footer><p>画面のひな形です。ルームの作成・参加・位置共有は未実装です。</p>${path !== '/' ? '<a href="#/">← ホームに戻る</a>' : ''}</footer></div>`;
  document.title = `${view?.label === 'HOME' ? 'ホーム' : view?.label === 'CREATE ROOM' ? 'ルーム作成' : view?.label === 'JOIN ROOM' ? 'ルーム参加' : view?.label === 'GUIDANCE' ? '案内' : 'ページが見つかりません'} | しゅーごー（集合！）`;
}

window.addEventListener('hashchange', () => {
  render();
  document.querySelector<HTMLElement>('#main')?.focus();
});
render();

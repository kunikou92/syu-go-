import type { BackendConfig, CreatedRoom } from './rooms';
import type { RoomInvitation } from './domain';
import { invitationUrl } from './rooms';
import { acceptReply, activeSession, parseInvitation, pendingDepartures, prepareJoin, readSession, requestLeave,
  roomAction, statusMessages, writeSession } from './membership';
import type { RoomReply, Session } from './membership';

const html = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export class RoomUI {
  private invitation: RoomInvitation | null = null;
  private checkedHash = '';
  private availability: RoomReply | null = null;
  private joinError = '';
  private joining = false;
  private inspectVersion = 0;
  private syncPromise: Promise<void> | null = null;
  private connection = '接続を確認しています…';
  private lastSuccess = Date.now();
  private terminal = '';

  constructor(private config: BackendConfig | null, private redraw: () => void) {
    window.setInterval(() => void this.sync(), 10000);
    window.addEventListener('online', () => { this.checkedHash = ''; void this.sync(); this.redraw(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void this.sync(); });
    window.addEventListener('storage', (event) => {
      // heartbeatで更新した時刻だけの通知には反応しない。他タブとの通信ループを防ぐ。
      if (event.key?.includes(':membership:') && event.oldValue && event.newValue) {
        try {
          const before = JSON.parse(event.oldValue) as Session;
          const after = JSON.parse(event.newValue) as Session;
          if (before.membership.participantId === after.membership.participantId &&
              before.pendingLeave === after.pendingLeave && before.inactive === after.inactive &&
              Boolean(before.snapshot) === Boolean(after.snapshot)) return;
        } catch { /* 破損や削除は画面を再確認する。 */ }
      } else if (event.key && !event.key.includes(':active-room') && !event.key.includes(':membership:')) return;
      void this.sync(); this.redraw();
    });
    window.setTimeout(() => void this.sync(), 0);
  }

  session(): Session | null {
    try { return this.config && activeSession(localStorage, this.config.url); }
    catch { return null; }
  }

  created(result: CreatedRoom, resumeToken: string): void {
    if (!this.config) return;
    writeSession(localStorage, this.config.url, { membership: { roomId: result.room.id,
      participantId: result.participant.id, resumeToken }, nickname: result.participant.nickname,
      snapshot: result, pendingLeave: false, inactive: false });
    this.lastSuccess = Date.now();
    this.connection = '参加中です。';
    this.terminal = '';
  }

  joinContent(): string {
    if (!this.config) return '<p class="notice">接続先の準備中です。</p>';
    const invitation = parseInvitation(window.location.hash);
    if (!invitation) return '<p class="notice">友達から届いた招待URLを開いてください。URLにはルームIDと招待情報が必要です。</p>';
    this.invitation = invitation;
    if (this.checkedHash !== window.location.hash) {
      this.checkedHash = window.location.hash;
      this.availability = null;
      this.joinError = '';
      void this.inspect(invitation, ++this.inspectVersion);
    }
    let saved: Session | null = null;
    try { saved = readSession(localStorage, this.config.url, invitation.roomId); } catch { /* 送信時に案内する */ }
    const available = this.availability?.status;
    const message = this.joinError || (available ? statusMessages[available] : '招待URLを確認しています…');
    const canResume = saved && !saved.inactive && saved.snapshot && ['open', 'full'].includes(available ?? '');
    const canRetry = available === 'full' && saved && !saved.inactive && !saved.snapshot && !saved.pendingLeave;
    return `<section class="card"><h2>ルーム参加</h2><p role="status">${html(message)}</p>
      ${canResume ? '<a class="button" href="#/guide">参加中のルームへ戻る →</a>' : `
      <form id="join-form" novalidate><label for="join-nickname">このルームで使うニックネーム</label>
      <input id="join-nickname" autocomplete="nickname" required value="${html(saved && !saved.inactive ? saved.nickname : '')}" aria-describedby="join-help join-status" ${this.joining ? 'readonly' : ''}>
      <p id="join-help" class="hint">1〜20文字。位置公開はOFFで始まります。</p>
      <button class="button" type="submit" ${(available !== 'open' && !canRetry) || this.joining ? 'disabled' : ''}>${this.joining ? '参加しています…' : canRetry ? '前回の参加結果を確認する' : 'ルームに参加する'}</button>
      <p id="join-status" role="status"></p></form>`}
      <button id="retry-invite" class="button secondary" type="button" ${this.joining ? 'disabled' : ''}>状態を再確認する</button></section>`;
  }

  guideContent(): string {
    const session = this.session();
    if (!session?.snapshot) return `<section class="card"><h2>ルームへの参加</h2><p>${html(this.terminal || 'まだルームに参加していません。招待URLから参加するか、ルームを作成してください。')}</p><a class="button" href="#/create">ルームを作る</a></section>`;
    return `<section class="card"><h2>${html(session.nickname)}さんのルーム</h2>
      <p id="connection-status" role="status">${html(session.pendingLeave ? '退出を送信しています。通信が戻り次第、退出を確定します。' : this.connection)}</p>
      <p class="hint">通信が5分間途絶えると自動退出します。画面を閉じるだけでは即退出になりません。</p>
      <a href="${html(invitationUrl(window.location.href, session.snapshot.invitation))}">このルームの招待画面</a>
      <button id="leave-room" class="button secondary" type="button" ${session.pendingLeave ? 'disabled' : ''}>ルームから退出する</button></section>`;
  }

  mount(): void {
    document.querySelector('#join-form')?.addEventListener('submit', (event) => void this.join(event));
    document.querySelector('#retry-invite')?.addEventListener('click', () => { this.checkedHash = ''; this.redraw(); });
    document.querySelector('#leave-room')?.addEventListener('click', () => void this.leave());
    const saved = this.session();
    if (saved?.snapshot && !saved.pendingLeave) {
      const home = document.querySelector('#main .compass');
      if (home) home.insertAdjacentHTML('afterend', '<a class="button secondary" href="#/guide">参加中のルームに戻る →</a>');
    }
  }

  private async inspect(invitation: RoomInvitation, version: number): Promise<void> {
    try {
      const result = await roomAction(this.config!, 'inspect', invitation.roomId, { invitation });
      if (version !== this.inspectVersion) return;
      this.availability = result;
      const saved = readSession(localStorage, this.config!.url, invitation.roomId);
      if (saved && !saved.inactive && saved.snapshot && ['open', 'full'].includes(result.status)) {
        writeSession(localStorage, this.config!.url, saved);
        void this.sync();
      }
    } catch (error) {
      if (version !== this.inspectVersion) return;
      this.joinError = error instanceof Error ? error.message : '招待URLを確認できませんでした。';
    }
    if (version === this.inspectVersion) this.redraw();
  }

  private async join(event: Event): Promise<void> {
    event.preventDefault();
    if (this.joining || !this.config || !this.invitation) return;
    if (this.availability?.status !== 'open' && this.availability?.status !== 'full') return;
    const form = event.currentTarget as HTMLFormElement;
    const input = form.querySelector<HTMLInputElement>('input')!;
    const status = form.querySelector<HTMLElement>('#join-status')!;
    let session;
    try { session = prepareJoin(localStorage, this.config.url, this.invitation, input.value); }
    catch (error) {
      status.textContent = error instanceof Error && (error.message.includes('ニックネーム') || error.message.startsWith('前回'))
        ? error.message : 'ブラウザーに参加情報を保存できません。保存を許可してください。';
      input.setAttribute('aria-invalid', 'true'); input.focus(); return;
    }
    this.joining = true;
    this.joinError = '';
    this.redraw();
    try {
      const reply = await roomAction(this.config, 'join', this.invitation.roomId, { invitation: this.invitation, session });
      acceptReply(localStorage, this.config.url, session, reply);
      if (reply.status === 'ok') {
        this.connection = '参加中です。'; this.lastSuccess = Date.now(); this.terminal = '';
        window.location.hash = '/guide';
      } else {
        this.joinError = statusMessages[reply.status];
        this.availability = reply.status === 'membership_expired' ? { status: 'open' } : reply;
      }
    } catch {
      this.joinError = '参加結果を確認できません。同じ名前で再試行してください。参加枠は重複しません。';
    } finally { this.joining = false; this.redraw(); }
  }

  private async leave(): Promise<void> {
    const session = this.session();
    if (!session || !this.config) return;
    try { requestLeave(localStorage, this.config.url, session); }
    catch {
      const status = document.querySelector('#connection-status');
      if (status) status.textContent = '退出要求を保存できません。保存を許可してから再試行してください。';
      return;
    }
    this.redraw();
    if (this.syncPromise) await this.syncPromise;
    await this.sync();
  }

  private sync(): Promise<void> {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.performSync().finally(() => { this.syncPromise = null; });
    return this.syncPromise;
  }

  private async performSync(): Promise<void> {
    if (!this.config) return;
    try {
      const departing = pendingDepartures(localStorage, this.config.url);
      await Promise.all(departing.map((session) => this.syncSession(session)));
    } catch { /* 保存済み情報を読めない場合は操作時に案内する。 */ }
    const session = this.session();
    if (session?.snapshot && !session.pendingLeave) await this.syncSession(session);
  }

  private async syncSession(session: Session): Promise<void> {
    if (!this.config) return;
    try {
      const reply = await roomAction(this.config, session.pendingLeave ? 'leave' : 'heartbeat', session.membership.roomId, { session });
      const current = readSession(localStorage, this.config.url, session.membership.roomId);
      const active = this.session();
      if (!current || current.inactive || current.membership.participantId !== session.membership.participantId ||
          (!session.pendingLeave && (active?.membership.roomId !== session.membership.roomId || active.membership.participantId !== session.membership.participantId))) return;
      acceptReply(localStorage, this.config.url, current, reply);
      if (reply.status === 'ok') {
        this.lastSuccess = Date.now(); this.connection = '参加中です。';
      } else {
        this.terminal = statusMessages[reply.status];
        this.checkedHash = ''; this.redraw();
      }
    } catch {
      this.connection = Date.now() - this.lastSuccess >= 30000
        ? '通信が止まっています。5分以内なら同じ参加者として復帰できます。接続を再試行しています。'
        : '通信を再試行しています…';
    }
    const current = this.session();
    const element = document.querySelector('#connection-status');
    if (element) element.textContent = current?.pendingLeave
      ? '退出はまだ確定していません。通信が戻り次第、退出を送信します。' : this.connection;
  }
}

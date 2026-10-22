import type { BackendConfig } from './rooms';
import type { Session } from './membership';
import type { SharedLocation } from './domain';
import { activeSession, acceptReply, readSession, statusMessages } from './membership';
import { locationAction, locationFresh, validLocation } from './location';
import type { LocatedParticipant, LocationReply } from './location';
import type { FriendSource } from './friends-ui';

const html = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const key = (s: Session | null) => s ? `${s.membership.roomId}:${s.membership.participantId}` : '';

export class LocationUI {
  private session: Session | null = null;
  private generation = 0;
  private running = false;
  private enabling = false;
  private acquiring = false;
  private reading = false;
  private version = 0;
  private sharing = false;
  private ready = false;
  private serverTime = 0;
  private receivedAt = 0;
  private members: LocatedParticipant[] = [];
  private message = '';
  private lastFix: SharedLocation | null = null;
  private pending = new Map<string, Session>();
  private flushing = false;

  constructor(private config: BackendConfig | null) {
    window.setInterval(() => void this.tick(), 5000);
    window.setInterval(() => { this.syncScope(); this.paint(); }, 1000);
    window.addEventListener('online', () => void this.tick());
    window.addEventListener('storage', (event) => {
      if (event.key?.includes(':membership:') && event.oldValue && event.newValue) {
        try {
          const before = JSON.parse(event.oldValue) as Session, after = JSON.parse(event.newValue) as Session;
          if (key(before) === key(after) && before.pendingLeave === after.pendingLeave &&
            before.inactive === after.inactive && !!before.snapshot === !!after.snapshot) return;
        } catch { /* 保存状態の変化を確認する。 */ }
      } else if (event.key && !event.key.includes(':active-room') &&
        !event.key.includes(':membership:') && !event.key.startsWith(this.stopPrefix())) return;
      if (event.key === this.stopPrefix() + key(this.session) && event.newValue) this.halt();
      this.syncScope(); void this.tick();
    });
    document.addEventListener('visibilitychange', () => {
      // 背景では新規取得を止める。戻った時に新しい位置を取得する。
      if (document.hidden) {
        if (this.enabling) void this.stop('公開開始中に画面が非表示になったため停止しました。再開する場合はONを押してください。');
        else { this.generation++; this.acquiring = false; }
      }
      else void this.tick();
    });
  }

  private current(): Session | null {
    try { const s = this.config && activeSession(localStorage, this.config.url);
      return s?.snapshot && !s.pendingLeave ? s : null;
    } catch { return null; }
  }
  private stopPrefix(): string { return `syu-go:${this.config?.url}:location-stop:`; }
  private halt(): void {
    this.generation++; this.running = false; this.enabling = false; this.acquiring = false; this.lastFix = null;
  }
  private queueOff(s: Session): void {
    this.pending.set(key(s), s);
    try { localStorage.setItem(this.stopPrefix() + key(s), s.membership.roomId); }
    catch { this.message = '取得・送信は停止しました。削除要求を保存できないため、この画面を開いたまま接続を戻してください。'; }
  }
  private syncScope(): void {
    const next = this.current();
    if (key(next) === key(this.session)) return;
    if (this.session && (this.running || this.enabling)) this.queueOff(this.session);
    this.halt(); this.session = next; this.members = []; this.sharing = false;
    this.ready = false; this.reading = false; this.message = ''; this.serverTime = 0;
  }
  content(): string {
    this.syncScope();
    return `<section class="card" aria-labelledby="location-heading"><h2 id="location-heading">位置の共有</h2>
      <div id="location-controls" role="group" aria-label="位置公開の切り替え"><button id="location-start" class="button secondary" type="button" aria-pressed="false">ON</button>
      <button id="location-stop" class="button secondary" type="button" aria-pressed="true">OFF</button></div>
      <p id="location-status" role="status"></p>
      <details class="location-details"><summary>位置情報についての注意</summary>
      <p class="hint">ONにすると、現在位置をこのルームの参加者に共有します。約5秒ごとに更新し、移動履歴は保存しません。</p>
      <p class="hint">OFFにすると取得・送信を停止し、共有済みの位置を削除します。通信できない間は削除が未確定です。30秒更新されない位置は案内に使いません。</p>
      <p id="my-location" class="hint"></p>
      <ul id="location-members" class="participants-list" aria-label="位置の共有状況"></ul>
      <p class="hint">画面を閉じている間や背景での更新は保証されません。案内画面の友達モードで方向と距離を確認できます。</p></details></section>`;
  }
  guidance(): FriendSource | null {
    this.syncScope();
    if (!this.session || document.hidden) return null;
    return { self: this.running && this.sharing ? this.lastFix : null,
      selfId: this.session.membership.participantId, roomId: this.session.membership.roomId,
      members: this.members, serverTime: this.serverTime, elapsed: performance.now() - this.receivedAt };
  }
  mount(): void {
    this.syncScope();
    document.querySelector('#location-start')?.addEventListener('click', () => void this.start());
    document.querySelector('#location-stop')?.addEventListener('click', () => void this.stop());
    this.paint(); void this.tick();
  }
  private apply(reply: LocationReply): void {
    const replaced = this.running && reply.version !== this.version;
    this.version = reply.version!; this.sharing = reply.sharing!; this.ready = true;
    this.serverTime = Date.parse(reply.serverTime!); this.receivedAt = performance.now();
    this.members = reply.participants!;
    if (this.running && (replaced || !this.sharing || reply.status === 'conflict')) {
      this.halt(); this.message = 'ほかの操作で公開設定が変わりました。再開する場合はONを押してください。';
    }
  }
  private terminal(reply: LocationReply, session: Session): boolean {
    if (reply.status === 'ok' || reply.status === 'conflict') return false;
    if (reply.status === 'invalid_request') throw new Error('取得した位置が古いか、内容を確認できません。次の取得をお待ちください。');
    this.halt(); this.members = [];
    acceptReply(localStorage, this.config!.url, session, { status: reply.status });
    this.message = statusMessages[reply.status]; this.paint(); return true;
  }
  private async tick(): Promise<void> {
    this.syncScope(); await this.flushOff();
    const s = this.session;
    if (!s || !this.config || this.reading || this.enabling || this.pending.has(key(s))) { this.paint(); return; }
    const generation = this.generation; this.reading = true;
    try {
      const reply = await locationAction(this.config, s, 'read');
      if (generation !== this.generation || key(s) !== key(this.current())) return;
      if (!this.terminal(reply, s)) this.apply(reply);
    } catch { if (generation === this.generation) this.message = '位置の共有状況を確認できません。接続が戻り次第、再試行します。'; }
    finally { this.reading = false; this.paint(); }
    if (generation === this.generation && this.running) this.acquire();
  }
  private async start(): Promise<void> {
    this.syncScope(); const s = this.session;
    if (!s || !this.config || !this.ready || this.enabling || this.running || this.pending.has(key(s))) return;
    if (!window.isSecureContext || !navigator.geolocation) {
      this.message = 'このブラウザーでは位置情報を利用できません。HTTPSのURLをSafariやChromeで開いてください。'; this.paint(); return;
    }
    const generation = ++this.generation; this.enabling = true;
    this.message = '位置公開の準備中です。ブラウザーから確認が出たら位置情報の利用を許可してください。'; this.paint();
    try {
      const reply = await locationAction(this.config, s, 'enable', this.version);
      if (generation !== this.generation || key(s) !== key(this.current())) return;
      if (this.terminal(reply, s)) return;
      this.apply(reply);
      if (reply.status === 'conflict') { this.message = '公開設定が変わりました。もう一度ONを押してください。'; return; }
      this.running = true; this.message = '現在位置を取得しています…'; this.acquire();
    } catch {
      if (generation === this.generation) { this.queueOff(s); this.halt(); this.message = '公開開始を確認できません。取得を止め、公開OFFを再送します。'; void this.flushOff(); }
    } finally { if (generation === this.generation) this.enabling = false; this.paint(); }
  }
  private acquire(): void {
    const s = this.session;
    if (!s || !this.running || this.acquiring || document.hidden) return;
    this.acquiring = true;
    const generation = this.generation;
    const valid = () => generation === this.generation && key(s) === key(this.current()) && this.running;
    navigator.geolocation.getCurrentPosition((position) => {
      if (!valid()) return;
      const age = Date.now() - position.timestamp;
      if (!Number.isFinite(age) || age < -5000 || age >= 30000) {
        this.acquiring = false; this.message = '新しい位置を取得できませんでした。次の取得をお待ちください。'; this.paint(); return;
      }
      const location: SharedLocation = { latitude: position.coords.latitude, longitude: position.coords.longitude,
        accuracyMeters: position.coords.accuracy,
        updatedAt: new Date(this.serverTime + performance.now() - this.receivedAt - Math.max(0, age)).toISOString() };
      if (!validLocation(location)) {
        this.acquiring = false; this.message = '新しい位置を取得できませんでした。次の取得をお待ちください。'; this.paint(); return;
      }
      this.lastFix = location;
      void this.publish(s, location, generation).finally(() => { if (valid()) this.acquiring = false; });
    }, (error) => {
      if (!valid()) return;
      this.acquiring = false;
      if (error.code === 1) {
        void this.stop('位置情報が許可されていません。ブラウザーの設定で許可した後、ONを押してください。');
      } else {
        this.message = error.code === 3 ? '位置の取得がタイムアウトしました。約5秒ごとに再試行します。'
          : '現在位置を取得できません。端末の位置情報設定や電波状況を確認してください。再試行します。'; this.paint();
      }
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
  }
  private async publish(s: Session, location: SharedLocation, generation: number): Promise<void> {
    try {
      const reply = await locationAction(this.config!, s, 'publish', this.version, location);
      if (generation !== this.generation || key(s) !== key(this.current())) return;
      if (this.terminal(reply, s)) return;
      this.apply(reply);
      if (reply.status === 'ok') this.message = '位置公開ON：現在位置を共有しています。';
    } catch { if (generation === this.generation) this.message = '位置を送信できません。古い位置は30秒で案内対象から外れます。接続を再試行します。'; }
    this.paint();
  }
  private async stop(reason = ''): Promise<void> {
    const s = this.session; if (!s) return;
    this.queueOff(s); this.halt(); this.sharing = false; this.members = this.members.map((p) =>
      p.id === s.membership.participantId ? { ...p, locationSharing: false, location: null } : p);
    this.message = reason || '取得・送信は停止しました。共有済みの位置の削除を確認しています…'; this.paint();
    await this.flushOff();
  }
  private async flushOff(): Promise<void> {
    if (!this.config || this.flushing) return;
    this.flushing = true;
    try {
      try { for (let i = 0; i < localStorage.length; i++) {
        const name = localStorage.key(i);
        if (!name?.startsWith(this.stopPrefix())) continue;
        const s = readSession(localStorage, this.config.url, localStorage.getItem(name)!);
        if (s && name === this.stopPrefix() + key(s)) this.pending.set(key(s), s);
        else localStorage.removeItem(name);
      } } catch { /* メモリー内の停止要求は引き続き送信する。 */ }
      for (const [id, s] of this.pending) {
        try {
          const reply = await locationAction(this.config, s, 'disable');
          if (!['ok', 'ended', 'membership_expired', 'unauthorized', 'missing'].includes(reply.status)) continue;
          localStorage.removeItem(this.stopPrefix() + id); this.pending.delete(id);
          if (id === key(this.session)) {
            if (reply.status === 'ok') this.apply(reply);
            if (!this.message.includes('許可') && !this.message.includes('保存でき')) this.message = '位置公開OFF：共有済みの位置を削除しました。';
          }
        } catch {
          if (id === key(this.session)) this.message = '取得・送信は停止中です。共有済みの位置の削除は未確定です。接続が戻り次第、OFFを再送します。';
        }
      }
    } catch { /* 保存不可のときもメモリー内の停止要求は保持する。 */ }
    finally { this.flushing = false; this.paint(); }
  }
  private paint(): void {
    const status = document.querySelector<HTMLElement>('#location-status'); if (!status) return;
    const start = document.querySelector<HTMLButtonElement>('#location-start')!;
    const stop = document.querySelector<HTMLButtonElement>('#location-stop')!;
    const mine = document.querySelector<HTMLElement>('#my-location')!;
    const list = document.querySelector<HTMLElement>('#location-members')!;
    const elapsed = performance.now() - this.receivedAt;
    start.disabled = !this.session || !this.ready || this.running || this.enabling || this.pending.has(key(this.session));
    start.textContent = 'ON';
    start.setAttribute('aria-label',this.sharing && !this.running?'位置公開を再開する':'位置公開をONにする');
    stop.setAttribute('aria-label','位置公開をOFFにする');
    start.setAttribute('aria-pressed',String(this.running && this.sharing));
    stop.setAttribute('aria-pressed',String(!this.sharing && !this.enabling && !this.pending.has(key(this.session))));
    stop.disabled = !this.session || (!this.sharing && !this.running && !this.enabling && !this.pending.has(key(this.session)));
    status.textContent = !this.session ? 'ルームに参加すると位置を共有できます。' : this.message ||
      (!this.ready ? '共有設定を確認しています…' : this.sharing ? '位置公開ONです。再開ボタンを押すまで、この画面では位置を取得しません。' : '位置公開OFFです。位置は取得・送信しません。');
    mine.textContent = this.running && locationFresh(this.lastFix, this.serverTime, elapsed)
      ? `位置を更新しました。精度 約${Math.round(this.lastFix!.accuracyMeters!)}m　取得 ${new Date(this.lastFix!.updatedAt).toLocaleTimeString('ja-JP')}` : '';
    const markup = this.members.map((p) => `<li class="participant-row"><p class="participant-name">${html(p.nickname)}</p><p class="hint">${!p.locationSharing ? '位置非公開' : locationFresh(p.location, this.serverTime, elapsed) ? '位置を共有中' : '新しい位置を待っています（案内対象外）'}</p></li>`).join('');
    if (list.innerHTML !== markup) list.innerHTML = markup;
  }
}

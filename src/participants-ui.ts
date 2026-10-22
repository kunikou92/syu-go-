import type { BackendConfig } from './rooms';
import type { ParticipantSummary } from './domain';
import type { RoomStatus, Session } from './membership';
import { activeSession, acceptReply, statusMessages } from './membership';
import { fetchParticipants, participantOnline } from './participants';

const html = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export class ParticipantsUI {
  private scope = '';
  private members: ParticipantSummary[] = [];
  private serverTime = 0;
  private receivedAt = 0;
  private error = '';
  private pendingArrival: boolean | null = null;
  private updating = false;
  private inFlight: Promise<void> | null = null;

  constructor(private config: BackendConfig | null, private redraw: () => void,
    private onTerminal?: (status: RoomStatus) => void) {
    window.setInterval(() => { void this.refresh(); }, 5000);
    window.setInterval(() => this.paint(), 1000);
    window.addEventListener('online', () => void this.refresh());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void this.refresh(); });
  }

  private current(): Session | null {
    try {
      const session = this.config && activeSession(localStorage, this.config.url);
      return session?.snapshot && !session.pendingLeave ? session : null;
    } catch { return null; }
  }

  private key(session: Session | null): string {
    return session ? `${session.membership.roomId}:${session.membership.participantId}` : '';
  }

  private resetFor(session: Session | null): void {
    const key = this.key(session);
    if (key !== this.scope) {
      this.scope = key; this.members = []; this.serverTime = 0; this.receivedAt = 0;
      this.pendingArrival = null; this.error = '';
    }
  }

  content(): string {
    this.resetFor(this.current());
    return `<section class="card participants-card" aria-labelledby="participants-heading">
      <h2 id="participants-heading">参加者 <span id="participant-count"></span></h2>
      <p id="participants-status" class="hint" role="status"></p>
      <ul id="participants-list" class="participants-list" aria-label="参加者一覧"></ul>
      <div id="arrival-control"><button id="arrival-toggle" class="button" type="button" disabled>到着</button>
      <p class="hint">自分の到着状態を切り替えられます。</p></div></section>`;
  }

  mount(): void {
    document.querySelector('#arrival-toggle')?.addEventListener('click', () => void this.setArrival());
    this.paint();
    if (!this.receivedAt) void this.refresh();
  }

  private paint(): void {
    const list = document.querySelector<HTMLElement>('#participants-list');
    if (!list) return;
    const session = this.current(); this.resetFor(session);
    const status = document.querySelector<HTMLElement>('#participants-status')!;
    const count = document.querySelector<HTMLElement>('#participant-count')!;
    const button = document.querySelector<HTMLButtonElement>('#arrival-toggle')!;
    const control = document.querySelector<HTMLElement>('#arrival-control')!;
    control.hidden = !session;
    if (!session) { list.innerHTML = ''; count.textContent = ''; status.textContent = 'ルームに参加すると一覧を表示します。'; return; }
    const now = performance.now();
    const markup = this.members.map((member) => {
      const self = member.id === session.membership.participantId;
      const online = participantOnline(member, this.serverTime, now - this.receivedAt);
      return `<li class="participant-row"><p class="participant-name">${html(member.nickname)}${self ? '<span class="self-label">あなた</span>' : ''}</p>
        <div class="participant-states"><span class="state-pill ${member.arrived ? 'is-arrived' : ''}">${member.arrived ? '到着' : '未到着'}</span>
        <span class="state-pill ${online ? 'is-online' : ''}">${online ? 'オンライン' : 'オフライン'}</span>
        <span class="state-pill">位置公開${member.locationSharing ? 'ON' : 'OFF'}</span></div></li>`;
    }).join('');
    if (list.innerHTML !== markup) list.innerHTML = markup;
    count.textContent = this.members.length ? `（${this.members.length}/10人）` : '';
    status.textContent = this.error || (this.updating ? '到着状態を更新しています…' : this.receivedAt ? '約5秒ごとに更新しています。' : '参加者を確認しています…');
    const own = this.members.find((member) => member.id === session.membership.participantId);
    button.disabled = !own || this.updating;
    button.setAttribute('aria-pressed', String(own?.arrived ?? false));
    button.textContent = this.updating ? '更新しています…' : this.pendingArrival !== null ? '到着状態の更新を再試行' : own?.arrived ? '未到着に戻す' : '到着';
  }

  private refresh(arrived: boolean | null = null): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.load(arrived).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async load(arrived: boolean | null): Promise<void> {
    const session = this.current(); this.resetFor(session);
    if (!session || !this.config) { this.paint(); return; }
    const scope = this.key(session);
    try {
      const reply = await fetchParticipants(this.config, session, arrived);
      if (scope !== this.key(this.current())) return;
      if (reply.status !== 'ok') {
        acceptReply(localStorage, this.config.url, session, { status: reply.status });
        this.members = []; this.error = statusMessages[reply.status];
        this.onTerminal?.(reply.status);
        this.redraw(); return;
      }
      this.members = reply.participants!; this.serverTime = Date.parse(reply.serverTime!); this.receivedAt = performance.now();
      this.error = '';
      if (arrived !== null) this.pendingArrival = null;
    } catch {
      if (scope !== this.key(this.current())) return;
      this.error = arrived !== null
        ? '到着状態の変更を確認できませんでした。再試行してください。'
        : '最新の一覧を確認できません。接続が戻り次第、更新します。';
    }
    this.paint();
  }

  private async setArrival(): Promise<void> {
    const session = this.current();
    if (!session || this.updating) return;
    const own = this.members.find((member) => member.id === session.membership.participantId);
    if (!own) return;
    const scope = this.key(session);
    const target = this.pendingArrival ?? !own.arrived;
    this.pendingArrival = target; this.updating = true; this.paint();
    try {
      if (this.inFlight) await this.inFlight;
      if (scope === this.key(this.current())) await this.refresh(target);
    } finally { this.updating = false; this.paint(); }
  }
}

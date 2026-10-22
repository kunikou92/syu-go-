import type { SharedLocation } from './domain';
import type { LocatedParticipant } from './location';
import { locationFresh } from './location';
import { Compass } from './compass';
import { degrees, directionTo, distanceLabel, markerPositions } from './friends';

export interface FriendSource {
  self: SharedLocation | null; selfId: string; roomId: string; members: LocatedParticipant[];
  serverTime: number; elapsed: number;
}
const html = (v: string) => v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const text = (node: Element, value: string) => { if (node.textContent !== value) node.textContent = value; };
export class FriendsUI {
  private compass: Compass;
  constructor(private source: () => FriendSource | null, compass?: Compass) {
    this.compass = compass ?? new Compass(() => this.paint());
    window.setInterval(() => this.paint(), 250);
  }
  content(): string {
    return `<section class="card friends-card" aria-labelledby="friends-heading"><p class="eyebrow">FRIENDS</p>
      <h2 id="friends-heading">友達は、どっち？</h2><p class="hint">スマホを水平に持ってください。矢印は直線方向、距離は直線距離の目安です。</p>
      <button id="compass-start" class="button secondary" type="button">コンパスを有効にする・再試行</button>
      <p id="compass-status" class="hint" role="status"></p><p id="friends-status" role="status"></p>
      <div id="friends-radar" class="friends-radar" aria-hidden="true" hidden></div>
      <ol id="friends-list" class="friends-list" aria-label="友達の方向と距離"></ol>
      <p class="hint">番号は下の名前に対応します。重なる番号をずらしても、矢印が指す向きは変わりません。道路や障害物に沿った経路案内ではありません。</p></section>`;
  }
  mount(): void {
    document.querySelector('#compass-start')?.addEventListener('click', () => void this.compass.start());
    this.paint();
  }
  paint(): void {
    const list = document.querySelector<HTMLElement>('#friends-list'); if (!list) return;
    const radar = document.querySelector<HTMLElement>('#friends-radar')!;
    const status = document.querySelector<HTMLElement>('#friends-status')!;
    text(document.querySelector('#compass-status')!, this.compass.status());
    (document.querySelector('#compass-start') as HTMLButtonElement).disabled = this.compass.busy();
    const source = this.source(), heading = this.compass.heading();
    const own = source && locationFresh(source.self, source.serverTime, source.elapsed) ? source.self : null;
    const friends = own && source ? source.members.filter(p => p.id !== source.selfId && p.roomId === source.roomId &&
      p.locationSharing && locationFresh(p.location, source.serverTime, source.elapsed)).map(p => ({
        ...p, ...directionTo(own, p.location!),
      })) : [];
    text(status, !source ? 'ルームに参加すると友達を案内できます。' : !own
      ? '自分の新しい位置が必要です。「位置の共有」をONにするか、位置の更新をお待ちください。'
      : !friends.length ? '今は案内できる友達がいません。友達の参加・位置公開・位置の更新をお待ちください。'
      : heading === null ? `${friends.length}人の距離を表示しています。方角を取得すると矢印を表示します。` : `${friends.length}人の方向と距離を表示しています。`);
    const arrows = friends.filter(p => heading !== null && p.bearing !== null);
    const angles = arrows.map(p => degrees(p.bearing! - heading!)), positions = markerPositions(angles);
    radar.hidden = !arrows.length;
    const radarMarkup = `<span class="radar-forward">前</span><span class="radar-self">あなた</span>` + arrows.map((p, i) =>
      `<span class="friend-marker" style="left:calc(50% + ${positions[i].x.toFixed(2)}px);top:calc(50% + ${positions[i].y.toFixed(2)}px)"><b>${friends.indexOf(p) + 1}</b><span class="friend-arrow" style="transform:rotate(${angles[i].toFixed(2)}deg)">↑</span></span>`).join('');
    if (radar.innerHTML !== radarMarkup) radar.innerHTML = radarMarkup;
    const markup = friends.map((p, i) => {
      const angle = heading !== null && p.bearing !== null ? degrees(p.bearing - heading) : null;
      return `<li class="friend-row"><span class="friend-number">${i + 1}</span><div><p class="participant-name">${html(p.nickname)}</p><p class="friend-distance">${distanceLabel(p.distance)}</p>
        <p class="hint">${p.bearing === null ? p.distance < 1 ? 'すぐ近くです。方角は表示しません。' : '方角を確定できません。' : angle === null ? '方角の取得待ち' : `画面の上から時計回りに約${Math.round(angle) % 360}°`}
        ${p.distance < (own!.accuracyMeters ?? 0) + (p.location!.accuracyMeters ?? 0) ? ' 位置の誤差が距離より大きい可能性があります。' : ''}</p></div>
        ${angle === null ? '' : `<span class="friend-row-arrow" role="img" aria-label="${html(p.nickname)}の方向：画面の上から時計回りに約${Math.round(angle) % 360}度" style="transform:rotate(${angle.toFixed(2)}deg)">↑</span>`}</li>`;
    }).join('');
    if (list.innerHTML !== markup) list.innerHTML = markup;
  }
}

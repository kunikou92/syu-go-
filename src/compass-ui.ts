import { Compass } from './compass';

/** 両案内モードが同じ端末内の方角設定を利用する。 */
export class CompassUI {
  constructor(private compass: Compass) {
    window.setInterval(() => this.paint(), 250);
  }
  content(): string {
    return `<div class="heading-settings">
      <button id="heading-manual" class="button secondary" type="button" aria-controls="heading-adjustment" aria-expanded="false">手動で方角を調整する</button>
      <div id="heading-adjustment" hidden>
        <p class="hint">コンパスが使えない・方向がずれる場合は、手動で指定できます。友達モードとピンモードの両方に反映します。</p>
        <p id="heading-help" class="hint">地図や目印で方角を確かめ、画面の上が向いている方角を選んでください。0°は北、90°は東、180°は南、270°は西です。スマホを向け直したら再調整してください。</p>
        <div class="heading-presets" role="group" aria-label="画面の上が向いている方角">
          ${[['北',0],['東',90],['南',180],['西',270]].map(([name,angle]) => `<button class="button secondary" type="button" data-heading="${angle}">${name}</button>`).join('')}
        </div>
        <label for="heading-angle">北から時計回りの角度 <output id="heading-value" for="heading-angle">未設定</output></label>
        <input id="heading-angle" type="range" min="0" max="359" step="1" value="0" aria-describedby="heading-help">
        <div class="heading-steps"><button id="heading-left" class="button secondary" type="button">−15°</button><button id="heading-right" class="button secondary" type="button">＋15°</button></div>
        <button id="heading-auto" class="button" type="button">自動取得に戻す</button>
        <p id="heading-status" class="hint" role="status"></p>
      </div>
    </div>`;
  }
  mount(): void {
    document.querySelector('#heading-manual')?.addEventListener('click', () => this.compass.useManual());
    document.querySelector('#heading-auto')?.addEventListener('click', () => void this.compass.start());
    document.querySelectorAll<HTMLButtonElement>('[data-heading]').forEach(button => button.addEventListener('click', () => this.compass.setManual(Number(button.dataset.heading))));
    document.querySelector<HTMLInputElement>('#heading-angle')?.addEventListener('input', event => this.compass.setManual(Number((event.target as HTMLInputElement).value)));
    for (const [id,delta] of [['heading-left',-15],['heading-right',15]] as const)
      document.querySelector(`#${id}`)?.addEventListener('click', () => this.compass.setManual((this.compass.heading() ?? 0) + delta));
    this.paint();
  }
  paint(): void {
    const root = document.querySelector('#heading-adjustment'); if (!root) return;
    const manual = this.compass.isManual(), heading = this.compass.heading();
    (root as HTMLElement).hidden = !manual;
    (document.querySelector('#heading-manual') as HTMLButtonElement).hidden = manual;
    document.querySelector('#heading-manual')!.setAttribute('aria-expanded', String(manual));
    const status = document.querySelector('#heading-status')!;
    const message = this.compass.status(); if (status.textContent !== message) status.textContent = message;
    const output = document.querySelector('#heading-value')!;
    const value = heading === null ? '未設定' : `${Math.round(heading)}°`;
    if (output.textContent !== value) output.textContent = value;
    const slider = document.querySelector<HTMLInputElement>('#heading-angle')!;
    // スライダーのドラッグやキーボード操作を再描画で中断しない。
    if (document.activeElement !== slider) slider.value = String(Math.round(heading ?? 0) % 360);
    slider.setAttribute('aria-valuetext', heading === null ? '未設定。方角を指定してください' : value);
    document.querySelectorAll<HTMLButtonElement>('[data-heading]').forEach(button => button.setAttribute('aria-pressed', String(manual && heading === Number(button.dataset.heading))));
  }
}

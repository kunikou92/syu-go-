import { compassHeading } from './friends';
import type { CompassReading } from './friends';

type OrientationAPI = typeof DeviceOrientationEvent & { requestPermission?: (absolute?: boolean) => Promise<string> };
export class Compass {
  private enabled = false;
  private requesting = false;
  private value: number | null = null;
  private at = 0;
  private message = 'スマホを水平に持ち、コンパスを有効にしてください。';
  constructor(private changed: () => void) {
    const read = (event: Event) => {
      if (!this.enabled || document.hidden) return;
      const reading = event as DeviceOrientationEvent & CompassReading;
      if (!reading.absolute && reading.webkitCompassHeading === undefined) return;
      const angle = window.screen.orientation?.angle ?? (window as Window & { orientation?: number }).orientation ?? 0;
      this.value = compassHeading(reading, angle);
      this.at = performance.now();
      this.message = this.value === null ? '方角を確認できません。端末を水平に持ち、磁気の強い物から離してください。' : '画面の上が、スマホを向けている方向です。';
      this.changed();
    };
    window.addEventListener('deviceorientation', read);
    window.addEventListener('deviceorientationabsolute', read);
    const reset = () => { this.value = null; if (this.enabled) this.message = '方角を待っています。スマホを水平に持ってください。'; this.changed(); };
    window.screen.orientation?.addEventListener('change', reset);
    window.addEventListener('orientationchange', reset);
    document.addEventListener('visibilitychange', reset);
  }
  heading(): number | null {
    return !document.hidden && this.value !== null && performance.now() - this.at < 5000 ? this.value : null;
  }
  status(): string {
    return this.enabled && this.value !== null && this.heading() === null
      ? 'コンパスの更新が止まっています。端末を水平に持ってください。' : this.message;
  }
  busy(): boolean { return this.requesting; }
  async start(): Promise<void> {
    if (this.requesting) return;
    const api = window.DeviceOrientationEvent as OrientationAPI | undefined;
    if (!window.isSecureContext || !api) {
      this.message = 'この端末ではコンパスを利用できません。HTTPS版をスマホのSafariやChromeで開いてください。'; this.changed(); return;
    }
    this.requesting = true;
    try {
      // iPhoneの許可要求はボタン操作から直接呼ぶ。
      const permission = api.requestPermission ? await api.requestPermission(true) : 'granted';
      this.enabled = permission === 'granted'; this.value = null;
      this.message = this.enabled ? '方角を待っています。スマホを水平に持ってください。'
        : 'コンパスが許可されていません。ブラウザーの設定を確認して再試行してください。';
    } catch { this.enabled = false; this.value = null; this.message = 'コンパスを開始できません。ブラウザーの設定を確認して再試行してください。'; }
    finally { this.requesting = false; this.changed(); }
  }
}

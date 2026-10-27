export interface MapPoint { lat: number; lng: number }
export interface MapListener { remove(): void }
export interface MapView {
  addListener(name: string, callback: (event: MapClick) => void): MapListener;
  panTo(point: MapPoint): void;
}
export interface MapClick { latLng?: { lat(): number; lng(): number }; stop?(): void }
export interface MapMarker {
  map: MapView | null; position: MapPoint | null; title: string;
  addListener(name: string, callback: (event: MapClick) => void): MapListener;
  append(node: Node): void;
}
export interface MapsSDK {
  Map: new (element: HTMLElement, options: Record<string, unknown>) => MapView;
  marker: { AdvancedMarkerElement: new (options: Record<string, unknown>) => MapMarker };
  event: { trigger(instance: MapView, name: string): void; clearInstanceListeners(instance: MapView | MapMarker): void };
}
type MapWindow = Window & {
  google?: { maps?: MapsSDK }; syuGoMapsReady?: () => void; gm_authFailure?: () => void;
};
export const MAP_ERROR_EVENT = 'syu-go-google-map-error';
export interface GoogleMapsConfig { apiKey: string; mapId: string }
export function googleMapsKey(value: string): string {
  const key = value.trim();
  if (!/^AIza[\w-]{35}$/.test(key)) throw new Error('地図の設定を確認できません。管理者にお問い合わせください。');
  return key;
}
export function googleMapsConfig(apiKey?: string, mapId?: string): GoogleMapsConfig | null {
  try {
    const id = mapId?.trim() ?? '';
    if (!/^[\w-]{1,128}$/.test(id) || id === 'DEMO_MAP_ID') return null;
    return { apiKey: googleMapsKey(apiKey ?? ''), mapId: id };
  } catch { return null; }
}
export function validPoint(point: MapPoint): boolean {
  return Number.isFinite(point.lat) && Math.abs(point.lat) <= 90 && Number.isFinite(point.lng) && Math.abs(point.lng) <= 180;
}
let loading: Promise<MapsSDK> | null = null;
let loadedKey = '';
/** SDKは1ページで1回だけ読み込む。キーの変更は再読み込み後に適用する。 */
export function loadGoogleMaps(key: string): Promise<MapsSDK> {
  key = googleMapsKey(key);
  if (loadedKey && loadedKey !== key) return Promise.reject(new Error('地図のキーを変更しました。画面を再読み込みしてください。'));
  if (loading) return loading;
  loadedKey = key;
  const w = window as MapWindow;
  loading = new Promise<MapsSDK>((resolve, reject) => {
    const script = document.createElement('script');
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; window.clearTimeout(timeout);
      if (error) { script.remove(); loading = null; reject(error); }
      else if (w.google?.maps?.Map && w.google.maps.marker?.AdvancedMarkerElement) resolve(w.google.maps);
      else { loading = null; reject(new Error('地図を開始できませんでした。画面を再読み込みして再試行してください。')); }
    };
    const timeout = window.setTimeout(() => finish(new Error('地図の読み込みがタイムアウトしました。接続を確認して再試行してください。')),20000);
    w.syuGoMapsReady = () => finish();
    w.gm_authFailure = () => {
      const message = '地図を利用できません。利用上限に達したか、地図の設定に問題がある可能性があります。時間をおいて再度お試しください。';
      window.dispatchEvent(new CustomEvent(MAP_ERROR_EVENT,{detail:message})); finish(new Error(message));
    };
    script.async = true;
    script.src = 'https://maps.googleapis.com/maps/api/js?' + new URLSearchParams({
      key, loading:'async', callback:'syuGoMapsReady', libraries:'marker', v:'weekly', language:'ja', region:'JP', auth_referrer_policy:'origin',
    });
    script.onerror = () => finish(new Error('地図に接続できません。接続が戻ったら再試行してください。'));
    document.head.append(script);
  });
  return loading;
}

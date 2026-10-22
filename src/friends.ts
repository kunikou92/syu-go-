import type { Coordinates } from './domain';

export const degrees = (n: number): number => ((n % 360) + 360) % 360;
const rad = (n: number) => n * Math.PI / 180;
/** 球面上の最短距離と初期方位。ほぼ同一点・対蹠点では方位を確定しない。 */
export function directionTo(from: Coordinates, to: Coordinates): { distance: number; bearing: number | null } {
  const a = rad(from.latitude), b = rad(to.latitude), delta = rad(to.longitude - from.longitude);
  const h = Math.sin((b - a) / 2) ** 2 + Math.cos(a) * Math.cos(b) * Math.sin(delta / 2) ** 2;
  const distance = 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
  const y = Math.sin(delta) * Math.cos(b), x = Math.cos(a) * Math.sin(b) - Math.sin(a) * Math.cos(b) * Math.cos(delta);
  return { distance, bearing: distance < 1 || Math.hypot(x, y) < 1e-12 ? null : degrees(Math.atan2(y, x) * 180 / Math.PI) };
}
export const distanceLabel = (m: number): string => m < 1 ? '1m未満' : m < 1000 ? `約${Math.round(m)}m` : `約${(m / 1000).toFixed(1)}km`;

export interface CompassReading {
  alpha: number | null; beta: number | null; gamma: number | null; absolute: boolean;
  webkitCompassHeading?: number; webkitCompassAccuracy?: number;
}
/** 画面を水平に持つ運用。相対alphaを北基準と誤認しない。 */
export function compassHeading(event: CompassReading, screenAngle: number): number | null {
  if (event.beta === null || event.gamma === null || !Number.isFinite(event.beta) || !Number.isFinite(event.gamma) ||
    Math.abs(event.beta) > 30 || Math.abs(event.gamma) > 30) return null;
  if (typeof event.webkitCompassHeading === 'number' && Number.isFinite(event.webkitCompassHeading) &&
    event.webkitCompassHeading >= 0 && event.webkitCompassHeading <= 360) {
    const accuracy = event.webkitCompassAccuracy;
    if (accuracy !== undefined && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 50)) return null;
    return degrees(event.webkitCompassHeading + screenAngle);
  }
  return event.absolute && event.alpha !== null && Number.isFinite(event.alpha)
    ? degrees(360 - event.alpha + screenAngle) : null;
}

/** 番号マーカーをずらす。矢印そのものの角度は変えない。 */
export function markerPositions(angles: number[]): { x: number; y: number }[] {
  const placed: { x: number; y: number }[] = [];
  for (const angle of angles) {
    let selected = { x: 0, y: 0 }, best = -Infinity;
    for (const offset of [0, 20, -20, 40, -40, 60, -60, 80, -80, 100, -100, 120, -120, 160, 180]) {
      for (const radius of [100, 60]) {
        const p = { x: Math.sin(rad(angle + offset)) * radius, y: -Math.cos(rad(angle + offset)) * radius };
        const clearance = Math.min(1000, ...placed.map(q => Math.hypot(p.x - q.x, p.y - q.y)));
        const score = (clearance >= 38 ? 1000 : clearance) - Math.abs(offset) * .1 - (100 - radius) * .01;
        if (score > best) { best = score; selected = p; }
      }
    }
    placed.push(selected);
  }
  return placed;
}

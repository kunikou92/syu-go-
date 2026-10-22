import type { Pin } from './domain';
import type { BackendConfig } from './rooms';
import type { RoomStatus, Session } from './membership';

export interface SharedPin extends Pin { version: number }
export interface PinChange {
  action: 'create' | 'update' | 'delete' | 'main'; requestId: string; pinId: string;
  name?: string; latitude?: number; longitude?: number; version?: number;
}
export interface PinReply {
  status: RoomStatus | 'conflict' | 'pin_missing'; revision?: number; mainPinId?: string | null; pins?: SharedPin[];
}
export function pinFields(name: string, latitude: string, longitude: string): { name: string; latitude: number; longitude: number } {
  const clean = name.trim();
  if (!clean || [...clean].length > 40 || /[\u0000-\u001f\u007f-\u009f]/u.test(clean)) throw new Error('地点名を1〜40文字で入力してください。');
  const lat = Number(latitude), lng = Number(longitude);
  if (!latitude.trim() || !longitude.trim() || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    throw new Error('緯度は−90〜90、経度は−180〜180で入力してください。');
  return { name: clean, latitude: lat, longitude: lng };
}
export async function pinAction(config: BackendConfig, session: Session, change: PinChange | null = null,
  request: typeof fetch = fetch): Promise<PinReply> {
  const response = await request(`${config.url}/rest/v1/rpc/room_pins`, {
    method: 'POST', headers: { apikey: config.publicKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_action: change?.action ?? 'read', p_room_id: session.membership.roomId,
      p_participant_id: session.membership.participantId, p_resume_token: session.membership.resumeToken,
      p_request_id: change?.requestId ?? null, p_pin_id: change?.pinId ?? null, p_name: change?.name ?? null,
      p_latitude: change?.latitude ?? null, p_longitude: change?.longitude ?? null, p_version: change?.version ?? null }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('集合地点を更新できませんでした。');
  const reply = await response.json() as PinReply;
  if (['unauthorized','missing','ended','membership_expired','invalid_request'].includes(reply.status)) return reply;
  if (!['ok','conflict','pin_missing'].includes(reply.status) || !Number.isSafeInteger(reply.revision) || reply.revision! < 0 ||
    !Array.isArray(reply.pins) || new Set(reply.pins.map(p => p.id)).size !== reply.pins.length ||
    (reply.pins.length === 0 ? reply.mainPinId !== null : !reply.pins.some(p => p.id === reply.mainPinId)) ||
    reply.pins.some(p => typeof p.id !== 'string' || p.roomId !== session.membership.roomId || typeof p.name !== 'string' ||
      !p.name.trim() || [...p.name].length > 40 || !Number.isFinite(p.latitude) || Math.abs(p.latitude) > 90 ||
      !Number.isFinite(p.longitude) || Math.abs(p.longitude) > 180 || !Number.isSafeInteger(p.version) || p.version < 1 ||
      !Number.isFinite(Date.parse(p.createdAt)) || !Number.isFinite(Date.parse(p.updatedAt)))) throw new Error('集合地点の内容を確認できませんでした。');
  return reply;
}

import type { SharedLocation } from './domain';
import type { Session, RoomStatus } from './membership';
import type { BackendConfig } from './rooms';

export interface LocatedParticipant {
  id: string; roomId: string; nickname: string; locationSharing: boolean; location: SharedLocation | null;
}
export interface LocationReply {
  status: RoomStatus | 'conflict'; serverTime?: string; version?: number;
  sharing?: boolean; participants?: LocatedParticipant[];
}
export const locationFresh = (location: SharedLocation | null, serverTime: number, elapsed: number): boolean =>
  !!location && serverTime + Math.max(0, elapsed) - Date.parse(location.updatedAt) < 30000;

export function validLocation(value: SharedLocation): boolean {
  return Number.isFinite(value.latitude) && Math.abs(value.latitude) <= 90 &&
    Number.isFinite(value.longitude) && Math.abs(value.longitude) <= 180 &&
    typeof value.accuracyMeters === 'number' && Number.isFinite(value.accuracyMeters) &&
    value.accuracyMeters >= 0 && value.accuracyMeters <= 10000000 && Number.isFinite(Date.parse(value.updatedAt));
}

export async function locationAction(config: BackendConfig, session: Session,
  action: 'read' | 'enable' | 'disable' | 'publish', version: number | null = null,
  location: SharedLocation | null = null, request: typeof fetch = fetch): Promise<LocationReply> {
  const response = await request(`${config.url}/rest/v1/rpc/room_location`, {
    method: 'POST', headers: { apikey: config.publicKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_action: action, p_room_id: session.membership.roomId,
      p_participant_id: session.membership.participantId, p_resume_token: session.membership.resumeToken,
      p_version: version, p_latitude: location?.latitude ?? null, p_longitude: location?.longitude ?? null,
      p_accuracy: location?.accuracyMeters ?? null, p_observed_at: location?.updatedAt ?? null }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('位置情報を更新できませんでした。');
  const reply = await response.json() as LocationReply;
  if (['unauthorized', 'missing', 'ended', 'membership_expired', 'invalid_request'].includes(reply.status)) return reply;
  if (!['ok', 'conflict'].includes(reply.status) || !Number.isFinite(Date.parse(reply.serverTime ?? '')) ||
    !Number.isSafeInteger(reply.version) || reply.version! < 0 || typeof reply.sharing !== 'boolean' ||
    !Array.isArray(reply.participants) || reply.participants.length > 10 ||
    !reply.participants.some((p) => p.id === session.membership.participantId) ||
    new Set(reply.participants.map((p) => p.id)).size !== reply.participants.length ||
    reply.participants.some((p) => typeof p.id !== 'string' || p.roomId !== session.membership.roomId ||
      typeof p.nickname !== 'string' || typeof p.locationSharing !== 'boolean' ||
      (p.location !== null && (!p.locationSharing || !validLocation(p.location))))) {
    throw new Error('位置情報の内容を確認できませんでした。');
  }
  return reply;
}

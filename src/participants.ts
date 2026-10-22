import type { ParticipantSummary } from './domain';
import type { BackendConfig } from './rooms';
import type { RoomStatus, Session } from './membership';

export interface ParticipantReply {
  status: RoomStatus;
  serverTime?: string;
  participants?: ParticipantSummary[];
}

export async function fetchParticipants(config: BackendConfig, session: Session, arrived: boolean | null = null,
  request: typeof fetch = fetch): Promise<ParticipantReply> {
  const response = await request(`${config.url}/rest/v1/rpc/room_participants`, {
    method: 'POST', headers: { apikey: config.publicKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_room_id: session.membership.roomId, p_participant_id: session.membership.participantId,
      p_resume_token: session.membership.resumeToken, p_arrived: arrived }), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('参加者一覧を更新できませんでした。');
  const reply = await response.json() as ParticipantReply;
  if (['unauthorized', 'missing', 'ended', 'membership_expired'].includes(reply.status)) return reply;
  if (reply.status !== 'ok' || !Number.isFinite(Date.parse(reply.serverTime ?? '')) ||
      !Array.isArray(reply.participants) || reply.participants.length > 10 ||
      !reply.participants.some((member) => member.id === session.membership.participantId) ||
      new Set(reply.participants.map((member) => member.id)).size !== reply.participants.length ||
      reply.participants.some((member) => typeof member.id !== 'string' || member.roomId !== session.membership.roomId ||
        typeof member.nickname !== 'string' || typeof member.arrived !== 'boolean' || typeof member.online !== 'boolean' ||
        typeof member.locationSharing !== 'boolean' || !Number.isFinite(Date.parse(member.lastSeenAt)))) {
    throw new Error('参加者一覧の内容を確認できませんでした。');
  }
  return reply;
}

export function participantOnline(member: ParticipantSummary, serverTimeMs: number, elapsedMs: number): boolean {
  return serverTimeMs + Math.max(0, elapsedMs) - Date.parse(member.lastSeenAt) < 30000;
}

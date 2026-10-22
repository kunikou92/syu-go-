import type { LocalMembership, RoomInvitation } from './domain';
import type { BackendConfig, CreatedRoom } from './rooms';
import { newIntent, normalizeNickname } from './rooms.ts';

export type RoomStatus = 'ok' | 'open' | 'full' | 'missing' | 'ended' | 'invalid_invitation' |
  'unauthorized' | 'membership_expired' | 'invalid_nickname' | 'invalid_request' | 'left';
export interface RoomReply extends Partial<CreatedRoom> { status: RoomStatus; expiresAt?: string }
export interface Session {
  membership: LocalMembership;
  snapshot: CreatedRoom | null;
  nickname: string;
  pendingLeave: boolean;
  inactive: boolean;
}
export const statusMessages: Record<RoomStatus, string> = {
  ok: '参加しています。', open: 'ニックネームを設定して参加できます。',
  full: 'このルームは満員です（最大10人）。時間をおいて再確認してください。',
  missing: 'このルームは見つかりません。招待URLを確認してください。',
  ended: 'このルームは終了しました。新しいルームを作成してください。',
  invalid_invitation: '招待URLが正しくありません。友達にURLを確認してください。',
  unauthorized: '参加情報を確認できません。招待URLから参加し直してください。',
  membership_expired: '最後の通信から5分が経過したか、すでに退出しています。招待URLから参加し直せます。',
  invalid_nickname: 'ニックネームを1〜20文字で入力してください。',
  invalid_request: '操作を確認できません。画面を開き直してください。', left: 'ルームから退出しました。',
};

export function parseInvitation(hash: string): RoomInvitation | null {
  const [path, query] = hash.replace(/^#/, '').split('?');
  if (path !== '/join' || !query) return null;
  const params = new URLSearchParams(query);
  const roomId = params.get('room') ?? '';
  const token = params.get('invite') ?? '';
  if (params.getAll('room').length !== 1 || params.getAll('invite').length !== 1 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(roomId) ||
      !/^[a-f0-9]{64}$/.test(token)) return null;
  return { roomId, token };
}

export async function roomAction(config: BackendConfig, action: 'inspect' | 'join' | 'heartbeat' | 'leave',
  roomId: string, options: { invitation?: RoomInvitation; session?: Session } = {}, request: typeof fetch = fetch): Promise<RoomReply> {
  let response;
  try {
    response = await request(`${config.url}/rest/v1/rpc/room_action`, {
      method: 'POST', headers: { apikey: config.publicKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_action: action, p_room_id: roomId,
        p_invite: options.invitation?.token ?? null,
        p_participant_id: options.session?.membership.participantId ?? null,
        p_resume_token: options.session?.membership.resumeToken ?? null,
        p_nickname: options.session?.nickname ?? null }), signal: AbortSignal.timeout(15000),
    });
  } catch { throw new Error('通信できません。接続が戻ったら自動で再試行します。'); }
  if (!response.ok) throw new Error('サーバーに接続できません。時間をおいて再試行してください。');
  const reply = await response.json() as RoomReply;
  if (!Object.hasOwn(statusMessages, reply.status)) throw new Error('ルームの状態を確認できませんでした。');
  if (reply.status === 'ok' && (!reply.room || reply.room.id !== roomId || !reply.participant ||
      reply.participant.id !== options.session?.membership.participantId || reply.participant.roomId !== roomId ||
      reply.invitation?.roomId !== roomId || !/^[a-f0-9]{64}$/.test(reply.invitation.token))) {
    throw new Error('参加結果を確認できませんでした。再試行してください。');
  }
  return reply;
}

const sessionKey = (scope: string, roomId: string) => `syu-go:${scope}:membership:${roomId}`;
export function readSession(storage: Storage, scope: string, roomId: string): Session | null {
  const raw = storage.getItem(sessionKey(scope, roomId));
  if (raw) return JSON.parse(raw) as Session;
  // タスク3で作成済みのルームの保存形式から移行する。
  const legacy = storage.getItem(`syu-go:${scope}:created:${roomId}`);
  if (!legacy) return null;
  const saved = JSON.parse(legacy) as CreatedRoom & { membership: LocalMembership };
  return { membership: saved.membership, snapshot: saved, nickname: saved.participant.nickname, pendingLeave: false, inactive: false };
}

export function writeSession(storage: Storage, scope: string, session: Session): void {
  storage.setItem(sessionKey(scope, session.membership.roomId), JSON.stringify(session));
  if (!session.inactive) storage.setItem(`syu-go:${scope}:active-room`, session.membership.roomId);
}

export function activeSession(storage: Storage, scope: string): Session | null {
  const id = storage.getItem(`syu-go:${scope}:active-room`) ?? storage.getItem(`syu-go:${scope}:latest-created`);
  const session = id && readSession(storage, scope, id);
  return session && !session.inactive ? session : null;
}

export function prepareJoin(storage: Storage, scope: string, invitation: RoomInvitation, value: string): Session {
  const nickname = normalizeNickname(value);
  const previous = readSession(storage, scope, invitation.roomId);
  if (previous && !previous.inactive) {
    if (previous.pendingLeave) throw new Error('前回の退出を確認しています。通信が戻るまでお待ちください。');
    if (previous.nickname !== nickname) throw new Error('前回と同じニックネームで再試行してください。');
    return previous;
  }
  const intent = newIntent(nickname);
  const session: Session = { membership: { roomId: invitation.roomId, participantId: intent.roomId,
    resumeToken: intent.resumeToken }, nickname, snapshot: null, inactive: false, pendingLeave: false };
  writeSession(storage, scope, session);
  return session;
}

export function acceptReply(storage: Storage, scope: string, session: Session, reply: RoomReply): Session {
  if (reply.status === 'ok') session = { ...session, snapshot: reply as CreatedRoom };
  if (['ended', 'membership_expired', 'unauthorized', 'missing', 'left'].includes(reply.status)) {
    session = { ...session, inactive: true, pendingLeave: false, snapshot: null };
  }
  writeSession(storage, scope, session);
  return session;
}

/** 退出要求を永続化してから通信する。応答消失・再読込後もheartbeatより退出を優先する。 */
export function requestLeave(storage: Storage, scope: string, session: Session): Session {
  const leaving = { ...session, pendingLeave: true };
  writeSession(storage, scope, leaving);
  return leaving;
}

export function pendingDepartures(storage: Storage, scope: string): Session[] {
  const prefix = `syu-go:${scope}:membership:`;
  const sessions: Session[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const session = readSession(storage, scope, key.slice(prefix.length));
    if (session && !session.inactive && session.pendingLeave) sessions.push(session);
  }
  return sessions;
}

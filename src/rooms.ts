import type { LocalMembership, Participant, Room, RoomInvitation } from './domain';

export interface BackendConfig { url: string; publicKey: string }
export interface CreationIntent { roomId: string; resumeToken: string; nickname: string; startedAt: number }
export interface CreatedRoom {
  room: Room;
  participant: Participant;
  invitation: RoomInvitation;
}
export interface SavedCreation extends CreatedRoom { membership: LocalMembership }

export const NICKNAME_MAX_LENGTH = 20;

export function normalizeNickname(value: string): string {
  const nickname = value.trim();
  if (!nickname) throw new Error('ニックネームを入力してください。');
  if (Array.from(nickname).length > NICKNAME_MAX_LENGTH) {
    throw new Error(`ニックネームは${NICKNAME_MAX_LENGTH}文字以内にしてください。`);
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(nickname)) {
    throw new Error('ニックネームに改行や制御文字は使えません。');
  }
  return nickname;
}

export function backendConfig(url: string | undefined, publicKey: string | undefined): BackendConfig | null {
  if (!url?.trim() || !publicKey?.trim()) return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    // 秘密キーを誤って画面に埋め込まない。新形式の公開キーと従来のanon JWTだけを受け付ける。
    const key = publicKey.trim();
    const legacyPayload = key.split('.')[1];
    const legacyAnon = legacyPayload && (() => {
      try { return JSON.parse(atob(legacyPayload.replace(/-/g, '+').replace(/_/g, '/'))).role === 'anon'; }
      catch { return false; }
    })();
    if (!key.startsWith('sb_publishable_') && !legacyAnon) return null;
    return { url: parsed.origin, publicKey: key };
  } catch { return null; }
}

export function newIntent(nickname: string): CreationIntent {
  return {
    roomId: crypto.randomUUID(),
    resumeToken: Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join(''),
    nickname: normalizeNickname(nickname),
    startedAt: Date.now(),
  };
}

export async function createRoom(config: BackendConfig, intent: CreationIntent, request: typeof fetch = fetch): Promise<CreatedRoom> {
  let response: Response;
  try {
    response = await request(`${config.url}/rest/v1/rpc/create_room`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: config.publicKey },
      body: JSON.stringify({ p_room_id: intent.roomId, p_resume_token: intent.resumeToken, p_nickname: normalizeNickname(intent.nickname) }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('通信を確認して、同じ名前でもう一度お試しください。再試行してもルームは重複しません。');
  }
  if (!response.ok) {
    throw new Error('ルームを作成できませんでした。接続設定を確認するか、時間をおいて再試行してください。');
  }
  const result = await response.json() as CreatedRoom;
  if (result.room?.id !== intent.roomId || result.participant?.roomId !== intent.roomId ||
      result.invitation?.roomId !== intent.roomId || !/^[a-f0-9]{64}$/.test(result.invitation?.token ?? '') ||
      !result.participant?.id || !Number.isFinite(Date.parse(result.room.expiresAt))) {
    throw new Error('作成結果を確認できませんでした。同じ名前でもう一度お試しください。');
  }
  return result;
}

/** queryや復帰用の秘密値を含めず、参加に必要な招待情報だけをURLに入れる。 */
export function invitationUrl(base: string, invitation: RoomInvitation): string {
  const url = new URL(base);
  url.search = '';
  url.hash = `/join?${new URLSearchParams({ room: invitation.roomId, invite: invitation.token })}`;
  return url.href;
}

/** 保存に失敗した場合は送信しない。成功後の保存失敗でも同じintentで再取得できる。 */
export function pendingCreation(storage: Storage, scope: string, nickname: string): CreationIntent {
  const key = `syu-go:${scope}:pending-creation`;
  const previous = storage.getItem(key);
  if (previous) {
    const intent = JSON.parse(previous) as CreationIntent;
    if (Date.now() - intent.startedAt < 24 * 60 * 60 * 1000) {
      if (intent.nickname !== nickname) throw new Error('前回の作成結果を確認するため、前回と同じニックネームで再試行してください。');
      return intent;
    }
  }
  const intent = newIntent(nickname);
  storage.setItem(key, JSON.stringify(intent));
  return intent;
}

export function saveCreation(storage: Storage, scope: string, result: CreatedRoom, intent: CreationIntent): void {
  const saved: SavedCreation = {
    ...result,
    membership: { roomId: result.room.id, participantId: result.participant.id, resumeToken: intent.resumeToken },
  };
  storage.setItem(`syu-go:${scope}:created:${result.room.id}`, JSON.stringify(saved));
  storage.setItem(`syu-go:${scope}:latest-created`, result.room.id);
  storage.removeItem(`syu-go:${scope}:pending-creation`);
}

export function loadCreation(storage: Storage, scope: string): SavedCreation | null {
  const id = storage.getItem(`syu-go:${scope}:latest-created`);
  const raw = id && storage.getItem(`syu-go:${scope}:created:${id}`);
  if (!raw) return null;
  const result = JSON.parse(raw) as SavedCreation;
  if (result.room?.id !== id || result.invitation?.roomId !== id || !result.participant?.nickname) return null;
  return result;
}

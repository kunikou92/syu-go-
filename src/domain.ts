/** 保存時刻はUTCのISO 8601文字列。期限の判定はサーバーの時刻を使う。 */
export type Timestamp = string;
export type RoomId = string;
export type ParticipantId = string;
export type PinId = string;

export const ROOM_POLICY = {
  maxParticipants: 10,
  lifetimeMs: 24 * 60 * 60 * 1000,
  offlineAfterMs: 30 * 1000,
  leaveAfterMs: 5 * 60 * 1000,
  locationUpdateIntervalMs: 5 * 1000,
  locationStaleAfterMs: 30 * 1000,
} as const;

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface Room {
  id: RoomId;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  endedAt: Timestamp | null;
  mainPinId: PinId | null;
}

/** 招待URLに含めるトークンはルーム情報とは別にサーバーで管理する。 */
export interface RoomInvitation {
  roomId: RoomId;
  token: string;
}

export interface SharedLocation extends Coordinates {
  accuracyMeters: number | null;
  updatedAt: Timestamp;
}

export interface Participant {
  id: ParticipantId;
  roomId: RoomId;
  nickname: string;
  joinedAt: Timestamp;
  lastSeenAt: Timestamp;
  arrived: boolean;
  locationSharing: boolean;
  /** 公開OFFでは必ずnull。履歴は保持しない。 */
  location: SharedLocation | null;
}

/** 一覧用の公開項目。座標や招待・復帰用の秘密値を含めない。 */
export interface ParticipantSummary {
  id: ParticipantId;
  roomId: RoomId;
  nickname: string;
  arrived: boolean;
  lastSeenAt: Timestamp;
  online: boolean;
  locationSharing: boolean;
}

export interface Pin extends Coordinates {
  id: PinId;
  roomId: RoomId;
  name: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface RoomSnapshot {
  room: Room;
  participants: Participant[];
  pins: Pin[];
}

export type GuidanceMode = 'friends' | 'pin';

/** 端末内の参加復帰用情報。参加者一覧や共有通知には含めない。 */
export interface LocalMembership {
  roomId: RoomId;
  participantId: ParticipantId;
  /** サーバー検証用の秘密値。サーバーにはハッシュだけ保存する。 */
  resumeToken: string;
}

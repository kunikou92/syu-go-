begin;

-- APIにテーブルを直接公開せず、作成RPCだけを許可する。
create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

create table app_private.rooms (
  id uuid primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  ended_at timestamptz,
  main_pin_id uuid,
  check (expires_at = created_at + interval '24 hours')
);

create table app_private.participants (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references app_private.rooms(id) on delete cascade,
  nickname text not null check (char_length(nickname) between 1 and 20),
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  arrived boolean not null default false,
  location_sharing boolean not null default false,
  location jsonb,
  check (location_sharing or location is null)
);
create index participants_room_id_idx on app_private.participants(room_id);

create table app_private.invitations (
  room_id uuid primary key references app_private.rooms(id) on delete cascade,
  token text not null unique
);

create table app_private.creation_credentials (
  room_id uuid primary key references app_private.rooms(id) on delete cascade,
  participant_id uuid not null references app_private.participants(id) on delete cascade,
  resume_token_hash text not null
);

alter table app_private.rooms enable row level security;
alter table app_private.participants enable row level security;
alter table app_private.invitations enable row level security;
alter table app_private.creation_credentials enable row level security;
revoke all on all tables in schema app_private from public, anon, authenticated;

create function public.create_room(p_room_id uuid, p_resume_token text, p_nickname text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_nickname text;
  v_room app_private.rooms;
  v_participant app_private.participants;
  v_invite text;
  v_hash text;
begin
  -- JSのtrimと同じ空白集合。改行等はトリム後も残っていれば拒否する。
  v_nickname := btrim(p_nickname, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
  if p_room_id is null or p_resume_token is null or p_resume_token !~ '^[a-f0-9]{64}$'
    or v_nickname is null or char_length(v_nickname) not between 1 and 20
    or v_nickname ~ '[[:cntrl:]]' or v_nickname ~ U&'[\007F-\009F]' then
    raise exception 'Invalid creation input' using errcode = '22023';
  end if;
  v_hash := encode(sha256(convert_to(p_resume_token, 'UTF8')), 'hex');

  -- 同じリクエストの並行実行を直列化。再送でも作成は一度だけ。
  perform pg_advisory_xact_lock(hashtextextended(p_room_id::text, 0));
  select * into v_room from app_private.rooms where id = p_room_id;
  if found then
    select p.* into v_participant
      from app_private.creation_credentials c
      join app_private.participants p on p.id = c.participant_id
      where c.room_id = p_room_id and c.resume_token_hash = v_hash;
    if not found then
      raise exception 'Invalid creation credential' using errcode = '42501';
    end if;
    if v_room.ended_at is not null or v_room.expires_at <= now() then
      raise exception 'Room expired' using errcode = '22023';
    end if;
  else
    insert into app_private.rooms(id) values (p_room_id) returning * into v_room;
    insert into app_private.participants(room_id, nickname)
      values (p_room_id, v_nickname) returning * into v_participant;
    insert into app_private.creation_credentials(room_id, participant_id, resume_token_hash)
      values (p_room_id, v_participant.id, v_hash);
    insert into app_private.invitations(room_id, token)
      values (p_room_id, replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''));
  end if;
  select token into v_invite from app_private.invitations where room_id = p_room_id;
  return jsonb_build_object(
    'room', jsonb_build_object('id', v_room.id, 'createdAt', v_room.created_at,
      'expiresAt', v_room.expires_at, 'endedAt', v_room.ended_at, 'mainPinId', v_room.main_pin_id),
    'participant', jsonb_build_object('id', v_participant.id, 'roomId', v_participant.room_id,
      'nickname', v_participant.nickname, 'joinedAt', v_participant.joined_at,
      'lastSeenAt', v_participant.last_seen_at, 'arrived', v_participant.arrived,
      'locationSharing', v_participant.location_sharing, 'location', v_participant.location),
    'invitation', jsonb_build_object('roomId', v_room.id, 'token', v_invite)
  );
end;
$$;

revoke all on function public.create_room(uuid, text, text) from public;
grant execute on function public.create_room(uuid, text, text) to anon, authenticated;
commit;

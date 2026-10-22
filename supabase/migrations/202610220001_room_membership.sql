begin;

-- 退出済みのIDは残し、遅延した参加・通信の再送による復活を防ぐ。
alter table app_private.participants add column left_at timestamptz;
create table app_private.participant_credentials (
  participant_id uuid primary key references app_private.participants(id) on delete cascade,
  room_id uuid not null references app_private.rooms(id) on delete cascade,
  resume_token_hash text not null
);
insert into app_private.participant_credentials
  select participant_id, room_id, resume_token_hash from app_private.creation_credentials;
alter table app_private.participant_credentials enable row level security;
revoke all on app_private.participant_credentials from public, anon, authenticated;

-- 呼出元は必ず同じルームのadvisory lockを取得する。
create function app_private.sweep_room(p_room_id uuid, p_now timestamptz)
returns void language plpgsql set search_path = '' as $$
declare v_room app_private.rooms;
begin
  select * into v_room from app_private.rooms where id = p_room_id;
  if not found then return; end if;
  update app_private.participants
    set left_at = last_seen_at + interval '5 minutes', location = null, location_sharing = false
    where room_id = p_room_id and left_at is null and last_seen_at <= p_now - interval '5 minutes';
  if v_room.expires_at <= p_now or v_room.ended_at is not null then
    update app_private.rooms set ended_at = coalesce(ended_at, expires_at) where id = p_room_id;
    update app_private.participants set left_at = coalesce(v_room.ended_at, v_room.expires_at),
      location = null, location_sharing = false where room_id = p_room_id and left_at is null;
  elsif not exists (select 1 from app_private.participants where room_id = p_room_id and left_at is null) then
    update app_private.rooms set ended_at = coalesce(
      (select max(left_at) from app_private.participants where room_id = p_room_id), p_now)
      where id = p_room_id and ended_at is null;
  end if;
end;
$$;

create function app_private.self_result(p_room_id uuid, p_participant_id uuid)
returns jsonb language sql set search_path = '' as $$
  select jsonb_build_object('status', 'ok',
    'room', jsonb_build_object('id', r.id, 'createdAt', r.created_at, 'expiresAt', r.expires_at,
      'endedAt', r.ended_at, 'mainPinId', r.main_pin_id),
    'participant', jsonb_build_object('id', p.id, 'roomId', p.room_id, 'nickname', p.nickname,
      'joinedAt', p.joined_at, 'lastSeenAt', p.last_seen_at, 'arrived', p.arrived,
      'locationSharing', p.location_sharing, 'location', p.location),
    'invitation', jsonb_build_object('roomId', r.id, 'token', i.token))
  from app_private.rooms r join app_private.participants p on p.room_id = r.id
    join app_private.invitations i on i.room_id = r.id
  where r.id = p_room_id and p.id = p_participant_id and p.left_at is null;
$$;

-- 初回作成を維持しつつ、作成者にも参加者共通の復帰資格を付与する。
alter function public.create_room(uuid, text, text) rename to create_room_initial;
alter function public.create_room_initial(uuid, text, text) set schema app_private;
revoke all on function app_private.create_room_initial(uuid, text, text) from public, anon, authenticated;
create function public.create_room(p_room_id uuid, p_resume_token text, p_nickname text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_room_id::text, 0));
  if exists (select 1 from app_private.rooms where id = p_room_id) then
    if p_resume_token is null or not exists (select 1 from app_private.creation_credentials
      where room_id = p_room_id and resume_token_hash = encode(sha256(convert_to(p_resume_token, 'UTF8')), 'hex')) then
      raise exception 'Invalid creation credential' using errcode = '42501';
    end if;
    perform app_private.sweep_room(p_room_id, clock_timestamp());
    if exists (select 1 from app_private.rooms where id = p_room_id and ended_at is not null) then
      return jsonb_build_object('status', 'ended');
    end if;
  end if;
  v_result := app_private.create_room_initial(p_room_id, p_resume_token, p_nickname);
  insert into app_private.participant_credentials(participant_id, room_id, resume_token_hash)
    values ((v_result->'participant'->>'id')::uuid, p_room_id,
      encode(sha256(convert_to(p_resume_token, 'UTF8')), 'hex')) on conflict do nothing;
  perform app_private.sweep_room(p_room_id, clock_timestamp());
  if exists (select 1 from app_private.participants
    where id = (v_result->'participant'->>'id')::uuid and left_at is not null) then
    return jsonb_build_object('status', 'membership_expired');
  end if;
  return v_result;
end;
$$;

create function public.room_action(p_action text, p_room_id uuid, p_invite text default null,
  p_participant_id uuid default null, p_resume_token text default null, p_nickname text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_room app_private.rooms;
  v_member app_private.participants;
  v_now timestamptz;
  v_nickname text;
  v_hash text;
begin
  if p_action is null or p_action not in ('inspect', 'join', 'heartbeat', 'leave') or p_room_id is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_room_id::text, 0));
  v_now := clock_timestamp();
  select * into v_room from app_private.rooms where id = p_room_id;
  if not found then return jsonb_build_object('status', 'missing'); end if;
  if p_action in ('inspect', 'join') then
    if p_invite is null or not exists (select 1 from app_private.invitations
      where room_id = p_room_id and token = p_invite) then
      return jsonb_build_object('status', 'invalid_invitation');
    end if;
  end if;
  if p_action <> 'inspect' then
    if p_participant_id is null or p_resume_token is null or p_resume_token !~ '^[a-f0-9]{64}$' then
      return jsonb_build_object('status', 'unauthorized');
    end if;
    v_hash := encode(sha256(convert_to(p_resume_token, 'UTF8')), 'hex');
    select * into v_member from app_private.participants where id = p_participant_id;
    if (p_action <> 'join' or found) and not exists (
      select 1 from app_private.participant_credentials c where c.participant_id = p_participant_id
        and c.room_id = p_room_id and c.resume_token_hash = v_hash) then
      return jsonb_build_object('status', 'unauthorized');
    end if;
  end if;
  perform app_private.sweep_room(p_room_id, v_now);
  select * into v_room from app_private.rooms where id = p_room_id;
  if p_action = 'leave' then
    update app_private.participants set left_at = coalesce(left_at, v_now),
      location = null, location_sharing = false where id = p_participant_id and room_id = p_room_id;
    perform app_private.sweep_room(p_room_id, v_now);
    return jsonb_build_object('status', 'left');
  end if;
  if v_room.ended_at is not null then return jsonb_build_object('status', 'ended'); end if;
  if p_action = 'inspect' then
    return jsonb_build_object('status', case when
      (select count(*) from app_private.participants where room_id = p_room_id and left_at is null) >= 10
      then 'full' else 'open' end, 'expiresAt', v_room.expires_at);
  end if;
  select * into v_member from app_private.participants where id = p_participant_id;
  if found then
    if v_member.left_at is not null then return jsonb_build_object('status', 'membership_expired'); end if;
  elsif p_action = 'join' then
    v_nickname := btrim(p_nickname, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
    if v_nickname is null or char_length(v_nickname) not between 1 and 20
      or v_nickname ~ '[[:cntrl:]]' or v_nickname ~ U&'[\007F-\009F]' then
      return jsonb_build_object('status', 'invalid_nickname');
    end if;
    if (select count(*) from app_private.participants where room_id = p_room_id and left_at is null) >= 10 then
      return jsonb_build_object('status', 'full');
    end if;
    insert into app_private.participants(id, room_id, nickname, joined_at, last_seen_at)
      values (p_participant_id, p_room_id, v_nickname, v_now, v_now);
    insert into app_private.participant_credentials(participant_id, room_id, resume_token_hash)
      values (p_participant_id, p_room_id, v_hash);
  else
    return jsonb_build_object('status', 'unauthorized');
  end if;
  update app_private.participants set last_seen_at = v_now where id = p_participant_id;
  return app_private.self_result(p_room_id, p_participant_id);
end;
$$;

-- 他の端末が通信していない場合もサーバーだけで終了判定を進める。
create function app_private.sweep_rooms() returns void language plpgsql
  security definer set search_path = '' as $$
declare v_id uuid;
begin
  for v_id in select id from app_private.rooms where ended_at is null loop
    if pg_try_advisory_xact_lock(hashtextextended(v_id::text, 0)) then
      perform app_private.sweep_room(v_id, clock_timestamp());
    end if;
  end loop;
end;
$$;
revoke all on all functions in schema app_private from public, anon, authenticated;
revoke all on function public.create_room(uuid, text, text) from public;
revoke all on function public.room_action(text, uuid, text, uuid, text, text) from public;
grant execute on function public.create_room(uuid, text, text) to anon, authenticated;
grant execute on function public.room_action(text, uuid, text, uuid, text, text) to anon, authenticated;
commit;

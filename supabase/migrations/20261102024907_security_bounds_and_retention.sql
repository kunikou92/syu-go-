-- Bounded anonymous use and replay-safe retention. Apply once after the six baseline migrations.
begin;

-- Future Data API exposure is opt-in. Existing explicit RPC grants are retained.
alter default privileges for role postgres in schema public
  revoke select,insert,update,delete on tables from anon,authenticated,service_role;
alter default privileges for role postgres in schema public
  revoke usage,select on sequences from anon,authenticated,service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from public,anon,authenticated,service_role;
-- PUBLIC's built-in EXECUTE default is global; a schema-level REVOKE cannot remove it.
alter default privileges for role postgres revoke execute on functions from public;

create index rooms_created_at_idx on app_private.rooms(created_at);
create index rooms_ended_at_idx on app_private.rooms(ended_at) where ended_at is not null;
create index participant_credentials_room_idx on app_private.participant_credentials(room_id);

-- Keep old extra pins as private archived rows until the room retention expires.
alter table app_private.pins add column retired_at timestamptz;
update app_private.rooms r set main_pin_id=(select p.id from app_private.pins p
  where p.room_id=r.id order by (p.id=r.main_pin_id) desc nulls last,p.created_at,p.id limit 1);
update app_private.pins p set retired_at=clock_timestamp() from app_private.rooms r
  where r.id=p.room_id and p.id is distinct from r.main_pin_id;
update app_private.rooms r set pin_revision=pin_revision+1
  where exists(select 1 from app_private.pins p where p.room_id=r.id and p.retired_at is not null);
create unique index one_active_pin_per_room on app_private.pins(room_id) where retired_at is null;
alter table app_private.pin_operations add column created_at timestamptz not null default clock_timestamp();
create index pin_operations_room_time_idx on app_private.pin_operations(room_id,created_at);

-- Keep the established credential checks and creation retry behavior behind a bounded entrypoint.
alter function public.create_room(uuid,text,text) rename to create_room_core;
alter function public.create_room_core(uuid,text,text) set schema app_private;
revoke all on function app_private.create_room_core(uuid,text,text) from public,anon,authenticated;
create function public.create_room(p_room_id uuid,p_resume_token text,p_nickname text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_now timestamptz; v_issued_at timestamptz;
begin
  if p_room_id is null or p_resume_token is null or p_resume_token !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid creation input' using errcode='22023';
  end if;
  -- Existing UUIDv4 rooms can still retry with their original secret. No new UUIDv4 room is admitted.
  if exists(select 1 from app_private.rooms where id=p_room_id) then
    return app_private.create_room_core(p_room_id,p_resume_token,p_nickname);
  end if;
  if substring(p_room_id::text from 15 for 1) <> '7' then
    return jsonb_build_object('status','creation_expired');
  end if;
  v_issued_at := to_timestamp((('x'||substring(replace(p_room_id::text,'-','') from 1 for 12))::bit(48)::bigint)::double precision/1000.0);
  v_now := clock_timestamp();
  if v_issued_at < v_now-interval '24 hours' or v_issued_at > v_now+interval '5 minutes' then
    return jsonb_build_object('status','creation_expired');
  end if;
  -- One shared transaction lock serializes quota checks and maintenance. Room locks are taken after it.
  perform pg_advisory_xact_lock(hashtextextended('syu-go:creation-budget',0));
  v_now := clock_timestamp();
  if exists(select 1 from app_private.rooms where id=p_room_id) then
    return app_private.create_room_core(p_room_id,p_resume_token,p_nickname);
  end if;
  if (select count(*) from app_private.rooms where created_at>v_now-interval '1 minute') >= 10 then
    return jsonb_build_object('status','rate_limited');
  end if;
  if (select count(*) from app_private.rooms where created_at>v_now-interval '24 hours') >= 100
    or (select count(*) from app_private.rooms where ended_at is null and expires_at>v_now) >= 50
    or (select count(*) from app_private.rooms) >= 1000 then
    return jsonb_build_object('status','capacity_reached');
  end if;
  return app_private.create_room_core(p_room_id,p_resume_token,p_nickname);
end;
$$;
revoke all on function public.create_room(uuid,text,text) from public;
grant execute on function public.create_room(uuid,text,text) to anon,authenticated;

create or replace function public.room_action(p_action text, p_room_id uuid, p_invite text default null,
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
      then 'full' when (select count(*) from app_private.participants where room_id=p_room_id) >= 100
      then 'membership_limit' else 'open' end, 'expiresAt', v_room.expires_at);
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
    if (select count(*) from app_private.participants where room_id=p_room_id) >= 100 then
      return jsonb_build_object('status','membership_limit');
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

create or replace function public.room_pins(p_action text, p_room_id uuid, p_participant_id uuid, p_resume_token text,
  p_request_id uuid default null, p_pin_id uuid default null, p_name text default null,
  p_latitude double precision default null, p_longitude double precision default null,
  p_version bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz;
  v_room app_private.rooms;
  v_pin app_private.pins;
  v_previous app_private.pin_operations;
  v_name text;
  v_payload jsonb;
  v_status text := 'ok';
  v_duplicate boolean := false;
  v_pins jsonb;
begin
  if p_room_id is null or p_participant_id is null or p_resume_token is null
    or p_resume_token !~ '^[a-f0-9]{64}$' then return jsonb_build_object('status','unauthorized'); end if;
  perform pg_advisory_xact_lock(hashtextextended(p_room_id::text,0));
  v_now := clock_timestamp();
  if not exists (select 1 from app_private.participant_credentials where room_id=p_room_id
    and participant_id=p_participant_id and resume_token_hash=encode(sha256(convert_to(p_resume_token,'UTF8')),'hex'))
    then return jsonb_build_object('status','unauthorized'); end if;
  perform app_private.sweep_room(p_room_id,v_now);
  select * into v_room from app_private.rooms where id=p_room_id;
  if not found then return jsonb_build_object('status','missing'); end if;
  if v_room.ended_at is not null then return jsonb_build_object('status','ended'); end if;
  if not exists (select 1 from app_private.participants where room_id=p_room_id and id=p_participant_id and left_at is null)
    then return jsonb_build_object('status','membership_expired'); end if;
  if p_action is null or p_action not in ('read','create','update','delete','main') then
    return jsonb_build_object('status','invalid_request'); end if;
  if p_action <> 'read' then
    if p_request_id is null or p_pin_id is null then return jsonb_build_object('status','invalid_request'); end if;
    v_payload := jsonb_build_object('action',p_action,'pin',p_pin_id,'name',p_name,
      'latitude',p_latitude,'longitude',p_longitude,'version',p_version);
    select * into v_previous from app_private.pin_operations where room_id=p_room_id and request_id=p_request_id;
    if found then
      if v_previous.participant_id <> p_participant_id or v_previous.payload_hash <> encode(sha256(convert_to(v_payload::text,'UTF8')),'hex') then
        return jsonb_build_object('status','invalid_request'); end if;
      v_duplicate := true;
    end if;
    if not v_duplicate then
      if (select count(*) from app_private.pin_operations where room_id=p_room_id) >= 300 then
        return jsonb_build_object('status','limit_reached');
      end if;
      if (select count(*) from app_private.pin_operations where room_id=p_room_id
        and created_at > v_now - interval '1 minute') >= 20 then
        return jsonb_build_object('status','rate_limited');
      end if;
      if p_action in ('create','update') then
        v_name := btrim(p_name,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
        if v_name is null or char_length(v_name) not between 1 and 40 or v_name ~ '[[:cntrl:]]'
          or v_name ~ U&'[\007F-\009F]' or p_latitude is null or not (p_latitude between -90 and 90)
          or p_longitude is null or not (p_longitude between -180 and 180) then
          return jsonb_build_object('status','invalid_request'); end if;
      end if;
      select * into v_pin from app_private.pins where room_id=p_room_id and id=p_pin_id and retired_at is null;
      if p_action='create' then
        if found or exists (select 1 from app_private.pins where id=p_pin_id) then v_status := 'conflict';
        elsif exists (select 1 from app_private.pins where room_id=p_room_id and retired_at is null) then
          v_status := 'limit_reached';
        else
          insert into app_private.pins(id,room_id,name,latitude,longitude,created_at,updated_at)
            values(p_pin_id,p_room_id,v_name,p_latitude,p_longitude,v_now,v_now);
          if v_room.main_pin_id is null then update app_private.rooms set main_pin_id=p_pin_id where id=p_room_id; end if;
        end if;
      elsif not found then v_status := 'pin_missing';
      elsif p_action='main' then
        if p_version is distinct from v_room.pin_revision then v_status := 'conflict';
        else update app_private.rooms set main_pin_id=p_pin_id where id=p_room_id; end if;
      elsif p_version is distinct from v_pin.version then v_status := 'conflict';
      elsif p_action='update' then
        update app_private.pins set name=v_name,latitude=p_latitude,longitude=p_longitude,
          updated_at=v_now,version=version+1 where id=p_pin_id and room_id=p_room_id;
      elsif p_action='delete' then
        delete from app_private.pins where id=p_pin_id and room_id=p_room_id;
        if v_room.main_pin_id=p_pin_id then
          update app_private.rooms set main_pin_id=(select id from app_private.pins where room_id=p_room_id and retired_at is null
            order by created_at,id limit 1) where id=p_room_id;
        end if;
      end if;
      if v_status='ok' then
        update app_private.rooms set pin_revision=pin_revision+1 where id=p_room_id;
        insert into app_private.pin_operations(room_id,request_id,participant_id,payload_hash) values(p_room_id,p_request_id,p_participant_id,encode(sha256(convert_to(v_payload::text,'UTF8')),'hex'));
      end if;
    end if;
  end if;
  update app_private.participants set last_seen_at=v_now where id=p_participant_id and room_id=p_room_id;
  select * into v_room from app_private.rooms where id=p_room_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'roomId',room_id,'name',name,'latitude',latitude,
    'longitude',longitude,'createdAt',created_at,'updatedAt',updated_at,'version',version) order by created_at,id),'[]'::jsonb)
    into v_pins from app_private.pins where room_id=p_room_id and retired_at is null;
  return jsonb_build_object('status',v_status,'revision',v_room.pin_revision,'mainPinId',v_room.main_pin_id,'pins',v_pins);
end;
$$;

create function app_private.maintain_room_data() returns void language plpgsql
security definer set search_path='' as $$
declare v_id uuid;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('syu-go:creation-budget',0)) then return; end if;
  perform app_private.sweep_rooms();
  -- Seven days exceeds the 24-hour creation-request window and the lifetime of every room operation.
  for v_id in select id from app_private.rooms where ended_at < clock_timestamp()-interval '7 days'
    order by ended_at,id limit 50 loop
    if pg_try_advisory_xact_lock(hashtextextended(v_id::text,0)) then
      delete from app_private.rooms where id=v_id and ended_at < clock_timestamp()-interval '7 days';
    end if;
  end loop;
end;
$$;
revoke all on function app_private.maintain_room_data() from public,anon,authenticated;
revoke all on all functions in schema app_private from public,anon,authenticated;

-- Skip scheduling in local PGlite. On Supabase, replace the same job rather than creating duplicates.
do $$ begin
  if to_regnamespace('cron') is not null then
    perform cron.schedule('syu-go-room-cleanup','* * * * *','select app_private.maintain_room_data();');
  end if;
end $$;
commit;

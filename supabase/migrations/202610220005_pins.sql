begin;
alter table app_private.rooms add column pin_revision bigint not null default 0;
create table app_private.pins (
  id uuid primary key,
  room_id uuid not null references app_private.rooms(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  version bigint not null default 1,
  unique (room_id, id)
);
create table app_private.pin_operations (
  room_id uuid not null references app_private.rooms(id) on delete cascade,
  request_id uuid not null,
  participant_id uuid not null,
  payload_hash text not null,
  primary key (room_id, request_id)
);
alter table app_private.pins enable row level security;
alter table app_private.pin_operations enable row level security;
revoke all on app_private.pins, app_private.pin_operations from public, anon, authenticated;

create function public.room_pins(p_action text, p_room_id uuid, p_participant_id uuid, p_resume_token text,
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
      if p_action in ('create','update') then
        v_name := btrim(p_name,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
        if v_name is null or char_length(v_name) not between 1 and 40 or v_name ~ '[[:cntrl:]]'
          or v_name ~ U&'[\007F-\009F]' or p_latitude is null or not (p_latitude between -90 and 90)
          or p_longitude is null or not (p_longitude between -180 and 180) then
          return jsonb_build_object('status','invalid_request'); end if;
      end if;
      select * into v_pin from app_private.pins where room_id=p_room_id and id=p_pin_id;
      if p_action='create' then
        if found or exists (select 1 from app_private.pins where id=p_pin_id) then v_status := 'conflict';
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
          update app_private.rooms set main_pin_id=(select id from app_private.pins where room_id=p_room_id
            order by created_at,id limit 1) where id=p_room_id;
        end if;
      end if;
      if v_status='ok' then
        update app_private.rooms set pin_revision=pin_revision+1 where id=p_room_id;
        insert into app_private.pin_operations values(p_room_id,p_request_id,p_participant_id,encode(sha256(convert_to(v_payload::text,'UTF8')),'hex'));
      end if;
    end if;
  end if;
  update app_private.participants set last_seen_at=v_now where id=p_participant_id and room_id=p_room_id;
  select * into v_room from app_private.rooms where id=p_room_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'roomId',room_id,'name',name,'latitude',latitude,
    'longitude',longitude,'createdAt',created_at,'updatedAt',updated_at,'version',version) order by created_at,id),'[]'::jsonb)
    into v_pins from app_private.pins where room_id=p_room_id;
  return jsonb_build_object('status',v_status,'revision',v_room.pin_revision,'mainPinId',v_room.main_pin_id,'pins',v_pins);
end;
$$;
revoke all on function public.room_pins(text,uuid,uuid,text,uuid,uuid,text,double precision,double precision,bigint) from public;
grant execute on function public.room_pins(text,uuid,uuid,text,uuid,uuid,text,double precision,double precision,bigint) to anon,authenticated;
commit;

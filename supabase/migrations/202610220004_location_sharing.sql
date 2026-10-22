begin;

alter table app_private.participants add column location_version bigint not null default 0;

-- OFFで世代を進め、遅れて届いたON・座標更新を拒否する。
create function public.room_location(p_action text, p_room_id uuid, p_participant_id uuid,
  p_resume_token text, p_version bigint default null, p_latitude double precision default null,
  p_longitude double precision default null, p_accuracy double precision default null,
  p_observed_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz;
  v_room app_private.rooms;
  v_self app_private.participants;
  v_status text := 'ok';
  v_members jsonb;
begin
  if p_room_id is null or p_participant_id is null or p_resume_token is null
    or p_resume_token !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_room_id::text, 0));
  v_now := clock_timestamp();
  if not exists (select 1 from app_private.participant_credentials
    where room_id = p_room_id and participant_id = p_participant_id
      and resume_token_hash = encode(sha256(convert_to(p_resume_token, 'UTF8')), 'hex')) then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  perform app_private.sweep_room(p_room_id, v_now);
  select * into v_room from app_private.rooms where id = p_room_id;
  if not found then return jsonb_build_object('status', 'missing'); end if;
  if v_room.ended_at is not null then return jsonb_build_object('status', 'ended'); end if;
  select * into v_self from app_private.participants
    where room_id = p_room_id and id = p_participant_id and left_at is null;
  if not found then return jsonb_build_object('status', 'membership_expired'); end if;
  if p_action not in ('read', 'enable', 'disable', 'publish') or p_action is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;
  if p_action = 'disable' then
    update app_private.participants set location_sharing = false, location = null,
      location_version = location_version + 1 where id = p_participant_id;
  elsif p_action in ('enable', 'publish') then
    if p_version is distinct from v_self.location_version or
      (p_action = 'publish' and not v_self.location_sharing) then
      v_status := 'conflict';
    elsif p_action = 'enable' then
      update app_private.participants set location_sharing = true, location = null,
        location_version = location_version + 1 where id = p_participant_id;
    elsif p_latitude is null or not (p_latitude between -90 and 90)
      or p_longitude is null or not (p_longitude between -180 and 180)
      or p_accuracy is null or not (p_accuracy between 0 and 10000000)
      or p_observed_at is null or not isfinite(p_observed_at)
      or p_observed_at > v_now + interval '5 seconds'
      or p_observed_at <= v_now - interval '30 seconds' then
      return jsonb_build_object('status', 'invalid_request');
    elsif v_self.location is null or p_observed_at > (v_self.location->>'updatedAt')::timestamptz then
      update app_private.participants set location = jsonb_build_object(
        'latitude', p_latitude, 'longitude', p_longitude, 'accuracyMeters', p_accuracy,
        'updatedAt', least(p_observed_at, v_now)) where id = p_participant_id;
    end if;
  end if;
  update app_private.participants set last_seen_at = v_now where id = p_participant_id;
  select * into v_self from app_private.participants where id = p_participant_id;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'roomId', room_id, 'nickname', nickname,
    'locationSharing', location_sharing, 'location', case when location_sharing
      and (location->>'updatedAt')::timestamptz > v_now - interval '30 seconds'
      then location else null end) order by joined_at, id), '[]'::jsonb)
    into v_members from app_private.participants where room_id = p_room_id and left_at is null;
  return jsonb_build_object('status', v_status, 'serverTime', v_now,
    'version', v_self.location_version, 'sharing', v_self.location_sharing, 'participants', v_members);
end;
$$;
revoke all on function public.room_location(text, uuid, uuid, text, bigint, double precision,
  double precision, double precision, timestamptz) from public;
grant execute on function public.room_location(text, uuid, uuid, text, bigint, double precision,
  double precision, double precision, timestamptz) to anon, authenticated;
commit;

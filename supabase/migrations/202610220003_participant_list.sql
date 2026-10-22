begin;

-- 一覧には状態だけを返し、座標・招待情報・復帰資格を含めない。
create function public.room_participants(p_room_id uuid, p_participant_id uuid,
  p_resume_token text, p_arrived boolean default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz;
  v_room app_private.rooms;
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
  if not exists (select 1 from app_private.participants
    where room_id = p_room_id and id = p_participant_id and left_at is null) then
    return jsonb_build_object('status', 'membership_expired');
  end if;
  -- 取得も本人からの通信として扱う。到着状態は本人の行だけを指定値へ更新する。
  update app_private.participants set last_seen_at = v_now,
    arrived = coalesce(p_arrived, arrived) where id = p_participant_id and room_id = p_room_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'roomId', room_id, 'nickname', nickname,
    'arrived', arrived, 'lastSeenAt', last_seen_at,
    'online', last_seen_at > v_now - interval '30 seconds',
    'locationSharing', location_sharing) order by joined_at, id), '[]'::jsonb)
    into v_members from app_private.participants where room_id = p_room_id and left_at is null;
  return jsonb_build_object('status', 'ok', 'serverTime', v_now, 'participants', v_members);
end;
$$;
revoke all on function public.room_participants(uuid, uuid, text, boolean) from public;
grant execute on function public.room_participants(uuid, uuid, text, boolean) to anon, authenticated;
commit;

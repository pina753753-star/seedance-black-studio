-- Preserve existing function ownership and service-role-only privileges.
-- Reject expired input and never invalidate an active third inspection.
begin;
create or replace function public.claim_seedance_reference_video_inspection(
  p_asset_id uuid,
  p_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.seedance_reference_video_uploads%rowtype;
begin
  select * into v_row
  from public.seedance_reference_video_uploads
  where id = p_asset_id and user_id = p_user_id
  for update;

  if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if v_row.expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'expired');
  end if;
  if v_row.status = 'ready' then return jsonb_build_object('ok', true, 'code', 'ready'); end if;
  if v_row.status in ('blocked', 'failed') then
    return jsonb_build_object('ok', false, 'code', v_row.status);
  end if;
  if v_row.status = 'checking' and v_row.updated_at > now() - interval '5 minutes' then
    return jsonb_build_object('ok', false, 'code', 'busy');
  end if;
  if v_row.inspection_attempts >= 3 then
    update public.seedance_reference_video_uploads
      set status = 'failed', updated_at = now()
      where id = p_asset_id;
    return jsonb_build_object('ok', false, 'code', 'attempt_limit');
  end if;

  update public.seedance_reference_video_uploads
    set status = 'checking',
        inspection_attempts = inspection_attempts + 1,
        expires_at = greatest(expires_at, now() + interval '1 hour'),
        updated_at = now()
    where id = p_asset_id;
  return jsonb_build_object('ok', true, 'code', 'claimed');
end;
$$;


commit;

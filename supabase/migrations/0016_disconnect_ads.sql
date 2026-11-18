-- Disconnect a Facebook/Instagram ad account from itaOS (owner/admin only).
-- Deletes the stored Meta token from the vault and removes the connection, so syncing stops at
-- once and the same ad account can be connected again later (here or in another workspace).
-- Past ad data (spend, chats per ad) is kept unless p_delete_data is true and no other ad
-- account is still connected to this workspace.
create or replace function public.disconnect_ads(p_conn uuid, p_delete_data boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = public, vault as $$
declare
  c public.connections; v_ws uuid; v_left int; v_ads int := 0; v_days int := 0;
begin
  select * into c from public.connections where id = p_conn and provider = 'meta_ads';
  if c.id is null then raise exception 'Ad account connection not found.'; end if;
  v_ws := c.workspace_id;
  if auth.uid() is null or not public.can_manage(v_ws) then
    raise exception 'Only the owner or an admin can disconnect an ad account.' using errcode = '42501';
  end if;
  if c.token_secret_id is not null then delete from vault.secrets where id = c.token_secret_id; end if;
  delete from public.connections where id = c.id;
  select count(*) into v_left from public.connections where workspace_id = v_ws and provider = 'meta_ads';
  if p_delete_data and v_left = 0 then
    delete from public.ad_insights_daily where workspace_id = v_ws; get diagnostics v_days = row_count;
    delete from public.ads where workspace_id = v_ws; get diagnostics v_ads = row_count;
  end if;
  return jsonb_build_object('disconnected', c.external_id, 'ads_deleted', v_ads, 'days_deleted', v_days, 'other_ad_accounts', v_left);
end $$;
revoke all on function public.disconnect_ads(uuid, boolean) from public, anon;
grant execute on function public.disconnect_ads(uuid, boolean) to authenticated;

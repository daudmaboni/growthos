-- Phone app (PWA) push notifications.
-- One row per device/browser that turned on notifications (Settings → Phone app).
-- push-send (service role) reads them; a user only ever sees and removes their own devices.
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  fail_count int not null default 0
);
create index if not exists push_subscriptions_ws on public.push_subscriptions(workspace_id);
create index if not exists push_subscriptions_user on public.push_subscriptions(user_id);

alter table public.push_subscriptions enable row level security;
drop policy if exists push_own_select on public.push_subscriptions;
create policy push_own_select on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
drop policy if exists push_own_delete on public.push_subscriptions;
create policy push_own_delete on public.push_subscriptions for delete to authenticated using (user_id = auth.uid());
revoke insert, update on public.push_subscriptions from anon, authenticated;

-- Save this device for the signed-in member. A device that was used by someone else before
-- (shared phone, signed out and in as another person) moves to the new person.
create or replace function public.save_push_subscription(p_workspace uuid, p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not public.is_member(p_workspace) then raise exception 'not a member of this workspace'; end if;
  if coalesce(p_endpoint, '') !~ '^https://' or length(p_endpoint) > 1000 then raise exception 'bad endpoint'; end if;
  insert into public.push_subscriptions(endpoint, user_id, workspace_id, p256dh, auth, user_agent)
  values (p_endpoint, auth.uid(), p_workspace, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update set user_id = excluded.user_id, workspace_id = excluded.workspace_id,
    p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, fail_count = 0;
end $$;
revoke all on function public.save_push_subscription(uuid, text, text, text, text) from public, anon;
grant execute on function public.save_push_subscription(uuid, text, text, text, text) to authenticated;

-- Not used: Vault writes were blocked, so the VAPID private key is the VAPID_PRIVATE_KEY Edge Function secret.
-- Kept because it was applied; it returns null while no 'vapid_private_key' Vault secret exists.
create or replace function public.svc_vapid_private()
returns text language sql security definer set search_path = public as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'vapid_private_key' limit 1
$$;
revoke all on function public.svc_vapid_private() from public, anon, authenticated;
grant execute on function public.svc_vapid_private() to service_role;

-- Monthly AI limit per business (19 Nov 2026). The platform-wide budget (admin_settings 'api_budget') stays.
-- Each business can now get its own monthly limit in USD, set by Pondi staff in /app/admin:
--   ai_limit_action = 'alert' (default): staff see a warning at 80% and when it is passed; nothing stops.
--   ai_limit_action = 'pause': once passed, Kito stops reading new chats for that business until the next month
--                              (or until staff raise the limit). Ask Kito and drafts answer with a clear message.
-- No limit (null) = no change from before. Costs are the same estimate as the AI usage page (api_pricing).

alter table public.workspace_admin_state
  add column if not exists ai_monthly_usd numeric check (ai_monthly_usd is null or ai_monthly_usd >= 0),
  add column if not exists ai_limit_action text not null default 'alert' check (ai_limit_action in ('alert', 'pause'));

-- This month's estimated AI cost for one business (Dar es Salaam calendar month).
create or replace function private.ai_month_cost(p_ws uuid) returns numeric
language sql stable security definer set search_path = public, private as $$
  select coalesce(sum(private.api_cost(x, p)), 0)
    from public.api_usage x left join public.api_pricing p on p.model = x.model
   where x.workspace_id = p_ws
     and x.at >= date_trunc('month', now() at time zone 'Africa/Dar_es_Salaam') at time zone 'Africa/Dar_es_Salaam'
$$;

-- Is this business over its limit with "pause" chosen? Used by the kito and kito-ask functions (service role).
create or replace function public.svc_ai_paused(p_ws uuid) returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select s.ai_limit_action = 'pause' and s.ai_monthly_usd is not null
                          and private.ai_month_cost(p_ws) >= s.ai_monthly_usd
                     from public.workspace_admin_state s where s.workspace_id = p_ws), false)
$$;

-- Staff: every business's limit and this month's cost.
create or replace function public.admin_ai_limits()
returns table(workspace_id uuid, name text, ai_monthly_usd numeric, ai_limit_action text, month_cost numeric)
language plpgsql stable security definer set search_path = public, private as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
    select w.id, w.name, s.ai_monthly_usd, coalesce(s.ai_limit_action, 'alert'), round(private.ai_month_cost(w.id), 4)
      from public.workspaces w left join public.workspace_admin_state s on s.workspace_id = w.id
     order by 5 desc, 2;
end $$;

-- Staff: set (or clear, with null) one business's limit.
create or replace function public.admin_set_ai_limit(p_ws uuid, p_usd numeric, p_action text default 'alert')
returns void language plpgsql security definer set search_path = public as $$
declare before jsonb;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_usd is not null and p_usd < 0 then raise exception 'The limit can''t be negative.'; end if;
  if coalesce(p_action, 'alert') not in ('alert', 'pause') then raise exception 'Choose alert or pause.'; end if;
  select jsonb_build_object('usd', ai_monthly_usd, 'action', ai_limit_action) into before
    from public.workspace_admin_state where workspace_id = p_ws;
  insert into public.workspace_admin_state (workspace_id, ai_monthly_usd, ai_limit_action)
  values (p_ws, p_usd, coalesce(p_action, 'alert'))
  on conflict (workspace_id) do update set ai_monthly_usd = excluded.ai_monthly_usd, ai_limit_action = excluded.ai_limit_action;
  insert into public.admin_audit (actor, action, workspace_id, details)
  values (auth.uid(), 'set_ai_limit', p_ws, jsonb_build_object('before', before, 'after', jsonb_build_object('usd', p_usd, 'action', coalesce(p_action, 'alert'))));
end $$;

revoke all on function private.ai_month_cost(uuid) from public, anon, authenticated;
revoke all on function public.svc_ai_paused(uuid) from public, anon, authenticated;
grant execute on function public.svc_ai_paused(uuid) to service_role;
revoke all on function public.admin_ai_limits() from public, anon;
revoke all on function public.admin_set_ai_limit(uuid, numeric, text) from public, anon;
grant execute on function public.admin_ai_limits() to authenticated;
grant execute on function public.admin_set_ai_limit(uuid, numeric, text) to authenticated;

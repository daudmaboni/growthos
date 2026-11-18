-- 0013_admin_activity — daily series for the admin dashboard (counts only). Applied to Supabase 18 Nov 2026.
create or replace function public.admin_activity(p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d int := greatest(7, least(p_days, 90)); r jsonb;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  with days as (
    select g::date as day from generate_series(current_date - (d - 1), current_date, interval '1 day') g
  ), msg as (
    select (sent_at at time zone 'Africa/Dar_es_Salaam')::date as day, workspace_id, count(*) n
      from messages where sent_at >= current_date - d group by 1, 2
  )
  select jsonb_build_object(
    'days',     (select jsonb_agg(day order by day) from days),
    'messages', (select jsonb_agg(coalesce((select sum(n) from msg where msg.day = days.day), 0) order by day) from days),
    'signups',  (select jsonb_agg((select count(*) from workspaces w
                   where (w.created_at at time zone 'Africa/Dar_es_Salaam')::date = days.day) order by day) from days),
    'kito',     (select jsonb_agg((select count(*) from kito_asks k
                   where (k.created_at at time zone 'Africa/Dar_es_Salaam')::date = days.day) order by day) from days),
    'per_ws',   coalesce((select jsonb_object_agg(w.id, (
                   select jsonb_agg(coalesce((select n from msg where msg.day = days.day and msg.workspace_id = w.id), 0) order by day)
                     from days where days.day > current_date - 14)) from workspaces w), '{}')
  ) into r;
  return r;
end $$;
revoke all on function public.admin_activity(int) from public, anon;
grant execute on function public.admin_activity(int) to authenticated;

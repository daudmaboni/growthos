-- 0012_platform_admin — Pondi platform admin dashboard (cross-workspace, read-mostly)
-- Customer RLS is untouched. Every admin_* function is SECURITY DEFINER and
-- refuses unless auth.uid() is in public.platform_admins.
-- Admin views never return message bodies, contact names or Kito questions.

-- 1. Who is a platform admin --------------------------------------------------
create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;
revoke all on public.platform_admins from anon, authenticated;

-- 2. Admin-only state per workspace (kept off public.workspaces so owners can't edit it)
create table if not exists public.workspace_admin_state (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  status       text not null default 'active' check (status in ('trial','active','suspended')),
  plan         text not null default 'pilot',
  note         text,
  updated_by   uuid references auth.users(id),
  updated_at   timestamptz not null default now()
);
alter table public.workspace_admin_state enable row level security;
revoke all on public.workspace_admin_state from anon, authenticated;

-- 3. Audit trail of admin actions
create table if not exists public.admin_audit (
  id           bigint generated always as identity primary key,
  actor        uuid references auth.users(id),
  action       text not null,
  workspace_id uuid references public.workspaces(id) on delete set null,
  details      jsonb not null default '{}'::jsonb,
  at           timestamptz not null default now()
);
alter table public.admin_audit enable row level security;
revoke all on public.admin_audit from anon, authenticated;

-- 4. Gate ---------------------------------------------------------------------
create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

-- 5. Overview tiles -----------------------------------------------------------
create or replace function public.admin_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'workspaces',        (select count(*) from workspaces),
    'workspaces_7d',     (select count(*) from workspaces where created_at > now() - interval '7 days'),
    'users',             (select count(*) from auth.users),
    'active_users_7d',   (select count(*) from auth.users where last_sign_in_at > now() - interval '7 days'),
    'messages',          (select count(*) from messages),
    'messages_24h',      (select count(*) from messages where sent_at > now() - interval '24 hours'),
    'messages_7d',       (select count(*) from messages where sent_at > now() - interval '7 days'),
    'connections_active',(select count(*) from connections where status = 'active'),
    'connections_error', (select count(*) from connections where status <> 'active'),
    'failed_events',     (select count(*) from raw_events where processed_at is null and (status = 'failed' or attempts >= max_attempts)),
    'pending_events',    (select count(*) from raw_events where status = 'pending'),
    'unrouted_events',   (select count(*) from raw_events where workspace_id is null),
    'kito_asks_7d',      (select count(*) from kito_asks where created_at > now() - interval '7 days'),
    'kito_tokens_7d',    (select coalesce(sum(coalesce(input_tokens,0) + coalesce(output_tokens,0)),0) from kito_asks where created_at > now() - interval '7 days'),
    'kito_errors_7d',    (select count(*) from kito_asks where error is not null and created_at > now() - interval '7 days'),
    'orders_paid',       (select count(*) from orders where status = 'paid'),
    'generated_at',      now()
  );
end $$;

-- 6. Workspaces table ---------------------------------------------------------
create or replace function public.admin_workspaces()
returns table(
  id uuid, name text, created_at timestamptz, status text, plan text, note text,
  owner_email text, owner_last_sign_in timestamptz, members int,
  wa_status text, wa_last_sync timestamptz, meta_status text, meta_last_sync timestamptz, last_error text,
  messages bigint, messages_7d bigint, last_message_at timestamptz, conversations bigint, orders bigint,
  spend_30d numeric, spend_currency text, kito_asks_30d bigint, kito_tokens_30d bigint,
  failed_events bigint, pending_events bigint)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
  select w.id, w.name, w.created_at,
         coalesce(s.status, 'active'), coalesce(s.plan, 'pilot'), s.note,
         o.email::text, o.last_sign_in_at,
         (select count(*)::int from memberships m where m.workspace_id = w.id),
         wa.status, wa.last_sync_at, ma.status, ma.last_sync_at,
         coalesce(wa.last_error, ma.last_error),
         (select count(*) from messages x where x.workspace_id = w.id),
         (select count(*) from messages x where x.workspace_id = w.id and x.sent_at > now() - interval '7 days'),
         (select max(x.sent_at) from messages x where x.workspace_id = w.id),
         (select count(*) from conversations c where c.workspace_id = w.id),
         (select count(*) from orders od where od.workspace_id = w.id and od.status = 'paid'),
         sp.spend, sp.currency,
         ka.n, ka.tokens,
         (select count(*) from raw_events r where r.workspace_id = w.id and r.processed_at is null
             and (r.status = 'failed' or r.attempts >= r.max_attempts)),
         (select count(*) from raw_events r where r.workspace_id = w.id and r.status = 'pending')
  from workspaces w
  left join workspace_admin_state s on s.workspace_id = w.id
  left join lateral (
    select u.email, u.last_sign_in_at from memberships m join auth.users u on u.id = m.user_id
    where m.workspace_id = w.id and m.role = 'owner' order by m.created_at limit 1) o on true
  left join lateral (
    select c.status, c.last_sync_at, c.last_error from connections c
    where c.workspace_id = w.id and c.provider = 'whatsapp' order by c.created_at desc limit 1) wa on true
  left join lateral (
    select c.status, c.last_sync_at, c.last_error from connections c
    where c.workspace_id = w.id and c.provider = 'meta_ads' order by c.created_at desc limit 1) ma on true
  left join lateral (
    select sum(a.spend) as spend, min(a.currency) as currency from ad_insights_daily a
    where a.workspace_id = w.id and a.day > current_date - 30) sp on true
  left join lateral (
    select count(*) as n,
           coalesce(sum(coalesce(k.input_tokens,0) + coalesce(k.output_tokens,0)),0)::bigint as tokens
    from kito_asks k where k.workspace_id = w.id and k.created_at > now() - interval '30 days') ka on true
  order by w.created_at desc;
end $$;

-- 7. One workspace in detail (no message bodies, no contact names) --------------
create or replace function public.admin_workspace_detail(p_ws uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select jsonb_build_object(
    'workspace', (select jsonb_build_object('id', w.id, 'name', w.name, 'created_at', w.created_at,
                    'currency', w.currency, 'timezone', w.timezone, 'language', w.language,
                    'fx_rate', w.fx_rate, 'status', coalesce(s.status,'active'),
                    'plan', coalesce(s.plan,'pilot'), 'note', s.note, 'state_updated_at', s.updated_at)
                  from workspaces w left join workspace_admin_state s on s.workspace_id = w.id where w.id = p_ws),
    'members', coalesce((select jsonb_agg(jsonb_build_object('email', u.email, 'role', m.role,
                    'joined', m.created_at, 'last_sign_in_at', u.last_sign_in_at) order by m.created_at)
                  from memberships m join auth.users u on u.id = m.user_id where m.workspace_id = p_ws), '[]'),
    'connections', coalesce((select jsonb_agg(jsonb_build_object('provider', c.provider, 'label', c.label,
                    'external_id', c.external_id, 'status', c.status, 'last_sync_at', c.last_sync_at,
                    'last_error', c.last_error, 'created_at', c.created_at) order by c.created_at)
                  from connections c where c.workspace_id = p_ws), '[]'),
    'wa_numbers', coalesce((select jsonb_agg(jsonb_build_object('display_phone', n.display_phone,
                    'phone_number_id', n.phone_number_id, 'waba_id', n.waba_id, 'coexistence', n.coexistence,
                    'history_status', n.history_status))
                  from wa_numbers n where n.workspace_id = p_ws), '[]'),
    'events', coalesce((select jsonb_agg(jsonb_build_object('status', e.status, 'n', e.n, 'newest', e.newest))
                  from (select status, count(*) n, max(received_at) newest from raw_events
                        where workspace_id = p_ws group by status) e), '[]'),
    'daily', (select jsonb_agg(jsonb_build_object('day', d::date,
                    'in',  (select count(*) from messages x where x.workspace_id = p_ws and x.direction = 'in'
                              and x.sent_at >= d and x.sent_at < d + interval '1 day'),
                    'out', (select count(*) from messages x where x.workspace_id = p_ws and x.direction = 'out'
                              and x.sent_at >= d and x.sent_at < d + interval '1 day')) order by d)
              from generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') d),
    'counts', jsonb_build_object(
        'contacts',      (select count(*) from contacts where workspace_id = p_ws),
        'conversations', (select count(*) from conversations where workspace_id = p_ws),
        'messages',      (select count(*) from messages where workspace_id = p_ws),
        'ads',           (select count(*) from ads where workspace_id = p_ws),
        'insight_days',  (select count(*) from ad_insights_daily where workspace_id = p_ws),
        'orders',        (select count(*) from orders where workspace_id = p_ws),
        'expenses',      (select count(*) from expenses where workspace_id = p_ws),
        'open_tasks',    (select count(*) from follow_up_tasks where workspace_id = p_ws and status = 'open'),
        'content_ideas', (select count(*) from content_ideas where workspace_id = p_ws),
        'kito_tagged',   (select count(*) from conversations where workspace_id = p_ws and kito_checked_at is not null)),
    'kito', jsonb_build_object(
        'asks_30d',      (select count(*) from kito_asks where workspace_id = p_ws and created_at > now() - interval '30 days'),
        'input_tokens_30d',  (select coalesce(sum(input_tokens),0) from kito_asks where workspace_id = p_ws and created_at > now() - interval '30 days'),
        'output_tokens_30d', (select coalesce(sum(output_tokens),0) from kito_asks where workspace_id = p_ws and created_at > now() - interval '30 days'),
        'errors_30d',    (select count(*) from kito_asks where workspace_id = p_ws and error is not null and created_at > now() - interval '30 days'),
        'runs', coalesce((select jsonb_agg(jsonb_build_object('ran_at', kr.ran_at, 'trigger', kr.trigger,
                    'checked', kr.checked, 'failed', kr.failed, 'remaining', kr.remaining) order by kr.ran_at desc)
                  from (select * from kito_runs where workspace_id = p_ws order by ran_at desc limit 5) kr), '[]')),
    'audit', coalesce((select jsonb_agg(jsonb_build_object('at', a.at, 'action', a.action,
                    'actor', u.email, 'details', a.details) order by a.at desc)
                  from (select * from admin_audit where workspace_id = p_ws order by at desc limit 20) a
                  left join auth.users u on u.id = a.actor), '[]')
  ) into r;
  return r;
end $$;

-- 8. Errors across the platform ------------------------------------------------
create or replace function public.admin_errors(p_limit int default 100)
returns table(at timestamptz, workspace_id uuid, workspace_name text, source text, detail text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
  select e.at, e.ws, w.name, e.source, e.detail from (
    select coalesce(r.last_attempt_at, r.received_at) as at, r.workspace_id as ws,
           'webhook:' || r.provider as source,
           coalesce(r.last_error, r.error, 'failed after ' || r.attempts || ' attempts') as detail
      from raw_events r
     where r.processed_at is null and (r.status = 'failed' or r.attempts >= r.max_attempts)
    union all
    select r.received_at, null, 'webhook:unrouted', 'Event for a number not linked to any workspace (' || coalesce(r.field, r.provider) || ')'
      from raw_events r where r.workspace_id is null
    union all
    select coalesce(c.last_sync_at, c.created_at), c.workspace_id, 'connection:' || c.provider,
           coalesce(c.last_error, 'status ' || c.status)
      from connections c where c.status <> 'active' or c.last_error is not null
    union all
    select k.created_at, k.workspace_id, 'kito-ask', k.error from kito_asks k where k.error is not null
    union all
    select kr.ran_at, kr.workspace_id, 'kito-run', kr.failed || ' chat(s) failed' || coalesce(': ' || kr.note, '')
      from kito_runs kr where kr.failed > 0
    union all
    select c.kito_checked_at, c.workspace_id, 'kito-tag', c.kito_error from conversations c where c.kito_error is not null
  ) e
  left join workspaces w on w.id = e.ws
  order by e.at desc nulls last
  limit greatest(1, least(p_limit, 500));
end $$;

-- 9. Actions --------------------------------------------------------------------
create or replace function public.admin_set_workspace_state(p_ws uuid, p_status text, p_plan text, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare before jsonb;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_status not in ('trial','active','suspended') then raise exception 'bad status %', p_status; end if;
  if not exists (select 1 from workspaces where id = p_ws) then raise exception 'no such workspace'; end if;
  select to_jsonb(s) - 'workspace_id' - 'updated_by' - 'updated_at' into before
    from workspace_admin_state s where s.workspace_id = p_ws;
  insert into workspace_admin_state(workspace_id, status, plan, note, updated_by, updated_at)
  values (p_ws, p_status, coalesce(nullif(trim(p_plan), ''), 'pilot'), nullif(trim(p_note), ''), auth.uid(), now())
  on conflict (workspace_id) do update
    set status = excluded.status, plan = excluded.plan, note = excluded.note,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  insert into admin_audit(actor, action, workspace_id, details)
  values (auth.uid(), 'set_state', p_ws, jsonb_build_object('before', before,
          'after', jsonb_build_object('status', p_status, 'plan', p_plan, 'note', p_note)));
end $$;

create or replace function public.admin_requeue_events(p_ws uuid)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  n := public.svc_requeue_failed_events(p_ws, 500);
  insert into admin_audit(actor, action, workspace_id, details)
  values (auth.uid(), 'requeue_events', p_ws, jsonb_build_object('requeued', n));
  return n;
end $$;

create or replace function public.admin_audit_log(p_limit int default 50)
returns table(at timestamptz, actor_email text, action text, workspace_name text, details jsonb)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
  select a.at, u.email::text, a.action, w.name, a.details
    from admin_audit a left join auth.users u on u.id = a.actor left join workspaces w on w.id = a.workspace_id
   order by a.at desc limit greatest(1, least(p_limit, 500));
end $$;

-- 10. Grants --------------------------------------------------------------------
revoke all on function public.is_platform_admin()                         from public, anon;
revoke all on function public.admin_overview()                            from public, anon;
revoke all on function public.admin_workspaces()                          from public, anon;
revoke all on function public.admin_workspace_detail(uuid)                from public, anon;
revoke all on function public.admin_errors(int)                           from public, anon;
revoke all on function public.admin_set_workspace_state(uuid,text,text,text) from public, anon;
revoke all on function public.admin_requeue_events(uuid)                  from public, anon;
revoke all on function public.admin_audit_log(int)                        from public, anon;
grant execute on function public.is_platform_admin()                         to authenticated;
grant execute on function public.admin_overview()                            to authenticated;
grant execute on function public.admin_workspaces()                          to authenticated;
grant execute on function public.admin_workspace_detail(uuid)                to authenticated;
grant execute on function public.admin_errors(int)                           to authenticated;
grant execute on function public.admin_set_workspace_state(uuid,text,text,text) to authenticated;
grant execute on function public.admin_requeue_events(uuid)                  to authenticated;
grant execute on function public.admin_audit_log(int)                        to authenticated;

-- 11. First platform admin: Daud (daudimaboni23@gmail.com)
insert into public.platform_admins(user_id)
select id from auth.users where email = 'daudimaboni23@gmail.com'
on conflict do nothing;

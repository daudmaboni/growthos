-- 0031_admin_insights — staff admin: business performance, AI usage & cost, onboarding follow-through,
-- import/data-quality monitoring. Additions only: no existing table, column, function or policy changes.
-- Same rules as 0012/0023: every admin_* function is SECURITY DEFINER and refuses unless the caller
-- is in platform_admins. Counts and labels only: no message bodies, contact names or Kito questions.

-- =====================================================================================
-- 1. Anthropic API usage log
-- =====================================================================================
-- One row per call to the Anthropic API, written by Edge Functions with the service role.
-- Holds usage numbers only: never the prompt, the reply, or the API key.
create table if not exists public.api_usage (
  id                 bigint generated always as identity primary key,
  at                 timestamptz not null default now(),
  workspace_id       uuid references public.workspaces(id) on delete set null,
  feature            text not null,          -- ask_kito, chat_analysis, reply_draft, content_ideas, receipt_reading
  model              text not null,
  input_tokens       int not null default 0, -- uncached input
  output_tokens      int not null default 0,
  cache_read_tokens  int not null default 0,
  cache_write_tokens int not null default 0,
  ok                 boolean not null,
  status             int,                    -- HTTP status from the API (null = network failure)
  error              text,                   -- short provider error message, never request content
  attempt            int not null default 1, -- 2+ = a retry/fallback of the same piece of work
  duration_ms        int,
  request_id         text,
  backfilled         boolean not null default false  -- copied from kito_asks history (one row per question)
);
create index if not exists api_usage_at_idx on public.api_usage (at desc);
create index if not exists api_usage_ws_at_idx on public.api_usage (workspace_id, at desc);
alter table public.api_usage enable row level security;
revoke all on public.api_usage from anon, authenticated;   -- service role writes; staff read through admin_* only

-- Prices staff can edit, USD per million tokens. Defaults: Anthropic's published list prices on
-- 19 Nov 2026. They change, so the admin page treats every cost as an estimate.
create table if not exists public.api_pricing (
  model              text primary key,       -- exact model id, e.g. claude-sonnet-5-5
  input_per_mtok     numeric not null check (input_per_mtok >= 0),
  output_per_mtok    numeric not null check (output_per_mtok >= 0),
  cache_read_per_mtok  numeric not null default 0 check (cache_read_per_mtok >= 0),
  cache_write_per_mtok numeric not null default 0 check (cache_write_per_mtok >= 0),
  long_over_tokens   int,                    -- prompts longer than this are billed at long_multiplier
  long_multiplier    numeric not null default 1 check (long_multiplier >= 1),
  updated_by         uuid references auth.users(id),
  updated_at         timestamptz not null default now()
);
alter table public.api_pricing enable row level security;
revoke all on public.api_pricing from anon, authenticated;
insert into public.api_pricing (model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, long_over_tokens, long_multiplier) values
  ('claude-sonnet-5-5', 2.00, 10.00, 0.10, 2.50,  null,   1),
  ('claude-haiku-5-5',  0.10,  0.50, 0.01, 0.125, 100000, 5),
  ('claude-opus-5-5',   4.00, 20.00, 0.20, 5.00,  null,   1)
on conflict (model) do nothing;

-- Platform-wide admin settings (budgets now; room for more later).
create table if not exists public.admin_settings (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
alter table public.admin_settings enable row level security;
revoke all on public.admin_settings from anon, authenticated;
insert into public.admin_settings (key, value) values
  ('api_budget', jsonb_build_object('monthly_usd', null, 'daily_usd', null, 'spike_multiplier', 3))
on conflict (key) do nothing;

-- Estimated cost of one usage row (USD). Null when the model has no price set.
create or replace function private.api_cost(u public.api_usage, p public.api_pricing)
returns numeric language sql immutable set search_path = public as $$
  select case when p.model is null then null else
    (u.input_tokens * p.input_per_mtok + u.output_tokens * p.output_per_mtok
     + u.cache_read_tokens * p.cache_read_per_mtok + u.cache_write_tokens * p.cache_write_per_mtok) / 1e6
    * case when p.long_over_tokens is not null
                and u.input_tokens + u.cache_read_tokens + u.cache_write_tokens > p.long_over_tokens
           then p.long_multiplier else 1 end
  end
$$;

-- History: Ask Kito already stored tokens per question. Copy it once so the cost page isn't empty.
-- (Older background labelling and receipt reading kept no token counts, so they start from today.)
insert into public.api_usage (at, workspace_id, feature, model, input_tokens, output_tokens, ok, error, backfilled)
select k.created_at, k.workspace_id, 'ask_kito', coalesce(k.model, 'claude-sonnet-5-5'),
       coalesce(k.input_tokens, 0), coalesce(k.output_tokens, 0), k.error is null, left(k.error, 300), true
  from public.kito_asks k
 where not exists (select 1 from public.api_usage x where x.backfilled);

-- =====================================================================================
-- 2. Staff follow-up tasks / notes per business
-- =====================================================================================
create table if not exists public.admin_tasks (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title        text not null check (length(trim(title)) between 1 and 500),
  due_on       date,
  done_at      timestamptz,
  done_by      uuid references auth.users(id),
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now()
);
create index if not exists admin_tasks_ws_idx on public.admin_tasks (workspace_id, created_at desc);
alter table public.admin_tasks enable row level security;
revoke all on public.admin_tasks from anon, authenticated;

-- =====================================================================================
-- 3. Business performance (aggregated funnel, diagnosis counts, coverage, trend)
-- =====================================================================================
-- Same definitions as the business app (web/src/metrics.ts, diagnosis.ts):
--   chats = chats started in the period (not-customers excluded); replied = business sent a message;
--   qualified = price shared; payment signals = inferred (words, screenshot, Kito, ✅), NOT confirmed;
--   confirmed orders / revenue = orders with status paid, counted by paid date.
create or replace function public.admin_performance(p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  d  int := greatest(1, least(coalesce(p_days, 30), 180));
  t0 timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 180)));
  tp timestamptz := now() - make_interval(days => 2 * greatest(1, least(coalesce(p_days, 30), 180)));
  r  jsonb;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  with paidc as (
    select distinct o.conversation_id from orders o where o.status = 'paid' and o.conversation_id is not null
  ), conv as (
    select c.workspace_id as ws, c.started_at >= t0 as cur, (c.started_at at time zone 'Africa/Dar_es_Salaam')::date as day,
           c.first_response_sec as frt, c.stage, c.price_shared, c.pay_instructions,
           (not (c.override_by is not null and c.outcome_override in ('open', 'lost'))
             and (c.payment_signal or c.kito_outcome = 'sold' or c.outcome_override = 'sold')) as sig,
           pc.conversation_id is not null as paid,
           c.source, c.kito_checked_at is not null as kito_read,
           coalesce(c.kito_label, c.label) as lbl,
           coalesce(case when c.kito_temp is not null then c.kito_temp <> 'cold' end, c.warm) as warm,
           c.followed_up, c.last_dir
      from conversations c
      join contacts ct on ct.id = c.contact_id
      left join paidc pc on pc.conversation_id = c.id
     where c.started_at >= tp and c.started_at < now() and not coalesce(ct.not_customer, false)
  ), agg as (
    select ws, cur,
           count(*) chats,
           count(*) filter (where frt is not null) replied,
           count(*) filter (where price_shared) qualified,
           count(*) filter (where sig) signals,
           count(*) filter (where sig and not paid) unconfirmed,
           count(*) filter (where stage = 'no_reply' and not paid) unanswered,
           count(*) filter (where frt > 3600) slow,
           percentile_cont(0.5) within group (order by frt) filter (where frt is not null) median_frt,
           count(*) filter (where stage = 'silent_after_price' and not paid) silent_after_price,
           count(*) filter (where pay_instructions) pay_details,
           count(*) filter (where lbl = 'awaiting_payment' and not paid) awaiting_payment,
           count(*) filter (where warm and not paid and not followed_up and last_dir = 'in') warm_no_follow,
           count(*) filter (where warm and not paid) warm,
           count(*) filter (where source = 'ad') ad_chats,
           count(*) filter (where source <> 'unknown') known_source,
           count(*) filter (where kito_read) kito_read
      from conv group by ws, cur
  ), ord as (
    select o.workspace_id ws, o.paid_at >= t0 as cur,
           count(*) n,
           coalesce(sum(o.amount - o.discount - o.refund_amount) filter (where o.currency = w.currency), 0) revenue,
           count(*) filter (where o.currency <> w.currency) other_currency,
           count(*) filter (where o.conversation_id is null) unlinked,
           count(*) filter (where o.cost is null and w.unit_cost is null) no_cost
      from orders o join workspaces w on w.id = o.workspace_id
     where o.status = 'paid' and o.paid_at >= tp and o.paid_at < now()
     group by 1, 2
  ), refunds as (
    select o.workspace_id ws, count(*) n from orders o
     where (o.status = 'refunded' or o.fulfillment_status = 'returned') and o.updated_at >= t0 group by 1
  ), spend as (
    select a.workspace_id ws, a.day >= t0::date as cur, sum(a.spend) spend, min(a.currency) currency
      from ad_insights_daily a where a.day >= tp::date group by 1, 2
  ), side as (
    select w.id ws, b.cur from workspaces w cross join (values (true), (false)) b(cur)
  ), per as (
    select s.ws, s.cur, jsonb_build_object(
             'chats', coalesce(a.chats, 0), 'replied', coalesce(a.replied, 0), 'qualified', coalesce(a.qualified, 0),
             'signals', coalesce(a.signals, 0), 'unconfirmed', coalesce(a.unconfirmed, 0),
             'orders', coalesce(o.n, 0), 'revenue', coalesce(o.revenue, 0), 'other_currency_orders', coalesce(o.other_currency, 0),
             'unlinked_orders', coalesce(o.unlinked, 0), 'orders_no_cost', coalesce(o.no_cost, 0),
             'unanswered', coalesce(a.unanswered, 0), 'slow', coalesce(a.slow, 0), 'median_frt', a.median_frt,
             'silent_after_price', coalesce(a.silent_after_price, 0), 'pay_details', coalesce(a.pay_details, 0),
             'awaiting_payment', coalesce(a.awaiting_payment, 0), 'warm', coalesce(a.warm, 0), 'warm_no_follow', coalesce(a.warm_no_follow, 0),
             'ad_chats', coalesce(a.ad_chats, 0), 'known_source', coalesce(a.known_source, 0), 'kito_read', coalesce(a.kito_read, 0),
             'spend', sp.spend, 'spend_currency', sp.currency) as m
      from side s
      left join agg a on a.ws = s.ws and a.cur = s.cur
      left join ord o on o.ws = s.ws and o.cur = s.cur
      left join spend sp on sp.ws = s.ws and sp.cur = s.cur
  ), days as (
    select g::date as day from generate_series((t0 at time zone 'Africa/Dar_es_Salaam')::date,
                                              (now() at time zone 'Africa/Dar_es_Salaam')::date, interval '1 day') g
  ), dconv as (
    select day, count(*) chats, count(*) filter (where frt is not null) replied, count(*) filter (where price_shared) qualified,
           count(*) filter (where sig) signals
      from conv where cur group by day
  ), dord as (
    select (paid_at at time zone 'Africa/Dar_es_Salaam')::date as day, count(*) n
      from orders where status = 'paid' and paid_at >= t0 and paid_at < now() group by 1
  )
  select jsonb_build_object(
    'days', d, 'from', t0, 'prev_from', tp, 'to', now(),
    'workspaces', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', w.id, 'name', w.name, 'currency', w.currency, 'fx_rate', w.fx_rate,
               'status', coalesce(st.status, 'active'),
               'cur', (select m from per where per.ws = w.id and per.cur),
               'prev', (select m from per where per.ws = w.id and not per.cur),
               'refunds', coalesce((select n from refunds where refunds.ws = w.id), 0),
               'profile_set', exists (select 1 from business_profiles bp where bp.workspace_id = w.id),
               'meta_connected', exists (select 1 from connections c where c.workspace_id = w.id and c.provider = 'meta_ads'),
               'wa_live', exists (select 1 from connections c where c.workspace_id = w.id and c.provider = 'whatsapp' and c.status = 'active'))
             order by w.created_at)
        from workspaces w left join workspace_admin_state st on st.workspace_id = w.id), '[]'),
    'daily', jsonb_build_object(
      'days',      (select jsonb_agg(day order by day) from days),
      'chats',     (select jsonb_agg(coalesce((select chats from dconv where dconv.day = days.day), 0) order by day) from days),
      'replied',   (select jsonb_agg(coalesce((select replied from dconv where dconv.day = days.day), 0) order by day) from days),
      'qualified', (select jsonb_agg(coalesce((select qualified from dconv where dconv.day = days.day), 0) order by day) from days),
      'signals',   (select jsonb_agg(coalesce((select signals from dconv where dconv.day = days.day), 0) order by day) from days),
      'orders',    (select jsonb_agg(coalesce((select n from dord where dord.day = days.day), 0) order by day) from days)),
    'generated_at', now()
  ) into r;
  return r;
end $$;

-- =====================================================================================
-- 4. API usage & estimated cost
-- =====================================================================================
create or replace function public.admin_api_usage(p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public, private as $$
declare
  d  int := greatest(1, least(coalesce(p_days, 30), 366));
  t0 timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 366)));
  m0 timestamptz := date_trunc('month', now() at time zone 'Africa/Dar_es_Salaam') at time zone 'Africa/Dar_es_Salaam';
  dd timestamptz := date_trunc('day', now() at time zone 'Africa/Dar_es_Salaam') at time zone 'Africa/Dar_es_Salaam';
  r  jsonb;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  with u as (
    select x.*, private.api_cost(x, p) as cost, p.model is not null as priced,
           (x.at at time zone 'Africa/Dar_es_Salaam')::date as day
      from api_usage x left join api_pricing p on p.model = x.model
     where x.at >= least(t0, m0, now() - interval '15 days')
  ), win as (select * from u where at >= t0),
  tot as (
    select count(*) calls, count(*) filter (where not ok) errors, count(*) filter (where attempt > 1) retries,
           coalesce(sum(input_tokens), 0) input_tokens, coalesce(sum(output_tokens), 0) output_tokens,
           coalesce(sum(cache_read_tokens), 0) cache_read_tokens, coalesce(sum(cache_write_tokens), 0) cache_write_tokens,
           coalesce(sum(cost), 0) cost, count(*) filter (where not priced) unpriced
      from win
  ), days as (
    select g::date as day from generate_series((t0 at time zone 'Africa/Dar_es_Salaam')::date,
                                              (now() at time zone 'Africa/Dar_es_Salaam')::date, interval '1 day') g
  ), byday as (select day, count(*) n, coalesce(sum(cost), 0) cost, count(*) filter (where not ok) errors from u group by day),
  base as (  -- typical day over the 14 full days before today (for spike alerts)
    select coalesce(avg(coalesce(b.cost, 0)), 0) avg_cost, coalesce(avg(coalesce(b.n, 0)), 0) avg_calls
      from generate_series((dd at time zone 'Africa/Dar_es_Salaam')::date - 14, (dd at time zone 'Africa/Dar_es_Salaam')::date - 1, interval '1 day') g
      left join byday b on b.day = g::date
  )
  select jsonb_build_object(
    'days', d, 'from', t0,
    'totals', (select to_jsonb(tot) from tot),
    'today', (select jsonb_build_object('calls', count(*), 'cost', coalesce(sum(cost), 0), 'errors', count(*) filter (where not ok)) from u where at >= dd),
    'month', (select jsonb_build_object('calls', count(*), 'cost', coalesce(sum(cost), 0), 'from', m0,
                'day_of_month', extract(day from now() at time zone 'Africa/Dar_es_Salaam')::int,
                'days_in_month', extract(day from (date_trunc('month', now() at time zone 'Africa/Dar_es_Salaam') + interval '1 month - 1 day'))::int)
              from u where at >= m0),
    'baseline', (select to_jsonb(base) from base),
    'daily', jsonb_build_object(
       'days',  (select jsonb_agg(day order by day) from days),
       'cost',  (select jsonb_agg(coalesce((select cost from byday b where b.day = days.day), 0) order by day) from days),
       'calls', (select jsonb_agg(coalesce((select n from byday b where b.day = days.day), 0) order by day) from days),
       'errors',(select jsonb_agg(coalesce((select errors from byday b where b.day = days.day), 0) order by day) from days)),
    'by_feature', coalesce((select jsonb_agg(to_jsonb(f) order by f.cost desc nulls last) from (
        select feature, count(*) calls, count(*) filter (where not ok) errors, count(*) filter (where attempt > 1) retries,
               sum(input_tokens + cache_read_tokens + cache_write_tokens) input_tokens, sum(output_tokens) output_tokens, coalesce(sum(cost), 0) cost
          from win group by feature) f), '[]'),
    'by_model', coalesce((select jsonb_agg(to_jsonb(f) order by f.cost desc nulls last) from (
        select model, bool_and(priced) priced, count(*) calls, count(*) filter (where not ok) errors,
               sum(input_tokens) input_tokens, sum(output_tokens) output_tokens,
               sum(cache_read_tokens) cache_read_tokens, sum(cache_write_tokens) cache_write_tokens, coalesce(sum(cost), 0) cost
          from win group by model) f), '[]'),
    'by_workspace', coalesce((select jsonb_agg(to_jsonb(f) order by f.cost desc nulls last) from (
        select win.workspace_id, w.name, count(*) calls, count(*) filter (where not ok) errors,
               sum(input_tokens + cache_read_tokens + cache_write_tokens) input_tokens, sum(output_tokens) output_tokens, coalesce(sum(cost), 0) cost,
               coalesce((select sum(u2.cost) from u u2 where u2.workspace_id is not distinct from win.workspace_id and u2.at >= dd), 0) cost_today,
               coalesce((select jsonb_object_agg(ff.feature, ff.cost) from (select feature, coalesce(sum(cost), 0) cost from win w2
                  where w2.workspace_id is not distinct from win.workspace_id group by feature) ff), '{}') by_feature
          from win left join workspaces w on w.id = win.workspace_id group by win.workspace_id, w.name) f), '[]'),
    'recent_errors', coalesce((select jsonb_agg(to_jsonb(e) order by e.at desc) from (
        select win.at, win.feature, win.model, win.status, win.error, win.attempt, w.name workspace_name
          from win left join workspaces w on w.id = win.workspace_id where not ok order by win.at desc limit 20) e), '[]'),
    'pricing', coalesce((select jsonb_agg(to_jsonb(p) - 'updated_by' || jsonb_build_object('updated_by_email', au.email) order by p.model)
        from api_pricing p left join auth.users au on au.id = p.updated_by), '[]'),
    'budget', (select value from admin_settings where key = 'api_budget'),
    'first_logged_at', (select min(at) from api_usage where not backfilled),
    'generated_at', now()
  ) into r;
  return r;
end $$;

create or replace function public.admin_set_api_price(p_model text, p_input numeric, p_output numeric,
  p_cache_read numeric default 0, p_cache_write numeric default 0, p_long_over int default null, p_long_multiplier numeric default 1)
returns void language plpgsql security definer set search_path = public as $$
declare before jsonb; m text := trim(p_model);
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if m is null or m = '' or length(m) > 100 then raise exception 'Give the exact model id, e.g. claude-sonnet-5-5.'; end if;
  if least(p_input, p_output, coalesce(p_cache_read, 0), coalesce(p_cache_write, 0)) < 0 then raise exception 'Prices can''t be negative.'; end if;
  select to_jsonb(p) - 'updated_by' - 'updated_at' into before from api_pricing p where p.model = m;
  insert into api_pricing (model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, long_over_tokens, long_multiplier, updated_by, updated_at)
  values (m, p_input, p_output, coalesce(p_cache_read, 0), coalesce(p_cache_write, 0), p_long_over, greatest(1, coalesce(p_long_multiplier, 1)), auth.uid(), now())
  on conflict (model) do update set input_per_mtok = excluded.input_per_mtok, output_per_mtok = excluded.output_per_mtok,
    cache_read_per_mtok = excluded.cache_read_per_mtok, cache_write_per_mtok = excluded.cache_write_per_mtok,
    long_over_tokens = excluded.long_over_tokens, long_multiplier = excluded.long_multiplier, updated_by = auth.uid(), updated_at = now();
  insert into admin_audit(actor, action, workspace_id, details)
  values (auth.uid(), 'set_api_price', null, jsonb_build_object('model', m, 'before', before,
    'after', jsonb_build_object('input', p_input, 'output', p_output, 'cache_read', p_cache_read, 'cache_write', p_cache_write,
                                'long_over', p_long_over, 'long_multiplier', p_long_multiplier)));
end $$;

create or replace function public.admin_set_api_budget(p_monthly_usd numeric, p_daily_usd numeric, p_spike_multiplier numeric default 3)
returns void language plpgsql security definer set search_path = public as $$
declare before jsonb; after jsonb;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(p_monthly_usd, 0) < 0 or coalesce(p_daily_usd, 0) < 0 then raise exception 'Budgets can''t be negative.'; end if;
  select value into before from admin_settings where key = 'api_budget';
  after := jsonb_build_object('monthly_usd', nullif(p_monthly_usd, 0), 'daily_usd', nullif(p_daily_usd, 0),
                              'spike_multiplier', greatest(1.5, least(coalesce(p_spike_multiplier, 3), 20)));
  insert into admin_settings (key, value, updated_by, updated_at) values ('api_budget', after, auth.uid(), now())
  on conflict (key) do update set value = excluded.value, updated_by = auth.uid(), updated_at = now();
  insert into admin_audit(actor, action, workspace_id, details)
  values (auth.uid(), 'set_api_budget', null, jsonb_build_object('before', before, 'after', after));
end $$;

-- =====================================================================================
-- 5. Onboarding follow-through: when each setup step was reached, plus staff tasks
-- =====================================================================================
create or replace function public.admin_onboarding()
returns table(workspace_id uuid, joined_at timestamptz, wa_at timestamptz, first_chat_at timestamptz,
              meta_at timestamptz, first_sale_at timestamptz, last_owner_sign_in timestamptz,
              open_tasks bigint, overdue_tasks bigint, next_task text, next_due date)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
  select w.id, w.created_at,
         (select min(c.created_at) from connections c where c.workspace_id = w.id and c.provider = 'whatsapp' and c.status = 'active'),
         (select min(c.started_at) from conversations c where c.workspace_id = w.id and c.phone_number_id <> 'import'),
         (select min(c.created_at) from connections c where c.workspace_id = w.id and c.provider = 'meta_ads' and c.status = 'active'),
         (select min(o.created_at) from orders o where o.workspace_id = w.id and o.status = 'paid'),
         (select max(u.last_sign_in_at) from memberships m join auth.users u on u.id = m.user_id where m.workspace_id = w.id),
         (select count(*) from admin_tasks t where t.workspace_id = w.id and t.done_at is null),
         (select count(*) from admin_tasks t where t.workspace_id = w.id and t.done_at is null and t.due_on < (now() at time zone 'Africa/Dar_es_Salaam')::date),
         (select t.title from admin_tasks t where t.workspace_id = w.id and t.done_at is null order by t.due_on nulls last, t.created_at limit 1),
         (select t.due_on from admin_tasks t where t.workspace_id = w.id and t.done_at is null order by t.due_on nulls last, t.created_at limit 1)
    from workspaces w;
end $$;

create or replace function public.admin_tasks_list(p_ws uuid default null, p_include_done boolean default false)
returns table(id uuid, workspace_id uuid, workspace_name text, title text, due_on date, done_at timestamptz,
              created_at timestamptz, created_by_email text, done_by_email text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
  select t.id, t.workspace_id, w.name, t.title, t.due_on, t.done_at, t.created_at, cu.email::text, du.email::text
    from admin_tasks t join workspaces w on w.id = t.workspace_id
    left join auth.users cu on cu.id = t.created_by left join auth.users du on du.id = t.done_by
   where (p_ws is null or t.workspace_id = p_ws) and (p_include_done or t.done_at is null)
   order by t.done_at is not null, t.due_on nulls last, t.created_at desc
   limit 300;
end $$;

create or replace function public.admin_add_task(p_ws uuid, p_title text, p_due date default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare tid uuid;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from workspaces where id = p_ws) then raise exception 'No such business.'; end if;
  if p_title is null or length(trim(p_title)) = 0 then raise exception 'Write what needs doing.'; end if;
  insert into admin_tasks (workspace_id, title, due_on, created_by) values (p_ws, left(trim(p_title), 500), p_due, auth.uid()) returning id into tid;
  insert into admin_audit(actor, action, workspace_id, details)
  values (auth.uid(), 'add_task', p_ws, jsonb_build_object('task', tid, 'title', left(trim(p_title), 500), 'due', p_due));
  return tid;
end $$;

create or replace function public.admin_set_task_done(p_task uuid, p_done boolean)
returns void language plpgsql security definer set search_path = public as $$
declare t admin_tasks;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into t from admin_tasks where id = p_task;
  if t.id is null then raise exception 'No such task.'; end if;
  update admin_tasks set done_at = case when p_done then now() end, done_by = case when p_done then auth.uid() end where id = p_task;
  insert into admin_audit(actor, action, workspace_id, details)
  values (auth.uid(), case when p_done then 'task_done' else 'task_reopened' end, t.workspace_id, jsonb_build_object('task', t.id, 'title', t.title));
end $$;

-- =====================================================================================
-- 6. Imports & data quality across businesses
-- =====================================================================================
create or replace function public.admin_data_quality(p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare t0 timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365))); r jsonb;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select jsonb_build_object(
    'imports', coalesce((select jsonb_agg(jsonb_build_object(
        'at', b.created_at, 'workspace_id', b.workspace_id, 'workspace_name', w.name, 'kind', b.kind,
        'created', b.created_count, 'skipped', b.skipped_count, 'rejected', b.rejected_count,
        'total', (b.summary->>'total')::int, 'duplicates', (b.summary->>'duplicates')::int,
        'matched', (b.summary->>'matched')::int, 'unmatched', (b.summary->>'unmatched')::int,
        'by', u.email) order by b.created_at desc)
      from (select * from import_batches where created_at >= t0 order by created_at desc limit 200) b
      join workspaces w on w.id = b.workspace_id left join auth.users u on u.id = b.created_by), '[]'),
    'workspaces', coalesce((select jsonb_agg(jsonb_build_object(
        'id', w.id, 'name', w.name,
        'imported_chats', (select count(*) from conversations c where c.workspace_id = w.id and c.phone_number_id = 'import'),
        'imported_chats_also_live', (select count(*) from conversations c where c.workspace_id = w.id and c.phone_number_id = 'import'
                                       and exists (select 1 from conversations l where l.workspace_id = w.id and l.contact_id = c.contact_id and l.phone_number_id <> 'import')),
        'chats_without_messages', (select count(*) from conversations c where c.workspace_id = w.id and c.last_message_at is null),
        'unknown_source_30d', (select count(*) from conversations c where c.workspace_id = w.id and c.source = 'unknown' and c.started_at >= now() - interval '30 days'),
        'chats_30d', (select count(*) from conversations c where c.workspace_id = w.id and c.started_at >= now() - interval '30 days'),
        'paid_unlinked', (select count(*) from orders o where o.workspace_id = w.id and o.status = 'paid' and o.conversation_id is null),
        'paid_no_cost', (select count(*) from orders o where o.workspace_id = w.id and o.status = 'paid' and o.cost is null) * (w.unit_cost is null)::int,
        'paid_total', (select count(*) from orders o where o.workspace_id = w.id and o.status = 'paid'),
        'unconfirmed_signals', (select count(*) from conversations c where c.workspace_id = w.id
                                   and (c.payment_signal or c.kito_outcome = 'sold' or c.outcome_override = 'sold')
                                   and not (c.override_by is not null and c.outcome_override in ('open', 'lost'))
                                   and not exists (select 1 from orders o where o.conversation_id = c.id and o.status = 'paid')),
        'kito_errors', (select count(*) from conversations c where c.workspace_id = w.id and c.kito_error is not null),
        'media_errors_30d', (select count(*) from messages m where m.workspace_id = w.id and m.media is not null
                               and m.media ? 'error' and m.media->>'error' is not null and m.sent_at >= now() - interval '30 days'),
        'missing', array_remove(array[
            case when exists (select 1 from connections c where c.workspace_id = w.id and c.provider = 'meta_ads') and w.fx_rate is null
                      and coalesce((select min(a.currency) from ad_insights_daily a where a.workspace_id = w.id), 'USD') <> w.currency then 'exchange rate' end,
            case when not exists (select 1 from business_profiles bp where bp.workspace_id = w.id) then 'business profile' end,
            case when not exists (select 1 from connections c where c.workspace_id = w.id and c.provider = 'meta_ads') then 'ad account' end,
            case when not exists (select 1 from connections c where c.workspace_id = w.id and c.provider = 'whatsapp' and c.status = 'active') then 'live WhatsApp' end
          ], null)) order by w.created_at)
      from workspaces w), '[]'),
    'generated_at', now()
  ) into r;
  return r;
end $$;

-- =====================================================================================
-- 7. Grants
-- =====================================================================================
revoke all on function private.api_cost(public.api_usage, public.api_pricing) from public, anon, authenticated;
revoke all on function public.admin_performance(int) from public, anon;
revoke all on function public.admin_api_usage(int) from public, anon;
revoke all on function public.admin_set_api_price(text, numeric, numeric, numeric, numeric, int, numeric) from public, anon;
revoke all on function public.admin_set_api_budget(numeric, numeric, numeric) from public, anon;
revoke all on function public.admin_onboarding() from public, anon;
revoke all on function public.admin_tasks_list(uuid, boolean) from public, anon;
revoke all on function public.admin_add_task(uuid, text, date) from public, anon;
revoke all on function public.admin_set_task_done(uuid, boolean) from public, anon;
revoke all on function public.admin_data_quality(int) from public, anon;
grant execute on function public.admin_performance(int) to authenticated;
grant execute on function public.admin_api_usage(int) to authenticated;
grant execute on function public.admin_set_api_price(text, numeric, numeric, numeric, numeric, int, numeric) to authenticated;
grant execute on function public.admin_set_api_budget(numeric, numeric, numeric) to authenticated;
grant execute on function public.admin_onboarding() to authenticated;
grant execute on function public.admin_tasks_list(uuid, boolean) to authenticated;
grant execute on function public.admin_add_task(uuid, text, date) to authenticated;
grant execute on function public.admin_set_task_done(uuid, boolean) to authenticated;
grant execute on function public.admin_data_quality(int) to authenticated;

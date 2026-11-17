-- Ask Kito: the owner asks any question about the business in plain Kiswahili or English and
-- Kito answers from the data. Kito writes SQL; the DATABASE computes every number.
--
-- Safety model (each layer holds on its own):
--   1. public.kito_query runs as the CALLER (security invoker): row-level security limits every
--      row to workspaces the signed-in user belongs to.
--   2. It checks membership of the requested workspace and pins it in the `kito.ws` setting;
--      every kito.* view filters on that setting, so one answer never mixes two businesses.
--   3. The transaction is switched to READ ONLY before the query runs: nothing can be written.
--   4. One SELECT/WITH statement only, kito.* views only, row cap; the role statement timeout applies.
--   5. Customer phone numbers are not in any view, and phone/payment numbers are masked in
--      message text before it leaves the database.

create schema if not exists kito;
revoke all on schema kito from public, anon;
grant usage on schema kito to authenticated, service_role;

create or replace function kito.ws() returns uuid language sql stable as $$
  select nullif(current_setting('kito.ws', true), '')::uuid
$$;

create or replace function kito.mask(t text) returns text language sql immutable as $$
  select regexp_replace(regexp_replace(regexp_replace(coalesce(t, ''),
    '(\+?255|\m0)[67][0-9]{2}[ -]?[0-9]{3}[ -]?[0-9]{3}', '[simu]', 'g'),
    '\m[0-9]{7,}\M', '[namba]', 'g'),
    '[^[:space:]]+@[^[:space:]]+\.[^[:space:]]+', '[email]', 'g')
$$;

-- ---------- Views Kito may read (all scoped to the pinned workspace) ----------
create or replace view kito.workspace with (security_invoker = true) as
select w.name, w.currency, w.timezone, w.language, w.fx_rate, w.unit_cost, w.follow_up_hours, w.conversion_window_days,
       (now() at time zone w.timezone)::date as today_local
from public.workspaces w where w.id = kito.ws();

create or replace view kito.business_profile with (security_invoker = true) as
select p.products, p.delivery_areas, p.payment_methods, p.tone, p.faqs, p.constraints
from public.business_profiles p where p.workspace_id = kito.ws();

create or replace view kito.chats with (security_invoker = true) as
select o.id as chat_id,
       o.contact_name as customer_name,
       o.source, o.source_label, o.ad_id, a.name as ad_name, a.adset_name, a.campaign_name,
       o.started_at, o.last_message_at, o.last_dir as last_message_from, o.last_out_at as last_business_message_at,
       round(extract(epoch from (now() - o.last_message_at)) / 3600)::int as hours_since_last_message,
       mc.customer_messages, mc.business_messages,
       o.first_response_sec,
       o.price_asked, o.price_shared, o.price_shared_at, o.replied_after_price,
       o.pay_instructions as payment_details_sent,
       o.payment_signal, o.payment_amount,
       o.objections as rule_objections, o.followed_up, o.stage as rule_stage, o.auto_outcome as rule_outcome,
       o.outcome_override as owner_outcome, o.override_note as owner_note,
       o.kito_outcome, o.kito_label, o.kito_temp, o.kito_blocker, o.kito_objections, o.kito_tags,
       o.kito_summary, o.kito_next, o.kito_confidence,
       o.outcome as final_outcome,
       o.paid_orders, o.sale_amount as paid_amount_net, o.first_paid_at, o.last_paid_at
from public.conversation_outcomes o
left join public.ads a on a.ad_id = o.ad_id
left join lateral (
  select count(*) filter (where m.direction = 'in') as customer_messages,
         count(*) filter (where m.direction = 'out') as business_messages
  from public.messages m where m.conversation_id = o.id
) mc on true
where o.workspace_id = kito.ws();

create or replace view kito.messages with (security_invoker = true) as
select m.conversation_id as chat_id,
       case m.direction when 'in' then 'customer' else 'business' end as sender,
       m.sent_at, m.type, kito.mask(m.body) as body
from public.messages m where m.workspace_id = kito.ws();

create or replace view kito.orders with (security_invoker = true) as
select o.id as order_id, o.conversation_id as chat_id, o.ad_id,
       o.amount, o.discount, o.refund_amount, (o.amount - o.discount - o.refund_amount) as net_amount, o.currency,
       o.status, o.fulfillment_status, o.product, o.items, o.occurred_at, o.paid_at, o.provenance, o.inferred_from
from public.orders o where o.workspace_id = kito.ws();

create or replace view kito.ads with (security_invoker = true) as
select a.ad_id, a.name as ad_name, a.adset_id, a.adset_name, a.campaign_id, a.campaign_name, a.updated_at
from public.ads a where a.workspace_id = kito.ws();

create or replace view kito.ad_daily with (security_invoker = true) as
select i.ad_id, i.day, i.spend, i.currency,
       case when i.currency = w.currency then i.spend when w.fx_rate is not null then i.spend * w.fx_rate end as spend_local,
       i.impressions, i.reach, i.clicks, i.messaging_conversations as meta_reported_chats
from public.ad_insights_daily i
join public.workspaces w on w.id = i.workspace_id
where i.workspace_id = kito.ws();

create or replace view kito.expenses with (security_invoker = true) as
select e.day, e.category, e.amount, e.currency, e.note from public.expenses e where e.workspace_id = kito.ws();

create or replace view kito.content_posts with (security_invoker = true) as
select p.id as post_id, p.platform, p.posted_at, p.caption, p.format, p.theme, p.hook, p.offer,
       p.reach, p.impressions, p.likes, p.comments, p.shares, p.saves, p.link_clicks, p.source_label
from public.content_posts p where p.workspace_id = kito.ws();

create or replace view kito.tasks with (security_invoker = true) as
select t.id as task_id, t.conversation_id as chat_id, t.title, t.status, t.due_at, t.snoozed_until,
       t.created_at, t.completed_at, t.draft_source
from public.follow_up_tasks t where t.workspace_id = kito.ws();

-- Per-ad funnel for a date range (same definitions as the Dashboard).
create or replace function kito.ad_performance(p_from date, p_to date)
returns table (ad_id text, ad_name text, campaign_name text, spend numeric, impressions bigint, clicks bigint,
               meta_reported_chats bigint, chats bigint, replied bigint, priced bigint, payment_signals bigint,
               attributed_sales bigint, attributed_revenue numeric, cost_per_sale numeric)
language sql stable security invoker set search_path = public as $$
  select * from public.ad_performance(kito.ws(), p_from, p_to)
$$;

revoke all on all tables in schema kito from public, anon;
revoke all on all functions in schema kito from public, anon;
grant select on all tables in schema kito to authenticated, service_role;
grant execute on all functions in schema kito to authenticated, service_role;

-- ---------- The one entry point ----------
create or replace function public.kito_query(p_ws uuid, p_sql text, p_max_rows int default 200)
returns jsonb language plpgsql volatile security invoker set search_path = kito, pg_temp as $$
declare
  q text := btrim(coalesce(p_sql, ''));
  lim int := least(greatest(coalesce(p_max_rows, 200), 1), 500);
  v_rows jsonb; n int;
begin
  if auth.uid() is null or not public.is_member(p_ws) then
    raise exception 'not a member of this workspace' using errcode = '42501';
  end if;
  q := regexp_replace(q, '(;\s*)+$', '');
  if length(q) > 8000 then raise exception 'query too long'; end if;
  if q !~* '^(select|with)\M' then raise exception 'only SELECT queries are allowed'; end if;
  if position(';' in q) > 0 then raise exception 'one statement only'; end if;
  if q ~ '(--|/\*)' then raise exception 'no comments in queries'; end if;
  if q ~* '\m(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|copy|call|execute|prepare|listen|notify|lock|vacuum|refresh|reindex|cluster|comment|security|set_config|current_setting|pg_sleep|dblink|lo_import|lo_export|into)\M'
    then raise exception 'that keyword is not allowed in Kito queries'; end if;
  if q ~* '\m(public|auth|vault|private|storage|extensions|graphql|graphql_public|realtime|cron|net|supabase_functions|pgsodium|information_schema|pg_catalog|pg_toast)\s*\.'
     or q ~* '\mpg_[a-z_]+' then
    raise exception 'only the kito views may be queried';
  end if;

  perform set_config('kito.ws', p_ws::text, true);
  set local transaction_read_only = on;

  execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb), count(*) from (select * from (%s) kito_q limit %s) t', q, lim)
    into v_rows, n;
  return jsonb_build_object('rows', v_rows, 'row_count', n, 'capped', n >= lim);
end $$;
revoke all on function public.kito_query(uuid, text, int) from public, anon;
grant execute on function public.kito_query(uuid, text, int) to authenticated;

-- ---------- Question log: what was asked, what Kito answered, which queries it ran ----------
create table public.kito_asks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  question text not null,
  answer jsonb,
  queries jsonb not null default '[]',      -- [{purpose, sql, rows, error}]
  model text,
  input_tokens int, output_tokens int,
  error text,
  created_at timestamptz not null default now()
);
create index kito_asks_ws_user_idx on public.kito_asks (workspace_id, user_id, created_at desc);
alter table public.kito_asks enable row level security;
-- Each person sees their own questions. Written only by the kito-ask function (service role).
create policy kito_asks_read on public.kito_asks for select using (user_id = auth.uid() and public.is_member(workspace_id));
revoke all on public.kito_asks from anon, authenticated;
grant select on public.kito_asks to authenticated;

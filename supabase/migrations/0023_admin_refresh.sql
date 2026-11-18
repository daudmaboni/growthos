-- 0023_admin_refresh — bring the Pondi admin dashboard up to date with the business app.
-- Covers what landed on the user side since 0013: Dualhook connections, replying from itaOS
-- (origin 'itaos', send_enabled, Dualhook API key), ✅ tick orders, payment screenshots (messages.media),
-- chat deletions, Kito reading new messages instantly, live vs imported chats, revenue.
-- Also: an index so per-business message counts stop scanning every message, stuck "processing"
-- events, staff management, send on/off per business, deleting empty workspaces, and
-- "suspended" now actually pauses the business app.
-- Still counts and labels only: no message bodies, contact names or Kito questions.

-- 0. Speed ---------------------------------------------------------------------------
create index if not exists messages_ws_sent_idx on public.messages (workspace_id, sent_at desc);
create index if not exists messages_media_idx on public.messages (workspace_id, sent_at desc) where media is not null;
create index if not exists messages_itaos_idx on public.messages (workspace_id, sent_at desc) where origin = 'itaos';

-- 1. Overview tiles --------------------------------------------------------------------
create or replace function public.admin_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'workspaces',        (select count(*) from workspaces),
    'workspaces_7d',     (select count(*) from workspaces where created_at > now() - interval '7 days'),
    'orphan_workspaces', (select count(*) from workspaces w where not exists (select 1 from memberships m where m.workspace_id = w.id)),
    'users',             (select count(*) from auth.users u where not exists (select 1 from platform_admins p where p.user_id = u.id)),
    'active_users_7d',   (select count(*) from auth.users u where last_sign_in_at > now() - interval '7 days'
                            and not exists (select 1 from platform_admins p where p.user_id = u.id)),
    'messages',          (select count(*) from messages),
    'messages_24h',      (select count(*) from messages where sent_at > now() - interval '24 hours'),
    'messages_7d',       (select count(*) from messages where sent_at > now() - interval '7 days'),
    'sent_itaos_7d',     (select count(*) from messages where origin = 'itaos' and sent_at > now() - interval '7 days'),
    'receipts_7d',       (select count(*) from messages where media is not null and media->'receipt'->>'is_receipt' = 'true'
                            and sent_at > now() - interval '7 days'),
    'wa_live',           (select count(distinct workspace_id) from connections where provider = 'whatsapp' and status = 'active'),
    'connections_active',(select count(*) from connections where status = 'active'),
    'connections_error', (select count(*) from connections where status <> 'active'),
    'failed_events',     (select count(*) from raw_events where processed_at is null and (status = 'failed' or attempts >= max_attempts)),
    'pending_events',    (select count(*) from raw_events where status = 'pending'),
    'stuck_events',      (select count(*) from raw_events where processed_at is null and status = 'processing'
                            and coalesce(last_attempt_at, received_at) < now() - interval '15 minutes'),
    'unrouted_events',   (select count(*) from raw_events where workspace_id is null),
    'kito_reads_24h',    (select coalesce(sum(checked), 0) from kito_runs where ran_at > now() - interval '24 hours'),
    'kito_read_fails_24h',(select coalesce(sum(failed), 0) from kito_runs where ran_at > now() - interval '24 hours'),
    'kito_asks_7d',      (select count(*) from kito_asks where created_at > now() - interval '7 days'),
    'kito_tokens_7d',    (select coalesce(sum(coalesce(input_tokens,0) + coalesce(output_tokens,0)),0) from kito_asks where created_at > now() - interval '7 days'),
    'kito_errors_7d',    (select count(*) from kito_asks where error is not null and created_at > now() - interval '7 days'),
    'orders_paid',       (select count(*) from orders where status = 'paid'),
    'orders_30d',        (select count(*) from orders where status = 'paid' and paid_at > now() - interval '30 days'),
    'tick_orders_30d',   (select count(*) from orders where status = 'paid' and inferred_from = 'tick' and paid_at > now() - interval '30 days'),
    'revenue_30d',       coalesce((select jsonb_object_agg(cur, amt) from (
                            select coalesce(currency, 'TZS') cur, sum(amount - discount - refund_amount) amt from orders
                             where status = 'paid' and paid_at > now() - interval '30 days' group by 1) r), '{}'),
    'generated_at',      now()
  );
end $$;

-- 2. Businesses table (new columns, so drop + recreate) ---------------------------------------
drop function if exists public.admin_workspaces();
create function public.admin_workspaces()
returns table(
  id uuid, name text, created_at timestamptz, status text, plan text, note text,
  owner_email text, owner_last_sign_in timestamptz, members int,
  wa_status text, wa_last_sync timestamptz, wa_via text, wa_phone text, send_enabled boolean, send_key boolean,
  meta_status text, meta_last_sync timestamptz, last_error text,
  messages bigint, messages_7d bigint, last_message_at timestamptz, last_customer_message_at timestamptz,
  conversations bigint, live_chats bigint, imported_chats bigint, sent_itaos_30d bigint, receipts_30d bigint,
  orders bigint, tick_orders bigint, revenue_30d numeric, revenue_total numeric, currency text,
  spend_30d numeric, spend_currency text, kito_asks_30d bigint, kito_tokens_30d bigint,
  kito_last_run timestamptz, kito_behind bigint,
  failed_events bigint, pending_events bigint, stuck_events bigint, settings_missing text[])
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
  select w.id, w.name, w.created_at,
         coalesce(s.status, 'active'), coalesce(s.plan, 'pilot'), s.note,
         o.email::text, o.last_sign_in_at,
         (select count(*)::int from memberships m where m.workspace_id = w.id),
         wa.status, wa.last_sync_at, coalesce(wa.meta->>'via', case when wa.id is not null then 'meta' end),
         (select n.display_phone from wa_numbers n where n.workspace_id = w.id order by n.created_at desc limit 1),
         w.send_enabled, (wa.meta ? 'api_key_secret_id'),
         ma.status, ma.last_sync_at,
         coalesce(wa.last_error, ma.last_error),
         (select count(*) from messages x where x.workspace_id = w.id),
         (select count(*) from messages x where x.workspace_id = w.id and x.sent_at > now() - interval '7 days'),
         (select max(c.last_message_at) from conversations c where c.workspace_id = w.id),
         (select x.sent_at from messages x where x.workspace_id = w.id and x.direction = 'in' order by x.sent_at desc limit 1),
         cv.total, cv.live, cv.imported,
         (select count(*) from messages x where x.workspace_id = w.id and x.origin = 'itaos' and x.sent_at > now() - interval '30 days'),
         (select count(*) from messages x where x.workspace_id = w.id and x.media is not null
             and x.media->'receipt'->>'is_receipt' = 'true' and x.sent_at > now() - interval '30 days'),
         od.paid, od.tick, od.rev_30d, od.rev_total, w.currency,
         sp.spend, sp.currency,
         ka.n, ka.tokens,
         (select max(kr.ran_at) from kito_runs kr where kr.workspace_id = w.id),
         (select count(*) from conversations c where c.workspace_id = w.id and c.phone_number_id <> 'import'
             and c.last_message_at > now() - interval '7 days'
             and (c.kito_checked_at is null or c.kito_checked_at < c.last_message_at)),
         (select count(*) from raw_events r where r.workspace_id = w.id and r.processed_at is null
             and (r.status = 'failed' or r.attempts >= r.max_attempts)),
         (select count(*) from raw_events r where r.workspace_id = w.id and r.status = 'pending'),
         (select count(*) from raw_events r where r.workspace_id = w.id and r.processed_at is null and r.status = 'processing'
             and coalesce(r.last_attempt_at, r.received_at) < now() - interval '15 minutes'),
         array_remove(array[
           case when ma.id is not null and w.fx_rate is null and coalesce(sp.currency, 'USD') <> w.currency then 'exchange rate' end,
           case when w.unit_cost is null then 'cost per order' end], null)
  from workspaces w
  left join workspace_admin_state s on s.workspace_id = w.id
  left join lateral (
    select u.email, u.last_sign_in_at from memberships m join auth.users u on u.id = m.user_id
    where m.workspace_id = w.id and m.role = 'owner' order by m.created_at limit 1) o on true
  left join lateral (
    select c.id, c.status, c.last_sync_at, c.last_error, c.meta from connections c
    where c.workspace_id = w.id and c.provider = 'whatsapp' order by c.created_at desc limit 1) wa on true
  left join lateral (
    select c.id, c.status, c.last_sync_at, c.last_error from connections c
    where c.workspace_id = w.id and c.provider = 'meta_ads' order by c.created_at desc limit 1) ma on true
  left join lateral (
    select count(*) total,
           count(*) filter (where c.phone_number_id <> 'import') live,
           count(*) filter (where c.phone_number_id = 'import') imported
    from conversations c where c.workspace_id = w.id) cv on true
  left join lateral (
    select count(*) filter (where x.status = 'paid') paid,
           count(*) filter (where x.status = 'paid' and x.inferred_from = 'tick') tick,
           coalesce(sum(x.amount - x.discount - x.refund_amount) filter (where x.status = 'paid' and x.paid_at > now() - interval '30 days'), 0) rev_30d,
           coalesce(sum(x.amount - x.discount - x.refund_amount) filter (where x.status = 'paid'), 0) rev_total
    from orders x where x.workspace_id = w.id) od on true
  left join lateral (
    select sum(a.spend) as spend, min(a.currency) as currency from ad_insights_daily a
    where a.workspace_id = w.id and a.day > current_date - 30) sp on true
  left join lateral (
    select count(*) as n,
           coalesce(sum(coalesce(k.input_tokens,0) + coalesce(k.output_tokens,0)),0)::bigint as tokens
    from kito_asks k where k.workspace_id = w.id and k.created_at > now() - interval '30 days') ka on true
  order by w.created_at desc;
end $$;

-- 3. One business in detail ----------------------------------------------------------------
create or replace function public.admin_workspace_detail(p_ws uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select jsonb_build_object(
    'workspace', (select jsonb_build_object('id', w.id, 'name', w.name, 'created_at', w.created_at,
                    'currency', w.currency, 'timezone', w.timezone, 'language', w.language,
                    'fx_rate', w.fx_rate, 'unit_cost', w.unit_cost, 'follow_up_hours', w.follow_up_hours,
                    'send_enabled', w.send_enabled, 'status', coalesce(s.status,'active'),
                    'plan', coalesce(s.plan,'pilot'), 'note', s.note, 'state_updated_at', s.updated_at)
                  from workspaces w left join workspace_admin_state s on s.workspace_id = w.id where w.id = p_ws),
    'members', coalesce((select jsonb_agg(jsonb_build_object('email', u.email, 'role', m.role,
                    'joined', m.created_at, 'last_sign_in_at', u.last_sign_in_at) order by m.created_at)
                  from memberships m join auth.users u on u.id = m.user_id where m.workspace_id = p_ws), '[]'),
    'connections', coalesce((select jsonb_agg(jsonb_build_object('provider', c.provider, 'label', c.label,
                    'external_id', c.external_id, 'status', c.status, 'last_sync_at', c.last_sync_at,
                    'last_error', c.last_error, 'created_at', c.created_at,
                    'via', coalesce(c.meta->>'via', case when c.provider = 'whatsapp' then 'meta' end),
                    'send_key', c.meta ? 'api_key_secret_id', 'send_key_set_at', c.meta->>'api_key_set_at',
                    'webhook_set_at', c.meta->>'webhook_set_at') order by c.created_at)
                  from connections c where c.workspace_id = p_ws), '[]'),
    'wa_numbers', coalesce((select jsonb_agg(jsonb_build_object('display_phone', n.display_phone,
                    'phone_number_id', n.phone_number_id, 'waba_id', n.waba_id, 'coexistence', n.coexistence,
                    'history_status', n.history_status, 'created_at', n.created_at,
                    'last_in', (select max(x.sent_at) from messages x join conversations c on c.id = x.conversation_id
                                 where c.workspace_id = p_ws and c.phone_number_id = n.phone_number_id
                                   and x.direction = 'in' and x.sent_at > now() - interval '30 days')))
                  from wa_numbers n where n.workspace_id = p_ws), '[]'),
    'events', coalesce((select jsonb_agg(jsonb_build_object('status', e.status, 'n', e.n, 'newest', e.newest))
                  from (select case when status = 'processing' and processed_at is null
                                     and coalesce(last_attempt_at, received_at) < now() - interval '15 minutes'
                                    then 'stuck' else status end as status,
                               count(*) n, max(received_at) newest from raw_events
                        where workspace_id = p_ws group by 1) e), '[]'),
    'daily', (with days as (select g::date d from generate_series(current_date - 13, current_date, interval '1 day') g),
                   m as (select (sent_at at time zone 'Africa/Dar_es_Salaam')::date d,
                                count(*) filter (where direction = 'in') i,
                                count(*) filter (where direction = 'out') o,
                                count(*) filter (where origin = 'itaos') s
                           from messages where workspace_id = p_ws and sent_at >= current_date - 14 group by 1)
              select jsonb_agg(jsonb_build_object('day', days.d, 'in', coalesce(m.i,0), 'out', coalesce(m.o,0), 'itaos', coalesce(m.s,0)) order by days.d)
              from days left join m on m.d = days.d),
    'counts', jsonb_build_object(
        'contacts',      (select count(*) from contacts where workspace_id = p_ws),
        'conversations', (select count(*) from conversations where workspace_id = p_ws),
        'live_chats',    (select count(*) from conversations where workspace_id = p_ws and phone_number_id <> 'import'),
        'imported_chats',(select count(*) from conversations where workspace_id = p_ws and phone_number_id = 'import'),
        'messages',      (select count(*) from messages where workspace_id = p_ws),
        'ads',           (select count(*) from ads where workspace_id = p_ws),
        'insight_days',  (select count(*) from ad_insights_daily where workspace_id = p_ws),
        'orders',        (select count(*) from orders where workspace_id = p_ws and status = 'paid'),
        'expenses',      (select count(*) from expenses where workspace_id = p_ws),
        'open_tasks',    (select count(*) from follow_up_tasks where workspace_id = p_ws and status = 'open'),
        'content_ideas', (select count(*) from content_ideas where workspace_id = p_ws),
        'kito_tagged',   (select count(*) from conversations where workspace_id = p_ws and kito_checked_at is not null)),
    'msg_origins', coalesce((select jsonb_object_agg(coalesce(origin, 'unknown'), n)
                  from (select origin, count(*) n from messages where workspace_id = p_ws group by 1) x), '{}'),
    'sales', jsonb_build_object(
        'revenue_30d', (select coalesce(sum(amount - discount - refund_amount), 0) from orders
                          where workspace_id = p_ws and status = 'paid' and paid_at > now() - interval '30 days'),
        'revenue_total', (select coalesce(sum(amount - discount - refund_amount), 0) from orders where workspace_id = p_ws and status = 'paid'),
        'last_paid_at', (select max(paid_at) from orders where workspace_id = p_ws and status = 'paid'),
        'by_source', coalesce((select jsonb_agg(jsonb_build_object('from', src, 'status', status, 'n', n, 'amount', amt) order by n desc)
                  from (select coalesce(inferred_from, case when import_batch_id is not null then 'import' else 'manual' end) src,
                               status, count(*) n, sum(amount - discount - refund_amount) amt
                          from orders where workspace_id = p_ws group by 1, 2) x), '[]')),
    'media', (select jsonb_build_object('saved', count(*) filter (where media ? 'path'),
                                        'receipts', count(*) filter (where media->'receipt'->>'is_receipt' = 'true'),
                                        'errors', count(*) filter (where media ? 'error' and media->>'error' is not null),
                                        'last_at', max(sent_at))
              from messages where workspace_id = p_ws and media is not null),
    'kito', jsonb_build_object(
        'asks_30d',      (select count(*) from kito_asks where workspace_id = p_ws and created_at > now() - interval '30 days'),
        'input_tokens_30d',  (select coalesce(sum(input_tokens),0) from kito_asks where workspace_id = p_ws and created_at > now() - interval '30 days'),
        'output_tokens_30d', (select coalesce(sum(output_tokens),0) from kito_asks where workspace_id = p_ws and created_at > now() - interval '30 days'),
        'errors_30d',    (select count(*) from kito_asks where workspace_id = p_ws and error is not null and created_at > now() - interval '30 days'),
        'reads_24h',     (select coalesce(sum(checked), 0) from kito_runs where workspace_id = p_ws and ran_at > now() - interval '24 hours'),
        'fails_24h',     (select coalesce(sum(failed), 0) from kito_runs where workspace_id = p_ws and ran_at > now() - interval '24 hours'),
        'behind',        (select count(*) from conversations c where c.workspace_id = p_ws and c.phone_number_id <> 'import'
                            and c.last_message_at > now() - interval '7 days'
                            and (c.kito_checked_at is null or c.kito_checked_at < c.last_message_at)),
        'runs', coalesce((select jsonb_agg(jsonb_build_object('ran_at', kr.ran_at, 'trigger', kr.trigger,
                    'checked', kr.checked, 'failed', kr.failed, 'remaining', kr.remaining) order by kr.ran_at desc)
                  from (select * from kito_runs where workspace_id = p_ws order by ran_at desc limit 6) kr), '[]')),
    'deletions', coalesce((select jsonb_agg(jsonb_build_object('at', d.created_at, 'via', d.via, 'chats', d.chats,
                    'messages', d.messages, 'by_origin', d.by_origin, 'orders_unlinked', d.orders_unlinked, 'by', u.email)
                    order by d.created_at desc)
                  from (select * from chat_deletions where workspace_id = p_ws order by created_at desc limit 10) d
                  left join auth.users u on u.id = d.user_id), '[]'),
    'imports', coalesce((select jsonb_agg(jsonb_build_object('at', b.created_at, 'kind', b.kind, 'created', b.created_count,
                    'skipped', b.skipped_count, 'rejected', b.rejected_count) order by b.created_at desc)
                  from (select * from import_batches where workspace_id = p_ws order by created_at desc limit 5) b), '[]'),
    'audit', coalesce((select jsonb_agg(jsonb_build_object('at', a.at, 'action', a.action,
                    'actor', u.email, 'details', a.details) order by a.at desc)
                  from (select * from admin_audit where workspace_id = p_ws order by at desc limit 20) a
                  left join auth.users u on u.id = a.actor), '[]')
  ) into r;
  return r;
end $$;

-- 4. Errors (adds stuck events, unread payment images, a time window) -------------------------
drop function if exists public.admin_errors(int);
create function public.admin_errors(p_limit int default 100, p_days int default 30)
returns table(at timestamptz, workspace_id uuid, workspace_name text, source text, detail text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare since timestamptz := now() - make_interval(days => greatest(1, least(p_days, 365)));
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
  select e.at, e.ws, w.name, e.source, e.detail from (
    select coalesce(r.last_attempt_at, r.received_at) as at, r.workspace_id as ws,
           'webhook:' || coalesce(r.field, r.provider) as source,
           coalesce(r.last_error, r.error, 'failed after ' || r.attempts || ' attempts') as detail
      from raw_events r
     where r.processed_at is null and (r.status = 'failed' or r.attempts >= r.max_attempts)
    union all
    select coalesce(r.last_attempt_at, r.received_at), r.workspace_id, 'stuck:' || coalesce(r.field, r.provider),
           'Started processing ' || to_char(coalesce(r.last_attempt_at, r.received_at) at time zone 'Africa/Dar_es_Salaam', 'DD Mon HH24:MI')
           || ' and never finished. Retry sends it back to the queue.'
      from raw_events r
     where r.processed_at is null and r.status = 'processing'
       and coalesce(r.last_attempt_at, r.received_at) < now() - interval '15 minutes'
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
    union all
    select m.sent_at, m.workspace_id, 'media', 'A photo or PDF from a customer could not be saved or read: ' || (m.media->>'error')
      from messages m where m.media is not null and m.media ? 'error' and m.media->>'error' is not null
  ) e
  left join workspaces w on w.id = e.ws
  where e.at is null or e.at >= since
  order by e.at desc nulls last
  limit greatest(1, least(p_limit, 500));
end $$;

-- 5. Activity (adds replies sent from itaOS and paid orders per day) ---------------------------
create or replace function public.admin_activity(p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d int := greatest(7, least(p_days, 90)); r jsonb;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  with days as (
    select g::date as day from generate_series(current_date - (d - 1), current_date, interval '1 day') g
  ), msg as (
    select (sent_at at time zone 'Africa/Dar_es_Salaam')::date as day, workspace_id,
           count(*) n, count(*) filter (where origin = 'itaos') s
      from messages where sent_at >= current_date - d group by 1, 2
  ), ord as (
    select (paid_at at time zone 'Africa/Dar_es_Salaam')::date as day, count(*) n
      from orders where status = 'paid' and paid_at >= current_date - d group by 1
  )
  select jsonb_build_object(
    'days',     (select jsonb_agg(day order by day) from days),
    'messages', (select jsonb_agg(coalesce((select sum(n) from msg where msg.day = days.day), 0) order by day) from days),
    'sent',     (select jsonb_agg(coalesce((select sum(s) from msg where msg.day = days.day), 0) order by day) from days),
    'orders',   (select jsonb_agg(coalesce((select n from ord where ord.day = days.day), 0) order by day) from days),
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

-- 6. Actions ---------------------------------------------------------------------------------
-- 6a. Turn replying-from-itaOS on/off for one business.
create or replace function public.admin_set_send_enabled(p_ws uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
declare before boolean;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select send_enabled into before from workspaces where id = p_ws;
  if not found then raise exception 'no such workspace'; end if;
  update workspaces set send_enabled = p_on where id = p_ws;
  insert into admin_audit(actor, action, workspace_id, details)
  values (auth.uid(), 'set_send', p_ws, jsonb_build_object('before', before, 'after', p_on));
end $$;

-- 6b. Delete a business. Only when nothing is connected and no customer photos are stored,
--     and the caller types the exact business name. Everything in the workspace goes with it.
create or replace function public.admin_delete_workspace(p_ws uuid, p_confirm text)
returns jsonb language plpgsql security definer set search_path = public, vault as $$
declare w public.workspaces; v jsonb;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into w from workspaces where id = p_ws;
  if w.id is null then raise exception 'No such business.'; end if;
  if p_confirm is distinct from w.name then raise exception 'Type the business name exactly to confirm.'; end if;
  if exists (select 1 from connections where workspace_id = p_ws) or exists (select 1 from wa_numbers where workspace_id = p_ws) then
    raise exception 'This business still has WhatsApp or Meta Ads connected. The owner must disconnect first.';
  end if;
  if exists (select 1 from messages where workspace_id = p_ws and media is not null) then
    raise exception 'This business has saved customer photos. Delete them from storage first.';
  end if;
  v := jsonb_build_object('name', w.name, 'created_at', w.created_at,
         'members', (select count(*) from memberships where workspace_id = p_ws),
         'chats', (select count(*) from conversations where workspace_id = p_ws),
         'messages', (select count(*) from messages where workspace_id = p_ws),
         'orders', (select count(*) from orders where workspace_id = p_ws));
  delete from workspaces where id = p_ws;
  insert into admin_audit(actor, action, workspace_id, details) values (auth.uid(), 'delete_workspace', null, v);
  return v;
end $$;

-- 6c. Staff (platform admins).
create or replace function public.admin_staff()
returns table(email text, added_at timestamptz, last_sign_in_at timestamptz, is_me boolean)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query select u.email::text, p.created_at, u.last_sign_in_at, p.user_id = auth.uid()
    from platform_admins p join auth.users u on u.id = p.user_id order by p.created_at;
end $$;

create or replace function public.admin_set_staff(p_email text, p_add boolean)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select id into uid from auth.users where lower(email) = lower(trim(p_email));
  if uid is null then raise exception 'No itaOS account uses %. Create the account first, then add it here.', trim(p_email); end if;
  if p_add then
    insert into platform_admins(user_id) values (uid) on conflict do nothing;
  else
    if uid = auth.uid() then raise exception 'You can''t remove yourself.'; end if;
    delete from platform_admins where user_id = uid;
  end if;
  insert into admin_audit(actor, action, workspace_id, details)
  values (auth.uid(), case when p_add then 'add_staff' else 'remove_staff' end, null, jsonb_build_object('email', lower(trim(p_email))));
end $$;

-- 7. "Suspended" now pauses the business app ----------------------------------------------------
-- Members can read their own business's status; the app shows a paused screen, and wa-send refuses.
create or replace function public.workspace_status(p_ws uuid)
returns text language sql stable security definer set search_path = public as $$
  select case when public.is_member(p_ws)
              then coalesce((select status from workspace_admin_state where workspace_id = p_ws), 'active') end;
$$;

-- 8. Grants ----------------------------------------------------------------------------------
revoke all on function public.admin_overview()                          from public, anon;
revoke all on function public.admin_workspaces()                        from public, anon;
revoke all on function public.admin_workspace_detail(uuid)              from public, anon;
revoke all on function public.admin_errors(int, int)                    from public, anon;
revoke all on function public.admin_activity(int)                       from public, anon;
revoke all on function public.admin_set_send_enabled(uuid, boolean)     from public, anon;
revoke all on function public.admin_delete_workspace(uuid, text)        from public, anon;
revoke all on function public.admin_staff()                             from public, anon;
revoke all on function public.admin_set_staff(text, boolean)            from public, anon;
revoke all on function public.workspace_status(uuid)                    from public, anon;
grant execute on function public.admin_overview()                       to authenticated;
grant execute on function public.admin_workspaces()                     to authenticated;
grant execute on function public.admin_workspace_detail(uuid)           to authenticated;
grant execute on function public.admin_errors(int, int)                 to authenticated;
grant execute on function public.admin_activity(int)                    to authenticated;
grant execute on function public.admin_set_send_enabled(uuid, boolean)  to authenticated;
grant execute on function public.admin_delete_workspace(uuid, text)     to authenticated;
grant execute on function public.admin_staff()                          to authenticated;
grant execute on function public.admin_set_staff(text, boolean)         to authenticated;
grant execute on function public.workspace_status(uuid)                 to authenticated, service_role;

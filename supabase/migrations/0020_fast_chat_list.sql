-- Customers page and Dashboard were slow on big numbers (14k+ chats): conversation_outcomes worked
-- out "who spoke last" and "when did we last reply" with two sub-queries per chat, for every chat,
-- before any filter or limit. The list query took ~9 s and hit the statement timeout, so the
-- Customers page showed "No chats here yet". Those two values are now kept on the chat itself
-- (written by reanalyze() whenever messages arrive), and the view just reads them.

alter table public.conversations add column if not exists last_dir text check (last_dir in ('in', 'out'));
alter table public.conversations add column if not exists last_out_at timestamptz;

update public.conversations c set
  last_dir = (select m.direction from public.messages m where m.conversation_id = c.id order by m.sent_at desc limit 1),
  last_out_at = (select max(m.sent_at) from public.messages m where m.conversation_id = c.id and m.direction = 'out');

create index if not exists conversations_ws_last_msg_idx on public.conversations (workspace_id, last_message_at desc nulls last);

create or replace view public.conversation_outcomes with (security_invoker = true) as
with paid as (
  select o.conversation_id,
         sum(o.amount - o.discount - o.refund_amount) as net, count(*) as n,
         max(o.paid_at) as last_paid_at, min(o.paid_at) as first_paid_at,
         (array_agg(o.provenance order by o.paid_at desc))[1] as provenance
  from public.orders o
  where o.status = 'paid' and o.conversation_id is not null
  group by o.conversation_id
)
select c.id, c.workspace_id, c.contact_id, c.phone_number_id, c.started_at, c.last_message_at, c.source, c.ad_id, c.ctwa_clid, c.referral,
  c.first_response_sec, c.price_asked, c.price_shared, c.price_shared_at, c.replied_after_price, c.pay_instructions, c.payment_signal,
  c.payment_amount, c.objections, c.followed_up, c.warm, c.stage, c.auto_outcome, c.outcome_override, c.analyzed_at, c.label,
  c.kito_outcome, c.kito_label, c.kito_amount, c.kito_objections, c.kito_tags, c.kito_summary, c.kito_next, c.kito_confidence,
  c.kito_checked_at, c.kito_error, c.source_label, c.kito_temp, c.kito_blocker, c.kito_evidence, c.override_by, c.override_at, c.override_note,
  ct.name as contact_name,
  coalesce(case when p.n > 0 then 'sold' end, c.outcome_override,
    case when coalesce(case when c.kito_confidence in ('high', 'medium') then c.kito_outcome end, c.auto_outcome) = 'open'
              and c.last_message_at < now() - interval '2 days' then 'lost'
         else coalesce(case when c.kito_confidence in ('high', 'medium') then c.kito_outcome end, c.auto_outcome) end) as outcome,
  p.net as sale_amount, p.provenance as sale_provenance, coalesce(p.n, 0::bigint) as paid_orders, p.first_paid_at, p.last_paid_at,
  c.last_dir, c.last_out_at
from public.conversations c
join public.contacts ct on ct.id = c.contact_id
left join paid p on p.conversation_id = c.id;

-- Tab counts for the Customers page in one call (the browser could only count the first 1,000).
create or replace function public.chat_counts(p_ws uuid, p_src text default 'any')
returns jsonb language sql stable security invoker set search_path = public as $$
  with o as (
    select * from public.conversation_outcomes
    where workspace_id = p_ws
      and (p_src = 'any' or (p_src = 'import' and phone_number_id = 'import') or (p_src = 'live' and phone_number_id <> 'import'))
  )
  select jsonb_build_object(
    'all', count(*),
    'follow', count(*) filter (where outcome is distinct from 'sold' and (kito_temp in ('hot', 'warm') or (kito_temp is null and warm))),
    'signals', count(*) filter (where paid_orders = 0
        and not (override_by is not null and outcome_override in ('open', 'lost'))
        and (payment_signal or kito_outcome = 'sold' or outcome_override = 'sold')),
    'open', count(*) filter (where outcome = 'open'),
    'sold', count(*) filter (where outcome = 'sold'),
    'lost', count(*) filter (where outcome = 'lost'),
    'imported', (select count(*) from public.conversations where workspace_id = p_ws and phone_number_id = 'import'))
  from o;
$$;
grant execute on function public.chat_counts(uuid, text) to authenticated;

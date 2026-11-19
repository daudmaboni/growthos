-- 19 Nov 2026 round:
--  * orders.cost: what this order cost the business (product + delivery), typed when confirming payment.
--    Contribution = revenue − ad spend − order costs − imported expenses. Replaces the one workspace-wide
--    "cost per order" box on the dashboard (workspaces.unit_cost stays as a fallback for older orders).
--  * workspaces.display_currency: show every amount on the dashboard in one currency (TZS or USD).
--  * contacts.not_customer: people the business talks money with who aren't buyers (bodaboda / delivery,
--    suppliers, staff, family). Marked once, they leave the customer lists, counts, dashboard and Kito.
--  * conversations.kito_party: Kito's guess of who the other person is, so the app can suggest the mark.
--  * Bought tab counts only chats with a recorded paid order (it also counted 178 chats the word rules
--    guessed as sold, so it never matched the dashboard's revenue).
--  * dashboard_conversations2 (the old one stays for older app builds): only the columns the dashboard reads, times as epoch seconds, no
--    not-customers. ~3x smaller payload.

alter table public.orders add column if not exists cost numeric check (cost is null or cost >= 0);
alter table public.workspaces add column if not exists display_currency text check (display_currency in ('TZS', 'USD'));
alter table public.contacts add column if not exists not_customer boolean not null default false;
alter table public.contacts add column if not exists not_customer_note text;
alter table public.contacts add column if not exists not_customer_at timestamptz;
alter table public.conversations add column if not exists kito_party text
  check (kito_party in ('customer', 'delivery', 'supplier', 'staff', 'personal', 'other'));

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
  case when ct.not_customer then 'not_customer' else
  coalesce(case when p.n > 0 then 'sold' end, c.outcome_override,
    case when coalesce(case when c.kito_confidence in ('high', 'medium') and c.kito_checked_at >= c.last_message_at then c.kito_outcome end, c.auto_outcome) = 'open'
              and c.last_message_at < now() - interval '2 days' then 'lost'
         else coalesce(case when c.kito_confidence in ('high', 'medium') and c.kito_checked_at >= c.last_message_at then c.kito_outcome end, c.auto_outcome) end) end as outcome,
  p.net as sale_amount, p.provenance as sale_provenance, coalesce(p.n, 0::bigint) as paid_orders, p.first_paid_at, p.last_paid_at,
  c.last_dir, c.last_out_at, c.ad_signal,
  ct.not_customer, c.kito_party
from public.conversations c
join public.contacts ct on ct.id = c.contact_id
left join paid p on p.conversation_id = c.id;

create or replace function public.chat_counts(p_ws uuid, p_src text default 'any')
returns jsonb language sql stable security invoker set search_path = public as $$
  with o as (
    select * from public.conversation_outcomes
    where workspace_id = p_ws
      and (p_src = 'any' or (p_src = 'import' and phone_number_id = 'import') or (p_src = 'live' and phone_number_id <> 'import'))
  )
  select jsonb_build_object(
    'all', count(*) filter (where not not_customer),
    'follow', count(*) filter (where not not_customer and outcome is distinct from 'sold' and (kito_temp in ('hot', 'warm') or (kito_temp is null and warm))),
    'signals', count(*) filter (where not not_customer and paid_orders = 0
        and not (override_by is not null and outcome_override in ('open', 'lost'))
        and (payment_signal or kito_outcome = 'sold' or outcome_override = 'sold')),
    'open', count(*) filter (where outcome = 'open'),
    'sold', count(*) filter (where paid_orders > 0 and not not_customer),   -- Bought = a sale you recorded, nothing else
    'lost', count(*) filter (where outcome = 'lost'),
    'not_customer', count(*) filter (where not_customer),
    'imported', (select count(*) from public.conversations where workspace_id = p_ws and phone_number_id = 'import'))
  from o;
$$;
grant execute on function public.chat_counts(uuid, text) to authenticated;

create or replace function public.dashboard_conversations2(p_ws uuid, p_from timestamptz)
returns json language sql stable security invoker set search_path = public as $$
  select json_build_object(
    'v', 2,
    'id', coalesce(json_agg(id), '[]'),
    'started_at', coalesce(json_agg(extract(epoch from started_at)::bigint), '[]'),
    'last_message_at', coalesce(json_agg(extract(epoch from last_message_at)::bigint), '[]'),
    'source', coalesce(json_agg(source), '[]'),
    'first_response_sec', coalesce(json_agg(first_response_sec), '[]'),
    'price_asked', coalesce(json_agg(price_asked), '[]'),
    'price_shared', coalesce(json_agg(price_shared), '[]'),
    'payment_signal', coalesce(json_agg(payment_signal), '[]'),
    'pay_instructions', coalesce(json_agg(pay_instructions), '[]'),
    'objections', coalesce(json_agg(nullif(objections, '{}')), '[]'),
    'kito_objections', coalesce(json_agg(nullif(kito_objections, '{}')), '[]'),
    'followed_up', coalesce(json_agg(followed_up), '[]'),
    'warm', coalesce(json_agg(warm), '[]'),
    'stage', coalesce(json_agg(stage), '[]'),
    'outcome_override', coalesce(json_agg(outcome_override), '[]'),
    'override_by', coalesce(json_agg(override_by is not null), '[]'),
    'label', coalesce(json_agg(label), '[]'),
    'kito_outcome', coalesce(json_agg(kito_outcome), '[]'),
    'kito_label', coalesce(json_agg(kito_label), '[]'),
    'kito_temp', coalesce(json_agg(kito_temp), '[]'),
    'kito_blocker', coalesce(json_agg(kito_blocker), '[]'),
    'kito_checked_at', coalesce(json_agg(extract(epoch from kito_checked_at)::bigint), '[]'),
    'last_dir', coalesce(json_agg(last_dir), '[]'),
    'outcome', coalesce(json_agg(outcome), '[]'),
    'sale_amount', coalesce(json_agg(sale_amount), '[]'),
    'paid_orders', coalesce(json_agg(paid_orders), '[]'),
    'first_paid_at', coalesce(json_agg(extract(epoch from first_paid_at)::bigint), '[]'),
    'last_out_at', coalesce(json_agg(extract(epoch from last_out_at)::bigint), '[]')
  )
  from (
    select * from public.conversation_outcomes
    where workspace_id = p_ws and started_at >= p_from and not not_customer
    order by started_at, id
  ) r;
$$;
revoke all on function public.dashboard_conversations2(uuid, timestamptz) from public, anon;
grant execute on function public.dashboard_conversations2(uuid, timestamptz) to authenticated;

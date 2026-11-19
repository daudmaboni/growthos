-- Mark a person as "not a customer" (or confirm they are one). Contacts have no update policy for
-- members, so this goes through one checked function. not_customer_at records that the owner decided,
-- so Kito's suggestion stops showing either way.

create or replace function public.set_not_customer(p_contact uuid, p_value boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_ws uuid;
begin
  select workspace_id into v_ws from public.contacts where id = p_contact;
  if v_ws is null or not public.can_edit(v_ws) then raise exception 'not allowed'; end if;
  update public.contacts
     set not_customer = p_value,
         not_customer_note = case when p_value then left(nullif(trim(p_note), ''), 120) else null end,
         not_customer_at = now()
   where id = p_contact;
  -- Open follow-up reminders for a not-customer are noise.
  if p_value then
    update public.follow_up_tasks t set status = 'dismissed'
      from public.conversations c
     where c.contact_id = p_contact and t.conversation_id = c.id and t.status in ('open', 'snoozed');
  end if;
end $$;
revoke all on function public.set_not_customer(uuid, boolean, text) from public, anon;
grant execute on function public.set_not_customer(uuid, boolean, text) to authenticated;

-- party_decided: the owner already said who this is, so don't show Kito's guess.
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
  ct.not_customer, c.kito_party, ct.not_customer_at is not null as party_decided, ct.not_customer_note
from public.conversations c
join public.contacts ct on ct.id = c.contact_id
left join paid p on p.conversation_id = c.id;

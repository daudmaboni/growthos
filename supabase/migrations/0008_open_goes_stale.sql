-- An "open" chat with no message for 2 days counts as lost, without needing a re-read.
create or replace view public.conversation_outcomes with (security_invoker = true) as
select c.*, ct.name as contact_name,
  coalesce(case when s.id is not null then 'sold' end, c.outcome_override,
    case when coalesce(case when c.kito_confidence in ('high','medium') then c.kito_outcome end, c.auto_outcome) = 'open'
              and c.last_message_at < now() - interval '2 days' then 'lost'
         else coalesce(case when c.kito_confidence in ('high','medium') then c.kito_outcome end, c.auto_outcome) end) as outcome,
  s.amount as sale_amount, s.provenance as sale_provenance,
  (select m.direction from public.messages m where m.conversation_id = c.id order by m.sent_at desc limit 1) as last_dir
from public.conversations c
join public.contacts ct on ct.id = c.contact_id
left join public.sales s on s.conversation_id = c.id;

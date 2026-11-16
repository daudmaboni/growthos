-- Kito's lead temperature and the single main blocker; who spoke last (for follow-up status)
alter table public.conversations
  add column kito_temp text check (kito_temp in ('hot','warm','cold')),
  add column kito_blocker text;
create index if not exists messages_conv_sent_idx on public.messages(conversation_id, sent_at desc);

drop view public.conversation_outcomes;
create view public.conversation_outcomes with (security_invoker = true) as
select c.*, ct.name as contact_name,
  coalesce(case when s.id is not null then 'sold' end, c.outcome_override,
           case when c.kito_confidence in ('high','medium') then c.kito_outcome end, c.auto_outcome) as outcome,
  s.amount as sale_amount, s.provenance as sale_provenance,
  (select m.direction from public.messages m where m.conversation_id = c.id order by m.sent_at desc limit 1) as last_dir
from public.conversations c
join public.contacts ct on ct.id = c.contact_id
left join public.sales s on s.conversation_id = c.id;
grant select on public.conversation_outcomes to authenticated;

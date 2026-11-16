-- Automatic label for where each chat stands (new, talking, priced, awaiting_payment, paid, shipped, received, using)
alter table public.conversations add column label text;
drop view public.conversation_outcomes;
create view public.conversation_outcomes with (security_invoker = true) as
select c.*,
  ct.name as contact_name,
  coalesce(case when s.id is not null then 'sold' end, c.outcome_override, c.auto_outcome) as outcome,
  s.amount as sale_amount, s.provenance as sale_provenance
from public.conversations c
join public.contacts ct on ct.id = c.contact_id
left join public.sales s on s.conversation_id = c.id;

-- Kito: the background AI that reads chats and labels them
alter table public.conversations
  add column kito_outcome text check (kito_outcome in ('sold','lost','open')),
  add column kito_label text,
  add column kito_amount numeric,
  add column kito_objections text[],
  add column kito_tags text[],
  add column kito_summary text,
  add column kito_next text,
  add column kito_confidence text check (kito_confidence in ('high','medium','low')),
  add column kito_checked_at timestamptz,
  add column kito_error text;
create index on public.conversations(workspace_id, kito_checked_at);

drop view public.conversation_outcomes;
create view public.conversation_outcomes with (security_invoker = true) as
select c.*,
  ct.name as contact_name,
  coalesce(
    case when s.id is not null then 'sold' end,
    c.outcome_override,
    case when c.kito_confidence in ('high','medium') then c.kito_outcome end,
    c.auto_outcome) as outcome,
  s.amount as sale_amount, s.provenance as sale_provenance
from public.conversations c
join public.contacts ct on ct.id = c.contact_id
left join public.sales s on s.conversation_id = c.id;
-- plus: cron.schedule('kito-15m', '*/15 * * * *', ...) calling /functions/v1/kito with the cron secret

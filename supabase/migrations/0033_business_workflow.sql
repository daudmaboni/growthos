-- 0033_business_workflow (applied in production as "0032_business_workflow") — business app: Needs-attention inbox, assignment of chats and orders,
-- delivery issues on orders. Additions only: no existing column, policy or function behaviour changes
-- (conversation_outcomes gains one column at the end; every existing column is unchanged).

-- =====================================================================================
-- 1. Assignment: who on the team owns a chat or an order (tasks already have assigned_to)
-- =====================================================================================
alter table public.conversations
  add column if not exists assigned_to uuid references auth.users(id) on delete set null,
  add column if not exists assigned_at timestamptz,
  add column if not exists assigned_by uuid references auth.users(id) on delete set null;
create index if not exists conversations_assigned_idx on public.conversations (workspace_id, assigned_to) where assigned_to is not null;

alter table public.orders
  add column if not exists assigned_to uuid references auth.users(id) on delete set null,
  -- Delivery problems the owner records next to the delivery status ("customer not reachable", "wrong item").
  add column if not exists delivery_issue text check (delivery_issue is null or length(delivery_issue) <= 500),
  add column if not exists delivery_issue_at timestamptz,
  add column if not exists delivery_resolved_at timestamptz;
create index if not exists orders_assigned_idx on public.orders (workspace_id, assigned_to) where assigned_to is not null;
create index if not exists orders_fulfil_idx on public.orders (workspace_id, fulfillment_status, paid_at) where status = 'paid';

-- History of chat assignments (orders are already audited row by row in order_events).
create table if not exists public.assignment_events (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  before_user  uuid,
  after_user   uuid,
  actor        uuid references auth.users(id) on delete set null,
  at           timestamptz not null default now()
);
create index if not exists assignment_events_ws_idx on public.assignment_events (workspace_id, at desc);
alter table public.assignment_events enable row level security;
drop policy if exists assignment_events_read on public.assignment_events;
create policy assignment_events_read on public.assignment_events for select using (public.is_member(workspace_id));
revoke all on public.assignment_events from anon, authenticated;
grant select on public.assignment_events to authenticated;

-- Assign (or unassign with null) a chat. Editors only; the assignee must belong to the same business.
create or replace function public.assign_chat(p_conv uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare c record;
begin
  select id, workspace_id, assigned_to into c from conversations where id = p_conv;
  if c.id is null then raise exception 'No such chat.'; end if;
  if not public.can_edit(c.workspace_id) then raise exception 'You need an editor role to assign chats.' using errcode = '42501'; end if;
  if p_user is not null and not exists (select 1 from memberships m where m.workspace_id = c.workspace_id and m.user_id = p_user) then
    raise exception 'That person is not on this business''s team.';
  end if;
  if c.assigned_to is not distinct from p_user then return; end if;
  update conversations set assigned_to = p_user, assigned_at = case when p_user is null then null else now() end,
         assigned_by = auth.uid() where id = p_conv;
  insert into assignment_events (workspace_id, conversation_id, before_user, after_user, actor)
  values (c.workspace_id, p_conv, c.assigned_to, p_user, auth.uid());
end $$;
revoke all on function public.assign_chat(uuid, uuid) from public, anon;
grant execute on function public.assign_chat(uuid, uuid) to authenticated;

-- Orders are edited directly (RLS: editors). Keep an order's assignee inside the team, and stamp
-- delivery-issue times. Separate trigger, so the existing orders_before_write is untouched.
create or replace function private.orders_workflow_check()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.assigned_to is not null and (tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to)
     and not exists (select 1 from memberships m where m.workspace_id = new.workspace_id and m.user_id = new.assigned_to) then
    raise exception 'That person is not on this business''s team.';
  end if;
  if new.delivery_issue is not null and (tg_op = 'INSERT' or new.delivery_issue is distinct from old.delivery_issue) then
    new.delivery_issue := nullif(trim(new.delivery_issue), '');
    if new.delivery_issue is not null then new.delivery_issue_at := now(); new.delivery_resolved_at := null; end if;
  end if;
  return new;
end $$;
drop trigger if exists orders_workflow_check on public.orders;
create trigger orders_workflow_check before insert or update on public.orders
  for each row execute function private.orders_workflow_check();

-- =====================================================================================
-- 2. conversation_outcomes: same columns as 0029, plus assigned_to at the end
-- =====================================================================================
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
  ct.not_customer, c.kito_party, ct.not_customer_at is not null as party_decided, ct.not_customer_note,
  c.assigned_to
from public.conversations c
join public.contacts ct on ct.id = c.contact_id
left join paid p on p.conversation_id = c.id;

-- =====================================================================================
-- 3. Needs attention: one list of things the business should act on
-- =====================================================================================
-- security invoker: row-level security decides what the caller sees (their own business only).
-- Payment signals stay signals here: they appear as "check and confirm", never as sales.
create or replace function public.needs_attention(p_ws uuid)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare r jsonb; me uuid := auth.uid();
begin
  if not public.is_member(p_ws) then raise exception 'not a member of this business' using errcode = '42501'; end if;
  with
  overdue as (
    select t.id, t.conversation_id, t.title, t.due_at, t.status, t.assigned_to, ct.name contact_name
      from follow_up_tasks t join conversations c on c.id = t.conversation_id join contacts ct on ct.id = c.contact_id
     where t.workspace_id = p_ws and t.status in ('open', 'snoozed')
       and (coalesce(t.snoozed_until, t.due_at) < now())
     order by coalesce(t.snoozed_until, t.due_at) limit 50
  ),
  signals as (
    select c.id, ct.name contact_name, c.last_message_at, coalesce(c.kito_amount, c.payment_amount) amount, c.assigned_to,
           case when c.kito_outcome = 'sold' then 'kito' when c.payment_signal then 'rules' else 'name_mark' end as via
      from conversations c join contacts ct on ct.id = c.contact_id
     where c.workspace_id = p_ws and not coalesce(ct.not_customer, false)
       and c.last_message_at > now() - interval '30 days'
       and (c.payment_signal or c.kito_outcome = 'sold' or c.outcome_override = 'sold')
       and not (c.override_by is not null and c.outcome_override in ('open', 'lost'))
       and not exists (select 1 from orders o where o.conversation_id = c.id and o.status = 'paid')
     order by c.last_message_at desc limit 50
  ),
  fulfil as (
    select o.id, o.conversation_id, ct.name contact_name, o.amount - o.discount - o.refund_amount net, o.currency, o.product,
           o.fulfillment_status, o.paid_at, o.delivery_issue, o.delivery_issue_at, o.assigned_to,
           case when o.delivery_issue is not null and o.delivery_resolved_at is null then 'issue'
                when o.fulfillment_status = 'returned' then 'returned'
                when o.fulfillment_status = 'not_shipped' then 'to_ship'
                else 'in_transit' end as why
      from orders o left join conversations c on c.id = o.conversation_id left join contacts ct on ct.id = c.contact_id
     where o.workspace_id = p_ws and o.status = 'paid' and o.paid_at > now() - interval '60 days'
       and ((o.delivery_issue is not null and o.delivery_resolved_at is null)
         or o.fulfillment_status = 'returned' and o.updated_at > now() - interval '14 days'
         or (o.fulfillment_status = 'not_shipped' and o.paid_at < now() - interval '1 day')
         or (o.fulfillment_status = 'shipped' and o.updated_at < now() - interval '5 days'))
     order by (o.delivery_issue is not null and o.delivery_resolved_at is null) desc, o.paid_at limit 50
  ),
  sync as (
    select 'connection' kind, c.provider ref, coalesce(c.last_error, 'status ' || c.status) detail, coalesce(c.last_sync_at, c.created_at) at
      from connections c where c.workspace_id = p_ws and (c.status not in ('active') or c.last_error is not null)
    union all
    select 'ads_stale', 'meta_ads', 'Ad numbers have not updated since ' || to_char(c.last_sync_at at time zone 'Africa/Dar_es_Salaam', 'DD Mon HH24:MI'), c.last_sync_at
      from connections c where c.workspace_id = p_ws and c.provider = 'meta_ads' and c.status = 'active' and c.last_error is null
       and c.last_sync_at < now() - interval '26 hours'
    union all
    select 'import', b.kind, b.rejected_count || ' rows rejected' || coalesce(', ' || (b.summary->>'duplicates') || ' duplicates', '') ||
           coalesce(' in ' || b.file_name, ''), b.created_at
      from import_batches b where b.workspace_id = p_ws and b.created_at > now() - interval '7 days' and b.rejected_count > 0
    union all
    select 'media', 'photos', count(*) || ' customer photo(s) could not be saved or read', max(m.sent_at)
      from messages m where m.workspace_id = p_ws and m.media is not null and m.media ? 'error' and m.media->>'error' is not null
       and m.sent_at > now() - interval '7 days' having count(*) > 0
  ),
  mine as (
    select 'chat' kind, c.id, ct.name contact_name, c.last_message_at at, c.last_dir
      from conversations c join contacts ct on ct.id = c.contact_id
     where c.workspace_id = p_ws and c.assigned_to = me and c.last_message_at > now() - interval '30 days'
       and not exists (select 1 from orders o where o.conversation_id = c.id and o.status = 'paid' and o.fulfillment_status in ('delivered', 'not_applicable'))
     order by c.last_message_at desc limit 30
  )
  select jsonb_build_object(
    'overdue',  coalesce((select jsonb_agg(to_jsonb(x)) from overdue x), '[]'),
    'signals',  coalesce((select jsonb_agg(to_jsonb(x)) from signals x), '[]'),
    'signals_total', (select count(*) from conversations c join contacts ct on ct.id = c.contact_id
                       where c.workspace_id = p_ws and not coalesce(ct.not_customer, false) and c.last_message_at > now() - interval '30 days'
                         and (c.payment_signal or c.kito_outcome = 'sold' or c.outcome_override = 'sold')
                         and not (c.override_by is not null and c.outcome_override in ('open', 'lost'))
                         and not exists (select 1 from orders o where o.conversation_id = c.id and o.status = 'paid')),
    'fulfil',   coalesce((select jsonb_agg(to_jsonb(x)) from fulfil x), '[]'),
    'sync',     coalesce((select jsonb_agg(to_jsonb(x) order by x.at desc nulls last) from sync x), '[]'),
    'mine',     coalesce((select jsonb_agg(to_jsonb(x)) from mine x), '[]'),
    'mine_orders', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'conversation_id', o.conversation_id, 'contact_name', ct.name,
                    'fulfillment_status', o.fulfillment_status, 'paid_at', o.paid_at, 'net', o.amount - o.discount - o.refund_amount, 'currency', o.currency))
                  from orders o left join conversations c on c.id = o.conversation_id left join contacts ct on ct.id = c.contact_id
                  where o.workspace_id = p_ws and o.assigned_to = me and o.status = 'paid' and o.fulfillment_status in ('not_shipped', 'shipped')), '[]'),
    'generated_at', now()
  ) into r;
  return r;
end $$;
revoke all on function public.needs_attention(uuid) from public, anon;
grant execute on function public.needs_attention(uuid) to authenticated;

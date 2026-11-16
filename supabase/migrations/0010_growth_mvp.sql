-- GrowthOS MVP: roles, confirmed orders as the sales source of truth (with audit trail),
-- CSV import batches and expenses, bounded webhook retries with a controlled replay path,
-- follow-up task history, the business profile, and a content-intelligence foundation.
-- Forward-only. Existing rows in public.sales are copied into public.orders; the old table
-- is kept (renamed) so nothing is lost.

-- =====================================================================================
-- 1. Roles. viewers read; analysts/admins/owners edit; admins/owners manage settings.
-- =====================================================================================
create or replace function public.member_role(ws uuid)
returns text language sql stable security definer set search_path = public as $$
  select m.role from public.memberships m where m.workspace_id = ws and m.user_id = auth.uid() limit 1;
$$;
create or replace function public.can_edit(ws uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.member_role(ws) in ('owner','admin','analyst'), false);
$$;
create or replace function public.can_manage(ws uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.member_role(ws) in ('owner','admin'), false);
$$;
revoke all on function public.member_role(uuid), public.can_edit(uuid), public.can_manage(uuid) from public, anon;
grant execute on function public.member_role(uuid), public.can_edit(uuid), public.can_manage(uuid) to authenticated, service_role;

-- Workspace settings may only be changed by owners/admins; conversations only by editors.
drop policy if exists ws_update on public.workspaces;
create policy ws_update on public.workspaces for update
  using (public.can_manage(id)) with check (public.can_manage(id));
drop policy if exists cv_update on public.conversations;
create policy cv_update on public.conversations for update
  using (public.can_edit(workspace_id)) with check (public.can_edit(workspace_id));

-- Reporting rules the owner can tune (used by the deterministic metrics, never by AI).
alter table public.workspaces
  add column if not exists follow_up_hours int not null default 24 check (follow_up_hours between 1 and 720),
  add column if not exists conversion_window_days int not null default 30 check (conversion_window_days between 1 and 180);
comment on column public.workspaces.follow_up_hours is 'A warm chat with no business message for this many hours is due for follow-up.';
comment on column public.workspaces.conversion_window_days is 'A paid order counts as attributed to a chat only if paid within this many days of the chat starting.';

-- =====================================================================================
-- 2. Orders: the only source of confirmed revenue. Inferred payment signals stay on
--    conversations (payment_signal, kito_outcome) and never become orders by themselves.
-- =====================================================================================
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid,                                  -- optional link to a chat (same workspace, enforced below)
  contact_id uuid references public.contacts(id) on delete set null,
  ad_id text,                                            -- ad referral when known (copied from the chat or imported)
  amount numeric not null check (amount >= 0),
  discount numeric not null default 0 check (discount >= 0),
  refund_amount numeric not null default 0 check (refund_amount >= 0),
  currency text not null,
  status text not null default 'paid' check (status in ('pending','paid','refunded','cancelled')),
  fulfillment_status text not null default 'not_applicable'
    check (fulfillment_status in ('not_applicable','not_shipped','shipped','delivered','returned')),
  items jsonb not null default '[]',                     -- [{name, qty, unit_price}]
  product text,
  notes text,
  occurred_at timestamptz not null default now(),        -- when the order was placed
  paid_at timestamptz,                                   -- when payment was confirmed (required for status = paid)
  provenance text not null default 'manual' check (provenance in ('manual','csv_import','provider','inferred')),
  inferred_from text check (inferred_from in ('rules','kito','name_mark')),  -- what the owner confirmed, if anything
  external_ref text,                                     -- import/provider reference used to stop duplicates
  import_batch_id uuid,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_conversation_workspace_fk foreign key (workspace_id, conversation_id)
    references public.conversations (workspace_id, id) on delete set null,
  constraint orders_paid_needs_paid_at check (status <> 'paid' or paid_at is not null)
);
create index orders_ws_paid_idx on public.orders (workspace_id, status, paid_at);
create index orders_conversation_idx on public.orders (conversation_id);
create unique index orders_external_ref_uniq on public.orders (workspace_id, external_ref) where external_ref is not null;
comment on table public.orders is 'Confirmed sales. Revenue = sum(amount - discount - refund_amount) where status = paid.';

-- Append-only audit trail written by a trigger, never by clients.
create table public.order_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  order_id uuid not null,
  action text not null check (action in ('insert','update','delete')),
  actor uuid,
  at timestamptz not null default now(),
  before jsonb,
  after jsonb
);
create index order_events_order_idx on public.order_events (order_id, at desc);

create or replace function private.orders_before_write()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if new.workspace_id <> old.workspace_id then raise exception 'orders cannot move between workspaces'; end if;
    if new.provenance <> old.provenance then raise exception 'order provenance cannot change'; end if;
    if new.created_by is distinct from old.created_by then raise exception 'order creator cannot change'; end if;
    new.created_at := old.created_at;
  else
    if new.created_by is null then new.created_by := auth.uid(); end if;
  end if;
  if new.status = 'paid' and new.paid_at is null then new.paid_at := coalesce(new.occurred_at, now()); end if;
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  -- Keep the ad referral consistent with the linked chat when the order does not say otherwise.
  if new.conversation_id is not null and new.ad_id is null then
    select c.ad_id, c.contact_id into new.ad_id, new.contact_id from public.conversations c where c.id = new.conversation_id;
  end if;
  return new;
end $$;
create trigger orders_before_write before insert or update on public.orders
  for each row execute function private.orders_before_write();

create or replace function private.orders_audit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.order_events(workspace_id, order_id, action, actor, after) values (new.workspace_id, new.id, 'insert', auth.uid(), to_jsonb(new));
    return new;
  elsif tg_op = 'UPDATE' then
    insert into public.order_events(workspace_id, order_id, action, actor, before, after) values (new.workspace_id, new.id, 'update', auth.uid(), to_jsonb(old), to_jsonb(new));
    return new;
  else
    insert into public.order_events(workspace_id, order_id, action, actor, before) values (old.workspace_id, old.id, 'delete', auth.uid(), to_jsonb(old));
    return old;
  end if;
end $$;
create trigger orders_audit after insert or update or delete on public.orders
  for each row execute function private.orders_audit();

-- Copy the v0.1 sales records, then retire the old table (kept for safety; no longer written).
insert into public.orders (id, workspace_id, conversation_id, amount, currency, status, occurred_at, paid_at, provenance, created_by, updated_by, created_at, updated_at, notes)
select s.id, s.workspace_id, s.conversation_id, s.amount, s.currency, 'paid', s.occurred_at, s.occurred_at,
       case s.provenance when 'import' then 'csv_import' when 'auto_detected' then 'inferred' else 'manual' end,
       s.confirmed_by, s.confirmed_by, s.created_at, s.created_at, 'migrated from sales v0.1'
from public.sales s;
alter table public.sales rename to sales_legacy_v01;
comment on table public.sales_legacy_v01 is 'Retired in migration 0010. Rows were copied to public.orders. Safe to drop after verification.';

alter table public.orders enable row level security;
alter table public.order_events enable row level security;
create policy orders_read on public.orders for select using (public.is_member(workspace_id));
-- Browser users can only record manual confirmations as themselves. Imports and provider
-- records are written by Edge Functions with the service role after their own checks.
create policy orders_insert on public.orders for insert
  with check (public.can_edit(workspace_id) and provenance = 'manual' and (created_by is null or created_by = auth.uid()));
create policy orders_update on public.orders for update
  using (public.can_edit(workspace_id)) with check (public.can_edit(workspace_id));
-- No client delete: corrections are status changes so the audit trail stays complete.
create policy order_events_read on public.order_events for select using (public.is_member(workspace_id));
revoke all on public.orders, public.order_events from anon, authenticated;
grant select, insert, update on public.orders to authenticated;
grant select on public.order_events to authenticated;

-- =====================================================================================
-- 3. Expenses (for contribution profit) and import batches (CSV provenance)
-- =====================================================================================
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  day date not null,
  category text not null default 'other' check (category in ('product','delivery','packaging','staff','ads_other','other')),
  amount numeric not null check (amount >= 0),
  currency text not null,
  note text,
  external_ref text,
  import_batch_id uuid,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index expenses_ws_day_idx on public.expenses (workspace_id, day);
create unique index expenses_external_ref_uniq on public.expenses (workspace_id, external_ref) where external_ref is not null;
alter table public.expenses enable row level security;
create policy expenses_read on public.expenses for select using (public.is_member(workspace_id));
create policy expenses_insert on public.expenses for insert with check (public.can_edit(workspace_id) and (created_by is null or created_by = auth.uid()));
create policy expenses_update on public.expenses for update using (public.can_edit(workspace_id)) with check (public.can_edit(workspace_id));
create policy expenses_delete on public.expenses for delete using (public.can_edit(workspace_id));
revoke all on public.expenses from anon, authenticated;
grant select, insert, update, delete on public.expenses to authenticated;

create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in ('orders','expenses','inquiries','content')),
  file_name text,
  created_count int not null default 0,
  skipped_count int not null default 0,
  rejected_count int not null default 0,
  summary jsonb not null default '{}',                   -- counts and anonymised reasons only; never row data
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index import_batches_ws_idx on public.import_batches (workspace_id, created_at desc);
alter table public.import_batches enable row level security;
create policy import_batches_read on public.import_batches for select using (public.is_member(workspace_id));
revoke all on public.import_batches from anon, authenticated;
grant select on public.import_batches to authenticated;   -- written by the csv-import function only

-- =====================================================================================
-- 4. Conversations: evidence behind a label, owner corrections with provenance
-- =====================================================================================
alter table public.conversations
  add column if not exists kito_evidence text[],                 -- short quotes Kito used for its outcome
  add column if not exists override_by uuid references auth.users(id),
  add column if not exists override_at timestamptz,
  add column if not exists override_note text;
-- Members may change only the correction columns (the analyzer and Kito own the rest).
revoke update on public.conversations from authenticated;
grant update (outcome_override, override_note) on public.conversations to authenticated;

create or replace function private.conversation_override_stamp()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.outcome_override is distinct from old.outcome_override or new.override_note is distinct from old.override_note then
    new.override_by := auth.uid();           -- null when set by a server job (e.g. the ✅ name mark)
    new.override_at := now();
  end if;
  return new;
end $$;
create trigger conversation_override_stamp before update on public.conversations
  for each row execute function private.conversation_override_stamp();

-- =====================================================================================
-- 5. Reporting view: confirmed revenue comes from orders only
-- =====================================================================================
drop view if exists public.conversation_outcomes;
create view public.conversation_outcomes with (security_invoker = true) as
with paid as (
  select o.conversation_id,
         sum(o.amount - o.discount - o.refund_amount) as net,
         count(*) as n,
         max(o.paid_at) as last_paid_at,
         min(o.paid_at) as first_paid_at,
         (array_agg(o.provenance order by o.paid_at desc))[1] as provenance
  from public.orders o
  where o.status = 'paid' and o.conversation_id is not null
  group by o.conversation_id
)
select c.*, ct.name as contact_name,
  coalesce(case when p.n > 0 then 'sold' end, c.outcome_override,
    case when coalesce(case when c.kito_confidence in ('high','medium') then c.kito_outcome end, c.auto_outcome) = 'open'
              and c.last_message_at < now() - interval '2 days' then 'lost'
         else coalesce(case when c.kito_confidence in ('high','medium') then c.kito_outcome end, c.auto_outcome) end) as outcome,
  p.net as sale_amount,
  p.provenance as sale_provenance,
  coalesce(p.n, 0) as paid_orders,
  p.first_paid_at,
  p.last_paid_at,
  (select m.direction from public.messages m where m.conversation_id = c.id order by m.sent_at desc limit 1) as last_dir,
  (select max(m.sent_at) from public.messages m where m.conversation_id = c.id and m.direction = 'out') as last_out_at
from public.conversations c
join public.contacts ct on ct.id = c.contact_id
left join paid p on p.conversation_id = c.id;
grant select on public.conversation_outcomes to authenticated;

-- Per-ad performance in the workspace's own timezone. "attributed" sales are paid orders linked
-- to a chat that started in the period and was paid inside the conversion window: a matched
-- estimate, not proof the ad caused the purchase.
drop function if exists public.ad_performance(uuid, date, date);
create or replace function public.ad_performance(p_ws uuid, p_from date, p_to date)
returns table (ad_id text, ad_name text, campaign_name text, spend numeric, impressions bigint, clicks bigint,
               platform_conversations bigint, chats bigint, replied bigint, priced bigint, payment_signals bigint,
               sold bigint, revenue numeric, cost_per_sale numeric)
language sql stable security invoker set search_path = public as $$
  with w as (select timezone as tz, conversion_window_days as win from public.workspaces where id = p_ws),
  sp as (
    select i.ad_id, sum(i.spend) spend, sum(i.impressions) impressions, sum(i.clicks) clicks, sum(i.messaging_conversations) conv
    from public.ad_insights_daily i where i.workspace_id = p_ws and i.day between p_from and p_to group by i.ad_id
  ), ch as (
    select o.ad_id, count(*) chats,
           count(*) filter (where o.first_response_sec is not null) replied,
           count(*) filter (where o.price_shared) priced,
           count(*) filter (where o.payment_signal or o.kito_outcome = 'sold') payment_signals,
           count(*) filter (where o.paid_orders > 0 and o.first_paid_at <= o.started_at + make_interval(days => (select win from w))) sold,
           coalesce(sum(o.sale_amount) filter (where o.paid_orders > 0 and o.first_paid_at <= o.started_at + make_interval(days => (select win from w))), 0) revenue
    from public.conversation_outcomes o
    where o.workspace_id = p_ws and o.ad_id is not null
      and (o.started_at at time zone (select tz from w))::date between p_from and p_to
    group by o.ad_id
  )
  select coalesce(sp.ad_id, ch.ad_id), a.name, a.campaign_name,
         coalesce(sp.spend, 0), coalesce(sp.impressions, 0), coalesce(sp.clicks, 0), coalesce(sp.conv, 0),
         coalesce(ch.chats, 0), coalesce(ch.replied, 0), coalesce(ch.priced, 0), coalesce(ch.payment_signals, 0),
         coalesce(ch.sold, 0), coalesce(ch.revenue, 0),
         case when coalesce(ch.sold, 0) > 0 then round(coalesce(sp.spend, 0) / ch.sold) end
  from sp full join ch on ch.ad_id = sp.ad_id
  left join public.ads a on a.ad_id = coalesce(sp.ad_id, ch.ad_id)
  where public.is_member(p_ws)
  order by coalesce(sp.spend, 0) desc;
$$;
revoke execute on function public.ad_performance(uuid, date, date) from public, anon;
grant execute on function public.ad_performance(uuid, date, date) to authenticated;

-- =====================================================================================
-- 6. Webhook events: bounded automatic retries, member-visible health, controlled replay
-- =====================================================================================
alter table public.raw_events add column if not exists max_attempts int not null default 8;
create index if not exists raw_events_ws_status_idx on public.raw_events (workspace_id, status);

-- A worker claims an event only while it still has attempts left. Manual replay resets the count.
create or replace function public.claim_raw_event(p_id bigint)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.raw_events
  set status = 'processing', attempts = attempts + 1, last_attempt_at = now(), error = null, last_error = null
  where id = p_id and processed_at is null and attempts < max_attempts
    and (status in ('pending','failed') or (status = 'processing' and last_attempt_at < now() - interval '5 minutes'));
  return found;
end $$;
revoke all on function public.claim_raw_event(bigint) from public, anon, authenticated;
grant execute on function public.claim_raw_event(bigint) to service_role;

-- Counts only: no payloads, message bodies or phone numbers leave the server.
create or replace function public.webhook_health(p_ws uuid)
returns table (status text, events bigint, oldest timestamptz, newest timestamptz, exhausted bigint)
language sql stable security definer set search_path = public as $$
  select r.status, count(*), min(r.received_at), max(r.received_at),
         count(*) filter (where r.processed_at is null and r.attempts >= r.max_attempts)
  from public.raw_events r
  where r.workspace_id = p_ws and public.is_member(p_ws)
  group by r.status;
$$;
revoke all on function public.webhook_health(uuid) from public, anon;
grant execute on function public.webhook_health(uuid) to authenticated;

-- Server-only: put this workspace's failed events back in the queue (the wa-webhook function
-- verifies the caller is an owner/admin of the workspace before calling it).
create or replace function public.svc_requeue_failed_events(p_ws uuid, p_limit int default 200)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with picked as (
    select id from public.raw_events
    where workspace_id = p_ws and processed_at is null and status in ('failed','processing')
      and (status = 'failed' or last_attempt_at < now() - interval '5 minutes')
    order by received_at limit greatest(1, least(p_limit, 1000))
  )
  update public.raw_events r set status = 'pending', attempts = 0, error = null, last_error = null
  from picked where r.id = picked.id;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.svc_requeue_failed_events(uuid, int) from public, anon, authenticated;
grant execute on function public.svc_requeue_failed_events(uuid, int) to service_role;

-- =====================================================================================
-- 7. Follow-up tasks: assignment, snooze, draft provenance, history
-- =====================================================================================
alter table public.follow_up_tasks
  add column if not exists assigned_to uuid references auth.users(id),
  add column if not exists snoozed_until timestamptz,
  add column if not exists source text not null default 'manual' check (source in ('manual','queue')),
  add column if not exists draft_source text check (draft_source in ('kito','manual','edited')),
  add column if not exists draft_edited_by uuid references auth.users(id),
  add column if not exists draft_edited_at timestamptz,
  add column if not exists updated_by uuid references auth.users(id);

create table public.task_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  task_id uuid not null,
  action text not null,
  actor uuid,
  at timestamptz not null default now(),
  details jsonb
);
create index task_events_task_idx on public.task_events (task_id, at desc);
alter table public.task_events enable row level security;
create policy task_events_read on public.task_events for select using (public.is_member(workspace_id));
revoke all on public.task_events from anon, authenticated;
grant select on public.task_events to authenticated;

create or replace function private.tasks_before_write()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if new.workspace_id <> old.workspace_id or new.conversation_id <> old.conversation_id then raise exception 'tasks cannot move'; end if;
    if new.draft is distinct from old.draft then
      -- A client may label a fresh Kito draft as 'kito'; any later human change becomes 'edited'.
      if new.draft_source is not distinct from old.draft_source then
        new.draft_source := case when old.draft is null and auth.uid() is not null then 'manual' else 'edited' end;
      end if;
      new.draft_edited_by := auth.uid(); new.draft_edited_at := now();
    end if;
    if new.status in ('done','dismissed') and old.status not in ('done','dismissed') then new.completed_at := coalesce(new.completed_at, now()); end if;
    if new.status = 'snoozed' and new.snoozed_until is null then new.snoozed_until := now() + interval '1 day'; end if;
  else
    if new.created_by is null then new.created_by := auth.uid(); end if;
  end if;
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end $$;
create trigger tasks_before_write before insert or update on public.follow_up_tasks
  for each row execute function private.tasks_before_write();

create or replace function private.tasks_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare d jsonb;
begin
  if tg_op = 'INSERT' then
    insert into public.task_events(workspace_id, task_id, action, actor, details)
      values (new.workspace_id, new.id, 'created', auth.uid(), jsonb_build_object('status', new.status, 'source', new.source, 'draft_source', new.draft_source));
    return new;
  end if;
  d := '{}'::jsonb;
  if new.status is distinct from old.status then d := d || jsonb_build_object('status', jsonb_build_array(old.status, new.status)); end if;
  if new.assigned_to is distinct from old.assigned_to then d := d || jsonb_build_object('assigned_to', new.assigned_to); end if;
  if new.snoozed_until is distinct from old.snoozed_until then d := d || jsonb_build_object('snoozed_until', new.snoozed_until); end if;
  if new.draft is distinct from old.draft then d := d || jsonb_build_object('draft', jsonb_build_object('source', new.draft_source, 'length', length(coalesce(new.draft,'')))); end if;
  if d <> '{}'::jsonb then
    insert into public.task_events(workspace_id, task_id, action, actor, details) values (new.workspace_id, new.id, 'updated', auth.uid(), d);
  end if;
  return new;
end $$;
create trigger tasks_audit after insert or update on public.follow_up_tasks
  for each row execute function private.tasks_audit();

drop policy if exists follow_up_tasks_insert on public.follow_up_tasks;
create policy follow_up_tasks_insert on public.follow_up_tasks for insert
  with check (public.can_edit(workspace_id) and (created_by is null or created_by = auth.uid()));
drop policy if exists follow_up_tasks_update on public.follow_up_tasks;
create policy follow_up_tasks_update on public.follow_up_tasks for update
  using (public.can_edit(workspace_id)) with check (public.can_edit(workspace_id));
drop policy if exists follow_up_tasks_delete on public.follow_up_tasks;   -- history must survive; dismiss instead
revoke delete on public.follow_up_tasks from authenticated;

-- Members of a workspace can see who else is in it (for assignment), by id and email only.
create or replace function public.workspace_members(p_ws uuid)
returns table (user_id uuid, role text, email text)
language sql stable security definer set search_path = public as $$
  select m.user_id, m.role, u.email::text
  from public.memberships m join auth.users u on u.id = m.user_id
  where m.workspace_id = p_ws and public.is_member(p_ws);
$$;
revoke all on function public.workspace_members(uuid) from public, anon;
grant execute on function public.workspace_members(uuid) to authenticated;

-- =====================================================================================
-- 8. Business profile: small, inspectable context for coaching. Never leaves its workspace.
-- =====================================================================================
create table public.business_profiles (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  products jsonb not null default '[]',        -- [{name, price, note}]
  delivery_areas text,
  payment_methods text,
  tone text,
  faqs jsonb not null default '[]',            -- [{q, a}]
  constraints text,                            -- hours, stock limits, things never to promise
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
alter table public.business_profiles enable row level security;
create policy bp_read on public.business_profiles for select using (public.is_member(workspace_id));
create policy bp_insert on public.business_profiles for insert with check (public.can_edit(workspace_id));
create policy bp_update on public.business_profiles for update using (public.can_edit(workspace_id)) with check (public.can_edit(workspace_id));
revoke all on public.business_profiles from anon, authenticated;
grant select, insert, update on public.business_profiles to authenticated;
create or replace function private.stamp_updated()
returns trigger language plpgsql security definer set search_path = public as $$
begin new.updated_at := now(); new.updated_by := coalesce(auth.uid(), new.updated_by); return new; end $$;
create trigger bp_stamp before insert or update on public.business_profiles for each row execute function private.stamp_updated();

-- =====================================================================================
-- 9. Content intelligence foundation: manually recorded or imported posts, and idea drafts.
--    Nothing here is published to Meta; drafts stay drafts.
-- =====================================================================================
create table public.content_posts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  platform text not null default 'facebook' check (platform in ('facebook','instagram','other')),
  posted_at timestamptz not null,
  caption text,
  format text,                                 -- reel, image, carousel, story, text
  theme text, hook text, offer text,
  reach bigint, impressions bigint, likes bigint, comments bigint, shares bigint, saves bigint, link_clicks bigint,
  source_label text,                           -- matches conversations.source_label to link inquiries
  source text not null default 'manual' check (source in ('manual','csv_import','provider')),
  external_ref text,
  import_batch_id uuid,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index content_posts_ws_idx on public.content_posts (workspace_id, posted_at desc);
create unique index content_posts_external_ref_uniq on public.content_posts (workspace_id, external_ref) where external_ref is not null;
alter table public.content_posts enable row level security;
create policy cp_read on public.content_posts for select using (public.is_member(workspace_id));
create policy cp_insert on public.content_posts for insert with check (public.can_edit(workspace_id) and source = 'manual');
create policy cp_update on public.content_posts for update using (public.can_edit(workspace_id)) with check (public.can_edit(workspace_id));
create policy cp_delete on public.content_posts for delete using (public.can_edit(workspace_id));
revoke all on public.content_posts from anon, authenticated;
grant select, insert, update, delete on public.content_posts to authenticated;
create trigger cp_stamp before insert or update on public.content_posts for each row execute function private.stamp_updated();

create table public.content_ideas (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null,
  draft text,
  theme text, hook text, offer text, format text,
  planned_for date,
  status text not null default 'draft' check (status in ('draft','planned','used','dropped')),
  source text not null default 'manual' check (source in ('manual','kito')),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index content_ideas_ws_idx on public.content_ideas (workspace_id, planned_for, status);
alter table public.content_ideas enable row level security;
create policy ci_read on public.content_ideas for select using (public.is_member(workspace_id));
create policy ci_insert on public.content_ideas for insert with check (public.can_edit(workspace_id));
create policy ci_update on public.content_ideas for update using (public.can_edit(workspace_id)) with check (public.can_edit(workspace_id));
create policy ci_delete on public.content_ideas for delete using (public.can_edit(workspace_id));
revoke all on public.content_ideas from anon, authenticated;
grant select, insert, update, delete on public.content_ideas to authenticated;
create trigger ci_stamp before insert or update on public.content_ideas for each row execute function private.stamp_updated();

-- =====================================================================================
-- 10. Belt and braces: anonymous visitors see nothing; server-only tables stay server-only.
-- =====================================================================================
revoke all on public.raw_events, public.sales_legacy_v01 from anon, authenticated;
revoke all on all tables in schema public from anon;

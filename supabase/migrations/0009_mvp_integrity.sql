-- itaOS MVP: durable webhook retries, workspace-safe links, and confirmed-sale reporting.

-- Make it impossible for a member to link a sale to another workspace's conversation.
alter table public.conversations
  add constraint conversations_workspace_id_unique unique (workspace_id, id);

alter table public.sales
  add constraint sales_conversation_workspace_fk
  foreign key (workspace_id, conversation_id)
  references public.conversations (workspace_id, id)
  on delete cascade;

-- Browser users can only create/maintain owner-confirmed records for themselves.
-- Server-side imports may use other provenance values with the service role.
drop policy if exists sale_write on public.sales;
create policy sale_write on public.sales for insert with check (
  public.is_member(workspace_id)
  and provenance = 'owner_confirmed'
  and confirmed_by = auth.uid()
);
drop policy if exists sale_update on public.sales;
create policy sale_update on public.sales for update
  using (public.is_member(workspace_id))
  with check (
    public.is_member(workspace_id)
    and provenance = 'owner_confirmed'
    and confirmed_by = auth.uid()
  );

-- A raw event is durable before acknowledgement. A worker claims it atomically;
-- failed or expired claims can be retried without treating them as completed.
alter table public.raw_events
  add column status text not null default 'pending'
    check (status in ('pending', 'processing', 'processed', 'failed')),
  add column attempts integer not null default 0 check (attempts >= 0),
  add column last_attempt_at timestamptz,
  add column last_error text;

update public.raw_events
set status = case when processed_at is not null then 'processed'
                  when error is not null then 'failed'
                  else 'pending' end,
    last_error = error;

create index raw_events_retry_idx
  on public.raw_events (received_at)
  where processed_at is null and status in ('pending', 'failed');

create or replace function public.claim_raw_event(p_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.raw_events
  set status = 'processing',
      attempts = attempts + 1,
      last_attempt_at = now(),
      error = null,
      last_error = null
  where id = p_id
    and processed_at is null
    and (status in ('pending', 'failed')
      or (status = 'processing' and last_attempt_at < now() - interval '5 minutes'));
  return found;
end;
$$;
revoke all on function public.claim_raw_event(bigint) from public, anon, authenticated;
grant execute on function public.claim_raw_event(bigint) to service_role;

-- Ad-level sale cost and revenue use only explicit sales records. Kito's inferred
-- labels remain useful for triage, but are not reported as confirmed purchases.
create or replace function public.ad_performance(p_ws uuid, p_from date, p_to date)
returns table (ad_id text, ad_name text, campaign_name text, spend numeric, platform_conversations bigint,
               chats bigint, priced bigint, sold bigint, revenue numeric, cost_per_sale numeric)
language sql stable security invoker set search_path = public as $$
  with sp as (
    select i.ad_id, sum(i.spend) spend, sum(i.messaging_conversations) conv
    from public.ad_insights_daily i
    where i.workspace_id = p_ws and i.day between p_from and p_to
    group by i.ad_id
  ), ch as (
    select o.ad_id,
           count(*) chats,
           count(*) filter (where o.price_shared) priced,
           count(*) filter (where o.sale_provenance in ('owner_confirmed', 'import')) sold,
           coalesce(sum(o.sale_amount) filter (where o.sale_provenance in ('owner_confirmed', 'import')), 0) revenue
    from public.conversation_outcomes o
    where o.workspace_id = p_ws and o.ad_id is not null
      and (o.started_at at time zone 'Africa/Dar_es_Salaam')::date between p_from and p_to
    group by o.ad_id
  )
  select coalesce(sp.ad_id, ch.ad_id), a.name, a.campaign_name,
         coalesce(sp.spend, 0), coalesce(sp.conv, 0), coalesce(ch.chats, 0),
         coalesce(ch.priced, 0), coalesce(ch.sold, 0), coalesce(ch.revenue, 0),
         case when coalesce(ch.sold, 0) > 0 then round(coalesce(sp.spend, 0) / ch.sold) end
  from sp full join ch on ch.ad_id = sp.ad_id
  left join public.ads a on a.ad_id = coalesce(sp.ad_id, ch.ad_id)
  where public.is_member(p_ws)
  order by coalesce(sp.spend, 0) desc;
$$;
revoke execute on function public.ad_performance(uuid, date, date) from public, anon;
grant execute on function public.ad_performance(uuid, date, date) to authenticated;

-- Durable follow-up tasks. Composite foreign key preserves workspace boundaries.
create table public.follow_up_tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  conversation_id uuid not null,
  title text not null,
  draft text,
  due_at timestamptz,
  status text not null default 'open' check (status in ('open', 'snoozed', 'done', 'dismissed')),
  created_by uuid references auth.users(id),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint follow_up_tasks_conversation_workspace_fk
    foreign key (workspace_id, conversation_id)
    references public.conversations (workspace_id, id)
    on delete cascade
);
create index follow_up_tasks_queue_idx
  on public.follow_up_tasks (workspace_id, status, due_at);
create unique index follow_up_tasks_one_open_per_conversation
  on public.follow_up_tasks (workspace_id, conversation_id)
  where status in ('open', 'snoozed');
alter table public.follow_up_tasks enable row level security;
create policy follow_up_tasks_read on public.follow_up_tasks
  for select using (public.is_member(workspace_id));
create policy follow_up_tasks_insert on public.follow_up_tasks
  for insert with check (public.is_member(workspace_id) and created_by = auth.uid());
create policy follow_up_tasks_update on public.follow_up_tasks
  for update using (public.is_member(workspace_id))
  with check (public.is_member(workspace_id));
create policy follow_up_tasks_delete on public.follow_up_tasks
  for delete using (public.is_member(workspace_id));
grant select, insert, update, delete on public.follow_up_tasks to authenticated;

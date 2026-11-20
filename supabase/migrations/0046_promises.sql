-- Ahadi: customer promises become reminders.
-- Kito reads a chat; when the customer made a still-open promise ("nitalipa Ijumaa", "nipigie saa kumi",
-- "nikipata mshahara"), it saves a PROPOSED task. The owner confirms (with the date fixed if needed) or
-- dismisses it. Confirmed promises ring the phone when due. itaOS never messages the customer.

-- 1. Task fields ----------------------------------------------------------------------------------
alter table public.follow_up_tasks drop constraint if exists follow_up_tasks_status_check;
alter table public.follow_up_tasks add constraint follow_up_tasks_status_check
  check (status in ('proposed', 'open', 'snoozed', 'done', 'dismissed'));
alter table public.follow_up_tasks drop constraint if exists follow_up_tasks_source_check;
alter table public.follow_up_tasks add constraint follow_up_tasks_source_check
  check (source in ('manual', 'queue', 'kito_promise'));

alter table public.follow_up_tasks
  add column if not exists kind text check (kind in ('pay', 'call', 'collect', 'come_back', 'other')),
  add column if not exists promise_text text,          -- the customer's own words, as written
  add column if not exists when_text text,             -- the time words as said ("Ijumaa", "saa kumi jioni")
  add column if not exists promise_key text,           -- stops the same promise making two tasks
  add column if not exists promise_at timestamptz,     -- when the customer said it
  add column if not exists needs_date boolean not null default false,
  add column if not exists result text check (result in ('paid', 'called', 'no_answer', 'postponed', 'not_interested', 'other')),
  add column if not exists notified_at timestamptz;    -- due-reminder push already sent for this due time

-- Not partial, so PostgREST upserts can use it; manual tasks have a null key (nulls never clash).
create unique index if not exists follow_up_tasks_promise_key
  on public.follow_up_tasks (conversation_id, promise_key);
create index if not exists follow_up_tasks_due_push
  on public.follow_up_tasks (status, due_at) where notified_at is null;

-- 2. Write rules: moving a due time re-arms the reminder; closing a promise needs no extra steps --------
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
    if new.due_at is distinct from old.due_at or new.snoozed_until is distinct from old.snoozed_until
       or (new.status = 'open' and old.status = 'proposed') then
      new.notified_at := null;
    end if;
    if new.due_at is not null then new.needs_date := false; end if;
  else
    if new.created_by is null then new.created_by := auth.uid(); end if;
  end if;
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end $$;

create or replace function private.tasks_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare d jsonb;
begin
  if tg_op = 'INSERT' then
    insert into public.task_events(workspace_id, task_id, action, actor, details)
      values (new.workspace_id, new.id, 'created', auth.uid(), jsonb_build_object('status', new.status, 'source', new.source, 'draft_source', new.draft_source, 'kind', new.kind));
    return new;
  end if;
  d := '{}'::jsonb;
  if new.status is distinct from old.status then d := d || jsonb_build_object('status', jsonb_build_array(old.status, new.status)); end if;
  if new.assigned_to is distinct from old.assigned_to then d := d || jsonb_build_object('assigned_to', new.assigned_to); end if;
  if new.snoozed_until is distinct from old.snoozed_until then d := d || jsonb_build_object('snoozed_until', new.snoozed_until); end if;
  if new.due_at is distinct from old.due_at then d := d || jsonb_build_object('due_at', jsonb_build_array(old.due_at, new.due_at)); end if;
  if new.kind is distinct from old.kind then d := d || jsonb_build_object('kind', jsonb_build_array(old.kind, new.kind)); end if;
  if new.result is distinct from old.result then d := d || jsonb_build_object('result', new.result); end if;
  if new.draft is distinct from old.draft then d := d || jsonb_build_object('draft', jsonb_build_object('source', new.draft_source, 'length', length(coalesce(new.draft,'')))); end if;
  if d <> '{}'::jsonb then
    insert into public.task_events(workspace_id, task_id, action, actor, details) values (new.workspace_id, new.id, 'updated', auth.uid(), d);
  end if;
  return new;
end $$;

-- 3. Confirm a proposed promise (owner/editor). Only one open task per chat is allowed, so an older
--    open task on the same chat is closed in favour of the dated promise.
create or replace function public.confirm_promise(p_task uuid, p_due timestamptz, p_kind text default null)
returns void language plpgsql security definer set search_path = public as $$
declare t public.follow_up_tasks;
begin
  select * into t from public.follow_up_tasks where id = p_task;
  if t.id is null or not public.can_edit(t.workspace_id) then raise exception 'not allowed'; end if;
  if t.status <> 'proposed' then raise exception 'this promise was already handled'; end if;
  if p_due is null then raise exception 'pick a date first'; end if;
  if p_kind is not null and p_kind not in ('pay', 'call', 'collect', 'come_back', 'other') then raise exception 'bad kind'; end if;
  update public.follow_up_tasks set status = 'dismissed', result = 'other'
   where conversation_id = t.conversation_id and status in ('open', 'snoozed') and id <> t.id;
  update public.follow_up_tasks
     set status = 'open', due_at = p_due, snoozed_until = null, kind = coalesce(p_kind, kind), needs_date = false
   where id = t.id;
end $$;
revoke all on function public.confirm_promise(uuid, timestamptz, text) from public, anon;
grant execute on function public.confirm_promise(uuid, timestamptz, text) to authenticated;

-- 4. A recorded paid order closes that chat's promises (Kito proposals and confirmed ones).
create or replace function private.orders_close_promises()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'paid' and new.conversation_id is not null
     and (tg_op = 'INSERT' or old.status is distinct from 'paid') then
    update public.follow_up_tasks
       set status = case when status = 'proposed' then 'dismissed' else 'done' end, result = 'paid'
     where conversation_id = new.conversation_id and source = 'kito_promise'
       and status in ('proposed', 'open', 'snoozed');
  end if;
  return null;
end $$;
drop trigger if exists orders_close_promises on public.orders;
create trigger orders_close_promises after insert or update of status on public.orders
  for each row execute function private.orders_close_promises();

-- 5. "Not a customer" also clears Kito's proposals.
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
  -- Open follow-up reminders and Kito's promise proposals for a not-customer are noise.
  if p_value then
    update public.follow_up_tasks t set status = 'dismissed'
      from public.conversations c
     where c.contact_id = p_contact and t.conversation_id = c.id and t.status in ('proposed', 'open', 'snoozed');
  end if;
end $$;
revoke all on function public.set_not_customer(uuid, boolean, text) from public, anon;
grant execute on function public.set_not_customer(uuid, boolean, text) to authenticated;

-- 6. Nav badge: proposals waiting for the owner count as "due" too.
create or replace function public.nav_badges(ws uuid)
returns json language plpgsql stable set search_path to 'public' as $function$
declare
  seen timestamptz;
  v_wait int; v_new int; v_due int;
begin
  if not public.is_member(ws) then raise exception 'forbidden'; end if;
  select chats_seen_at into seen from public.nav_seen where user_id = auth.uid() and workspace_id = ws;
  seen := coalesce(seen, now() - interval '24 hours');

  select count(*) into v_wait
  from public.conversations c
  join public.contacts ct on ct.id = c.contact_id
  where c.workspace_id = ws
    and c.last_message_at between now() - interval '48 hours' and now() - interval '15 minutes'
    and public.chat_origin(ct.wa_id, c.phone_number_id) = 'live'
    and coalesce(c.outcome_override, '') not in ('sold', 'lost')
    and (select m.direction from public.messages m where m.conversation_id = c.id order by m.sent_at desc limit 1) = 'in';

  select count(*) into v_new
  from public.conversations c
  join public.contacts ct on ct.id = c.contact_id
  where c.workspace_id = ws
    and c.started_at > seen
    and public.chat_origin(ct.wa_id, c.phone_number_id) = 'live';

  select count(*) into v_due
  from public.follow_up_tasks t
  where t.workspace_id = ws
    and (t.status = 'proposed'
         or (t.status in ('open', 'snoozed') and coalesce(t.snoozed_until, t.due_at) <= now()));

  return json_build_object('chats_waiting', v_wait, 'chats_new', v_new, 'actions_due', v_due);
end $function$;

-- 7. Ask Kito can answer "who promised to pay this week?"
create or replace view kito.tasks with (security_invoker = true) as
select t.id as task_id, t.conversation_id as chat_id, t.title, t.status, t.due_at, t.snoozed_until,
       t.created_at, t.completed_at, t.draft_source,
       t.source, t.kind, t.promise_text, t.when_text, t.promise_at, t.needs_date, t.result
from public.follow_up_tasks t where t.workspace_id = kito.ws();

-- 8. Ring the phone when a confirmed promise is due (push-send picks due tasks every 15 minutes).
select cron.unschedule('promises-due-15m') where exists (select 1 from cron.job where jobname = 'promises-due-15m');
select cron.schedule('promises-due-15m', '3,18,33,48 * * * *', $cron$
  select net.http_post(
    url := 'https://jrdxeagnmunmatxtgmpk.supabase.co/functions/v1/push-send',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpyZHhlYWdubXVubWF0eHRnbXBrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ1ODkyNjcsImV4cCI6MjExMDE2NTI2N30.1HJUnCAwcCwQ0BiGZxfhJsh6xa6Amm3SrDuDopSZOWc',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{"due_tasks": true}'::jsonb,
    timeout_milliseconds := 30000
  );
$cron$);

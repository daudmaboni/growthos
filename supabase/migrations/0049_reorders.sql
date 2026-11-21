-- Reorders (Step 3, 21 Nov 2026): bring past buyers back.
-- Actions → Reorders lists customers whose last recorded purchase was 45–120 days ago and who haven't bought
-- since. Kito writes a reorder draft (reorder function); the owner copies it and sends it from WhatsApp.
-- "Sent" saves a follow_up_tasks row (source 'reorder', status 'done') so itaOS can show who replied and who
-- bought again afterwards. "Not now" saves a dismissed row and hides the customer for 60 days.

alter table public.follow_up_tasks drop constraint if exists follow_up_tasks_source_check;
alter table public.follow_up_tasks add constraint follow_up_tasks_source_check
  check (source in ('manual', 'queue', 'kito_promise', 'reorder'));

-- state: 'todo'      = bought in the window, not contacted since that purchase (and not dismissed in 60 days)
--        'contacted' = marked sent in the last 45 days; replied / reordered say what happened after
create or replace function public.reorder_candidates(p_ws uuid, p_min_days int default 45, p_max_days int default 120)
returns table (
  conversation_id uuid, contact_name text, last_paid_at timestamptz, products text, amount numeric, currency text,
  orders_count int, last_message_at timestamptz, last_dir text, state text, task_id uuid, contacted_at timestamptz,
  draft text, replied boolean, reordered boolean, reorder_amount numeric
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member(p_ws) then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
  with paid as (
    select o.conversation_id cid, o.paid_at, o.amount, o.currency,
           coalesce(nullif(o.product, ''), (select string_agg(i->>'name', ', ') from jsonb_array_elements(coalesce(o.items, '[]'::jsonb)) i)) prod,
           row_number() over (partition by o.conversation_id order by o.paid_at desc) rn,
           count(*) over (partition by o.conversation_id) n
      from public.orders o
     where o.workspace_id = p_ws and o.status = 'paid' and o.conversation_id is not null and o.paid_at is not null
  ),
  last_task as (
    select distinct on (t.conversation_id) t.conversation_id cid, t.id, t.status, t.completed_at, t.updated_at, t.draft
      from public.follow_up_tasks t
     where t.workspace_id = p_ws and t.source = 'reorder'
     order by t.conversation_id, t.created_at desc
  ),
  base as (
    select p.cid, p.paid_at, p.amount, p.currency, p.prod, p.n::int n, c.last_message_at, c.last_dir,
           coalesce(nullif(ct.name, ''), ct.wa_id) cname, lt.id tid, lt.status tstatus, lt.completed_at, lt.updated_at tupd, lt.draft tdraft
      from paid p
      join public.conversations c on c.id = p.cid and c.workspace_id = p_ws
      join public.contacts ct on ct.id = c.contact_id
      left join last_task lt on lt.cid = p.cid
     where p.rn = 1 and not ct.not_customer
  )
  select b.cid, b.cname, b.paid_at, b.prod, b.amount, b.currency, b.n, b.last_message_at, b.last_dir,
         'todo'::text, null::uuid, null::timestamptz, null::text, false, false, null::numeric
    from base b
   where b.paid_at between now() - make_interval(days => p_max_days) and now() - make_interval(days => p_min_days)
     and not (b.tstatus = 'done' and b.completed_at > b.paid_at)
     and not (b.tstatus = 'dismissed' and b.tupd > now() - interval '60 days')
  union all
  select b.cid, b.cname, b.paid_at, b.prod, b.amount, b.currency, b.n, b.last_message_at, b.last_dir,
         'contacted'::text, b.tid, b.completed_at, b.tdraft,
         exists (select 1 from public.messages m where m.conversation_id = b.cid and m.direction = 'in' and m.sent_at > b.completed_at),
         exists (select 1 from public.orders o where o.conversation_id = b.cid and o.status = 'paid' and o.paid_at > b.completed_at),
         (select sum(o.amount) from public.orders o where o.conversation_id = b.cid and o.status = 'paid' and o.paid_at > b.completed_at)
    from base b
   where b.tstatus = 'done' and b.completed_at > now() - interval '45 days';
end $$;

revoke all on function public.reorder_candidates(uuid, int, int) from public, anon;
grant execute on function public.reorder_candidates(uuid, int, int) to authenticated;

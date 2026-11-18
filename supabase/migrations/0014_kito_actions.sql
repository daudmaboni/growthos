-- Kito actions: Kito can now PROPOSE deleting chats (e.g. "delete all imported chats").
-- Kito itself still only reads. The app shows the owner exactly which chats would go, and only
-- the owner's click calls public.delete_chats, which checks the role again on the server.

-- 1. Where each chat came from, so Kito can tell imported chats from live WhatsApp ones.
--    live   = arrived through the WhatsApp connection (webhook / history sync)
--    export = uploaded WhatsApp chat export (.txt / .zip) on the Import page
--    csv    = inquiry row from a CSV file
create or replace function public.chat_origin(p_wa_id text, p_phone_number_id text)
returns text language sql immutable as $$
  select case
    when p_wa_id like 'csv:%' then 'csv'
    when p_wa_id like 'import:%' or p_phone_number_id = 'import' then 'export'
    else 'live' end
$$;
grant execute on function public.chat_origin(text, text) to authenticated, service_role;

create or replace view kito.chats with (security_invoker = true) as
select o.id as chat_id,
       o.contact_name as customer_name,
       o.source, o.source_label, o.ad_id, a.name as ad_name, a.adset_name, a.campaign_name,
       o.started_at, o.last_message_at, o.last_dir as last_message_from, o.last_out_at as last_business_message_at,
       round(extract(epoch from (now() - o.last_message_at)) / 3600)::int as hours_since_last_message,
       mc.customer_messages, mc.business_messages,
       o.first_response_sec,
       o.price_asked, o.price_shared, o.price_shared_at, o.replied_after_price,
       o.pay_instructions as payment_details_sent,
       o.payment_signal, o.payment_amount,
       o.objections as rule_objections, o.followed_up, o.stage as rule_stage, o.auto_outcome as rule_outcome,
       o.outcome_override as owner_outcome, o.override_note as owner_note,
       o.kito_outcome, o.kito_label, o.kito_temp, o.kito_blocker, o.kito_objections, o.kito_tags,
       o.kito_summary, o.kito_next, o.kito_confidence,
       o.outcome as final_outcome,
       o.paid_orders, o.sale_amount as paid_amount_net, o.first_paid_at, o.last_paid_at,
       public.chat_origin(ct.wa_id, c.phone_number_id) as origin
from public.conversation_outcomes o
join public.conversations c on c.id = o.id
join public.contacts ct on ct.id = c.contact_id
left join public.ads a on a.ad_id = o.ad_id
left join lateral (
  select count(*) filter (where m.direction = 'in') as customer_messages,
         count(*) filter (where m.direction = 'out') as business_messages
  from public.messages m where m.conversation_id = o.id
) mc on true
where o.workspace_id = kito.ws();
grant select on kito.chats to authenticated, service_role;

-- 2. Audit trail of every delete (counts only, never message text or phone numbers).
create table if not exists public.chat_deletions (
  id bigserial primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid references auth.users(id),
  via text not null default 'kito' check (via in ('kito','chats_page')),
  request text,                       -- the owner's question that led to it (Kito) or a short note
  chats int not null,
  messages int not null,
  by_origin jsonb not null default '{}',
  orders_unlinked int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists chat_deletions_ws_idx on public.chat_deletions (workspace_id, created_at desc);
alter table public.chat_deletions enable row level security;
drop policy if exists chat_deletions_read on public.chat_deletions;
create policy chat_deletions_read on public.chat_deletions for select using (public.is_member(workspace_id));
revoke all on public.chat_deletions from anon, authenticated;
grant select on public.chat_deletions to authenticated;

-- 3. The only way to delete chats. Owner/admin only, this workspace only, max 1000 at a time.
--    Messages and follow-up tasks go with the chat; recorded orders are KEPT (just unlinked),
--    so confirmed revenue never disappears. Contacts left with no chat are removed too.
create or replace function public.delete_chats(p_ws uuid, p_ids uuid[], p_via text default 'kito', p_request text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_ids uuid[]; v_contacts uuid[]; v_msgs int; v_orders int; v_origin jsonb; v_n int;
begin
  if auth.uid() is null or not public.can_manage(p_ws) then
    raise exception 'Only the owner or an admin can delete chats.' using errcode = '42501';
  end if;
  if coalesce(array_length(p_ids, 1), 0) = 0 then raise exception 'No chats to delete.'; end if;
  if array_length(p_ids, 1) > 1000 then raise exception 'Delete at most 1000 chats at a time.'; end if;

  select array_agg(c.id), array_agg(distinct c.contact_id)
    into v_ids, v_contacts
  from public.conversations c where c.workspace_id = p_ws and c.id = any(p_ids);
  if v_ids is null then raise exception 'None of those chats belong to this business.'; end if;

  select count(*) into v_msgs from public.messages m where m.conversation_id = any(v_ids);
  select count(*) into v_orders from public.orders o where o.workspace_id = p_ws and o.conversation_id = any(v_ids);
  select coalesce(jsonb_object_agg(origin, n), '{}') into v_origin from (
    select public.chat_origin(ct.wa_id, c.phone_number_id) as origin, count(*) as n
    from public.conversations c join public.contacts ct on ct.id = c.contact_id
    where c.id = any(v_ids) group by 1) x;

  delete from public.conversations c where c.workspace_id = p_ws and c.id = any(v_ids);
  get diagnostics v_n = row_count;
  delete from public.contacts ct where ct.workspace_id = p_ws and ct.id = any(v_contacts)
    and not exists (select 1 from public.conversations c where c.contact_id = ct.id);

  insert into public.chat_deletions (workspace_id, user_id, via, request, chats, messages, by_origin, orders_unlinked)
  values (p_ws, auth.uid(), case when p_via = 'chats_page' then 'chats_page' else 'kito' end, left(p_request, 500), v_n, v_msgs, v_origin, v_orders);

  return jsonb_build_object('deleted', v_n, 'messages', v_msgs, 'by_origin', v_origin, 'orders_unlinked', v_orders,
                            'not_found', coalesce(array_length(p_ids, 1), 0) - v_n);
end $$;
revoke all on function public.delete_chats(uuid, uuid[], text, text) from public, anon;
grant execute on function public.delete_chats(uuid, uuid[], text, text) to authenticated;

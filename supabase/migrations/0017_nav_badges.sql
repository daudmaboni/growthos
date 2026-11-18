-- Nav badges (WhatsApp-style counts on the tabs).
--   red   = live chats where the customer wrote last, 15 min – 48 h ago, and the chat isn't sold/lost
--   green = live chats that started since this user last opened Chats
--   actions = open follow-ups that are due now
-- "Last opened" is per user per workspace, so the phone and laptop agree.

create table if not exists public.nav_seen (
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  chats_seen_at timestamptz,
  actions_seen_at timestamptz,
  primary key (user_id, workspace_id)
);
alter table public.nav_seen enable row level security;
drop policy if exists nav_seen_own on public.nav_seen;
create policy nav_seen_own on public.nav_seen for all
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.is_member(workspace_id));

create or replace function public.nav_badges(ws uuid)
returns json language plpgsql stable security invoker set search_path = public as $$
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
  where t.workspace_id = ws and t.status in ('open', 'snoozed') and t.due_at <= now();

  return json_build_object('chats_waiting', v_wait, 'chats_new', v_new, 'actions_due', v_due);
end $$;
grant execute on function public.nav_badges(uuid) to authenticated;

create or replace function public.mark_nav_seen(ws uuid, what text)
returns void language plpgsql security invoker set search_path = public as $$
begin
  if not public.is_member(ws) then raise exception 'forbidden'; end if;
  if what = 'chats' then
    insert into public.nav_seen (user_id, workspace_id, chats_seen_at) values (auth.uid(), ws, now())
    on conflict (user_id, workspace_id) do update set chats_seen_at = excluded.chats_seen_at;
  elsif what = 'actions' then
    insert into public.nav_seen (user_id, workspace_id, actions_seen_at) values (auth.uid(), ws, now())
    on conflict (user_id, workspace_id) do update set actions_seen_at = excluded.actions_seen_at;
  end if;
end $$;
grant execute on function public.mark_nav_seen(uuid, text) to authenticated;

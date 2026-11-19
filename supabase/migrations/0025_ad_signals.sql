-- Mark chats as "from an ad" using the patterns found in Kayani's history (19 Nov 2026), not only Meta's referral tag.
--   meta_tag      : Meta sent the CTWA referral on the first message (set by wa-webhook).
--   greeting_card : the chat opens with the business's ad card + automated greeting. WhatsApp can't pass that card
--                   through, so it arrives as an outgoing "unsupported" message (type 'errors'), and the customer's
--                   first message follows within 2 minutes.
--   ad_text       : the customer's first message is one of the ads' ready-made texts
--                   ("Mnapatikana Wapi??", "Hello! Can I get more info on this?", "Hallo, Nahitaji Tiba Ya KayaPower…",
--                   "Hallo, Nahitaji Kupata Offer Hii Ya Dawa…") and nothing real was sent to them before it.
-- Kayani's standard replies (location, 1️⃣/2️⃣/3️⃣ menu) go to everyone, so they are NOT ad signals.
alter table public.conversations add column if not exists ad_signal text
  check (ad_signal is null or ad_signal in ('meta_tag', 'greeting_card', 'ad_text'));
comment on column public.conversations.ad_signal is 'Why source = ad: meta_tag (Meta referral), greeting_card (opens with the ad greeting card), ad_text (first message is an ad''s ready-made text).';

update public.conversations set ad_signal = 'meta_tag' where referral is not null and source = 'ad' and ad_signal is null;

create or replace function private.ad_signal_for(p_conv uuid)
returns text language sql stable security definer set search_path = public as $$
  with firsts as (
    select m.direction, m.type, m.body, m.sent_at
    from public.messages m where m.conversation_id = p_conv
    order by m.sent_at, m.id limit 2
  ), f as (
    select (array_agg(direction order by sent_at))[1] d1, (array_agg(type order by sent_at))[1] t1, (array_agg(sent_at order by sent_at))[1] s1,
           (array_agg(direction order by sent_at))[2] d2, (array_agg(sent_at order by sent_at))[2] s2
    from firsts
  ), first_in as (
    -- the customer's first message, and whether a real (non-card) message went out before it
    select m.body, m.sent_at,
           exists (select 1 from public.messages o where o.conversation_id = p_conv and o.direction = 'out'
                     and o.type is distinct from 'errors' and o.sent_at < m.sent_at) as had_real_out_before
    from public.messages m where m.conversation_id = p_conv and m.direction = 'in'
    order by m.sent_at, m.id limit 1
  )
  select case
    when f.d1 = 'out' and f.t1 = 'errors' and f.d2 = 'in' and f.s2 - f.s1 <= interval '2 minutes' then 'greeting_card'
    when fi.body is not null and not fi.had_real_out_before and (
         lower(btrim(fi.body)) ~ '^mnapatikana\s+wapi[\s?!.]*$'
      or lower(btrim(fi.body)) like 'hello! can i get more info on this%'
      or lower(btrim(fi.body)) like 'hallo, nahitaji tiba ya kayapower%'
      or lower(btrim(fi.body)) like 'hallo, nahitaji kupata offer hii ya dawa%') then 'ad_text'
  end
  from f left join first_in fi on true;
$$;

create or replace function private.mark_ad_chat() returns trigger
language plpgsql security definer set search_path = public as $$
declare s text;
begin
  if exists (select 1 from public.conversations c where c.id = new.conversation_id and c.source <> 'ad') then
    s := private.ad_signal_for(new.conversation_id);
    if s is not null then
      update public.conversations set source = 'ad', ad_signal = s
      where id = new.conversation_id and source <> 'ad';
    end if;
  end if;
  return null;
end $$;

drop trigger if exists messages_mark_ad_chat on public.messages;
create trigger messages_mark_ad_chat after insert on public.messages
  for each row execute function private.mark_ad_chat();

-- Meta's referral (written by wa-webhook) always wins and is recorded as meta_tag.
create or replace function private.stamp_meta_tag() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.referral is not null and new.source = 'ad' then new.ad_signal := 'meta_tag'; end if;
  return new;
end $$;
drop trigger if exists conversations_stamp_meta_tag on public.conversations;
create trigger conversations_stamp_meta_tag before insert or update of referral, source on public.conversations
  for each row execute function private.stamp_meta_tag();

-- Expose why a chat counts as an ad chat to the app.
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
  coalesce(case when p.n > 0 then 'sold' end, c.outcome_override,
    case when coalesce(case when c.kito_confidence in ('high', 'medium') and c.kito_checked_at >= c.last_message_at then c.kito_outcome end, c.auto_outcome) = 'open'
              and c.last_message_at < now() - interval '2 days' then 'lost'
         else coalesce(case when c.kito_confidence in ('high', 'medium') and c.kito_checked_at >= c.last_message_at then c.kito_outcome end, c.auto_outcome) end) as outcome,
  p.net as sale_amount, p.provenance as sale_provenance, coalesce(p.n, 0::bigint) as paid_orders, p.first_paid_at, p.last_paid_at,
  c.last_dir, c.last_out_at, c.ad_signal
from public.conversations c
join public.contacts ct on ct.id = c.contact_id
left join paid p on p.conversation_id = c.id;

-- Backfill (run in batches on large workspaces):
-- update public.conversations c set source = 'ad', ad_signal = s.sig
-- from (select id, private.ad_signal_for(id) sig from public.conversations where source <> 'ad') s
-- where s.id = c.id and s.sig is not null;

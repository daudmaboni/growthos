-- Switch to the per-business rules (19 Nov 2026). Before switching, the new versions were compared with the old
-- Kayani-only ones on Kayani's data: "from an ad" gave the same answer on all 14,643 chats, and the payment day was
-- the same on 1,816 chats (every chat with an order, a payment sign or a "Matumizi" message, plus the latest 1,500).
-- The payment-day reason is now called 'payment_message' (it was 'kayatox').
-- payment_moment runs with the caller's rights (owners call it from the app), so the "after-payment message"
-- check is written inline rather than through private.rule_paid_hit, which owners can't execute.

create or replace function private.ad_signal_for(p_conv uuid)
returns text language sql stable security definer set search_path = public as $$
  with r as (
    select w.rule_ad_texts, w.rule_loc_question, w.rule_loc_reply
    from public.conversations c join public.workspaces w on w.id = c.workspace_id where c.id = p_conv
  ), firsts as (
    select m.direction, m.type, m.body, m.sent_at
    from public.messages m where m.conversation_id = p_conv
    order by m.sent_at, m.id limit 2
  ), f as (
    select (array_agg(direction order by sent_at))[1] d1, (array_agg(type order by sent_at))[1] t1, (array_agg(sent_at order by sent_at))[1] s1,
           (array_agg(direction order by sent_at))[2] d2, (array_agg(sent_at order by sent_at))[2] s2
    from firsts
  ), first_in as (
    select m.body, m.sent_at,
           exists (select 1 from public.messages o where o.conversation_id = p_conv and o.direction = 'out'
                     and o.type is distinct from 'errors' and o.sent_at < m.sent_at) as had_real_out_before
    from public.messages m where m.conversation_id = p_conv and m.direction = 'in'
    order by m.sent_at, m.id limit 1
  ), loc as (
    select exists (
      select 1 from r, public.messages q
      join public.messages a on a.conversation_id = q.conversation_id and a.direction = 'out' and a.sent_at >= q.sent_at
      where q.conversation_id = p_conv and q.direction = 'in'
        and cardinality(r.rule_loc_reply) > 0
        and private.rule_contains_any(q.body, r.rule_loc_question)
        and private.rule_contains_all(a.body, r.rule_loc_reply)
    ) as hit
  )
  select case
    when f.d1 = 'out' and f.t1 = 'errors' and f.d2 = 'in' and f.s2 - f.s1 <= interval '2 minutes' then 'greeting_card'
    when fi.body is not null and not fi.had_real_out_before and private.rule_first_msg_match(fi.body, r.rule_ad_texts) then 'ad_text'
    when loc.hit then 'location_reply'
  end
  from loc left join f on true left join first_in fi on true left join r on true;
$$;

create or replace function public.payment_moment(p_conv uuid, p_before timestamptz default now())
returns table(at timestamptz, kind text, snippet text, message_id text)
language sql stable set search_path = public as $$
  with pt as (
    select w.rule_paid_texts from conversations c join workspaces w on w.id = c.workspace_id where c.id = p_conv
  ), m as (
    select id, sent_at, direction, coalesce(body,'') b, media from messages
    where conversation_id = p_conv and sent_at <= p_before
  ), c as (
    select id, sent_at, b,
      case
        when direction='out' and exists (select 1 from pt, unnest(pt.rule_paid_texts) p
          where length(regexp_replace(lower(p), '[\s-]+', '', 'g')) >= 4
            and regexp_replace(lower(b), '[\s-]+', '', 'g') like '%' || replace(replace(replace(regexp_replace(lower(p), '[\s-]+', '', 'g'), '\', '\\'), '%', '\%'), '_', '\_') || '%') then 1
        when direction='in' and ((media->'receipt'->>'is_receipt')='true' or b ilike '[picha ya malipo]%'
          or b ~* '(imethibitishwa|\mconfirmed\M[. ]|umetuma (tsh|tzs|sh)|umelipa (tsh|tzs|sh)|you have paid|paid to lipa|kwenda kwa mpokeaji)') then 2
        when direction='out' and b ~ '(✅|✔)' and length(b) <= 160
          and (b ~ '\d[\d,.]{2,}|\d+\s*[kK]\M' or b ~* '(lipi|lipa|paid|malipo)' or btrim(b, E' \n\t✅✔️') = '') then 3
        when direction='in' and b ~* '(nimetuma|nimelipa|nimelipia|nimeshalipa|nimeshalipia|nishalipa|nishalipia|nishatuma|nimeshatuma|nimekutumia|nimeweka (pesa|hela)|(nimefanya|nimeshafanya|nishafanya|nmefanya) malipo|huo hapo muamala|muamala huo|risiti hiyo|nimesend|i have paid|i.ve (paid|sent)|sent the money|\mpaid\M)' then 4
        when direction='out' and b ~* '(tumepokea (malipo|pesa|tsh|tzs)|malipo yamepokelewa|payment received|asante kwa malipo|umelipiwa|imelipiwa|amelipia|kalipia|majina ya mpokeaji)' then 4
      end tier
    from m
  ), main as (
    select * from c where tier between 1 and 3
      and sent_at >= (select max(sent_at) - interval '10 days' from c where tier between 1 and 3)
    order by tier, sent_at asc limit 1
  ), backup as (
    select * from c where tier = 4 and not exists (select 1 from main) order by sent_at desc limit 1
  ), pick as (
    select sent_at, tier, b, id from main
    union all select sent_at, tier, b, id from backup
    union all select sent_at, 5, b, id from (select * from m where direction='in' order by sent_at desc limit 1) x
      where not exists (select 1 from main) and not exists (select 1 from backup)
  )
  select sent_at, case tier when 1 then 'payment_message' when 2 then 'receipt' when 3 then 'owner_tick' when 4 then 'customer_said_paid' else 'last_message' end,
    left(regexp_replace(b, '\s+', ' ', 'g'), 120), id
  from pick limit 1
$$;

drop function if exists private.ad_signal_for_v2(uuid);
drop function if exists public.payment_moment_v2(uuid, timestamptz);

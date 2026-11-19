-- 19 Nov 2026
-- 1) "Came from an ad? Yes / No" failed with "permission denied for table conversations":
--    the app could only change outcome_override / override_note. Let editors save source + ad_signal too
--    (row access is still limited by the cv_update policy: can_edit(workspace_id)).
grant update (source, ad_signal) on public.conversations to authenticated;

-- 2) The day the customer paid. Your "Matumizi ya <product>" message is sent the day the customer paid,
--    so it anchors the latest order. A payment message (receipt, "nimetuma", your "tumepokea") only wins
--    when it belongs to that same order: no more than 4 days before the first "Matumizi ya" of the latest
--    delivery, or after it. Before this, an old "nimelipa" from a previous order beat a newer delivery.
create or replace function public.payment_moment(p_conv uuid, p_before timestamptz default now())
returns table(at timestamptz, kind text, snippet text, message_id text)
language sql stable security invoker set search_path = public as $$
  with m as (
    select id, sent_at, direction, coalesce(body,'') b, media from messages
    where conversation_id = p_conv and sent_at <= p_before
  ), c as (
    select id, sent_at, b,
      case
        when direction='in' and ((media->'receipt'->>'is_receipt')='true' or b ilike '[picha ya malipo]%'
          or b ~* '(imethibitishwa|\mconfirmed\M[. ]|umetuma (tsh|tzs|sh)|umelipa (tsh|tzs|sh)|you have paid|paid to lipa|kwenda kwa mpokeaji)') then 1
        when direction='in' and b ~* '(nimetuma|nimelipa|nimelipia|nimeshalipa|nimeshalipia|nishalipa|nishalipia|nishatuma|nimeshatuma|nimekutumia|nimeweka (pesa|hela)|(nimefanya|nimeshafanya|nishafanya|nmefanya) malipo|huo hapo muamala|muamala huo|risiti hiyo|nimesend|i have paid|i.ve (paid|sent)|sent the money|\mpaid\M)' then 2
        when direction='out' and b ~* '(tumepokea (malipo|pesa|tsh|tzs)|malipo yamepokelewa|payment received|asante kwa malipo|umelipiwa|imelipiwa|amelipia|kalipia|majina ya mpokeaji)' then 3
        when direction='out' and b ~* '(^|\n)\s*matumizi (ya|yake)\M' then 4
        when b ~* '(dawa ulizopokea|nimepokea (mzigo|dawa))' then 6
      end tier
    from m
  ), weak as (
    -- The first "Matumizi ya …" (KayaPower, KayaTox, NgiriMaster…) of the latest delivery: the day they paid.
    -- Only when there is none: the first "dawa ulizopokea" / "nimepokea mzigo" of the latest delivery.
    select * from (
      select * from c where tier = 4 and sent_at >= (select max(sent_at) - interval '10 days' from c where tier = 4)
      union all
      select * from c where tier = 6 and not exists (select 1 from c where tier = 4)
        and sent_at >= (select max(sent_at) - interval '10 days' from c where tier = 6)
    ) w order by tier, sent_at asc limit 1
  ), strong as (
    select * from c where tier between 1 and 3
      and (not exists (select 1 from weak) or sent_at >= (select sent_at - interval '4 days' from weak))
    order by sent_at desc limit 1
  ), pick as (
    select sent_at, tier, b, id from strong
    union all select sent_at, tier, b, id from weak where not exists (select 1 from strong)
    union all select sent_at, 5, b, id from (select * from m where direction='in' order by sent_at desc limit 1) x
      where not exists (select 1 from strong) and not exists (select 1 from weak)
  )
  select sent_at, case tier when 1 then 'receipt' when 2 then 'customer_said_paid' when 3 then 'business_confirmed' when 4 then 'goods_received' when 6 then 'goods_received' else 'last_message' end,
    left(regexp_replace(b, '\s+', ' ', 'g'), 120), id
  from pick limit 1
$$;
grant execute on function public.payment_moment(uuid, timestamptz) to authenticated;

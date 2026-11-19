-- 19 Nov 2026 — the day the customer paid, as Daud set it. Three signs, in this order:
--   1. your "Matumizi ya KayaTox" message (only KayaTox; other products' "Matumizi ya …" don't count)
--   2. the customer's payment screenshot (or a pasted M-Pesa / bank message)
--   3. your short message with the price and a green tick, e.g. "175,000 ✅", "Umelipiwa ✅", "Paid ✅", "✅"
-- Only signs from the latest order count: those within 10 days before the newest sign. Old orders don't win.
-- If none of the three is in the chat: the customer saying they paid / your "tumepokea", else their last message.
create or replace function public.payment_moment(p_conv uuid, p_before timestamptz default now())
returns table(at timestamptz, kind text, snippet text, message_id text)
language sql stable security invoker set search_path = public as $$
  with m as (
    select id, sent_at, direction, coalesce(body,'') b, media from messages
    where conversation_id = p_conv and sent_at <= p_before
  ), c as (
    select id, sent_at, b,
      case
        when direction='out' and b ~* 'matumizi\s+ya\s+kaya\s*-?\s*tox' then 1
        when direction='in' and ((media->'receipt'->>'is_receipt')='true' or b ilike '[picha ya malipo]%'
          or b ~* '(imethibitishwa|\mconfirmed\M[. ]|umetuma (tsh|tzs|sh)|umelipa (tsh|tzs|sh)|you have paid|paid to lipa|kwenda kwa mpokeaji)') then 2
        when direction='out' and b ~ '(✅|✔)' and length(b) <= 160
          and (b ~ '\d[\d,.]{2,}|\d+\s*[kK]\M' or b ~* '(lipi|lipa|paid|malipo)' or btrim(b, E' \n\t✅✔️') = '') then 3
        when direction='in' and b ~* '(nimetuma|nimelipa|nimelipia|nimeshalipa|nimeshalipia|nishalipa|nishalipia|nishatuma|nimeshatuma|nimekutumia|nimeweka (pesa|hela)|(nimefanya|nimeshafanya|nishafanya|nmefanya) malipo|huo hapo muamala|muamala huo|risiti hiyo|nimesend|i have paid|i.ve (paid|sent)|sent the money|\mpaid\M)' then 4
        when direction='out' and b ~* '(tumepokea (malipo|pesa|tsh|tzs)|malipo yamepokelewa|payment received|asante kwa malipo|umelipiwa|imelipiwa|amelipia|kalipia|majina ya mpokeaji)' then 4
      end tier
    from m
  ), main as (
    -- The three signs of the latest order; the best sign wins, its first message gives the day.
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
  select sent_at, case tier when 1 then 'kayatox' when 2 then 'receipt' when 3 then 'owner_tick' when 4 then 'customer_said_paid' else 'last_message' end,
    left(regexp_replace(b, '\s+', ' ', 'g'), 120), id
  from pick limit 1
$$;
grant execute on function public.payment_moment(uuid, timestamptz) to authenticated;

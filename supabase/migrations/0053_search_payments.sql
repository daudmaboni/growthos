-- 21 Nov 2026 — Find a payment: search by name, phone, location and date (not only receipt / M-Pesa code).
-- search_payments(ws, q, by, from, to): paid (and refunded) sales, newest payment first.
--   by = 'any' | 'code' | 'name' | 'location'
--   code      → our receipt number (whole or part, "123" finds KH-000123) or the sale's transaction code
--   name      → the customer's WhatsApp name, or their phone ("0712…" and "255712…" both work)
--   location  → a place the customer wrote in the chat, in Kito's summary of the chat, or in the sale's notes
--               (whole-word start: "Mbeya" finds "Mbeya mjini", "dar" doesn't find "darasa")
--   from / to → the payment time (paid_at) window; with no search word, every payment in that window.
-- Runs with the caller's rights, so people only ever see their own business's sales. Read-only.

create or replace function public.search_payments(
  p_ws uuid, p_q text default null, p_by text default 'any',
  p_from timestamptz default null, p_to timestamptz default null, p_limit integer default 200)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare
  q text := nullif(btrim(coalesce(p_q, '')), '');
  qu text := upper(regexp_replace(coalesce(p_q, ''), '\s+', '', 'g'));
  qd text := regexp_replace(coalesce(p_q, ''), '\D', '', 'g');
  pat text;
  res jsonb;
begin
  if q is null and p_from is null and p_to is null then return '[]'::jsonb; end if;
  if q is not null and length(q) < 2 then return '[]'::jsonb; end if;
  if qd like '0%' then qd := '255' || substr(qd, 2); end if;
  -- the words as typed, special characters escaped, matched from the start of a word
  pat := '\m' || regexp_replace(coalesce(q, ''), '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g');

  with base as (
    select o.id, o.receipt_no, o.receipt_seq, o.payment_ref, o.notes, o.paid_at, o.conversation_id,
           cv.kito_summary, ct.name c_name, ct.wa_id c_phone
    from orders o
    left join conversations cv on cv.id = o.conversation_id
    left join contacts ct on ct.id = cv.contact_id
    where o.workspace_id = p_ws and o.status in ('paid', 'refunded')
      and (p_from is null or o.paid_at >= p_from) and (p_to is null or o.paid_at < p_to)
  ),
  hit as (
    select b.*,
      case
        when q is null then 'date'
        when p_by in ('any', 'code') and (upper(b.receipt_no) like '%' || qu || '%'
              or (qu ~ '^\d+$' and length(qu) <= 9 and b.receipt_seq = qu::bigint)
              or upper(b.payment_ref) like '%' || qu || '%') then 'code'
        when p_by in ('any', 'name') and (b.c_name ilike '%' || q || '%'
              or (length(qd) >= 4 and b.c_phone like '%' || qd || '%')) then 'name'
        when p_by in ('any', 'location') and (b.kito_summary ~* pat or b.notes ~* pat
              or exists (select 1 from messages m where m.conversation_id = b.conversation_id
                           and m.direction = 'in' and m.body ~* pat)) then 'location'
      end matched
    from base b
  ),
  picked as (
    select * from hit where matched is not null order by paid_at desc nulls last limit greatest(1, least(p_limit, 500))
  )
  select coalesce(jsonb_agg(item order by sort_at desc nulls last), '[]'::jsonb) into res from (
    select p.paid_at sort_at, jsonb_build_object(
      'matched', p.matched,
      -- for a location hit: the words around the place, from the customer's message, Kito's summary or the notes
      'place', case when p.matched = 'location' then coalesce(
          (select (regexp_match(regexp_replace(m.body, '\s+', ' ', 'g'), '.{0,40}' || pat || '.{0,40}', 'i'))[1]
             from messages m where m.conversation_id = p.conversation_id and m.direction = 'in' and m.body ~* pat
             order by m.sent_at desc limit 1),
          (regexp_match(p.kito_summary, '.{0,40}' || pat || '.{0,40}', 'i'))[1],
          (regexp_match(p.notes, '.{0,40}' || pat || '.{0,40}', 'i'))[1]) end,
      'order', (select jsonb_build_object(
        'id', o.id, 'receipt_no', o.receipt_no, 'amount', o.amount, 'discount', o.discount, 'refund_amount', o.refund_amount,
        'currency', o.currency, 'status', o.status, 'items', o.items, 'product', o.product, 'notes', o.notes,
        'paid_at', o.paid_at, 'occurred_at', o.occurred_at, 'created_at', o.created_at, 'provenance', o.provenance,
        'inferred_from', o.inferred_from, 'payment_ref', o.payment_ref, 'fulfillment_status', o.fulfillment_status)
        from orders o where o.id = p.id),
      'conversation_id', p.conversation_id,
      'customer', case when p.conversation_id is null then null else jsonb_build_object('name', p.c_name, 'phone', p.c_phone) end,
      'evidence', (
        select jsonb_build_object('message_id', m.id, 'sent_at', m.sent_at, 'direction', m.direction,
          'text', left(regexp_replace(coalesce(m.body, ''), '\s+', ' ', 'g'), 300), 'receipt', m.media->'receipt')
        from messages m
        where m.conversation_id = p.conversation_id
          and ((m.media->'receipt'->>'is_receipt') = 'true'
               or (m.direction = 'in' and m.body ~* '(confirmed|imethibitishwa|umetuma|umelipa|you have paid)'))
          and m.sent_at between p.paid_at - interval '4 days' and p.paid_at + interval '1 day'
        order by (p.payment_ref is not null and (upper(m.media->'receipt'->>'txn_code') = upper(p.payment_ref) or m.body like '%' || p.payment_ref || '%')) desc,
                 abs(extract(epoch from m.sent_at - p.paid_at))
        limit 1)
    ) item
    from picked p
  ) z;
  return res;
end $$;
grant execute on function public.search_payments(uuid, text, text, timestamptz, timestamptz, integer) to authenticated;

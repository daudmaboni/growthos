-- 21 Nov 2026 — Our own receipt numbers (Kumbukumbu Na.) and a payment lookup.
-- 1) Every paid sale gets a receipt number: the business's initials + a running number per business,
--    e.g. Kayani Herbs → KH-000123. Given once, never changed, never reused.
-- 2) Every sale also keeps the payment's transaction code (M-Pesa / Mixx / Airtel… "namba ya muamala")
--    read from the customer's receipt screenshot or the pasted payment SMS in that chat.
-- 3) find_payment(ws, text): type a receipt number, a transaction code (or part of either) and get the
--    whole payment: who, what, how much, when, how it was paid and the message that proves it.

alter table public.workspaces add column if not exists receipt_prefix text;
alter table public.orders add column if not exists receipt_no text;
alter table public.orders add column if not exists receipt_seq integer;
alter table public.orders add column if not exists payment_ref text;
create unique index if not exists orders_receipt_no_uidx on public.orders (workspace_id, receipt_no) where receipt_no is not null;
create index if not exists orders_payment_ref_idx on public.orders (workspace_id, upper(payment_ref)) where payment_ref is not null;

create table if not exists private.receipt_counters (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  last_no integer not null default 0
);

-- "Kayani Herbs" → "KH", "Duka la Mama Neema" → "DLM", one word "Fredyy" → "FRE".
-- Owners can set their own in workspaces.receipt_prefix.
create or replace function private.receipt_prefix(p_ws uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(upper(regexp_replace(w.receipt_prefix, '[^A-Za-z0-9]', '', 'g')), ''),
    (select case when length(i) >= 2 then i end from (select left(upper(string_agg(left(t, 1), '')), 3) i
       from regexp_split_to_table(regexp_replace(w.name, '[^A-Za-z0-9 ]', ' ', 'g'), '\s+') t where t <> '') x),
    nullif(left(upper(regexp_replace(w.name, '[^A-Za-z0-9]', '', 'g')), 3), ''),
    'IT')
  from public.workspaces w where w.id = p_ws
$$;

-- The transaction code of the payment behind a sale: a receipt screenshot Kito read, else a payment SMS
-- the customer pasted ("TKL8XJ2Q4P Confirmed…"), from 4 days before the payment day to 1 day after.
create or replace function private.payment_ref_for(p_conv uuid, p_paid timestamptz) returns text
language sql stable security definer set search_path = public as $$
  select ref from (
    select nullif(btrim(m.media->'receipt'->>'txn_code'), '') ref, m.sent_at, 1 pri
    from messages m
    where m.conversation_id = p_conv and (m.media->'receipt'->>'is_receipt') = 'true'
      and m.sent_at between p_paid - interval '4 days' and p_paid + interval '1 day'
    union all
    select substring(m.body from '\m([A-Z0-9]{10})\M'), m.sent_at, 2
    from messages m
    where m.conversation_id = p_conv and m.direction = 'in'
      and m.body ~* '(confirmed|imethibitishwa|umetuma|umelipa|you have paid)'
      and m.sent_at between p_paid - interval '4 days' and p_paid + interval '1 day'
  ) x where ref is not null
  order by pri, abs(extract(epoch from sent_at - p_paid)) limit 1
$$;

create or replace function private.orders_receipt_no() returns trigger
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if tg_op = 'UPDATE' then
    -- A receipt number never changes once given.
    if old.receipt_no is not null then new.receipt_no := old.receipt_no; new.receipt_seq := old.receipt_seq; end if;
  end if;
  if new.receipt_no is null and new.status = 'paid' then
    insert into private.receipt_counters as rc (workspace_id, last_no) values (new.workspace_id, 1)
      on conflict (workspace_id) do update set last_no = rc.last_no + 1
      returning last_no into n;
    new.receipt_seq := n;
    new.receipt_no := private.receipt_prefix(new.workspace_id) || '-' || lpad(n::text, 6, '0');
  end if;
  if new.payment_ref is null and new.conversation_id is not null and new.paid_at is not null then
    new.payment_ref := private.payment_ref_for(new.conversation_id, new.paid_at);
  end if;
  return new;
end $$;

drop trigger if exists orders_receipt_no on public.orders;
create trigger orders_receipt_no before insert or update on public.orders
  for each row execute function private.orders_receipt_no();

-- Number the sales already recorded, oldest payment first, and fill their transaction codes.
with numbered as (
  select o.id, o.workspace_id,
         row_number() over (partition by o.workspace_id order by coalesce(o.paid_at, o.occurred_at), o.created_at, o.id) seq
  from public.orders o where o.status = 'paid' and o.receipt_no is null
)
update public.orders o set receipt_seq = n.seq, receipt_no = private.receipt_prefix(n.workspace_id) || '-' || lpad(n.seq::text, 6, '0')
from numbered n where n.id = o.id;

insert into private.receipt_counters (workspace_id, last_no)
  select workspace_id, max(receipt_seq) from public.orders where receipt_seq is not null group by workspace_id
on conflict (workspace_id) do update set last_no = greatest(private.receipt_counters.last_no, excluded.last_no);

update public.orders o set payment_ref = private.payment_ref_for(o.conversation_id, o.paid_at)
where o.payment_ref is null and o.conversation_id is not null and o.paid_at is not null;

-- The lookup. Runs with the caller's rights, so people only ever find their own business's payments.
-- Matches: receipt number (whole or part, "123" finds KH-000123), the sale's transaction code,
-- a transaction code on a receipt screenshot or in a pasted payment SMS (then the sale in that chat),
-- or a payment that was sent but never recorded as a sale (returned with order = null).
create or replace function public.find_payment(p_ws uuid, p_q text)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare
  q text := upper(regexp_replace(coalesce(p_q, ''), '\s+', '', 'g'));
  digits text := regexp_replace(coalesce(p_q, ''), '\D', '', 'g');
  res jsonb;
begin
  if length(q) < 3 then return '[]'::jsonb; end if;
  with
  by_order as (
    select o.id from orders o
    where o.workspace_id = p_ws and (
      upper(o.receipt_no) like '%' || q || '%'
      or (q ~ '^\d+$' and o.receipt_seq = q::bigint)
      or upper(o.payment_ref) like '%' || q || '%')
  ),
  pay_msgs as (
    select m.id, m.conversation_id, m.sent_at from messages m
    where m.workspace_id = p_ws and length(q) >= 5 and (
      upper(m.media->'receipt'->>'txn_code') like '%' || q || '%'
      or (m.body ilike '%' || q || '%' and m.body ~* '(confirmed|imethibitishwa|umetuma|umelipa|you have paid|muamala|risiti)'))
    order by m.sent_at desc limit 20
  ),
  by_msg as (   -- the sale in that chat closest to the payment message
    select distinct on (p.id) p.id msg_id, o.id order_id, p.conversation_id
    from pay_msgs p left join orders o on o.conversation_id = p.conversation_id and o.status = 'paid'
      and o.paid_at between p.sent_at - interval '4 days' and p.sent_at + interval '10 days'
    order by p.id, abs(extract(epoch from o.paid_at - p.sent_at)) nulls last
  ),
  hits as (
    select id order_id, null::text msg_id from by_order
    union select order_id, null from by_msg where order_id is not null
    union select null, msg_id from by_msg where order_id is null
  ),
  rows_ as (
    select h.*, o.*, coalesce(o.conversation_id, m.conversation_id) conv_id, m.sent_at msg_at
    from hits h left join orders o on o.id = h.order_id left join messages m on m.id = h.msg_id
  )
  select coalesce(jsonb_agg(item order by sort_at desc nulls last), '[]'::jsonb) into res from (
    select coalesce(r.paid_at, r.msg_at) sort_at, jsonb_build_object(
      'order', case when r.order_id is null then null else jsonb_build_object(
        'id', r.order_id, 'receipt_no', r.receipt_no, 'amount', r.amount, 'discount', r.discount, 'refund_amount', r.refund_amount,
        'currency', r.currency, 'status', r.status, 'items', r.items, 'product', r.product, 'notes', r.notes,
        'paid_at', r.paid_at, 'occurred_at', r.occurred_at, 'created_at', r.created_at, 'provenance', r.provenance,
        'inferred_from', r.inferred_from, 'payment_ref', r.payment_ref, 'fulfillment_status', r.fulfillment_status) end,
      'conversation_id', r.conv_id,
      'customer', (select jsonb_build_object('name', ct.name, 'phone', ct.wa_id) from conversations cv join contacts ct on ct.id = cv.contact_id where cv.id = r.conv_id),
      -- The proof: the receipt screenshot / payment SMS for this payment.
      'evidence', (
        select jsonb_build_object('message_id', m.id, 'sent_at', m.sent_at, 'direction', m.direction,
          'text', left(regexp_replace(coalesce(m.body, ''), '\s+', ' ', 'g'), 300), 'receipt', m.media->'receipt')
        from messages m
        where m.conversation_id = r.conv_id and (
          (r.msg_id is not null and m.id = r.msg_id)
          or (r.msg_id is null and ((m.media->'receipt'->>'is_receipt') = 'true'
              or (m.direction = 'in' and m.body ~* '(confirmed|imethibitishwa|umetuma|umelipa|you have paid)'))
              and m.sent_at between r.paid_at - interval '4 days' and r.paid_at + interval '1 day'))
        order by (r.payment_ref is not null and (upper(m.media->'receipt'->>'txn_code') = upper(r.payment_ref) or m.body like '%' || r.payment_ref || '%')) desc,
                 abs(extract(epoch from m.sent_at - coalesce(r.paid_at, m.sent_at)))
        limit 1)
    ) item
    from rows_ r
  ) z;
  return res;
end $$;
grant execute on function public.find_payment(uuid, text) to authenticated;

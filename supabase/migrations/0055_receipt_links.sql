-- 21 Nov 2026 — A real QR code on every printed receipt.
-- The QR opens itaos.app/r/<secret>: anyone who scans it sees that the receipt is genuine (paid / refunded /
-- cancelled, amount, items, date), can order again or ask a question on the business's WhatsApp, and
-- signed-in staff of that business get "Open in itaOS".
--
-- Why a secret and not the receipt number: receipt numbers count up (KH-000042, KH-000043…), so anyone could
-- try the next number and read other customers' purchases. Each sale gets a random 22-character code
-- (122 bits) instead; it can't be guessed. The public page shows only what is printed on the paper receipt,
-- and the customer's first name only (no phone number).
--
-- The codes live in their own table, not on orders: making a link or counting a scan is never an edit to the
-- sale (no updated_at change, no order_events audit row, nothing for other order triggers to react to).
-- A sale gets its code the first time someone opens Print receipt for it (receipt_link).
-- If a receipt photo is shared somewhere it shouldn't be, an owner/admin can give the sale a new code
-- (rotate_receipt_link); the old QR then says "not found".

create table if not exists private.receipt_links (
  order_id uuid primary key references public.orders(id) on delete cascade,
  token text not null unique check (token ~ '^[A-Za-z0-9_-]{16,40}$'),
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  scans integer not null default 0,     -- customer opens (staff of the business aren't counted)
  first_scan_at timestamptz,
  last_scan_at timestamptz
);

-- 16 random bytes → 22 URL-safe characters. gen_random_uuid() is built in (no pgcrypto needed); the v4 UUID
-- carries 122 random bits.
create or replace function private.new_receipt_token() returns text
language sql volatile set search_path = public as $$
  select translate(encode(decode(replace(gen_random_uuid()::text, '-', ''), 'hex'), 'base64'), '+/=', '-_')
$$;

-- Staff: the sale's code (made on first use). Only for members of the sale's business, and only for sales
-- that have a receipt number.
create or replace function public.receipt_link(p_order uuid)
returns text language plpgsql volatile security definer set search_path = public as $$
declare ws uuid; no text; t text;
begin
  select workspace_id, receipt_no into ws, no from public.orders where id = p_order;
  if ws is null or not public.is_member(ws) then raise exception 'forbidden' using errcode = '42501'; end if;
  if no is null then return null; end if;
  insert into private.receipt_links (order_id, token) values (p_order, private.new_receipt_token())
    on conflict (order_id) do nothing;
  select token into t from private.receipt_links where order_id = p_order;
  return t;
end $$;

revoke all on function public.receipt_link(uuid) from public, anon;
grant execute on function public.receipt_link(uuid) to authenticated, service_role;

-- The public check. Callable without signing in (that's the point of a QR anyone can scan).
-- Returns null for a code that doesn't exist. Only paper-receipt facts are returned; staff of the business
-- (signed in on this phone) additionally get the ids to open the sale and how often customers opened it.
create or replace function public.receipt_check(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  o record;
  staff boolean;
  wa text;
  items jsonb;
  first_name text;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{16,40}$' then return null; end if;

  select ord.id, ord.workspace_id, ord.receipt_no, ord.status, ord.amount, ord.discount, ord.refund_amount,
         ord.currency, ord.paid_at, ord.occurred_at, ord.items, ord.product, ord.payment_ref, ord.fulfillment_status,
         ord.conversation_id, l.scans, l.first_scan_at, l.last_scan_at,
         w.name biz, coalesce(w.timezone, 'Africa/Dar_es_Salaam') tz
    into o
    from private.receipt_links l
    join public.orders ord on ord.id = l.order_id
    join public.workspaces w on w.id = ord.workspace_id
   where l.token = p_token and ord.receipt_no is not null;
  if not found then return null; end if;

  staff := auth.uid() is not null and public.is_member(o.workspace_id);

  -- Count customer opens only, at most one per minute per receipt.
  if not staff and (o.last_scan_at is null or o.last_scan_at < now() - interval '1 minute') then
    update private.receipt_links
       set scans = scans + 1, first_scan_at = coalesce(first_scan_at, now()), last_scan_at = now()
     where order_id = o.id;
  end if;

  select n.display_phone into wa from public.wa_numbers n where n.workspace_id = o.workspace_id
   order by n.display_phone nulls last limit 1;

  items := case
    when jsonb_typeof(o.items) = 'array' and jsonb_array_length(o.items) > 0 then
      (select jsonb_agg(jsonb_build_object('name', coalesce(i->>'name', '?'), 'qty', coalesce((i->>'qty')::numeric, 1)))
         from jsonb_array_elements(o.items) i)
    when nullif(btrim(o.product), '') is not null then
      (select jsonb_agg(jsonb_build_object('name', btrim(p), 'qty', 1))
         from regexp_split_to_table(o.product, '\s*[,+]\s*') p where btrim(p) <> '')
    else '[]'::jsonb end;

  -- First name only: the corrected name (contacts.full_name, 0054) if set, else the WhatsApp name.
  select nullif(split_part(btrim(coalesce(nullif(btrim(c.full_name), ''), c.name)), ' ', 1), '') into first_name
    from public.conversations cv join public.contacts c on c.id = cv.contact_id
   where cv.id = o.conversation_id;

  return jsonb_build_object(
    'business', o.biz,
    'business_wa', nullif(regexp_replace(coalesce(wa, ''), '\D', '', 'g'), ''),
    'timezone', o.tz,
    'receipt_no', o.receipt_no,
    'status', o.status,
    'currency', o.currency,
    'total', o.amount - o.discount - o.refund_amount,
    'paid', o.amount - o.discount,
    'refunded', o.refund_amount,
    'paid_at', coalesce(o.paid_at, o.occurred_at),
    'items', coalesce(items, '[]'::jsonb),
    'customer', first_name,
    'payment_ref_end', case when length(o.payment_ref) >= 4 then right(o.payment_ref, 4) end,
    'delivery', o.fulfillment_status,
    'staff', case when staff then jsonb_build_object(
      'order_id', o.id, 'workspace_id', o.workspace_id,
      'scans', o.scans, 'first_scan_at', o.first_scan_at, 'last_scan_at', o.last_scan_at) end
  );
end $$;

revoke all on function public.receipt_check(text) from public;
grant execute on function public.receipt_check(text) to anon, authenticated, service_role;

-- Owner/admin: give a sale a new secret code. The old QR stops working. Returns the new code.
create or replace function public.rotate_receipt_link(p_order uuid)
returns text language plpgsql volatile security definer set search_path = public as $$
declare ws uuid; no text; t text := private.new_receipt_token();
begin
  select workspace_id, receipt_no into ws, no from public.orders where id = p_order;
  if ws is null or not public.can_manage(ws) then raise exception 'forbidden' using errcode = '42501'; end if;
  if no is null then raise exception 'this sale has no receipt yet' using errcode = '22023'; end if;
  insert into private.receipt_links (order_id, token) values (p_order, t)
    on conflict (order_id) do update set token = excluded.token, rotated_at = now(),
      scans = 0, first_scan_at = null, last_scan_at = null;
  return t;
end $$;

revoke all on function public.rotate_receipt_link(uuid) from public, anon;
grant execute on function public.rotate_receipt_link(uuid) to authenticated, service_role;

revoke all on function private.new_receipt_token() from public, anon, authenticated;

-- 21 Nov 2026 — A buyer's location is the delivery location THEY wrote ("Kyela, boda Kasumulu",
-- "Nyashimo, Busega", "Mpendae/ Zanzibar"), saved word for word in contacts.delivery_place. Taken only
-- from their delivery message: (3) name + phone + place, (2) a labelled place ("Mahali: …", "Nipo …"),
-- (1) a short reply that is just a place. Talk about trips ("safari kwenda Dodoma", "nimerejea toka
-- Arusha") never counts; no delivery message → no location rather than a guess. Region / district are
-- still worked out from those words, for the region filter. Receipts print delivery_place as written.
-- Also: suggested names lose place words stuck on the end ("Rance Felix Morogoro" → "Rance Felix"), and
-- the business's own numbers (and the name next to them) are never taken as a customer's.
-- Suggestions not confirmed by the owner are recomputed with these rules; owner entries are untouched.

alter table public.contacts add column if not exists delivery_place text;

create or replace function private.delivery_place_for(p_contact uuid)
returns table(place text, region text, district text, evidence text)
language plpgsql stable security definer set search_path = public as $$
declare
  phone_re constant text := '(\+?255[ -]?[67]\d{2}[ -]?\d{3}[ -]?\d{3}|0[67]\d{2}[ -]?\d{3}[ -]?\d{3})';
  label_re constant text := '\m(mahali|niko|nipo|npo|napatikana|naishi|mkoa|sehemu|niletee|aniletee|nitumie|unitumie|tuma)\M\s*[:\-–]?\s*\**';
  travel_re constant text := '\m(safari|kwenda|nimerejea|nilikuwa|nilikua|nilitoka|nimetoka|narudi|nirudi|nikirudi|naelekea|nilisafiri|nilienda|nimeenda|nilienda|nimesafiri|nitakuwa)\M|\mkuja dar\M';
  -- the place ends where the sentence moves on: a question, "but", "how do I get it", thanks, the bus…
  stop_re constant text := '\s*(\m(basi|gari|pakia|kituo|namba|simu|jina|mzigo|asante|nitalipa|naipataje|nazipataje|napataje|nipate|napata|mnatuma|munatuma|jee|je|ipi|lakini|ila|hadi|mpaka|utaratibu|ukoje|bado|natarajia|kuja|huku|cjui|sijui|nataka|nahitaji|naomba|vip|vipi|hiyo|dawa|ofisi|office|mnaofisi|mnaoffice|mnaofficce|boss|bro|kaka|dada|kesho|leo|asubuh|asubuhi|napa|nikuletee|unaweza|tafadhali|please)\M|[?!\n]|\.\s).*$';
  lead_re constant text := '^[\s:;,.\-–/>]*((hapa|huku|kwa|ni|n|wa|ya|nipo|niko|npo|mimi|mm|mi|eneo|maeneo ya)\s+)*';
  biz text[];
  m record; t text; after_ph text; before_ph text; pl record; firstpos int;
begin
  select array_agg(regexp_replace(display_phone, '\D', '', 'g')) || array['255745160572', '255626277027'] into biz
    from wa_numbers where workspace_id = (select workspace_id from contacts where id = p_contact);
  -- the customer's delivery message: (3) name/phone/place, (2) a labelled place ("Mahali: …", "Nipo …"),
  -- (1) a short reply that is just a place ("Mbezi", "Goba mti pesa"). Talk about trips doesn't count.
  for m in
    select x.body, x.sent_at, x.score from (
      select regexp_replace(regexp_replace(mm.body, '[*_📍📞]', '', 'g'), '\s+', ' ', 'g') body, mm.sent_at,
        case
          when mm.body ~ phone_re and exists (select 1 from private.tz_places p where mm.body ~* ('\m' || p.name || '\M'))
               and not (regexp_replace(substring(mm.body from phone_re), '\D', '', 'g') ~ ('^(0|255)?(' || array_to_string(array(select right(b, 9) from unnest(biz) b), '|') || ')$')) then 3
          when mm.body ~* label_re and mm.body !~* travel_re and exists (select 1 from private.tz_places p where mm.body ~* ('\m' || p.name || '\M')) then 2
          when length(mm.body) <= 40 and mm.body !~* travel_re and exists (select 1 from private.tz_places p where mm.body ~* ('\m' || p.name || '\M')) then 1
          else 0 end score
      from conversations cv join messages mm on mm.conversation_id = cv.id and mm.direction = 'in' and mm.body is not null
      where cv.contact_id = p_contact
    ) x where x.score > 0
    order by x.score desc, x.sent_at desc limit 1
  loop
    t := null;
    if m.score = 3 then
      after_ph := btrim(regexp_replace(substring(m.body from position(substring(m.body from phone_re) in m.body) + length(substring(m.body from phone_re))), phone_re, '', 'g'));
      after_ph := btrim(regexp_replace(after_ph, '^[\s.,:;/-]+', ''));
      if after_ph ~* label_re then after_ph := regexp_replace(after_ph, '^.*?' || label_re, '', 'i'); end if;
      after_ph := btrim(regexp_replace(after_ph, stop_re, '', 'i'));
      if after_ph ~ '[A-Za-z]{3}' then
        -- name before the place ("Erick Inocent Dodoma") is dropped unless the customer separated parts with , / -
        select min(strpos(lower(after_ph), lower(p.name))) into firstpos from private.tz_places p where after_ph ~* ('\m' || p.name || '\M');
        if firstpos > 1 and substr(after_ph, 1, firstpos - 1) !~ '[,/\-]' then after_ph := substr(after_ph, firstpos); end if;
        t := after_ph;
      else
        before_ph := btrim(substring(m.body from 1 for position(substring(m.body from phone_re) in m.body) - 1));
        select min(strpos(lower(before_ph), lower(p.name))) into firstpos from private.tz_places p where before_ph ~* ('\m' || p.name || '\M');
        if firstpos > 0 then t := substr(before_ph, firstpos); end if;
      end if;
    elsif m.score = 2 then
      t := regexp_replace(m.body, '^.*?' || label_re, '', 'i');
      t := btrim(regexp_replace(t, stop_re, '', 'i'));
    else
      t := btrim(regexp_replace(m.body, stop_re, '', 'i'));
    end if;
    t := btrim(regexp_replace(t, stop_re, '', 'i'));
    t := btrim(regexp_replace(coalesce(t, ''), lead_re, '', 'i'));
    -- start at the place itself ("Mi mteja wako Edwin wa Kahama" → "Kahama"), unless the customer wrote
    -- something before it with , / - (e.g. "Nyashimo, Busega", "Mpendae/ Zanzibar")
    select min(strpos(lower(t), lower(p.name))) into firstpos from private.tz_places p where t ~* ('\m' || p.name || '\M');
    if firstpos is null then return; end if;   -- no place in what's left → no location rather than a guess
    if firstpos > 1 and substr(t, 1, firstpos - 1) !~ '[,/\-]' then t := substr(t, firstpos); end if;
    t := btrim(regexp_replace(left(t, 70), '[\s.,:;/>-]+$', ''));
    t := btrim(regexp_replace(t, '(\s+(kwa|na|ya|wa|ni|pale|hapa|mjin))+$', '', 'i'));
    if t = '' or t !~* '[a-z]{3}' then return; end if;
    select p.region, case when p.kind = 'town' then initcap(p.name) end d into pl
      from private.tz_places p where t ~* ('\m' || p.name || '\M') order by (p.kind <> 'region') desc, length(p.name) desc limit 1;
    if pl.region is null then
      select p.region, case when p.kind = 'town' then initcap(p.name) end d into pl
        from private.tz_places p where m.body ~* ('\m' || p.name || '\M') order by (p.kind <> 'region') desc, length(p.name) desc limit 1;
    end if;
    place := t; region := pl.region; district := pl.d; evidence := left(m.body, 160);
    return next;
  end loop;
end $$;

-- Business numbers a customer may forward (ours, never theirs).
create or replace function private.business_phones(p_ws uuid) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(right(regexp_replace(display_phone, '\D', '', 'g'), 9)), '{}') || array['745160572', '626277027']
  from wa_numbers where workspace_id = p_ws
$$;

drop function if exists private.fill_contact_location(uuid);
create or replace function private.fill_contact_location(p_contact uuid, p_force boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare s record; c record;
begin
  if p_contact is null then return; end if;
  select * into c from contacts where id = p_contact;
  if c.id is null or c.location_source = 'owner' then return; end if;
  if not p_force and (c.delivery_place is not null or c.region is not null) then return; end if;
  select * into s from private.delivery_place_for(p_contact);
  update contacts set delivery_place = s.place, region = s.region, district = s.district, area = null,
         location_source = case when s.place is null then null else 'auto' end, location_evidence = s.evidence
   where id = p_contact and location_source is distinct from 'owner';
end $$;

drop function if exists private.fill_contact_details(uuid);
create or replace function private.fill_contact_details(p_contact uuid, p_force boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare c record; mm text[]; nm text; ph text; biz text[]; w text; changed boolean;
  phone_re constant text := '(\+?255[ -]?[67]\d{2}[ -]?\d{3}[ -]?\d{3}|0[67]\d{2}[ -]?\d{3}[ -]?\d{3})';
begin
  select * into c from contacts where id = p_contact;
  if c.id is null then return; end if;
  if not p_force and c.full_name is not null and c.alt_phone is not null then return; end if;
  biz := private.business_phones(c.workspace_id);
  select regexp_match(regexp_replace(regexp_replace(m.body, '[*_]', '', 'g'), '\s+', ' ', 'g'),
           '([A-Za-z][A-Za-z.'' ]{3,60}?)[ ,:;-]*' || phone_re)
    into mm
  from conversations cv join messages m on m.conversation_id = cv.id and m.direction = 'in'
  where cv.contact_id = p_contact and m.body ~ phone_re
    and right(regexp_replace(substring(m.body from phone_re), '\D', '', 'g'), 9) <> all (biz)
  order by m.sent_at desc limit 1;
  if mm is not null then
    nm := initcap(btrim(regexp_replace(mm[1], '^(jina( langu)?( ni)?|name|majina|mimi( ni)?|naitwa|mpokeaji)\s*[:;-]?\s+', '', 'i')));
    nm := btrim(regexp_replace(nm, '^(kwa|ni|mpokeaji|jina)\s+', '', 'i'));
    -- drop place words and fillers stuck on the end of the name
    loop
      changed := false;
      w := lower(substring(nm from '([A-Za-z.'']+)$'));
      if w is not null and (w in ('mjini','mby','na','town','city','zanzbar','znz','mkoa','wilaya','kaka','dada','ndugu','mr','mrs')
           or exists (select 1 from private.tz_places p where lower(p.name) = w)) then
        nm := btrim(regexp_replace(nm, '\s*[A-Za-z.'']+$', ''));
        changed := true;
      end if;
      exit when not changed or nm = '';
    end loop;
    nm := btrim(nm, ' .');
    if nm !~ '^[A-Za-z.'']+( [A-Za-z.'']+){1,3}$'
       or nm ~* '\m(no|namba|nambari|simu|za|ya|cm|ni|mzigo|sawa|nipo|niko|kwa|tuma|hii|hiyo|huo|naomba|pale|mkoa|kijiji|wilaya|town|mtaa|kwenda|tumia|mpokeaji|kupokea|jina|habari|asante|ok|guys|dawa)\M'
    then nm := null; end if;
    ph := regexp_replace(mm[2], '\D', '', 'g');
    if ph like '0%' then ph := '255' || substr(ph, 2); end if;
  end if;
  update contacts set
    full_name = case when name_source = 'owner' then full_name when p_force or full_name is null then nm else full_name end,
    name_source = case when name_source = 'owner' then 'owner' when (p_force or full_name is null) then case when nm is null then null else 'auto' end else name_source end,
    alt_phone = case when details_updated_at is not null then alt_phone
                     when p_force or alt_phone is null then case when ph is not null and ph <> wa_id then '0' || substr(ph, 4) end
                     else alt_phone end
  where id = p_contact;
end $$;

-- Redo every suggestion the owner hasn't confirmed, with the new rules.
select private.fill_contact_location(c.id, true), private.fill_contact_details(c.id, true)
from (select distinct coalesce(o.contact_id, cv.contact_id) id
      from orders o left join conversations cv on cv.id = o.conversation_id
      where o.status = 'paid') c
where c.id is not null;

-- Saving the form: the delivery location as typed, plus region / district for the filter.
drop function if exists public.save_customer(uuid, text, text, text, text, text, text, text);
create or replace function public.save_customer(
  p_contact uuid, p_full_name text default null, p_alt_phone text default null, p_delivery_place text default null,
  p_region text default null, p_district text default null, p_area text default null, p_landmark text default null,
  p_delivery_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_ws uuid; c record;
begin
  select * into c from contacts where id = p_contact;
  v_ws := c.workspace_id;
  if v_ws is null or not public.can_edit(v_ws) then raise exception 'not allowed'; end if;
  update contacts set
    full_name = left(nullif(btrim(p_full_name), ''), 120),
    name_source = case when nullif(btrim(p_full_name), '') is null then null else 'owner' end,
    alt_phone = left(nullif(btrim(p_alt_phone), ''), 30),
    delivery_place = left(nullif(btrim(p_delivery_place), ''), 160),
    region = left(nullif(btrim(p_region), ''), 60),
    district = left(nullif(btrim(p_district), ''), 80),
    area = left(nullif(btrim(p_area), ''), 120),
    landmark = left(nullif(btrim(p_landmark), ''), 200),
    delivery_note = left(nullif(btrim(p_delivery_note), ''), 300),
    location_source = case when nullif(btrim(coalesce(p_delivery_place,'') || coalesce(p_region,'') || coalesce(p_district,'') || coalesce(p_area,'')), '') is null then null else 'owner' end,
    location_evidence = case when coalesce(c.delivery_place, '') is distinct from coalesce(nullif(btrim(p_delivery_place), ''), '') then null else location_evidence end,
    details_updated_at = now(), details_updated_by = auth.uid()
  where id = p_contact;
end $$;
revoke all on function public.save_customer(uuid, text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.save_customer(uuid, text, text, text, text, text, text, text, text) to authenticated;

create or replace function public.list_buyers(p_ws uuid, p_q text default null, p_region text default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare q text := nullif(btrim(coalesce(p_q, '')), ''); qd text := regexp_replace(coalesce(p_q, ''), '\D', '', 'g'); res jsonb;
begin
  if qd like '0%' then qd := '255' || substr(qd, 2); end if;
  with sales as (
    select coalesce(o.contact_id, cv.contact_id) buyer_id, o.amount, o.discount, o.refund_amount, o.paid_at, o.currency,
           o.conversation_id, o.receipt_no, o.items, o.product
    from orders o left join conversations cv on cv.id = o.conversation_id
    where o.workspace_id = p_ws and o.status = 'paid'
  ),
  prods as (
    select buyer_id, string_agg(distinct x, ', ') products from (
      select s.buyer_id, it->>'name' x from sales s, jsonb_array_elements(coalesce(s.items, '[]'::jsonb)) it
      union all
      select s.buyer_id, btrim(p) from sales s, regexp_split_to_table(coalesce(s.product, ''), '\s*,\s*') p
       where coalesce(s.items, '[]'::jsonb) = '[]'::jsonb
    ) z where x is not null and x <> '' group by buyer_id
  ),
  agg as (
    select s.buyer_id, count(*) n, sum(s.amount - coalesce(s.discount, 0) - coalesce(s.refund_amount, 0)) spent,
           min(s.paid_at) first_at, max(s.paid_at) last_at, max(s.currency) currency,
           (array_agg(s.conversation_id order by s.paid_at desc nulls last))[1] last_conv,
           (array_agg(s.receipt_no order by s.paid_at desc nulls last))[1] last_receipt
    from sales s where s.buyer_id is not null group by s.buyer_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'contact_id', c.id, 'wa_name', c.name, 'full_name', c.full_name, 'phone', c.wa_id, 'alt_phone', c.alt_phone,
      'delivery_place', c.delivery_place, 'region', c.region, 'district', c.district, 'area', c.area, 'landmark', c.landmark, 'delivery_note', c.delivery_note,
      'location_source', c.location_source, 'location_evidence', c.location_evidence, 'name_source', c.name_source,
      'orders', a.n, 'spent', a.spent, 'currency', a.currency, 'first_at', a.first_at, 'last_at', a.last_at,
      'last_conversation_id', a.last_conv, 'last_receipt', a.last_receipt, 'products', pr.products
    ) order by a.last_at desc nulls last), '[]'::jsonb) into res
  from agg a join contacts c on c.id = a.buyer_id left join prods pr on pr.buyer_id = a.buyer_id
  where c.workspace_id = p_ws and not coalesce(c.not_customer, false)
    and (p_region is null or c.region = p_region)
    and (q is null or c.name ilike '%' || q || '%' or c.full_name ilike '%' || q || '%'
         or (length(qd) >= 4 and (c.wa_id like '%' || qd || '%' or regexp_replace(coalesce(c.alt_phone, ''), '\D', '', 'g') like '%' || right(qd, 9) || '%'))
         or concat_ws(' ', c.delivery_place, c.region, c.district, c.area, c.landmark) ilike '%' || q || '%'
         or pr.products ilike '%' || q || '%');
  return res;
end $$;
grant execute on function public.list_buyers(uuid, text, text) to authenticated;

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
           cv.kito_summary, ct.name c_name, ct.wa_id c_phone, ct.full_name c_full, ct.alt_phone c_alt,
           ct.region c_region, ct.district c_district, ct.area c_area, ct.landmark c_landmark,
           ct.delivery_place c_dp, concat_ws(' ', ct.delivery_place, ct.region, ct.district, ct.area, ct.landmark) c_loc
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
        when p_by in ('any', 'name') and (b.c_name ilike '%' || q || '%' or b.c_full ilike '%' || q || '%'
              or (length(qd) >= 4 and (b.c_phone like '%' || qd || '%'
                  or regexp_replace(coalesce(b.c_alt, ''), '\D', '', 'g') like '%' || right(qd, 9) || '%'))) then 'name'
        when p_by in ('any', 'location') and (b.c_loc ~* pat or b.kito_summary ~* pat or b.notes ~* pat
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
          case when p.c_loc ~* pat then coalesce(p.c_dp, concat_ws(', ', p.c_area, p.c_district, p.c_region)) end,
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
      'customer', case when p.conversation_id is null then null else jsonb_build_object(
        'name', coalesce(p.c_full, p.c_name), 'wa_name', p.c_name, 'phone', p.c_phone, 'alt_phone', p.c_alt,
        'location', coalesce(p.c_dp, nullif(concat_ws(', ', p.c_area, p.c_district, p.c_region), '')), 'region', p.c_region, 'landmark', p.c_landmark) end,
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
      'customer', (select jsonb_build_object('name', coalesce(ct.full_name, ct.name), 'wa_name', ct.name, 'phone', ct.wa_id, 'alt_phone', ct.alt_phone,
          'location', coalesce(ct.delivery_place, nullif(concat_ws(', ', ct.area, ct.district, ct.region), '')), 'region', ct.region, 'landmark', ct.landmark)
        from conversations cv join contacts ct on ct.id = cv.contact_id where cv.id = r.conv_id),
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

-- 21 Nov 2026 — Customer records for buyers: corrected name, second phone and location (region, district,
-- area, landmark, delivery note), used by the Buyers page, Find a payment and printed receipts.
-- * Location is suggested automatically from places the customer wrote in the chat (towns mapped to their
--   region, Dar es Salaam neighbourhoods as the area) and marked 'auto' until the owner confirms or edits it.
-- * The owner's edits ('owner') are never overwritten by a suggestion.
-- * WhatsApp's own name (contacts.name) stays as it is; full_name is the corrected one shown everywhere.

alter table public.contacts
  add column if not exists full_name text,
  add column if not exists alt_phone text,
  add column if not exists region text,
  add column if not exists district text,
  add column if not exists area text,
  add column if not exists landmark text,
  add column if not exists delivery_note text,
  add column if not exists location_source text check (location_source in ('auto', 'owner')),
  add column if not exists name_source text check (name_source in ('auto', 'owner')),
  add column if not exists location_evidence text,
  add column if not exists details_updated_at timestamptz,
  add column if not exists details_updated_by uuid;

-- Places we recognise in chats. kind: region | town (district/town → its region) | area (Dar neighbourhood).
-- Words that are also everyday Swahili (Mara, Hai, Mwanga, Same, Magu…) are left out on purpose.
create table if not exists private.tz_places (name text primary key, region text not null, kind text not null);
insert into private.tz_places (name, region, kind) values
 ('Arusha','Arusha','region'),('Dar es Salaam','Dar es Salaam','region'),('Dar','Dar es Salaam','region'),('Dsm','Dar es Salaam','region'),
 ('Dodoma','Dodoma','region'),('Geita','Geita','region'),('Iringa','Iringa','region'),('Kagera','Kagera','region'),('Katavi','Katavi','region'),
 ('Kigoma','Kigoma','region'),('Kilimanjaro','Kilimanjaro','region'),('Lindi','Lindi','region'),('Manyara','Manyara','region'),
 ('Mbeya','Mbeya','region'),('Morogoro','Morogoro','region'),('Mtwara','Mtwara','region'),('Mwanza','Mwanza','region'),('Njombe','Njombe','region'),
 ('Pwani','Pwani','region'),('Rukwa','Rukwa','region'),('Ruvuma','Ruvuma','region'),('Shinyanga','Shinyanga','region'),('Simiyu','Simiyu','region'),
 ('Singida','Singida','region'),('Songwe','Songwe','region'),('Tabora','Tabora','region'),('Tanga','Tanga','region'),
 ('Zanzibar','Zanzibar','region'),('Unguja','Zanzibar','region'),('Pemba','Zanzibar','region'),('Zenji','Zanzibar','region'),
 -- towns / districts
 ('Bukoba','Kagera','town'),('Karagwe','Kagera','town'),('Muleba','Kagera','town'),('Ngara','Kagera','town'),('Biharamulo','Kagera','town'),
 ('Musoma','Mara','town'),('Tarime','Mara','town'),('Bunda','Mara','town'),('Serengeti','Mara','town'),('Rorya','Mara','town'),
 ('Kahama','Shinyanga','town'),('Kishapu','Shinyanga','town'),
 ('Moshi','Kilimanjaro','town'),('Rombo','Kilimanjaro','town'),('Siha','Kilimanjaro','town'),('Himo','Kilimanjaro','town'),
 ('Babati','Manyara','town'),('Mbulu','Manyara','town'),('Mererani','Manyara','town'),('Kiteto','Manyara','town'),('Simanjiro','Manyara','town'),
 ('Mpanda','Katavi','town'),('Sumbawanga','Rukwa','town'),('Tunduma','Songwe','town'),('Mbozi','Songwe','town'),('Vwawa','Songwe','town'),('Mlowo','Songwe','town'),
 ('Kyela','Mbeya','town'),('Tukuyu','Mbeya','town'),('Rungwe','Mbeya','town'),('Chunya','Mbeya','town'),('Mbarali','Mbeya','town'),('Mbalizi','Mbeya','town'),('Uyole','Mbeya','town'),
 ('Makambako','Njombe','town'),('Ludewa','Njombe','town'),('Makete','Njombe','town'),
 ('Songea','Ruvuma','town'),('Tunduru','Ruvuma','town'),('Mbinga','Ruvuma','town'),('Namtumbo','Ruvuma','town'),
 ('Masasi','Mtwara','town'),('Newala','Mtwara','town'),('Tandahimba','Mtwara','town'),('Kilwa','Lindi','town'),('Nachingwea','Lindi','town'),('Ruangwa','Lindi','town'),
 ('Ifakara','Morogoro','town'),('Kilosa','Morogoro','town'),('Gairo','Morogoro','town'),('Mvomero','Morogoro','town'),('Malinyi','Morogoro','town'),('Turiani','Morogoro','town'),('Ulanga','Morogoro','town'),
 ('Kibaha','Pwani','town'),('Bagamoyo','Pwani','town'),('Mkuranga','Pwani','town'),('Kisarawe','Pwani','town'),('Chalinze','Pwani','town'),('Rufiji','Pwani','town'),('Kibiti','Pwani','town'),('Mlandizi','Pwani','town'),
 ('Handeni','Tanga','town'),('Korogwe','Tanga','town'),('Lushoto','Tanga','town'),('Muheza','Tanga','town'),('Pangani','Tanga','town'),('Kilindi','Tanga','town'),('Mkinga','Tanga','town'),
 ('Nzega','Tabora','town'),('Igunga','Tabora','town'),('Urambo','Tabora','town'),('Sikonge','Tabora','town'),('Kaliua','Tabora','town'),
 ('Kasulu','Kigoma','town'),('Kibondo','Kigoma','town'),('Uvinza','Kigoma','town'),('Kakonko','Kigoma','town'),
 ('Bariadi','Simiyu','town'),('Maswa','Simiyu','town'),('Meatu','Simiyu','town'),('Busega','Simiyu','town'),
 ('Chato','Geita','town'),('Bukombe','Geita','town'),('Katoro','Geita','town'),('Nyang''hwale','Geita','town'),
 ('Sengerema','Mwanza','town'),('Ukerewe','Mwanza','town'),('Kwimba','Mwanza','town'),('Misungwi','Mwanza','town'),('Ilemela','Mwanza','town'),('Nyamagana','Mwanza','town'),
 ('Kondoa','Dodoma','town'),('Mpwapwa','Dodoma','town'),('Kongwa','Dodoma','town'),('Chamwino','Dodoma','town'),('Bahi','Dodoma','town'),
 ('Manyoni','Singida','town'),('Itigi','Singida','town'),('Iramba','Singida','town'),('Kiomboi','Singida','town'),
 ('Mafinga','Iringa','town'),('Kilolo','Iringa','town'),('Mufindi','Iringa','town'),
 ('Karatu','Arusha','town'),('Monduli','Arusha','town'),('Longido','Arusha','town'),('Usa River','Arusha','town'),('Arumeru','Arusha','town'),('Mto wa Mbu','Arusha','town'),
 ('Mafia','Pwani','town'),('Chake Chake','Zanzibar','town'),('Wete','Zanzibar','town'),('Mkokotoni','Zanzibar','town'),
 -- Dar es Salaam neighbourhoods (area)
 ('Kinondoni','Dar es Salaam','area'),('Temeke','Dar es Salaam','area'),('Ilala','Dar es Salaam','area'),('Ubungo','Dar es Salaam','area'),('Kigamboni','Dar es Salaam','area'),
 ('Mbezi','Dar es Salaam','area'),('Tegeta','Dar es Salaam','area'),('Kariakoo','Dar es Salaam','area'),('Sinza','Dar es Salaam','area'),('Mwenge','Dar es Salaam','area'),
 ('Kimara','Dar es Salaam','area'),('Tabata','Dar es Salaam','area'),('Gongo la Mboto','Dar es Salaam','area'),('Ukonga','Dar es Salaam','area'),('Kinyerezi','Dar es Salaam','area'),
 ('Mbagala','Dar es Salaam','area'),('Buguruni','Dar es Salaam','area'),('Magomeni','Dar es Salaam','area'),('Manzese','Dar es Salaam','area'),('Mikocheni','Dar es Salaam','area'),
 ('Masaki','Dar es Salaam','area'),('Msasani','Dar es Salaam','area'),('Oysterbay','Dar es Salaam','area'),('Bunju','Dar es Salaam','area'),('Goba','Dar es Salaam','area'),
 ('Kawe','Dar es Salaam','area'),('Posta','Dar es Salaam','area'),('Kurasini','Dar es Salaam','area'),('Chanika','Dar es Salaam','area'),('Pugu','Dar es Salaam','area'),
 ('Segerea','Dar es Salaam','area'),('Kibamba','Dar es Salaam','area'),('Mabibo','Dar es Salaam','area'),('Kijitonyama','Dar es Salaam','area'),('Mwananyamala','Dar es Salaam','area'),
 ('Upanga','Dar es Salaam','area'),('Keko','Dar es Salaam','area'),('Vingunguti','Dar es Salaam','area'),('Kitunda','Dar es Salaam','area'),('Mbezi Beach','Dar es Salaam','area'),
 ('Boko','Dar es Salaam','area'),('Kunduchi','Dar es Salaam','area'),('Madale','Dar es Salaam','area'),('Kibada','Dar es Salaam','area'),('Chamazi','Dar es Salaam','area'),
 ('Tandika','Dar es Salaam','area'),('Kigogo','Dar es Salaam','area'),('Ubungo Kibo','Dar es Salaam','area'),('Kimanga','Dar es Salaam','area'),('Kiwalani','Dar es Salaam','area'),
 ('Mbezi Luis','Dar es Salaam','area'),('Kinyerezi Mwisho','Dar es Salaam','area'),('Msata','Pwani','town')
on conflict (name) do nothing;

-- Most recent place the customer named in any of their chats. A town or Dar area beats a bare region in the
-- same message ("niko Kyela, Mbeya" → Mbeya / Kyela).
create or replace function private.suggest_location(p_contact uuid)
returns table(region text, district text, area text, evidence text)
language sql stable security definer set search_path = public as $$
  select pl.region,
         case when pl.kind = 'town' then pl.name end,
         case when pl.kind = 'area' then pl.name end,
         left(regexp_replace(m.body, '\s+', ' ', 'g'), 160)
  from conversations cv
  join messages m on m.conversation_id = cv.id and m.direction = 'in' and m.body is not null
  join private.tz_places pl on m.body ~* ('\m' || pl.name || '\M')
  where cv.contact_id = p_contact
  order by m.sent_at desc, (pl.kind <> 'region') desc, length(pl.name) desc
  limit 1
$$;

-- Fill a suggestion only where nothing is set yet (never over the owner's own entry).
create or replace function private.fill_contact_location(p_contact uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s record;
begin
  if p_contact is null then return; end if;
  if exists (select 1 from contacts where id = p_contact and (location_source = 'owner' or region is not null)) then return; end if;
  select * into s from private.suggest_location(p_contact);
  if s.region is null then return; end if;
  update contacts set region = s.region, district = s.district, area = s.area, location_source = 'auto', location_evidence = s.evidence
   where id = p_contact and location_source is distinct from 'owner' and region is null;
end $$;

-- Customers often send their delivery details as one message: "Wilbert L. Kitula 0763049447 Mwanza".
-- From the latest such message: the name before the number → full name, the number → second phone
-- (when it isn't their WhatsApp number). Only fills empty fields, marked 'auto'.
create or replace function private.fill_contact_details(p_contact uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c record; mm text[]; nm text; ph text;
begin
  select * into c from contacts where id = p_contact;
  if c.id is null or (c.full_name is not null and c.alt_phone is not null) then return; end if;
  select regexp_match(regexp_replace(m.body, '\s+', ' ', 'g'),
           '([A-Za-z][A-Za-z.'' ]{3,60}?)[ ,:;-]*(\+?255[ -]?[67]\d{2}[ -]?\d{3}[ -]?\d{3}|0[67]\d{2}[ -]?\d{3}[ -]?\d{3})')
    into mm
  from conversations cv join messages m on m.conversation_id = cv.id and m.direction = 'in'
  where cv.contact_id = p_contact
    and m.body ~ '(\+?255[ -]?[67]\d{2}[ -]?\d{3}[ -]?\d{3}|0[67]\d{2}[ -]?\d{3}[ -]?\d{3})'
  order by m.sent_at desc limit 1;
  if mm is null then return; end if;
  nm := initcap(btrim(regexp_replace(mm[1], '^(jina( langu)?( ni)?|name|majina|mimi( ni)?|naitwa)\s+', '', 'i')));
  nm := btrim(regexp_replace(nm, '^(kwa|ni|mpokeaji|jina)\s+', '', 'i'));
  -- a name is 2–4 words of letters with no everyday words in it ("No Za Simu", "Nipo Lamadi…" are left out)
  if nm !~ '^[A-Za-z.'']+( [A-Za-z.'']+){1,3}$'
     or nm ~* '\m(no|namba|nambari|simu|za|ya|cm|ni|mzigo|sawa|nipo|niko|kwa|tuma|hii|hiyo|huo|naomba|pale|mkoa|kijiji|wilaya|town|mtaa|kwenda|tumia|mpokeaji|kupokea|jina|habari|asante|ok)\M'
  then nm := null; end if;
  ph := regexp_replace(mm[2], '\D', '', 'g');
  if ph like '0%' then ph := '255' || substr(ph, 2); end if;
  update contacts set
    full_name = coalesce(full_name, nm),
    name_source = case when full_name is null and nm is not null then 'auto' else name_source end,
    alt_phone = coalesce(alt_phone, case when ph <> wa_id then '0' || substr(ph, 4) end)
  where id = p_contact;
end $$;

-- A new paid sale → suggest where the buyer is (and their delivery name/phone), if we don't know yet.
create or replace function private.orders_fill_location() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'paid' and (tg_op = 'INSERT' or old.status is distinct from 'paid') then
    perform private.fill_contact_location(coalesce(new.contact_id, (select contact_id from conversations where id = new.conversation_id)));
    perform private.fill_contact_details(coalesce(new.contact_id, (select contact_id from conversations where id = new.conversation_id)));
  end if;
  return null;
end $$;
drop trigger if exists orders_fill_location on public.orders;
create trigger orders_fill_location after insert or update of status on public.orders
  for each row execute function private.orders_fill_location();

-- Suggestions for everyone who has already bought.
select private.fill_contact_location(c.id), private.fill_contact_details(c.id)
from (select distinct coalesce(o.contact_id, cv.contact_id) id
      from orders o left join conversations cv on cv.id = o.conversation_id
      where o.status = 'paid') c
where c.id is not null;

-- Owner / staff save a buyer's details. Empty strings clear a field. Location typed here is 'owner'.
create or replace function public.save_customer(
  p_contact uuid, p_full_name text default null, p_alt_phone text default null, p_region text default null,
  p_district text default null, p_area text default null, p_landmark text default null, p_delivery_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_ws uuid; loc_changed boolean;
begin
  select workspace_id into v_ws from contacts where id = p_contact;
  if v_ws is null or not public.can_edit(v_ws) then raise exception 'not allowed'; end if;
  select (coalesce(region,'') is distinct from coalesce(nullif(btrim(p_region),''),'')
       or coalesce(district,'') is distinct from coalesce(nullif(btrim(p_district),''),'')
       or coalesce(area,'') is distinct from coalesce(nullif(btrim(p_area),''),'')
       or location_source = 'auto') into loc_changed
    from contacts where id = p_contact;
  update contacts set
    full_name = left(nullif(btrim(p_full_name), ''), 120),
    name_source = case when nullif(btrim(p_full_name), '') is null then null else 'owner' end,
    alt_phone = left(nullif(btrim(p_alt_phone), ''), 30),
    region = left(nullif(btrim(p_region), ''), 60),
    district = left(nullif(btrim(p_district), ''), 80),
    area = left(nullif(btrim(p_area), ''), 120),
    landmark = left(nullif(btrim(p_landmark), ''), 200),
    delivery_note = left(nullif(btrim(p_delivery_note), ''), 300),
    -- Saving the form confirms the location (even an unchanged suggestion); cleared location has no source.
    location_source = case when nullif(btrim(coalesce(p_region,'') || coalesce(p_district,'') || coalesce(p_area,'')), '') is null then null else 'owner' end,
    location_evidence = case when loc_changed then null else location_evidence end,
    details_updated_at = now(), details_updated_by = auth.uid()
  where id = p_contact;
end $$;
revoke all on function public.save_customer(uuid, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.save_customer(uuid, text, text, text, text, text, text, text) to authenticated;

-- Buyers list: everyone with at least one paid sale, with what they bought, how much and when.
create or replace function public.list_buyers(p_ws uuid, p_q text default null, p_region text default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare q text := nullif(btrim(coalesce(p_q, '')), ''); qd text := regexp_replace(coalesce(p_q, ''), '\D', '', 'g'); res jsonb;
begin
  if qd like '0%' then qd := '255' || substr(qd, 2); end if;
  with sales as (
    select coalesce(o.contact_id, cv.contact_id) contact_id, o.*
    from orders o left join conversations cv on cv.id = o.conversation_id
    where o.workspace_id = p_ws and o.status = 'paid'
  ),
  agg as (
    select s.contact_id, count(*) n, sum(s.amount - coalesce(s.discount, 0) - coalesce(s.refund_amount, 0)) spent,
           min(s.paid_at) first_at, max(s.paid_at) last_at, max(s.currency) currency,
           (array_agg(s.conversation_id order by s.paid_at desc nulls last))[1] last_conv,
           (array_agg(s.receipt_no order by s.paid_at desc nulls last))[1] last_receipt,
           (select string_agg(distinct x, ', ') from (
              select coalesce(it->>'name', null) x from sales s2, jsonb_array_elements(coalesce(s2.items, '[]'::jsonb)) it where s2.contact_id = s.contact_id
              union select btrim(p) from sales s3, regexp_split_to_table(coalesce(s3.product, ''), '\s*,\s*') p where s3.contact_id = s.contact_id and coalesce(s3.items, '[]'::jsonb) = '[]'::jsonb
            ) z where x is not null and x <> '') products
    from sales s where s.contact_id is not null group by s.contact_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'contact_id', c.id, 'wa_name', c.name, 'full_name', c.full_name, 'phone', c.wa_id, 'alt_phone', c.alt_phone,
      'region', c.region, 'district', c.district, 'area', c.area, 'landmark', c.landmark, 'delivery_note', c.delivery_note,
      'location_source', c.location_source, 'location_evidence', c.location_evidence, 'name_source', c.name_source,
      'orders', a.n, 'spent', a.spent, 'currency', a.currency, 'first_at', a.first_at, 'last_at', a.last_at,
      'last_conversation_id', a.last_conv, 'last_receipt', a.last_receipt, 'products', a.products
    ) order by a.last_at desc nulls last), '[]'::jsonb) into res
  from agg a join contacts c on c.id = a.contact_id
  where c.workspace_id = p_ws and not coalesce(c.not_customer, false)
    and (p_region is null or c.region = p_region)
    and (q is null or c.name ilike '%' || q || '%' or c.full_name ilike '%' || q || '%'
         or (length(qd) >= 4 and (c.wa_id like '%' || qd || '%' or regexp_replace(coalesce(c.alt_phone, ''), '\D', '', 'g') like '%' || right(qd, 9) || '%'))
         or concat_ws(' ', c.region, c.district, c.area, c.landmark) ilike '%' || q || '%'
         or a.products ilike '%' || q || '%');
  return res;
end $$;
grant execute on function public.list_buyers(uuid, text, text) to authenticated;

-- Find a payment uses the saved details too: corrected name and second phone for name search, the saved
-- location first for location search, and the customer block carries the location for the card and receipts.
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
           concat_ws(' ', ct.region, ct.district, ct.area, ct.landmark) c_loc
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
          case when p.c_loc ~* pat then concat_ws(', ', p.c_area, p.c_district, p.c_region) end,
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
        'location', nullif(concat_ws(', ', p.c_area, p.c_district, p.c_region), ''), 'landmark', p.c_landmark) end,
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
          'location', nullif(concat_ws(', ', ct.area, ct.district, ct.region), ''), 'landmark', ct.landmark)
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

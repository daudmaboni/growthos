-- Per-business rules (19 Nov 2026). Until now Kayani Herbs' own wording was written into the app for every business:
--   · the ads' ready-made first messages ("Mnapatikana Wapi??", "Hello! Can I get more info on this?", …)
--   · Kayani's location reply that points back to the ad video ("Tunapatikana … video hiyo")
--   · "Matumizi ya KayaTox", the message Kayani sends once a customer has paid
-- Each business now keeps its own wording in Settings → Rules & rates. Kayani's workspaces are filled with exactly
-- the wording the app used before, so its results don't change. Other businesses start empty (no Kayani rules).
--
-- Matching (same for every business, no AI):
--   rule_ad_texts     the customer's FIRST message equals one of these (case, spaces and ?!. at the end ignored).
--                     A line ending in * matches any first message that STARTS with the text.
--   rule_loc_question a customer message contains one of these (e.g. "Mnapatikana wapi"). Empty = any customer message.
--   rule_loc_reply    …and a later business reply contains ALL of these (e.g. "Tunapatikana" + "video hiyo").
--                     Empty = this rule is off.
--   rule_paid_texts   a business message containing one of these means the customer has paid (the payment day).
--                     Spaces and hyphens are ignored ("Kaya-Tox" = "KayaTox").

alter table public.workspaces
  add column if not exists rule_ad_texts     text[] not null default '{}',
  add column if not exists rule_loc_question text[] not null default '{}',
  add column if not exists rule_loc_reply    text[] not null default '{}',
  add column if not exists rule_paid_texts   text[] not null default '{}';

alter table public.workspaces drop constraint if exists workspaces_rules_size;
alter table public.workspaces add constraint workspaces_rules_size check (
  cardinality(rule_ad_texts) <= 20 and cardinality(rule_loc_question) <= 10
  and cardinality(rule_loc_reply) <= 10 and cardinality(rule_paid_texts) <= 10);

comment on column public.workspaces.rule_ad_texts is 'Ad ready-made first messages. Exact match (case/space/?!. ignored); a trailing * means "starts with".';
comment on column public.workspaces.rule_loc_question is 'Customer question that the location reply answers. Empty = any customer message.';
comment on column public.workspaces.rule_loc_reply is 'Words the business''s ad-only location reply always contains (all must appear). Empty = rule off.';
comment on column public.workspaces.rule_paid_texts is 'A business message containing one of these means the customer paid (sets the payment day).';

-- ---------- helpers ----------
create or replace function private.rule_norm(t text) returns text
language sql immutable set search_path = public as $$
  select regexp_replace(lower(btrim(coalesce(t, ''))), '\s+', ' ', 'g')
$$;

create or replace function private.rule_like_escape(t text) returns text
language sql immutable set search_path = public as $$
  select replace(replace(replace(t, '\', '\\'), '%', '\%'), '_', '\_')
$$;

-- The customer's first message is one of the ad texts.
create or replace function private.rule_first_msg_match(msg text, pats text[]) returns boolean
language sql immutable set search_path = public as $$
  select coalesce(msg, '') <> '' and exists (
    select 1 from unnest(coalesce(pats, '{}')) p
    where length(private.rule_norm(rtrim(btrim(p), '*'))) >= 3
      and case when right(btrim(p), 1) = '*'
            then private.rule_norm(msg) like private.rule_like_escape(private.rule_norm(rtrim(btrim(p), '*'))) || '%'
            else regexp_replace(private.rule_norm(msg), '[\s?!.]+$', '') = regexp_replace(private.rule_norm(p), '[\s?!.]+$', '')
          end)
$$;

-- The message contains at least one of the phrases (an empty list counts as a match).
create or replace function private.rule_contains_any(msg text, pats text[]) returns boolean
language sql immutable set search_path = public as $$
  select cardinality(coalesce(pats, '{}')) = 0 or exists (
    select 1 from unnest(pats) p where length(private.rule_norm(p)) >= 2
      and private.rule_norm(msg) like '%' || private.rule_like_escape(private.rule_norm(p)) || '%')
$$;

-- The message contains every phrase (an empty list never matches: the rule is off).
create or replace function private.rule_contains_all(msg text, pats text[]) returns boolean
language sql immutable set search_path = public as $$
  select cardinality(coalesce(pats, '{}')) > 0 and not exists (
    select 1 from unnest(pats) p
    where not (private.rule_norm(msg) like '%' || private.rule_like_escape(private.rule_norm(p)) || '%'))
$$;

-- A business message contains one of the "customer has paid" texts (spaces and hyphens ignored).
create or replace function private.rule_paid_hit(msg text, pats text[]) returns boolean
language sql immutable set search_path = public as $$
  select coalesce(msg, '') <> '' and exists (
    select 1 from unnest(coalesce(pats, '{}')) p
    where length(regexp_replace(lower(p), '[\s-]+', '', 'g')) >= 4
      and regexp_replace(lower(msg), '[\s-]+', '', 'g') like '%' || private.rule_like_escape(regexp_replace(lower(p), '[\s-]+', '', 'g')) || '%')
$$;

revoke all on function private.rule_norm(text), private.rule_like_escape(text), private.rule_first_msg_match(text, text[]),
  private.rule_contains_any(text, text[]), private.rule_contains_all(text, text[]), private.rule_paid_hit(text, text[]) from public, anon, authenticated;

-- ---------- Kayani keeps exactly the wording the app used before ----------
update public.workspaces set
  rule_ad_texts = array['Mnapatikana Wapi??', 'Hello! Can I get more info on this*', 'Hallo, Nahitaji Tiba Ya KayaPower*', 'Hallo, Nahitaji Kupata Offer Hii Ya Dawa*'],
  rule_loc_question = array['Mnapatikana wapi'],
  rule_loc_reply = array['Tunapatikana', 'video hiyo'],
  rule_paid_texts = array['Matumizi ya KayaTox']
where name = 'Kayani Herbs';

-- ---------- new versions, side by side with the old ones so the results can be compared before switching ----------
create or replace function private.ad_signal_for_v2(p_conv uuid)
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
revoke all on function private.ad_signal_for_v2(uuid) from public, anon, authenticated;

create or replace function public.payment_moment_v2(p_conv uuid, p_before timestamptz default now())
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
        when direction='out' and private.rule_paid_hit(b, (select rule_paid_texts from pt)) then 1
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
revoke all on function public.payment_moment_v2(uuid, timestamptz) from public, anon;

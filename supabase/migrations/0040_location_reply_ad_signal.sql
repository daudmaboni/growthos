-- New "from an ad" pattern (19 Nov 2026, Daud): the customer asks "Mnapatikana wapi" anywhere in the chat and the
-- business answers with the location reply that points back to the ad video
-- ("Tunapatikana Kinondoni Biafra … Je, Unasumbuliwa Na Changamoto Gani Hasa Kutoka Katika Zilizoelezewa katika Video Hiyo?").
-- That reply only makes sense for someone who saw the ad video, so the chat goes to "From an ad" automatically,
-- with no need for the owner to tick yes / no. An owner's explicit answer (ad_signal = 'owner') still stands.
--   location_reply : the pattern above.
alter table public.conversations drop constraint if exists conversations_ad_signal_check;
alter table public.conversations add constraint conversations_ad_signal_check
  check (ad_signal is null or ad_signal in ('meta_tag', 'greeting_card', 'ad_text', 'location_reply', 'owner'));
comment on column public.conversations.ad_signal is 'Why the source is what it is: meta_tag (Meta referral), greeting_card (opens with the ad greeting card), ad_text (first message is an ad''s ready-made text), location_reply (customer asked "Mnapatikana wapi" and got the location reply that mentions the ad video), owner (the owner answered "from an ad?" in the chat; source may then be ad or organic).';

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
    select m.body, m.sent_at,
           exists (select 1 from public.messages o where o.conversation_id = p_conv and o.direction = 'out'
                     and o.type is distinct from 'errors' and o.sent_at < m.sent_at) as had_real_out_before
    from public.messages m where m.conversation_id = p_conv and m.direction = 'in'
    order by m.sent_at, m.id limit 1
  ), loc as (
    -- "Mnapatikana wapi" from the customer, answered by the location reply that mentions the ad video
    select exists (
      select 1 from public.messages q
      join public.messages a on a.conversation_id = q.conversation_id and a.direction = 'out' and a.sent_at >= q.sent_at
      where q.conversation_id = p_conv and q.direction = 'in'
        and lower(q.body) ~ 'mnapatikana\s+wapi'
        and a.body ilike '%tunapatikana%' and a.body ilike '%video hiyo%'
    ) as hit
  )
  select case
    when f.d1 = 'out' and f.t1 = 'errors' and f.d2 = 'in' and f.s2 - f.s1 <= interval '2 minutes' then 'greeting_card'
    when fi.body is not null and not fi.had_real_out_before and (
         lower(btrim(fi.body)) ~ '^mnapatikana\s+wapi[\s?!.]*$'
      or lower(btrim(fi.body)) like 'hello! can i get more info on this%'
      or lower(btrim(fi.body)) like 'hallo, nahitaji tiba ya kayapower%'
      or lower(btrim(fi.body)) like 'hallo, nahitaji kupata offer hii ya dawa%') then 'ad_text'
    when loc.hit then 'location_reply'
  end
  from loc left join f on true left join first_in fi on true;
$$;

-- Backfill: every chat that already shows the pattern (the owner's own answers are left alone).
update public.conversations c set source = 'ad', ad_signal = 'location_reply'
where c.source <> 'ad' and c.ad_signal is distinct from 'owner'
  and exists (select 1 from public.messages a where a.conversation_id = c.id and a.direction = 'out'
                and a.body ilike '%tunapatikana%' and a.body ilike '%video hiyo%')
  and private.ad_signal_for(c.id) = 'location_reply';

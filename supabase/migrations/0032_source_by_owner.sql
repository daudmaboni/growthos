-- The owner can say "this customer came from an ad: yes / no" in the chat (19 Nov 2026).
-- Some ad customers open with a photo instead of the ad's text, so no pattern catches them.
-- ad_signal = 'owner' marks the owner's answer; the automatic ad checks never change it after that.
alter table public.conversations drop constraint if exists conversations_ad_signal_check;
alter table public.conversations add constraint conversations_ad_signal_check
  check (ad_signal is null or ad_signal in ('meta_tag', 'greeting_card', 'ad_text', 'owner'));
comment on column public.conversations.ad_signal is 'Why the source is what it is: meta_tag (Meta referral), greeting_card (opens with the ad greeting card), ad_text (first message is an ad''s ready-made text), owner (the owner answered "from an ad?" in the chat; source may then be ad or organic).';

create or replace function private.mark_ad_chat() returns trigger
language plpgsql security definer set search_path = public as $$
declare s text;
begin
  if exists (select 1 from public.conversations c where c.id = new.conversation_id and c.source <> 'ad'
               and c.ad_signal is distinct from 'owner') then
    s := private.ad_signal_for(new.conversation_id);
    if s is not null then
      update public.conversations set source = 'ad', ad_signal = s
      where id = new.conversation_id and source <> 'ad' and ad_signal is distinct from 'owner';
    end if;
  end if;
  return null;
end $$;

create or replace function private.stamp_meta_tag() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.ad_signal = 'owner' then return new; end if;   -- the owner's answer stands
  if new.referral is not null and new.source = 'ad' then new.ad_signal := 'meta_tag'; end if;
  return new;
end $$;

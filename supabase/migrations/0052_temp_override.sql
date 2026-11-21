-- One-tap correction of Kito's hot / warm / cold (Step 5, 21 Nov 2026).
-- The owner's answer is written to kito_temp and kept in temp_override. A trigger stops Kito's next read from
-- overwriting it, until the customer writes again after the correction: then Kito judges the new messages afresh.
-- Corrections also show where Kito's labelling is off (compare temp_override with Kito's own reads later).
alter table public.conversations
  add column if not exists temp_override text check (temp_override in ('hot', 'warm', 'cold')),
  add column if not exists temp_override_at timestamptz,
  add column if not exists temp_override_by uuid references auth.users(id);

create or replace function private.keep_temp_override() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.temp_override is not null and new.temp_override is not distinct from old.temp_override then
    if new.last_message_at is not null and new.temp_override_at is not null and new.last_message_at > new.temp_override_at then
      new.temp_override := null; new.temp_override_at := null; new.temp_override_by := null;   -- customer wrote again
    else
      new.kito_temp := new.temp_override;   -- Kito re-read without new messages: the owner's answer stands
    end if;
  end if;
  return new;
end $$;

drop trigger if exists conversations_keep_temp on public.conversations;
create trigger conversations_keep_temp before update on public.conversations
  for each row execute function private.keep_temp_override();

-- Safety net for any app version: a sale recorded "now" from a chat gets the day the payment shows in
-- that chat (payment_moment, 0027) instead of the moment the button was pressed. An order dated on
-- purpose (paid_at more than 2 minutes from now) is left as typed. ✅ orders already carry the time
-- of the ✅ message.
create or replace function private.orders_paid_at_from_chat() returns trigger
language plpgsql security definer set search_path = public as $$
declare pm record;
begin
  if new.status = 'paid' and new.conversation_id is not null and coalesce(new.inferred_from, '') <> 'tick'
     and new.paid_at is not null and abs(extract(epoch from new.paid_at - now())) < 120 then
    select * into pm from public.payment_moment(new.conversation_id, now());
    if pm.at is not null and pm.at < new.paid_at then
      new.notes := trim(both E'\n ' from coalesce(new.notes, '') || E'\n' || 'Paid date read from the chat (' || pm.kind || '): "' || left(pm.snippet, 80)
        || '". Confirmed in itaOS ' || to_char(new.paid_at at time zone 'Africa/Dar_es_Salaam', 'DD Mon YYYY HH24:MI') || '.');
      new.paid_at := pm.at;
      new.occurred_at := pm.at;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists orders_paid_at_from_chat on public.orders;
create trigger orders_paid_at_from_chat before insert on public.orders
  for each row execute function private.orders_paid_at_from_chat();

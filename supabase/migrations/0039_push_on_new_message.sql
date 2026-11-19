-- Ring the owners' phones (itaOS phone app) when a customer's WhatsApp message is saved.
-- Runs in the database, so wa-webhook needed no change. Fires only for real new rows
-- (wa-webhook inserts with ON CONFLICT DO NOTHING, so replays don't fire), only for live
-- webhook messages from the last 10 minutes, and only when someone in that business
-- turned notifications on. The call is async (pg_net): saving the message never waits for it.
create or replace function public.push_on_new_message()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.direction = 'in' and new.origin = 'webhook' and new.sent_at > now() - interval '10 minutes'
     and exists (select 1 from public.push_subscriptions s where s.workspace_id = new.workspace_id) then
    perform net.http_post(
      url := 'https://jrdxeagnmunmatxtgmpk.supabase.co/functions/v1/push-send',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpyZHhlYWdubXVubWF0eHRnbXBrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ1ODkyNjcsImV4cCI6MjExMDE2NTI2N30.1HJUnCAwcCwQ0BiGZxfhJsh6xa6Amm3SrDuDopSZOWc',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
      body := jsonb_build_object('conversation_ids', jsonb_build_array(new.conversation_id)),
      timeout_milliseconds := 30000
    );
  end if;
  return null;
exception when others then
  -- A notification must never stop a WhatsApp message from being saved.
  raise warning 'push_on_new_message: %', sqlerrm;
  return null;
end $$;
revoke all on function public.push_on_new_message() from public, anon, authenticated;

create or replace trigger messages_push after insert on public.messages
  for each row when (new.direction = 'in' and new.origin = 'webhook')
  execute function public.push_on_new_message();

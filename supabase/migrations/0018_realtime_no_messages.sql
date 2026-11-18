-- Stop streaming the messages table over Realtime. A newly connected Coexistence number backfills
-- thousands of messages (each with its raw WhatsApp payload) and every row was decoded and sent to
-- every open app tab, saturating the database. The app listens to conversations instead: a chat's
-- row is recomputed whenever a message lands, so live updates still arrive.
do $$ begin
  alter publication supabase_realtime drop table public.messages;
exception when undefined_object then null; end $$;

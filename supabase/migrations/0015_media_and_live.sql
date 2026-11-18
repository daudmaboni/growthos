-- Payment screenshots + live updates.
--
-- 1. WhatsApp's media links expire after a few minutes, so the webhook saves every image /
--    PDF a customer sends into private storage right away. Kito then reads it: if it is a
--    payment receipt, the amount, transaction code, provider and payee are kept in messages.media
--    and written into the message text so the payment rules and Kito both see it.
-- 2. Chats, messages and orders are published to Realtime so open pages update by themselves.
--    Realtime applies the same row-level security, so each member only receives their own data.

alter table public.messages add column if not exists media jsonb;
comment on column public.messages.media is
  'Saved media: {path, mime, bytes, receipt: {is_receipt, amount, currency, txn_code, provider, paid_to, sender, paid_at, confidence, notes}, error}';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('wa-media', 'wa-media', false, 10485760, array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do nothing;

-- Files live at <workspace_id>/<message id>.<ext>. Members may view their own workspace's files.
drop policy if exists wa_media_read on storage.objects;
create policy wa_media_read on storage.objects for select to authenticated
  using (bucket_id = 'wa-media' and public.is_member(((storage.foldername(name))[1])::uuid));

do $$ begin
  begin alter publication supabase_realtime add table public.conversations; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.messages; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.orders; exception when duplicate_object then null; end;
end $$;

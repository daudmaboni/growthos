-- Sales back to Meta (Conversions API for Business Messaging, Step 4, 21 Nov 2026).
-- The `capi` Edge Function sends each recorded paid order from a Click-to-WhatsApp ad chat to Meta as a
-- Purchase (ctwa_clid + WhatsApp account id + amount), so Meta can optimise ads for buyers.

alter table public.connections drop constraint if exists connections_provider_check;
alter table public.connections add constraint connections_provider_check check (provider in ('meta_ads', 'whatsapp', 'meta_capi'));

alter table public.orders
  add column if not exists capi_sent_at timestamptz,
  add column if not exists capi_error text,
  add column if not exists capi_tries int not null default 0;

create index if not exists orders_capi_pending on public.orders (workspace_id, paid_at) where status = 'paid' and capi_sent_at is null;

-- Every 15 minutes: send new sales (Meta accepts events up to 7 days old).
select cron.unschedule('capi-15m') where exists (select 1 from cron.job where jobname = 'capi-15m');
select cron.schedule('capi-15m', '7,22,37,52 * * * *', $cron$
  select net.http_post(
    url := 'https://jrdxeagnmunmatxtgmpk.supabase.co/functions/v1/capi',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpyZHhlYWdubXVubWF0eHRnbXBrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ1ODkyNjcsImV4cCI6MjExMDE2NTI2N30.1HJUnCAwcCwQ0BiGZxfhJsh6xa6Amm3SrDuDopSZOWc',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
$cron$);

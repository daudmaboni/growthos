-- Each ad's delivery status from Meta (ACTIVE, PAUSED, CAMPAIGN_PAUSED, ...), so the Dashboard can show
-- which ads are running now and put them first. Filled by ads-sync on every run.
alter table public.ads add column if not exists effective_status text;
alter table public.ads add column if not exists status_synced_at timestamptz;

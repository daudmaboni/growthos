-- Automatic exchange rate: the fx-rate function fetches the ad-currency -> workspace-currency rate
-- every hour (refetching when older than 6 h). Owners can switch to a manual rate in Settings → Rules.
alter table public.workspaces
  add column if not exists fx_auto boolean not null default true,
  add column if not exists fx_updated_at timestamptz,
  add column if not exists fx_source text,
  add column if not exists fx_base text;

comment on column public.workspaces.fx_auto is 'true = fx_rate is fetched automatically (fx-rate function); false = the owner typed it.';
comment on column public.workspaces.fx_updated_at is 'When fx_rate was last set (automatically or by hand).';
comment on column public.workspaces.fx_source is 'Where fx_rate came from: a rate provider, or ''manual''.';
comment on column public.workspaces.fx_base is 'Ad account currency fx_rate converts from (e.g. USD).';

-- A rate someone already typed stays theirs.
update public.workspaces set fx_auto = false, fx_source = 'manual' where fx_rate is not null;

-- Hourly; the function skips workspaces whose rate is under 6 h old.
select cron.unschedule('fx-rate-hourly') where exists (select 1 from cron.job where jobname = 'fx-rate-hourly');
select cron.schedule('fx-rate-hourly', '41 * * * *', $$
  select net.http_post(
    url := 'https://jrdxeagnmunmatxtgmpk.supabase.co/functions/v1/fx-rate',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb
  );
$$);

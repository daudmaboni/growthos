alter table public.workspaces add column fx_rate numeric check (fx_rate is null or fx_rate > 0);
comment on column public.workspaces.fx_rate is 'How many units of workspace currency equal 1 unit of the ad account currency (e.g. TZS per USD). Null = not set.';

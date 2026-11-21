-- Kito quiet window (21 Nov 2026): the scheduled Kito run now reads a changed chat once it has been
-- quiet for 10 minutes (or 15 minutes after its last read while the talk goes on), instead of after
-- every customer message. Money moments are still read at once (wa-webhook). Running every 5 minutes
-- keeps the longest wait for an ordinary chat at about 15 minutes. The job keeps its old name.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'kito-15m') then
    perform cron.alter_job(job_id := (select jobid from cron.job where jobname = 'kito-15m'), schedule := '*/5 * * * *');
  end if;
end $$;

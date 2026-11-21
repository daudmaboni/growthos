-- Morning briefing (Step 5, 21 Nov 2026): every day at 07:50 Dar es Salaam time (04:50 UTC), push-send sends each
-- business one notification with what needs doing today: promises/tasks due, hot chats waiting for a reply,
-- payments to check, new promises to confirm. Nothing waiting = no notification.
select cron.unschedule('briefing-daily') where exists (select 1 from cron.job where jobname = 'briefing-daily');
select cron.schedule('briefing-daily', '50 4 * * *', $cron$
  select net.http_post(
    url := 'https://jrdxeagnmunmatxtgmpk.supabase.co/functions/v1/push-send',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpyZHhlYWdubXVubWF0eHRnbXBrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ1ODkyNjcsImV4cCI6MjExMDE2NTI2N30.1HJUnCAwcCwQ0BiGZxfhJsh6xa6Amm3SrDuDopSZOWc',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{"briefing": true}'::jsonb,
    timeout_milliseconds := 60000
  );
$cron$);

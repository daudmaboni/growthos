-- Voice notes → text (21 Nov 2026). The `voice` Edge Function (every 2 minutes) saves voice notes that were
-- never downloaded, sends saved ones to Soniox speech-to-text (Swahili + English) and writes the text on the
-- message: body = '[voice note] <text>', media.transcript = {text, model, at, seconds}. Kito, Ask Kito, the
-- word rules and search then read it like any typed message. Needs the SONIOX_API_KEY secret.

-- Cost estimate for the AI usage page and the per-business monthly limit. Soniox async bills tokens:
-- ~30,000 audio tokens per hour in, ~0.3 tokens per character of text out (≈ $0.10 per hour of audio).
insert into public.api_pricing (model, input_per_mtok, output_per_mtok)
values ('soniox-stt-async-v5', 1.50, 3.50)
on conflict (model) do update set input_per_mtok = excluded.input_per_mtok, output_per_mtok = excluded.output_per_mtok, updated_at = now();

-- Finding voice notes with no text yet stays quick as messages grow.
create index if not exists messages_audio_recent on public.messages (sent_at desc) where type = 'audio';

select cron.unschedule('voice-2m') where exists (select 1 from cron.job where jobname = 'voice-2m');
select cron.schedule('voice-2m', '*/2 * * * *', $cron$
  select net.http_post(
    url := 'https://jrdxeagnmunmatxtgmpk.supabase.co/functions/v1/voice',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpyZHhlYWdubXVubWF0eHRnbXBrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ1ODkyNjcsImV4cCI6MjExMDE2NTI2N30.1HJUnCAwcCwQ0BiGZxfhJsh6xa6Amm3SrDuDopSZOWc',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$cron$);

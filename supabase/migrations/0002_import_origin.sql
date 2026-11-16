-- Allow messages that come from uploaded WhatsApp chat exports
alter table public.messages drop constraint messages_origin_check;
alter table public.messages add constraint messages_origin_check check (origin in ('webhook','app_echo','history','api','import'));

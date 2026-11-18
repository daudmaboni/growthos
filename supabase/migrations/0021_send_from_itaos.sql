-- Replies sent from itaOS (wa-send function): their own origin, who sent them, and a per-business switch.
alter table public.messages drop constraint if exists messages_origin_check;
alter table public.messages add constraint messages_origin_check check (origin in ('webhook', 'app_echo', 'history', 'api', 'import', 'itaos'));
alter table public.messages add column if not exists sent_by uuid references auth.users(id) on delete set null;
alter table public.workspaces add column if not exists send_enabled boolean not null default true;
comment on column public.workspaces.send_enabled is 'Owners/admins may send WhatsApp replies from itaOS (inside the 24-hour window).';

-- Kito activity log, and a source label taken from the saved contact name (e.g. "Aug Mid TTS Leads")
create table public.kito_runs (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  trigger text not null check (trigger in ('auto','manual')),
  ran_at timestamptz not null default now(),
  checked int not null default 0, failed int not null default 0, remaining int not null default 0,
  note text
);
create index on public.kito_runs(workspace_id, ran_at desc);
alter table public.kito_runs enable row level security;
create policy kito_runs_read on public.kito_runs for select using (public.is_member(workspace_id));
alter table public.conversations add column source_label text;
-- (conversation_outcomes view is dropped and recreated after adding columns; see 0005 for its definition)

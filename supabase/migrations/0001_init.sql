-- GrowthOS v0.1 — core schema
-- Tenancy: every business-owned row carries workspace_id; RLS allows members only.
-- Source facts (raw_events) are append-only; normalized tables are derived from them.

create extension if not exists pgcrypto;

-- ---------- Tenancy ----------
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  currency text not null default 'TZS',
  timezone text not null default 'Africa/Dar_es_Salaam',
  language text not null default 'sw' check (language in ('sw','en')),
  unit_cost numeric,                       -- optional product + delivery cost per order
  created_at timestamptz not null default now()
);

create table public.memberships (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner','admin','analyst','viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index on public.memberships(user_id);

create or replace function public.is_member(ws uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships m where m.workspace_id = ws and m.user_id = auth.uid());
$$;

-- Create a workspace and make the caller its owner (called from the app after sign-up)
create or replace function public.create_workspace(p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare ws uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into public.workspaces(name) values (p_name) returning id into ws;
  insert into public.memberships(workspace_id, user_id, role) values (ws, auth.uid(), 'owner');
  return ws;
end $$;

-- ---------- Integrations ----------
-- Tokens never live in this table: token_secret_id points into Supabase Vault.
create table public.connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null check (provider in ('meta_ads','whatsapp')),
  external_id text not null,               -- ad account id (act_…) or WABA id
  label text,
  token_secret_id uuid,                    -- vault.secrets.id
  status text not null default 'active' check (status in ('active','error','revoked')),
  last_sync_at timestamptz,
  last_error text,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (provider, external_id)
);
create index on public.connections(workspace_id);

create table public.wa_numbers (
  phone_number_id text primary key,        -- Meta phone number id (webhook routing key)
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  connection_id uuid references public.connections(id) on delete set null,
  waba_id text not null,
  display_phone text,
  coexistence boolean not null default true,
  history_requested_at timestamptz,
  history_status text,                     -- requested / receiving / complete / declined
  created_at timestamptz not null default now()
);
create index on public.wa_numbers(workspace_id);

-- ---------- Raw landing (append-only) ----------
create table public.raw_events (
  id bigint generated always as identity primary key,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  provider text not null,
  event_key text not null,                 -- idempotency key (message id, etc.)
  field text,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text,
  unique (provider, event_key)
);
create index on public.raw_events(workspace_id, received_at desc);

-- ---------- Ads ----------
create table public.ads (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  ad_id text primary key,
  ad_account_id text not null,
  name text, adset_id text, adset_name text, campaign_id text, campaign_name text,
  updated_at timestamptz not null default now()
);
create index on public.ads(workspace_id);

create table public.ad_insights_daily (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  ad_id text not null,
  day date not null,
  spend numeric not null default 0,
  currency text not null default 'TZS',
  impressions bigint not null default 0,
  reach bigint not null default 0,
  clicks bigint not null default 0,
  messaging_conversations int not null default 0,  -- platform-reported
  raw jsonb,
  synced_at timestamptz not null default now(),
  primary key (ad_id, day)
);
create index on public.ad_insights_daily(workspace_id, day);

-- ---------- Customers & conversations ----------
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  wa_id text not null,                     -- customer WhatsApp number (PII)
  name text,
  created_at timestamptz not null default now(),
  unique (workspace_id, wa_id)
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  phone_number_id text not null,
  started_at timestamptz,
  last_message_at timestamptz,
  -- attribution (Tier A: from Meta referral on first inbound message)
  source text not null default 'unknown' check (source in ('ad','organic','unknown')),
  ad_id text,
  ctwa_clid text,
  referral jsonb,
  -- derived signals (recomputed by analyzer)
  first_response_sec int,
  price_asked boolean not null default false,
  price_shared boolean not null default false,
  price_shared_at timestamptz,
  replied_after_price boolean not null default false,
  pay_instructions boolean not null default false,
  payment_signal boolean not null default false,
  payment_amount numeric,
  objections text[] not null default '{}',
  followed_up boolean not null default false,
  warm boolean not null default false,
  stage text,                              -- no_reply / before_price / silent_after_price / after_price_talk / paid
  auto_outcome text,                       -- sold / lost / open
  analyzed_at timestamptz,
  unique (workspace_id, contact_id, phone_number_id)
);
create index on public.conversations(workspace_id, last_message_at desc);
create index on public.conversations(workspace_id, ad_id);

create table public.messages (
  id text primary key,                     -- WhatsApp message id (wamid)
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  direction text not null check (direction in ('in','out')),
  origin text not null default 'webhook' check (origin in ('webhook','app_echo','history','api')),
  sent_at timestamptz not null,
  type text not null,
  body text,                               -- text content (PII; never logged)
  raw jsonb
);
create index on public.messages(conversation_id, sent_at);

-- ---------- Sales (business-confirmed outcomes) ----------
create table public.sales (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  amount numeric not null,
  currency text not null default 'TZS',
  occurred_at timestamptz not null default now(),
  provenance text not null default 'owner_confirmed' check (provenance in ('owner_confirmed','auto_detected','import')),
  confirmed_by uuid references auth.users(id),
  capi_sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (conversation_id)
);

-- Owner's manual outcome override (lost / open) when they disagree with auto
alter table public.conversations add column outcome_override text check (outcome_override in ('sold','lost','open'));

-- ---------- RLS ----------
alter table public.workspaces enable row level security;
alter table public.memberships enable row level security;
alter table public.connections enable row level security;
alter table public.wa_numbers enable row level security;
alter table public.raw_events enable row level security;
alter table public.ads enable row level security;
alter table public.ad_insights_daily enable row level security;
alter table public.contacts enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.sales enable row level security;

create policy ws_read on public.workspaces for select using (public.is_member(id));
create policy ws_update on public.workspaces for update using (public.is_member(id));
create policy mem_read on public.memberships for select using (user_id = auth.uid() or public.is_member(workspace_id));
create policy conn_read on public.connections for select using (public.is_member(workspace_id));
create policy wan_read on public.wa_numbers for select using (public.is_member(workspace_id));
create policy ads_read on public.ads for select using (public.is_member(workspace_id));
create policy ins_read on public.ad_insights_daily for select using (public.is_member(workspace_id));
create policy ct_read on public.contacts for select using (public.is_member(workspace_id));
create policy cv_read on public.conversations for select using (public.is_member(workspace_id));
create policy cv_update on public.conversations for update using (public.is_member(workspace_id));
create policy msg_read on public.messages for select using (public.is_member(workspace_id));
create policy sale_read on public.sales for select using (public.is_member(workspace_id));
create policy sale_write on public.sales for insert with check (public.is_member(workspace_id));
create policy sale_update on public.sales for update using (public.is_member(workspace_id));
create policy sale_delete on public.sales for delete using (public.is_member(workspace_id));
-- raw_events: no client policies (service role only)

-- Members may only change the override column on conversations
revoke update on public.conversations from authenticated;
grant update (outcome_override) on public.conversations to authenticated;

-- ---------- Vault helpers (service role only) ----------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.store_token(p_name text, p_token text)
returns uuid language plpgsql security definer set search_path = public, vault as $$
declare sid uuid;
begin
  select id into sid from vault.secrets where name = p_name;
  if sid is null then
    sid := vault.create_secret(p_token, p_name);
  else
    perform vault.update_secret(sid, p_token);
  end if;
  return sid;
end $$;

create or replace function private.read_token(p_secret_id uuid)
returns text language sql security definer set search_path = public, vault as $$
  select decrypted_secret from vault.decrypted_secrets where id = p_secret_id;
$$;

-- RPC wrappers callable only by service_role (edge functions)
create or replace function public.svc_store_token(p_name text, p_token text)
returns uuid language sql security definer set search_path = public as $$ select private.store_token(p_name, p_token) $$;
create or replace function public.svc_read_token(p_secret_id uuid)
returns text language sql security definer set search_path = public as $$ select private.read_token(p_secret_id) $$;
revoke all on function public.svc_store_token(text,text) from public, anon, authenticated;
revoke all on function public.svc_read_token(uuid) from public, anon, authenticated;
grant execute on function public.svc_store_token(text,text) to service_role;
grant execute on function public.svc_read_token(uuid) to service_role;

-- ---------- Reporting view: funnel per conversation with final outcome ----------
create or replace view public.conversation_outcomes with (security_invoker = true) as
select c.*,
  ct.name as contact_name,
  coalesce(case when s.id is not null then 'sold' end, c.outcome_override, c.auto_outcome) as outcome,
  s.amount as sale_amount, s.provenance as sale_provenance
from public.conversations c
join public.contacts ct on ct.id = c.contact_id
left join public.sales s on s.conversation_id = c.id;

-- Per-ad performance: platform spend + GrowthOS-observed chats and confirmed sales
create or replace function public.ad_performance(p_ws uuid, p_from date, p_to date)
returns table (ad_id text, ad_name text, campaign_name text, spend numeric, platform_conversations bigint,
               chats bigint, priced bigint, sold bigint, revenue numeric, cost_per_sale numeric)
language sql stable security invoker set search_path = public as $$
  with sp as (
    select i.ad_id, sum(i.spend) spend, sum(i.messaging_conversations) conv
    from ad_insights_daily i where i.workspace_id = p_ws and i.day between p_from and p_to group by i.ad_id
  ), ch as (
    select o.ad_id, count(*) chats, count(*) filter (where o.price_shared) priced,
           count(*) filter (where o.outcome = 'sold') sold, coalesce(sum(o.sale_amount),0) revenue
    from conversation_outcomes o
    where o.workspace_id = p_ws and o.ad_id is not null
      and (o.started_at at time zone 'Africa/Dar_es_Salaam')::date between p_from and p_to
    group by o.ad_id
  )
  select coalesce(sp.ad_id, ch.ad_id), a.name, a.campaign_name, coalesce(sp.spend,0), coalesce(sp.conv,0),
         coalesce(ch.chats,0), coalesce(ch.priced,0), coalesce(ch.sold,0), coalesce(ch.revenue,0),
         case when coalesce(ch.sold,0) > 0 then round(coalesce(sp.spend,0) / ch.sold) end
  from sp full join ch on ch.ad_id = sp.ad_id
  left join ads a on a.ad_id = coalesce(sp.ad_id, ch.ad_id)
  where public.is_member(p_ws)
  order by coalesce(sp.spend,0) desc;
$$;

-- Anonymous visitors may not call RPCs
revoke execute on function public.create_workspace(text) from public, anon;
revoke execute on function public.is_member(uuid) from public, anon;
grant execute on function public.create_workspace(text) to authenticated;
grant execute on function public.is_member(uuid) to authenticated;
revoke execute on function public.ad_performance(uuid, date, date) from public, anon;
grant execute on function public.ad_performance(uuid, date, date) to authenticated;

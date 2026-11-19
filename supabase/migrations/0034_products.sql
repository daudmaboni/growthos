-- My products (19 Nov 2026).
-- Each business keeps a list of what it sells: name, other names customers use, selling price,
-- what one unit costs the business (product + delivery), and a few reference photos.
-- When a sale is recorded the owner picks the products; the order's cost is filled in from them
-- (still editable). Photos are kept for matching customers' product photos later.
-- Nothing here is assumed for a business: a new workspace starts with no products and no default cost.

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  aliases text[] not null default '{}',                 -- other names customers use ("kaya power", "dawa ya tumbo")
  price numeric check (price is null or price >= 0),    -- selling price, in the workspace currency
  cost numeric check (cost is null or cost >= 0),       -- what one unit costs the business (product + delivery)
  photos text[] not null default '{}',                  -- storage paths in product-photos: <workspace_id>/<product_id>/<file>
  notes text,
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists products_ws_name on public.products (workspace_id, lower(btrim(name)));
create index if not exists products_ws on public.products (workspace_id, active, sort);
comment on table public.products is 'What a business sells: price, unit cost, other names and reference photos.';

alter table public.products enable row level security;
drop policy if exists products_read on public.products;
create policy products_read on public.products for select to authenticated using (public.is_member(workspace_id));
drop policy if exists products_insert on public.products;
create policy products_insert on public.products for insert to authenticated with check (public.can_edit(workspace_id));
drop policy if exists products_update on public.products;
create policy products_update on public.products for update to authenticated
  using (public.can_edit(workspace_id)) with check (public.can_edit(workspace_id));
drop policy if exists products_delete on public.products;
create policy products_delete on public.products for delete to authenticated using (public.can_edit(workspace_id));
grant select, insert, update, delete on public.products to authenticated;

create or replace function private.touch_product() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists products_touch on public.products;
create trigger products_touch before update on public.products for each row execute function private.touch_product();

-- Reference photos. Private bucket; path <workspace_id>/<product_id>/<file>.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-photos', 'product-photos', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

drop policy if exists product_photos_read on storage.objects;
create policy product_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'product-photos' and public.is_member(((storage.foldername(name))[1])::uuid));
drop policy if exists product_photos_insert on storage.objects;
create policy product_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'product-photos' and public.can_edit(((storage.foldername(name))[1])::uuid));
drop policy if exists product_photos_delete on storage.objects;
create policy product_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'product-photos' and public.can_edit(((storage.foldername(name))[1])::uuid));

comment on column public.orders.items is
  'What was sold: [{product_id?, name, qty, unit_price?, unit_cost?}]. When products are picked, orders.cost is filled from qty × unit_cost (the owner can still change it).';

-- Ask Kito can see the product list too.
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'kito') then
    execute $v$create or replace view kito.products with (security_invoker = true) as
      select p.name, p.aliases, p.price as selling_price, p.cost as unit_cost, p.active from public.products p where p.workspace_id = kito.ws()$v$;
    execute 'grant select on kito.products to authenticated, service_role';
  end if;
end $$;

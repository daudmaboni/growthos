-- Receipt QR links (migration 0055): secret codes, the public check, scan counts, rotation.
\set ON_ERROR_STOP on
\t on
\pset footer off
begin;

create function pg_temp.as_user(uid uuid, r text default 'authenticated') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true);
  execute format('set local role %I', r);
end $$;
create function pg_temp.check_(ok boolean, label text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception 'FAIL: %', label; end if;
  raise notice 'ok: %', label;
end $$;

insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'owner-c@test'),
  ('00000000-0000-0000-0000-0000000000c2', 'viewer-c@test'),
  ('00000000-0000-0000-0000-0000000000d1', 'owner-d@test');
insert into public.workspaces(id, name, currency) values
  ('10000000-0000-0000-0000-0000000000c1', 'Kayani Herbs', 'TZS'),
  ('10000000-0000-0000-0000-0000000000d1', 'Other Shop', 'TZS');
insert into public.memberships(workspace_id, user_id, role) values
  ('10000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1', 'owner'),
  ('10000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c2', 'viewer'),
  ('10000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d1', 'owner');
insert into public.contacts(id, workspace_id, wa_id, name) values
  ('20000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000c1', '255711222333', 'Asha Juma Mwinyi');
insert into public.conversations(id, workspace_id, contact_id, phone_number_id, started_at, last_message_at) values
  ('30000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000c1', '20000000-0000-0000-0000-0000000000c1', 'pn-c', now() - interval '2 days', now());

-- The owner records a paid sale and a pending one.
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
insert into public.orders(id, workspace_id, conversation_id, amount, discount, currency, status, items, payment_ref) values
  ('40000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000c1', '30000000-0000-0000-0000-0000000000c1', 120000, 5000, 'TZS', 'paid',
   '[{"name":"KayaTox","qty":2},{"name":"TumboFlux","qty":1}]', 'TKL8XJ2Q4P'),
  ('40000000-0000-0000-0000-0000000000c2', '10000000-0000-0000-0000-0000000000c1', '30000000-0000-0000-0000-0000000000c1', 50000, 0, 'TZS', 'pending', '[]', null);
reset role;

-- Staff get the code; a sale without a receipt number gets none; outsiders and anon are refused.
create temp table tok (t text, n text);
grant all on tok to anon, authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c2');
insert into tok select public.receipt_link('40000000-0000-0000-0000-0000000000c1'), (select receipt_no from public.orders where id = '40000000-0000-0000-0000-0000000000c1');
reset role;
select pg_temp.check_((select t ~ '^[A-Za-z0-9_-]{22}$' and n is not null from tok), 'member gets a 22-char secret code');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.check_((select public.receipt_link('40000000-0000-0000-0000-0000000000c1') = (select t from tok)), 'same code every time');
select pg_temp.check_((select public.receipt_link('40000000-0000-0000-0000-0000000000c2') is null), 'pending sale has no code');
reset role;
do $$ begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1');
  begin perform public.receipt_link('40000000-0000-0000-0000-0000000000c1'); raise exception 'FAIL: other business got code';
  exception when insufficient_privilege then null; end;
  reset role;
  perform pg_temp.as_user(null, 'anon');
  begin perform public.receipt_link('40000000-0000-0000-0000-0000000000c1'); raise exception 'FAIL: anon got code';
  exception when insufficient_privilege then null; end;
  reset role;
  raise notice 'ok: only the business can get the code';
end $$;
select pg_temp.check_((select count(*) = 0 from public.order_events where order_id = '40000000-0000-0000-0000-0000000000c1' and action = 'update'), 'making a link is not an edit to the sale');

-- Anyone (not signed in) can check a receipt; only paper-receipt facts come back.
create temp table got (j jsonb);
grant all on got to anon, authenticated;
select pg_temp.as_user(null, 'anon');
insert into got select public.receipt_check((select t from tok));
reset role;
select pg_temp.check_((select j->>'status' = 'paid' and (j->>'total')::numeric = 115000 and j->>'receipt_no' = (select n from tok) from got), 'anon check shows status, net total, receipt number');
select pg_temp.check_((select j->>'customer' = 'Asha' from got), 'customer shown by first name only');
select pg_temp.check_((select j::text not like '%255711222333%' and j::text not like '%TKL8XJ2Q4P%' and j->>'payment_ref_end' = '2Q4P' from got), 'no customer phone, payment code only last 4');
select pg_temp.check_((select j->'staff' = 'null'::jsonb or j->'staff' is null from got), 'anon gets no staff block');
select pg_temp.check_((select jsonb_array_length(j->'items') = 2 from got), 'items listed');
select pg_temp.check_((select scans = 1 from private.receipt_links where order_id = '40000000-0000-0000-0000-0000000000c1'), 'customer scan counted');

-- A second scan within a minute isn't counted again; the sale itself is never touched by a scan.
select pg_temp.as_user(null, 'anon');
select public.receipt_check((select t from tok));
reset role;
select pg_temp.check_((select scans = 1 from private.receipt_links where order_id = '40000000-0000-0000-0000-0000000000c1'), 'repeat scan within a minute not double-counted');
select pg_temp.check_((select count(*) = 0 from public.order_events e where e.order_id = '40000000-0000-0000-0000-0000000000c1' and e.action = 'update'), 'scans never edit the sale (no audit rows)');

-- Staff of the business get the staff block; staff of another business don't.
truncate got;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c2');
insert into got select public.receipt_check((select t from tok));
reset role;
select pg_temp.check_((select (j->'staff'->>'order_id')::uuid = '40000000-0000-0000-0000-0000000000c1' and (j->'staff'->>'scans')::int = 1 from got), 'viewer of the business sees staff block and scan count');
truncate got;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d1');
insert into got select public.receipt_check((select t from tok));
reset role;
select pg_temp.check_((select j->'staff' = 'null'::jsonb from got), 'owner of another business gets no staff block');

-- Unknown / malformed codes.
select pg_temp.as_user(null, 'anon');
insert into got select public.receipt_check('KH-000042');
insert into got select public.receipt_check('zzzzzzzzzzzzzzzzzzzzzz');
reset role;
select pg_temp.check_((select count(*) = 2 from got where j is null), 'receipt number or unknown code returns nothing');

-- Rotation: viewer and other business refused; owner gets a new code and the old one stops working.
do $$ begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c2');
  begin perform public.rotate_receipt_link('40000000-0000-0000-0000-0000000000c1'); raise exception 'FAIL: viewer rotated';
  exception when insufficient_privilege then null; end;
  reset role;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1');
  begin perform public.rotate_receipt_link('40000000-0000-0000-0000-0000000000c1'); raise exception 'FAIL: other owner rotated';
  exception when insufficient_privilege then null; end;
  reset role;
  perform pg_temp.as_user(null, 'anon');
  begin perform public.rotate_receipt_link('40000000-0000-0000-0000-0000000000c1'); raise exception 'FAIL: anon rotated';
  exception when insufficient_privilege then null; end;
  reset role;
  raise notice 'ok: only owner/admin of the business can rotate';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select public.rotate_receipt_link('40000000-0000-0000-0000-0000000000c1');
reset role;
select pg_temp.check_((select l.token <> tok.t from private.receipt_links l, tok where l.order_id = '40000000-0000-0000-0000-0000000000c1'), 'owner rotation gives a new code');
select pg_temp.check_((select public.receipt_check((select t from tok)) is null), 'old code no longer works');
insert into public.orders(id, workspace_id, amount, currency, status, items) values
  ('40000000-0000-0000-0000-0000000000c3', '10000000-0000-0000-0000-0000000000c1', 1000, 'TZS', 'pending', '[]');
do $$ begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  begin perform public.rotate_receipt_link('40000000-0000-0000-0000-0000000000c3'); raise exception 'FAIL: rotated a sale with no receipt';
  exception when invalid_parameter_value then null; end;
  reset role;
  raise notice 'ok: sale without a receipt cannot get a link';
end $$;

rollback;

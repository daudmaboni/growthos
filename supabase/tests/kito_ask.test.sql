-- Ask Kito: kito_query must stay inside one workspace, read only, kito views only.
-- Each check runs in its own transaction because kito_query switches its transaction to read only.
\set ON_ERROR_STOP on
\t on
\pset footer off

begin;
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'kito-owner-c@test'),
  ('00000000-0000-0000-0000-0000000000c2', 'kito-viewer-c@test'),
  ('00000000-0000-0000-0000-0000000000d1', 'kito-owner-d@test');
insert into public.workspaces(id, name, currency, fx_rate) values
  ('10000000-0000-0000-0000-0000000000c0', 'C', 'TZS', 2600),
  ('10000000-0000-0000-0000-0000000000d0', 'D', 'TZS', null);
insert into public.memberships(workspace_id, user_id, role) values
  ('10000000-0000-0000-0000-0000000000c0', '00000000-0000-0000-0000-0000000000c1', 'owner'),
  ('10000000-0000-0000-0000-0000000000c0', '00000000-0000-0000-0000-0000000000c2', 'viewer'),
  ('10000000-0000-0000-0000-0000000000d0', '00000000-0000-0000-0000-0000000000d1', 'owner');
insert into public.contacts(id, workspace_id, wa_id, name) values
  ('20000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000c0', '255711111111', 'Juma'),
  ('20000000-0000-0000-0000-0000000000c2', '10000000-0000-0000-0000-0000000000c0', '255722222222', 'Asha'),
  ('20000000-0000-0000-0000-0000000000d1', '10000000-0000-0000-0000-0000000000d0', '255733333333', 'Other');
insert into public.conversations(id, workspace_id, contact_id, phone_number_id, started_at, last_message_at, pay_instructions, ad_id, source) values
  ('30000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000c0', '20000000-0000-0000-0000-0000000000c1', 'pn', now() - interval '3 days', now() - interval '2 days', true, 'adc', 'ad'),
  ('30000000-0000-0000-0000-0000000000c2', '10000000-0000-0000-0000-0000000000c0', '20000000-0000-0000-0000-0000000000c2', 'pn', now() - interval '3 days', now() - interval '1 days', true, 'adc', 'ad'),
  ('30000000-0000-0000-0000-0000000000d1', '10000000-0000-0000-0000-0000000000d0', '20000000-0000-0000-0000-0000000000d1', 'pn', now() - interval '3 days', now() - interval '1 days', true, null, 'organic');
insert into public.messages(id, workspace_id, conversation_id, direction, sent_at, type, body) values
  ('wamid.c1', '10000000-0000-0000-0000-0000000000c0', '30000000-0000-0000-0000-0000000000c1', 'out', now() - interval '2 days', 'text', 'Lipa namba 0712 345 678 jina Kayani, au 12345678'),
  ('wamid.c2', '10000000-0000-0000-0000-0000000000c0', '30000000-0000-0000-0000-0000000000c2', 'in', now() - interval '1 days', 'text', 'Nimetuma');
insert into public.orders(workspace_id, conversation_id, amount, currency, status, paid_at, provenance) values
  ('10000000-0000-0000-0000-0000000000c0', '30000000-0000-0000-0000-0000000000c2', 85000, 'TZS', 'paid', now() - interval '1 days', 'manual');
insert into public.ads(workspace_id, ad_id, ad_account_id, name) values ('10000000-0000-0000-0000-0000000000c0', 'adc', 'act_1', 'Ad C');
insert into public.ad_insights_daily(workspace_id, ad_id, day, spend, currency) values ('10000000-0000-0000-0000-0000000000c0', 'adc', current_date - 1, 10, 'USD');
commit;

create function pg_temp.ask(uid uuid, ws uuid, q text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true);
  set local role authenticated;
  r := public.kito_query(ws, q);
  return r;
end $$;
create function pg_temp.denied(label text, uid uuid, ws uuid, q text) returns void language plpgsql as $$
begin
  begin
    perform pg_temp.ask(uid, ws, q);
  exception when others then
    raise notice 'ok (denied): % [%]', label, sqlerrm; return;
  end;
  raise exception 'FAIL: % should have been denied', label;
end $$;
create function pg_temp.expect(label text, got jsonb, want jsonb) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'FAIL: % expected %, got %', label, want, got; end if;
  raise notice 'ok: %', label;
end $$;

-- Lipa namba sent, not paid: only Juma, never the other workspace's chat.
select pg_temp.expect('owner sees only own workspace, unpaid after payment details',
  pg_temp.ask('00000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000c0',
    'select customer_name from chats where payment_details_sent and paid_orders = 0') -> 'rows',
  '[{"customer_name": "Juma"}]');
select pg_temp.expect('views never mix workspaces',
  pg_temp.ask('00000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000c0', 'select count(*) as n from chats') -> 'rows',
  '[{"n": 2}]');
select pg_temp.expect('viewer may ask (read only)',
  pg_temp.ask('00000000-0000-0000-0000-0000000000c2', '10000000-0000-0000-0000-0000000000c0', 'select sum(net_amount) as revenue from orders where status = ''paid''') -> 'rows',
  '[{"revenue": 85000}]');
select pg_temp.expect('phone and long numbers are masked in message text',
  pg_temp.ask('00000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000c0', 'select body from messages where sender = ''business''') -> 'rows',
  '[{"body": "Lipa namba [simu] jina Kayani, au [namba]"}]');
select pg_temp.expect('ad spend converted with the workspace rate',
  pg_temp.ask('00000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000c0', 'select spend_local from ad_daily') -> 'rows',
  '[{"spend_local": 26000}]');
select pg_temp.expect('ad performance helper works and is scoped',
  pg_temp.ask('00000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000c0', 'select ad_id, chats, attributed_sales from ad_performance(current_date - 7, current_date)') -> 'rows',
  '[{"ad_id": "adc", "chats": 2, "attributed_sales": 1}]');
select pg_temp.expect('row cap is reported',
  (pg_temp.ask('00000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000c0', 'select g from generate_series(1, 1000) g') -> 'capped'),
  'true');
select pg_temp.expect('no phone column anywhere in kito',
  (select to_jsonb(count(*)) from information_schema.columns where table_schema = 'kito' and column_name in ('wa_id', 'phone', 'display_phone')),
  '0');

select pg_temp.denied('other workspace', '00000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000d0', 'select * from chats');
select pg_temp.denied('outsider', '00000000-0000-0000-0000-0000000000d1', '10000000-0000-0000-0000-0000000000c0', 'select * from chats');
select pg_temp.denied('signed out', null, '10000000-0000-0000-0000-0000000000c0', 'select * from chats');
select pg_temp.denied('second statement', '00000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000c0', 'select 1; delete from orders');
select pg_temp.denied('writable CTE', '00000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000c0', 'with x as (delete from orders returning 1) select * from x');
select pg_temp.denied('raw tables', '00000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000c0', 'select wa_id from public.contacts');
select pg_temp.denied('re-pin workspace', '00000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000c0', 'select set_config(''kito.ws'', ''10000000-0000-0000-0000-0000000000d0'', true)');
select pg_temp.denied('catalog', '00000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000c0', 'select * from pg_roles');
select pg_temp.denied('comment trick', '00000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000c0', 'select 1 /* ; */');
select pg_temp.denied('unqualified write function', '00000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000c0', 'select create_workspace(''x'')');
select pg_temp.denied('not a select', '00000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000c0', 'values (1)');
-- Read only even if a write slipped past the word checks: a volatile write inside the query fails.
do $$ begin
  begin
    perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
    perform public.kito_query('10000000-0000-0000-0000-0000000000c0', 'select 1');
    insert into public.workspaces(name) values ('should fail');
  exception when read_only_sql_transaction then raise notice 'ok: transaction is read only after kito_query'; return;
  end;
  raise exception 'FAIL: transaction was still writable';
end $$;
select pg_temp.expect('kito_asks: user reads only own questions',
  (select to_jsonb(has_table_privilege('authenticated', 'public.kito_asks', 'insert'))), 'false');

-- (no cleanup: the test cluster is thrown away by run.sh)

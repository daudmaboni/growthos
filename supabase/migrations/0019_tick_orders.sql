-- The owner's ✅ message ("175,000✅", "Umelipiwa✅") is recorded as a confirmed paid order by the
-- WhatsApp webhook (supabase/functions/_shared/ticks.ts). Mark those orders so the app can say so.
alter table public.orders drop constraint if exists orders_inferred_from_check;
alter table public.orders add constraint orders_inferred_from_check
  check (inferred_from in ('rules', 'kito', 'name_mark', 'tick'));

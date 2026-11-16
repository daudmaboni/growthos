# GrowthOS

Ads → WhatsApp → paid. GrowthOS reads a business's Meta ad spend and its WhatsApp chats (via Coexistence),
links chats to ad referrals where available, helps identify where conversations stall, and reports cost per sale
using sales the business has explicitly confirmed.

## Structure
- `web/` — Vite + React app (deployed on Netlify: growthos-tz)
- `supabase/migrations/` — Postgres schema, RLS, reporting functions
- `supabase/functions/`
  - `ads-sync` — Marketing API ad-level daily insights (cron every 3h)
  - `sales-import` — workspace-scoped import of confirmed sales against existing conversation IDs
  - `wa-webhook` — durably records verified events, processes them idempotently, and retries failed events on scheduled syncs
  - `meta-connect` — Facebook Login (ad account) and Embedded Signup (WhatsApp Coexistence)
  - `_shared/signals.ts` — chat analyzer (Kiswahili + English): price, payment, objections, follow-ups

## Local dev
```
cd web && cp .env.example .env && npm install && npm run dev
```

## Data rules
- Tokens live only in Supabase Vault; `connections.token_secret_id` points to them.
- Every business row has `workspace_id`; RLS lets members read only their workspace.
- `raw_events` is append-only and server-only; normalized tables are rebuilt from it.
- Money metrics are computed in SQL, not by AI.
- Kito's inferred outcomes are useful for triage but are excluded from confirmed sales, revenue, ROAS, and cost-per-sale calculations until recorded as a sale.
- Follow-up tasks and imported sales are workspace-scoped and protected by row-level security.

See `SETUP.md` for going live.

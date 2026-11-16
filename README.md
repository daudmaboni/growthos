# GrowthOS

Ads → WhatsApp → paid. GrowthOS reads a business's Meta ad spend and its WhatsApp chats (via Coexistence),
links each chat to the ad that started it, detects where sales are lost, and shows the real cost per sale.

## Structure
- `web/` — Vite + React app (deployed on Netlify: growthos-tz)
- `supabase/migrations/` — Postgres schema, RLS, reporting functions
- `supabase/functions/`
  - `wa-webhook` — WhatsApp webhook: messages + CTWA referral, app echoes, 6-month history, contacts
  - `ads-sync` — Marketing API ad-level daily insights (cron every 3h)
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

See `SETUP.md` for going live.

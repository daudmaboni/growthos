# GrowthOS

Ads → WhatsApp → paid. GrowthOS reads a business's Meta ad spend and its WhatsApp chats (Coexistence or uploaded
exports), links chats to ad referrals where available, shows where conversations stall, and reports results using
**orders the business has confirmed or imported**, never inferred signals alone.

## What it does (MVP)
| View | What the owner gets |
|---|---|
| **Ask Kito** | Ask anything in Kiswahili or English ("who did I send Lipa namba to but hasn't paid?", "which ads bring paying customers?", "what do payers have in common?"). Kito writes read-only SQL over the `kito.*` views, the database computes every number, and the answer comes back with the chats (Open chat / WhatsApp / draft a follow-up), ads, tables and stats behind it, plus the queries it ran. |
| **Dashboard** | Ad spend, Meta-reported chats, chats received, replies, price shared, payment signals (inferred), confirmed paid orders, revenue, cost per chat / qualified inquiry / attributed sale, matched return on ad spend, contribution (only when cost data exists), period-over-period deltas, source health and data coverage. Every figure is labelled with its source. |
| **Diagnosis** | Weekly, rule-based bottleneck findings (unanswered, slow reply, low intent, price, no follow-up, payment friction, unconfirmed payments, fulfilment, data gaps) with counts, sample size, confidence, observed facts vs hypothesis, missing data and links to the supporting chats/orders. |
| **Actions** | Follow-up queue (configurable hours) → tasks that can be assigned, snoozed, completed or dismissed, with history. Kito drafts replies in Kiswahili and English grounded in the chat and the business profile. **Drafts are never sent.** |
| **Chats** | Why each chat is labelled (rules, Kito evidence quotes, owner corrections), record / correct / refund / cancel orders with a full audit trail, mark lost/open with a note. |
| **Content** | Honest "not connected" state (no Meta content permissions yet); manual post records with defined engagement metrics, theme comparison, inquiry/sale linkage via source label with coverage, and an idea/calendar workflow of editable drafts. |
| **Connections** | Meta ads + WhatsApp connection and sync status, webhook event health with owner/admin replay, WhatsApp chat upload, guided CSV import (orders, expenses, past inquiries), import history. |
| **Settings** | Business, **business profile** (products, prices, delivery, payment, tone, FAQs, constraints), appearance, **rules & rates** (exchange rate, follow-up hours, conversion window, timezone), account. |

## Structure
- `web/` — Vite + React app (Netlify: growthos-tz)
  - `src/metrics.ts` — **the** metric definitions (pure, deterministic, unit-tested)
  - `src/diagnosis.ts` — weekly diagnosis rules (pure, unit-tested)
  - `src/csv.ts` — CSV parsing, column mapping, templates
- `supabase/migrations/` — schema, RLS, roles, reporting functions (`0010_growth_mvp.sql` is this MVP)
- `supabase/functions/`
  - `ads-sync` — ad-level daily insights. Three explicit paths: scheduled `sync_all` (cron secret), one named workspace+connection (internal first sync), or a member's own workspace.
  - `meta-connect` — Facebook Login (ads) and Embedded Signup (WhatsApp). Owner/admin only; refuses accounts already connected to another workspace.
  - `wa-webhook` — stores each verified change before acknowledging, processes idempotently, bounded automatic retries, owner/admin replay.
  - `csv-import` — dry-run validation, duplicate detection and in-workspace chat matching, then import with provenance.
  - `chat-import` — WhatsApp `.txt/.zip` export upload and re-analysis.
  - `kito-ask` — Ask Kito: Claude plans and runs read-only queries through `public.kito_query` with the user's own token (RLS + workspace pin + read-only transaction), returns a structured answer, logs it in `kito_asks`.
  - `kito` — AI labelling with evidence quotes; on-demand reply drafts and content ideas (drafts only).
  - `_shared/` — `signals.ts` (Kiswahili/English chat rules), `csv.ts`, `webhook.ts`, `db.ts`.
- `supabase/tests/` — SQL authorization tests run against a throwaway local Postgres.

## Local dev and checks
```
cd web && cp .env.example .env   # fill in public values
npm install
npm run dev
npm run build      # typecheck + production build
npm test           # metrics, diagnosis, CSV validation/dedupe, webhook identity/retry
npm run test:sql   # applies every migration to a temporary local Postgres and runs RLS/role tests
```
`test:sql` needs PostgreSQL server binaries (`initdb`, `pg_ctl`, `psql`) and must not run as root. It never touches Supabase.

## Data rules
- **Confirmed revenue comes only from `orders` with status `paid`.** Payment words, screenshots, Kito's reading and ✅ name marks are *signals*; they show up as "payment detected, not confirmed" until someone records an order.
- Orders keep provenance (`manual`, `csv_import`, `provider`, `inferred` + what was confirmed) and every insert/update is written to `order_events` by a trigger. Orders are corrected by status change (refund/cancel), never deleted by clients.
- Ad-to-sale figures are **attributed/matched estimates**: a paid order linked to a chat that carried a Meta ad referral, paid within the workspace conversion window (default 30 days). Not proof the ad caused the purchase.
- Chats are counted in the period they started, in the workspace timezone; revenue is counted by paid date.
- Money and metrics are computed in SQL/TypeScript rules, never by AI.
- Roles: `viewer` reads; `analyst`/`admin`/`owner` edit orders, tasks and the profile; `owner`/`admin` change settings, connect accounts and replay webhook events. Enforced by RLS and in Edge Functions.
- Tokens live only in Supabase Vault; token RPCs are executable by `service_role` only.
- `raw_events` is server-only. Webhook health is exposed to members as counts only.
- CSV phone numbers are used only to find a chat inside the same workspace; they are not stored.

See `SETUP.md` for going live and `web/public/privacy.html` for the privacy policy.

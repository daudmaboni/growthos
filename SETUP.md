# GrowthOS — go-live setup (Kayani pilot)

The existing pilot has a live web app and Supabase project. Repository changes are not automatically deployed; apply the new migration and deploy the updated Edge Functions and web app before using the features described here.

**Existing pilot endpoints**
- Web app: https://growthos-tz.netlify.app (privacy policy: `/privacy.html`)
- Database + server functions: Supabase project `growthos` (Frankfurt)
- WhatsApp webhook URL: `https://jrdxeagnmunmatxtgmpk.supabase.co/functions/v1/wa-webhook`
- Ads sync runs every 3 hours automatically once an ad account is connected
- The scheduled all-workspace `ads-sync` request must include `{"action":"sync_all","days":30}` and the current `x-cron-secret` header. Each scheduled run also retries up to 50 saved WhatsApp events that are pending or failed.

## Deploy repository updates

Before using the updated MVP, apply migrations `0001` through `0009` in order (skip versions already recorded by your Supabase project), deploy the updated `ads-sync`, `meta-connect`, and `wa-webhook` functions plus the new `sales-import` function, then deploy the `web/` app to Netlify. Confirm the scheduled `ads-sync` request uses the `sync_all` action shown above. Do not run these steps against production until the rotated secrets and migration have been reviewed.

---

## 1. Supabase: sign-in link and secrets (5 min)

**Authentication → URL Configuration**
- Site URL: `https://growthos-tz.netlify.app`
- Redirect URLs: add `https://growthos-tz.netlify.app/**`

**Edge Functions → Secrets** (generate fresh values for the first two; never commit them. The last two come from step 2.)

| Name | Value |
|---|---|
| `CRON_SECRET` | Generate a new high-entropy value; store only in Supabase secrets and the scheduled job configuration. The previously committed value must be rotated. |
| `META_VERIFY_TOKEN` | Generate a new high-entropy value; store in Supabase and enter the same value in Meta Webhooks. The previously committed value must be rotated. |
| `META_APP_ID` | App ID from step 2 |
| `META_APP_SECRET` | App Secret from step 2 |

## 2. Create the Meta app in Kayani's business portfolio (15 min)

You need to be an admin of the Kayani Herbs Business Portfolio.

1. Go to developers.facebook.com → **My Apps → Create App**.
2. Use case: **Other** → app type **Business**. Name: `GrowthOS`. Business portfolio: **Kayani Herbs**.
   (Don't put "WhatsApp" or "Facebook" in the name.)
3. **Add products:** WhatsApp, Facebook Login for Business, Marketing API.
4. **App settings → Basic**
   - App domains: `growthos-tz.netlify.app`
   - Privacy policy URL: `https://growthos-tz.netlify.app/privacy.html`
   - Category: Business and pages. Add an icon.
   - Copy **App ID** and **App Secret** → put them in Supabase secrets (step 1).
5. **Facebook Login for Business → Settings**
   - Valid OAuth redirect URIs: `https://growthos-tz.netlify.app/`
   - Allowed domains for the JavaScript SDK: `https://growthos-tz.netlify.app`
   - Login with the JavaScript SDK: **Yes**
6. **Facebook Login for Business → Configurations → Create** (two configurations)
   - **"GrowthOS Ads"**: login variation *General*, token type *User access token*, permissions `ads_read`, `business_management`. Copy its **Configuration ID**.
   - **"GrowthOS WhatsApp"**: login variation *WhatsApp Embedded Signup*, permissions `whatsapp_business_management`, `whatsapp_business_messaging`. Copy its **Configuration ID**.
7. **WhatsApp → Configuration → Webhook**
   - Callback URL: `https://jrdxeagnmunmatxtgmpk.supabase.co/functions/v1/wa-webhook`
   - Verify token: the newly generated `META_VERIFY_TOKEN` value saved in Supabase (do not copy it into repository files).
   - Click **Verify and save**. (Secrets from step 1 must already be saved.)
   - Subscribe these fields: `messages`, `history`, `smb_app_state_sync`, `smb_message_echoes`.
8. **App roles:** while the app is in development mode, only people with a role on the app can connect.
   Add the Kayani owner as **Tester** if they will connect WhatsApp themselves.

**Send me the App ID and the two Configuration IDs.** (They aren't secret.) I'll add them to the site and redeploy.

## 3. Connect Kayani (10 min, after the redeploy)

1. Open https://growthos-tz.netlify.app → enter your email → open the sign-in link.
2. Create the workspace: `Kayani Herbs`.
3. **Connections → Connect ad account** → log in → pick the Kayani ad account.
   The last 30 days of ads load within a minute.
4. **Connections → Connect WhatsApp** → follow Meta's window → choose **"Connect your existing WhatsApp Business App"**
   → scan the QR code with the phone that runs Kayani's WhatsApp Business app → **allow sharing chat history**.
   - The phone must run WhatsApp Business app version 2.24.17 or newer, and the number must have been in use for at least 7 days.
   - The history import can only happen once, within 24 hours of connecting. Don't skip it.
   - WhatsApp Web / Desktop on other devices gets logged out once. Link them again from the phone.
   - The phone keeps working exactly as before. GrowthOS only reads.
5. Wait a few hours for the 6-month history to arrive. Then open **Dashboard** and **Chats**.

## Known limits of v0.1
- Only people with a role on the Meta app can connect (development mode). Opening to other businesses needs Meta App Review + Tech Provider verification later.
- Sales are detected from payment messages ("nimetuma", M-Pesa confirmations) and can be confirmed or corrected in **Chats**.
- Chats from before an ad referral existed (old history) show as source "unknown". Per-ad cost per sale is accurate for chats started after connecting.
- Not built yet: AI-written weekly report, sending sales back to Meta (Conversions API), team members.

## Security follow-up after the public release

The prior `CRON_SECRET` and `META_VERIFY_TOKEN` values were committed to this repository. Treat both as compromised even after removing them from the current files: generate replacements, update Supabase Edge Function secrets, update every scheduled Edge Function request that uses `CRON_SECRET` (including `ads-sync`, `kito`, and any `chat-import` reanalysis job), and update the Meta webhook configuration to use the new verification token. The scheduled all-workspace `ads-sync` request must send `{"action":"sync_all","days":30}`. Redeploy the Edge Functions after updating secrets and verify one scheduled sync and one Meta webhook verification. Do not put replacement values in GitHub, chat, screenshots, or deployment logs.

// Connects a workspace to Meta: ad account (Facebook Login for Business) and
// WhatsApp number (Embedded Signup, Coexistence). Tokens go straight into Vault.
import { admin, userClient, graph, storeToken, json, cors, GRAPH } from "../_shared/db.ts";

const APP_ID = Deno.env.get("META_APP_ID") ?? "";
const APP_SECRET = Deno.env.get("META_APP_SECRET") ?? "";

async function oauth(params: Record<string, string>) {
  const qs = new URLSearchParams({ client_id: APP_ID, client_secret: APP_SECRET, ...params });
  const res = await fetch(`${GRAPH}/oauth/access_token?${qs}`);
  const b = await res.json();
  if (!res.ok || b.error) throw new Error(b.error?.message ?? "token exchange failed");
  return b.access_token as string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!APP_ID || !APP_SECRET) return json({ error: "Meta app is not configured yet (META_APP_ID / META_APP_SECRET)." }, 500);
  const body = await req.json().catch(() => ({}));
  const ws = body.workspace_id as string;
  if (!ws) return json({ error: "workspace_id required" }, 400);
  // Connecting changes what the workspace syncs, so it needs an owner/admin, not just a member.
  const { data: ok } = await userClient(req).rpc("can_manage", { ws });
  if (!ok) return json({ error: "Only a workspace owner or admin can connect accounts." }, 403);
  const db = admin();

  /** A provider account may belong to one workspace only. Refuse to re-home another workspace's connection. */
  async function assertNotOwnedElsewhere(provider: "meta_ads" | "whatsapp", externalId: string) {
    const { data: existing, error } = await db.from("connections").select("workspace_id").eq("provider", provider).eq("external_id", externalId).maybeSingle();
    if (error) throw new Error("could not check existing connections");
    if (existing && existing.workspace_id !== ws) throw new Error("This account is already connected to another itaOS workspace. Disconnect it there first.");
  }

  try {
    // ---- Ads: step 1 list ad accounts, step 2 save the chosen one ----
    if (body.action === "ads_accounts") {
      const long = await oauth({ grant_type: "fb_exchange_token", fb_exchange_token: body.access_token });
      const accts = await graph("me/adaccounts?fields=id,name,currency,account_status&limit=100", long);
      const pending = await storeToken(db, `meta_ads_pending:${ws}`, long);
      return json({ accounts: accts.data ?? [], pending_secret: pending });
    }
    if (body.action === "ads_connect") {
      const { data: tok } = await db.rpc("svc_read_token", { p_secret_id: body.pending_secret });
      if (!tok) return json({ error: "Login expired. Connect again." }, 400);
      if (!/^act_\d+$/.test(String(body.ad_account_id ?? ""))) return json({ error: "invalid ad account id" }, 400);
      await assertNotOwnedElsewhere("meta_ads", body.ad_account_id);
      const secret = await storeToken(db, `meta_ads:${ws}:${body.ad_account_id}`, tok);
      const { data: connection, error } = await db.from("connections").upsert({
        workspace_id: ws, provider: "meta_ads", external_id: body.ad_account_id, label: body.label ?? null,
        token_secret_id: secret, status: "active", last_error: null,
      }, { onConflict: "provider,external_id" }).select("id").single();
      if (error) throw new Error(error.message);
      // First sync is explicitly limited to the connection just authorized.
      // @ts-ignore EdgeRuntime is provided by Supabase; keeps the first sync alive after we respond
      EdgeRuntime.waitUntil(fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/ads-sync`, {
        method: "POST", headers: { Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json" },
        body: JSON.stringify({ days: 30, workspace_id: ws, connection_id: connection!.id }),
      }).catch(() => {}));
      return json({ ok: true });
    }

    // ---- WhatsApp: Embedded Signup (Coexistence) ----
    if (body.action === "wa_connect") {
      const { code, waba_id, phone_number_id } = body;
      if (!code || !waba_id || !phone_number_id) return json({ error: "code, waba_id and phone_number_id are required" }, 400);
      await assertNotOwnedElsewhere("whatsapp", String(waba_id));
      const { data: numberOwner } = await db.from("wa_numbers").select("workspace_id").eq("phone_number_id", String(phone_number_id)).maybeSingle();
      if (numberOwner && numberOwner.workspace_id !== ws) return json({ error: "This WhatsApp number is already connected to another workspace." }, 409);
      const token = await oauth({ code });
      const secret = await storeToken(db, `whatsapp:${waba_id}`, token);
      const { data: conn, error } = await db.from("connections").upsert({
        workspace_id: ws, provider: "whatsapp", external_id: waba_id, token_secret_id: secret, status: "active",
      }, { onConflict: "provider,external_id" }).select("id").single();
      if (error) throw new Error(error.message);
      // receive this WABA's webhooks
      await graph(`${waba_id}/subscribed_apps`, token, { method: "POST" });
      const info = await graph(`${phone_number_id}?fields=display_phone_number,verified_name`, token).catch(() => ({}));
      await db.from("wa_numbers").upsert({
        phone_number_id, workspace_id: ws, connection_id: conn!.id, waba_id,
        display_phone: info.display_phone_number ?? null, coexistence: true,
      }, { onConflict: "phone_number_id" });
      // Coexistence: request contacts + 6-month history (allowed once, within 24h of onboarding)
      const syncs: Record<string, string> = {};
      for (const sync_type of ["smb_app_state_sync", "history"]) {
        try {
          await graph(`${phone_number_id}/smb_app_data`, token, { method: "POST", body: JSON.stringify({ messaging_product: "whatsapp", sync_type }) });
          syncs[sync_type] = "requested";
        } catch (e) { syncs[sync_type] = (e as Error).message; }
      }
      await db.from("wa_numbers").update({
        history_requested_at: new Date().toISOString(),
        history_status: syncs.history === "requested" ? "requested" : "failed: " + syncs.history,
      }).eq("phone_number_id", phone_number_id);
      return json({ ok: true, display_phone: info.display_phone_number ?? null, syncs });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    // Provider errors are safe to show (no tokens or customer data); keep them short.
    return json({ error: String((e as Error).message).slice(0, 300) }, 502);
  }
});

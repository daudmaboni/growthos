// Sales back to Meta (Conversions API for Business Messaging, Step 4).
// When a recorded paid order belongs to a chat that started from a Click-to-WhatsApp ad (conversations.ctwa_clid),
// itaOS tells Meta "this ad click became a Purchase of TSh X", so Meta can optimise ads for buyers, not chatters.
//
//   action "setup"  (owner / manager): save a Meta system-user token from the business's own portfolio that has
//                   whatsapp_business_management + whatsapp_business_manage_events. itaOS finds (or creates) the
//                   dataset of each of the business's WhatsApp accounts and keeps the token in the vault.
//   action "status" (any member): what is connected and how many sales were sent.
//   cron / "send_now": sends paid orders from the last 7 days that weren't sent yet (Meta accepts events up to
//                   7 days old). One event per order, event_id = order id (Meta drops duplicates). Max 3 tries.
// Only the click id, the WhatsApp account id, the amount and the currency leave itaOS: no names, phones or messages.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });
const GRAPH = `https://graph.facebook.com/${Deno.env.get("META_GRAPH_VERSION") ?? "v25.0"}`;
const MAX_TRIES = 3;

async function graph(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${GRAPH}/${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) } }).catch(() => null);
  if (!res) return { ok: false, body: { error: { message: "network error" } } as any };
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && !body?.error, body };
}
const metaError = (b: any) => {
  const e = b?.error ?? {};
  return `${e.error_user_msg || e.message || "Meta refused the request"}${e.code ? ` (code ${e.code}${e.error_subcode ? "/" + e.error_subcode : ""})` : ""}`.slice(0, 300);
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const body = await req.json().catch(() => ({}));
  const cronSecret = Deno.env.get("CRON_SECRET");
  const isCron = !!cronSecret && req.headers.get("x-cron-secret") === cronSecret;
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });

  let wsOnly: string | null = null;
  if (!isCron) {
    const ws = String(body.workspace_id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(ws)) return json({ error: "workspace_id required" }, 400);
    const need = body.action === "status" ? "is_member" : "can_manage";
    const { data: ok } = await user.rpc(need, { ws });
    if (ok !== true) return json({ error: need === "is_member" ? "Not a member of this business." : "Only the owner or a manager can do this." }, 403);
    wsOnly = ws;
  }

  // ---- setup: save the token and find the dataset of each WhatsApp account ----
  if (body.action === "setup") {
    const token = String(body.token ?? "").trim();
    if (token.length < 50 || /\s/.test(token)) return json({ error: "That doesn't look like a Meta access token. Copy the whole token from the system user." }, 400);
    const { data: was } = await db.from("connections").select("meta").eq("workspace_id", wsOnly).eq("provider", "whatsapp");
    const wabas = [...new Set((was ?? []).map((c: any) => c.meta?.waba_id).filter(Boolean))] as string[];
    if (!wabas.length) return json({ error: "Connect WhatsApp first: itaOS needs the WhatsApp account id." }, 400);
    const datasets: Record<string, string> = {};
    const problems: string[] = [];
    for (const waba of wabas) {
      let r = await graph(`${waba}/dataset`, token);
      let id = r.ok ? (r.body?.id ?? r.body?.data?.[0]?.id) : null;
      if (!id && r.ok) { r = await graph(`${waba}/dataset`, token, { method: "POST" }); id = r.ok ? r.body?.id : null; }   // none yet: create it
      if (id) datasets[waba] = String(id); else problems.push(`${waba}: ${metaError(r.body)}`);
    }
    if (!Object.keys(datasets).length) return json({ error: `Meta didn't accept this token for your WhatsApp account. ${problems[0] ?? ""} Check that the system user has the WhatsApp account assigned with full control, and the token has whatsapp_business_management and whatsapp_business_manage_events.` }, 400);
    const { data: secretId, error: se } = await db.rpc("svc_store_token", { p_name: `meta_capi:${wsOnly}:${Date.now()}`, p_token: token });
    if (se || !secretId) return json({ error: "Could not store the token safely." }, 500);
    const ext = `capi:${wsOnly}`;
    const { error } = await db.from("connections").upsert({
      workspace_id: wsOnly, provider: "meta_capi", external_id: ext, label: "Sales to Meta", status: "active", last_error: null,
      meta: { datasets, token_secret_id: secretId, token_last4: token.slice(-4), set_at: new Date().toISOString(), problems },
    }, { onConflict: "provider,external_id" });
    if (error) return json({ error: error.message }, 500);
    const sent = await sendPending(db, wsOnly);
    return json({ ok: true, datasets: Object.keys(datasets).length, problems, ...sent });
  }

  if (body.action === "status") {
    const { data: c } = await db.from("connections").select("status,last_error,last_sync_at,meta").eq("workspace_id", wsOnly).eq("provider", "meta_capi").maybeSingle();
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const [{ count: sent }, { count: failed }] = await Promise.all([
      db.from("orders").select("id", { count: "exact", head: true }).eq("workspace_id", wsOnly).not("capi_sent_at", "is", null).gte("capi_sent_at", since),
      db.from("orders").select("id", { count: "exact", head: true }).eq("workspace_id", wsOnly).is("capi_sent_at", null).not("capi_error", "is", null).gte("paid_at", since),
    ]);
    return json({ connected: !!c && c.status === "active", last_error: c?.last_error ?? null, last_sent_at: c?.last_sync_at ?? null, token_last4: (c?.meta as any)?.token_last4 ?? null, sent_30d: sent ?? 0, failed_30d: failed ?? 0 });
  }

  // ---- cron / send_now ----
  return json(await sendPending(db, wsOnly));
});

// deno-lint-ignore no-explicit-any
async function sendPending(db: any, wsOnly: string | null) {
  let cq = db.from("connections").select("id,workspace_id,meta").eq("provider", "meta_capi").eq("status", "active");
  if (wsOnly) cq = cq.eq("workspace_id", wsOnly);
  const { data: conns } = await cq;
  const out = { sent: 0, failed: 0, last_error: null as string | null };
  for (const c of (conns ?? []) as any[]) {
    const datasets: Record<string, string> = c.meta?.datasets ?? {};
    let token: string;
    try { const { data } = await db.rpc("svc_read_token", { p_secret_id: c.meta?.token_secret_id }); token = String(data ?? ""); } catch { token = ""; }
    if (!token) continue;
    const since = new Date(Date.now() - 7 * 864e5 + 3600e3).toISOString();
    const { data: orders } = await db.from("orders").select("id,conversation_id,paid_at,amount,discount,refund_amount,currency,capi_tries")
      .eq("workspace_id", c.workspace_id).eq("status", "paid").is("capi_sent_at", null).gte("paid_at", since).not("conversation_id", "is", null).limit(100);
    const todo = ((orders ?? []) as any[]).filter((o) => (o.capi_tries ?? 0) < MAX_TRIES);
    if (!todo.length) continue;
    const { data: convs } = await db.from("conversations").select("id,ctwa_clid,phone_number_id").in("id", [...new Set(todo.map((o) => o.conversation_id))]).not("ctwa_clid", "is", null);
    const byConv = new Map((convs ?? []).map((x: any) => [x.id, x]));
    const pnIds = [...new Set((convs ?? []).map((x: any) => x.phone_number_id).filter(Boolean))];
    const { data: nums } = pnIds.length ? await db.from("wa_numbers").select("phone_number_id,connection_id").in("phone_number_id", pnIds) : { data: [] };
    const { data: waConns } = await db.from("connections").select("id,meta").eq("workspace_id", c.workspace_id).eq("provider", "whatsapp");
    const wabaOfConn = new Map((waConns ?? []).map((x: any) => [x.id, x.meta?.waba_id]));
    const wabaOfNum = new Map((nums ?? []).map((n: any) => [n.phone_number_id, wabaOfConn.get(n.connection_id)]));
    const { data: w } = await db.from("workspaces").select("currency").eq("id", c.workspace_id).single();
    let lastOk: string | null = null, lastErr: string | null = null;
    for (const o of todo) {
      const conv: any = byConv.get(o.conversation_id);
      if (!conv) continue;   // not from an ad: nothing to tell Meta
      const waba = String(wabaOfNum.get(conv.phone_number_id) ?? Object.keys(datasets)[0] ?? "");
      const dataset = datasets[waba];
      if (!waba || !dataset) continue;
      const value = Math.max(0, Number(o.amount ?? 0) - Number(o.discount ?? 0) - Number(o.refund_amount ?? 0));
      const event = {
        event_name: "Purchase", event_time: Math.min(Math.floor(Date.parse(o.paid_at) / 1000), Math.floor(Date.now() / 1000)), event_id: o.id,
        action_source: "business_messaging", messaging_channel: "whatsapp",
        user_data: { whatsapp_business_account_id: waba, ctwa_clid: conv.ctwa_clid },
        custom_data: { currency: String(o.currency || w?.currency || "TZS").toUpperCase(), value },
      };
      const r = await graph(`${dataset}/events`, token, { method: "POST", body: JSON.stringify({ data: [event] }) });
      if (r.ok) {
        out.sent++; lastOk = new Date().toISOString();
        await db.from("orders").update({ capi_sent_at: lastOk, capi_error: null }).eq("id", o.id);
      } else {
        out.failed++; lastErr = metaError(r.body); out.last_error = lastErr;
        await db.from("orders").update({ capi_error: lastErr, capi_tries: (o.capi_tries ?? 0) + 1 }).eq("id", o.id);
        if (r.body?.error?.code === 190) break;   // token expired or revoked: stop for this business
      }
    }
    await db.from("connections").update({
      ...(lastOk ? { last_sync_at: lastOk } : {}),
      last_error: lastErr && !lastOk ? lastErr : null,
      ...(lastErr && /code 190/.test(lastErr) ? { status: "error" } : {}),
    }).eq("id", c.id);
  }
  return out;
}

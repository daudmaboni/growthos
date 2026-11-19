// Push notifications to the itaOS phone app (PWA).
//
// Two callers:
//  - The messages_push database trigger (migration 0039), right after a customer's WhatsApp message is saved (x-cron-secret header):
//      { conversation_ids: [...] } → one notification per chat to every device that turned
//      notifications on for that business. Only for messages from the last 10 minutes, so
//      replayed or backfilled events never ring phones about old chats.
//  - A signed-in member from Settings → Phone app: { test: true, workspace_id } → a test to
//    that member's own devices.
//
// Needs the VAPID_PRIVATE_KEY secret (the public key is in web/src/pwa.ts).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const VAPID_PUBLIC = "BKxMcuarzjl5x6fGfsPnmySAi2XKYUl7gj5oD21thQtHPyJXHOm-dIRtjOTbsuuL_yj1DN_QJ58btb7QKMjj2no";
const FRESH_MS = 10 * 60_000;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Sub = { endpoint: string; p256dh: string; auth: string; fail_count: number };
type Note = { title: string; body: string; url: string; tag: string };

function preview(type: string, body: string | null, sw: boolean) {
  const T = (en: string, s: string) => (sw ? s : en);
  switch (type) {
    case "image": return "📷 " + (body && body !== "[image]" ? body : T("Photo", "Picha"));
    case "audio": return "🎤 " + T("Voice note", "Ujumbe wa sauti");
    case "video": return "🎥 " + (body && body !== "[video]" ? body : T("Video", "Video"));
    case "document": return "📄 " + (body && body !== "[document]" ? body : T("File", "Faili"));
    case "location": return "📍 " + T("Location", "Mahali");
    case "sticker": return T("Sticker", "Stika");
    default: { const t = (body ?? "").replace(/\s+/g, " ").trim(); return t.length > 140 ? t.slice(0, 139) + "…" : t || T("New message", "Ujumbe mpya"); }
  }
}

async function deliver(db: ReturnType<typeof createClient>, subs: Sub[], note: Note) {
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(note), { TTL: 3600, urgency: "high", topic: note.tag.slice(0, 32) });
      sent++;
      await db.from("push_subscriptions").update({ last_ok_at: new Date().toISOString(), fail_count: 0 }).eq("endpoint", s.endpoint);
    } catch (e: any) {
      const code = e?.statusCode ?? 0;
      // 404/410: the phone dropped this subscription (app removed, permission revoked). Forget it.
      if (code === 404 || code === 410 || s.fail_count >= 20) await db.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
      else await db.from("push_subscriptions").update({ fail_count: s.fail_count + 1 }).eq("endpoint", s.endpoint);
      console.error("push failed", code, String(e?.body ?? e?.message ?? e).slice(0, 160));
    }
  }));
  return sent;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const priv = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!priv) return json({ error: "Notifications aren't set up on the server yet (VAPID_PRIVATE_KEY missing)." }, 503);
  webpush.setVapidDetails("mailto:hello@ponditech.com", VAPID_PUBLIC, priv);

  const body = await req.json().catch(() => ({}));
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const cronSecret = Deno.env.get("CRON_SECRET");
  const isCron = !!cronSecret && req.headers.get("x-cron-secret") === cronSecret;

  if (body.test) {
    const ws = String(body.workspace_id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(ws)) return json({ error: "workspace_id required" }, 400);
    const uc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: u } = await uc.auth.getUser();
    if (!u?.user) return json({ error: "Sign in first." }, 401);
    const { data: subs } = await db.from("push_subscriptions").select("endpoint,p256dh,auth,fail_count").eq("user_id", u.user.id).eq("workspace_id", ws);
    if (!subs?.length) return json({ error: "No device has notifications on yet. Turn them on first." }, 400);
    const { data: w } = await db.from("workspaces").select("language").eq("id", ws).maybeSingle();
    const sw = w?.language === "sw";
    const sent = await deliver(db, subs as Sub[], { title: "itaOS", body: sw ? "Arifa zinafanya kazi ✅ Utapata ujumbe hapa mteja akiandika." : "Notifications work ✅ You'll see it here when a customer writes.", url: "/app#chats", tag: "test" });
    return sent ? json({ ok: true, sent }) : json({ error: "The test couldn't be delivered. Turn notifications off and on again." }, 502);
  }

  if (!isCron) return json({ error: "forbidden" }, 403);
  const ids: string[] = [...new Set((body.conversation_ids ?? []).map(String))].filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 20);
  let sent = 0;
  for (const id of ids) {
    const { data: conv } = await db.from("conversations").select("id,workspace_id,contacts(name,wa_id)").eq("id", id).maybeSingle();
    if (!conv) continue;
    const { data: last } = await db.from("messages").select("direction,type,body,sent_at").eq("conversation_id", id).order("sent_at", { ascending: false }).limit(1);
    const m = last?.[0];
    if (!m || m.direction !== "in" || Date.now() - Date.parse(m.sent_at) > FRESH_MS) continue;
    const { data: subs } = await db.from("push_subscriptions").select("endpoint,p256dh,auth,fail_count").eq("workspace_id", conv.workspace_id);
    if (!subs?.length) continue;
    const { data: w } = await db.from("workspaces").select("language").eq("id", conv.workspace_id).maybeSingle();
    const c = (conv as any).contacts ?? {};
    const who = c.name || (c.wa_id ? "+" + String(c.wa_id).replace(/\D/g, "") : "WhatsApp");
    sent += await deliver(db, subs as Sub[], { title: who, body: preview(m.type, m.body, w?.language === "sw"), url: "/app#chats/open=" + id, tag: "chat-" + id });
  }
  return json({ ok: true, sent });
});

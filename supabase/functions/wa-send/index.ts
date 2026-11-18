// Send a WhatsApp reply from itaOS (owners and admins only).
//
// Goes out from the business's own number through Dualhook's runtime
// (POST https://api.dualhook.com/v25.0/<PHONE_NUMBER_ID>/messages, Bearer dh_live_… key the owner
// saved on the Connect page). With Coexistence the reply also appears in the WhatsApp Business app.
// WhatsApp only allows free-form replies inside the 24-hour customer service window (24 h after the
// customer's last message); outside it this refuses, because only approved templates may be sent.
// Every message sent here is saved with origin "itaos" and the sender's user id.
import { admin, userClient, json, cors, reanalyze } from "../_shared/db.ts";
import { dualhookKey } from "../_shared/media.ts";

const DUALHOOK = "https://api.dualhook.com/v25.0";
const WINDOW_MS = 24 * 3600e3;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body = await req.json().catch(() => ({}));
  const ws = String(body.workspace_id ?? "");
  const convId = String(body.conversation_id ?? "");
  const text = String(body.text ?? "").replace(/\r\n/g, "\n").trim();
  if (!/^[0-9a-f-]{36}$/i.test(ws) || !/^[0-9a-f-]{36}$/i.test(convId)) return json({ error: "workspace_id and conversation_id required" }, 400);
  if (!text) return json({ error: "Write a message first." }, 400);
  if (text.length > 4096) return json({ error: "WhatsApp messages can be at most 4,096 characters." }, 400);

  const uc = userClient(req);
  const [{ data: ok }, { data: user }] = await Promise.all([uc.rpc("can_manage", { ws }), uc.auth.getUser()]);
  if (!ok || !user?.user) return json({ error: "Only the owner or an admin can send WhatsApp messages from itaOS." }, 403);

  const db = admin();
  const { data: w } = await db.from("workspaces").select("send_enabled").eq("id", ws).maybeSingle();
  if (w && w.send_enabled === false) return json({ error: "Sending from itaOS is turned off for this business (Settings)." }, 403);
  const { data: conv } = await db.from("conversations").select("id,phone_number_id,contacts(wa_id)").eq("id", convId).eq("workspace_id", ws).maybeSingle();
  if (!conv) return json({ error: "Chat not found." }, 404);
  const to = String((conv as any).contacts?.wa_id ?? "").replace(/\D/g, "");
  if (conv.phone_number_id === "import" || !to) return json({ error: "This chat came from an uploaded file, so it can't be answered from itaOS." }, 400);

  const { data: lastIn } = await db.from("messages").select("sent_at").eq("conversation_id", convId).eq("direction", "in").order("sent_at", { ascending: false }).limit(1);
  const lastInAt = lastIn?.[0]?.sent_at ? Date.parse(lastIn[0].sent_at) : 0;
  if (!lastInAt || Date.now() - lastInAt > WINDOW_MS) {
    return json({ error: "More than 24 hours since the customer's last message. WhatsApp only allows approved template messages now; reply from the WhatsApp app.", window_closed: true }, 409);
  }

  const key = await dualhookKey(db, ws);
  if (!key) return json({ error: "Add your Dualhook API key (dh_live_…) on the Connections page to send from itaOS." }, 400);

  const res = await fetch(`${DUALHOOK}/${encodeURIComponent(conv.phone_number_id)}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body: text, preview_url: false } }),
  }).catch(() => null);
  const out = res ? await res.json().catch(() => ({})) : {};
  if (!res || !res.ok || out.error) {
    const e = out.error ?? {};
    console.error("wa-send failed", res?.status, e.code, String(e.message ?? "").slice(0, 160));
    const msg = e.code === 131047 ? "More than 24 hours since the customer's last message. Reply from the WhatsApp app."
      : res?.status === 401 || res?.status === 403 ? "Dualhook refused the key. Save it again on the Connections page."
      : `WhatsApp didn't accept the message${e.message ? `: ${String(e.message).slice(0, 160)}` : "."}`;
    return json({ error: msg, code: e.code ?? null }, 502);
  }
  const id = out.messages?.[0]?.id;
  if (!id) return json({ error: "WhatsApp gave no message id; check the chat in WhatsApp." }, 502);

  const now = new Date().toISOString();
  const { error } = await db.from("messages").upsert({
    id, workspace_id: ws, conversation_id: convId, direction: "out", origin: "itaos", sent_at: now, type: "text", body: text,
    raw: { sent_via: "itaos", to }, sent_by: user.user.id,
  }, { onConflict: "id", ignoreDuplicates: true });
  if (error) console.error("wa-send: sent but not saved", error.message);
  await reanalyze(db, [convId]).catch((e) => console.error("wa-send reanalyze", String(e?.message ?? e).slice(0, 160)));
  return json({ ok: true, id, sent_at: now });
});

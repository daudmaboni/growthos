// Connects a workspace's WhatsApp number through 360dialog (a Meta-verified partner that supports
// Coexistence). Bridge until GrowthOS has its own Tech Provider access; then reconnect with
// Embedded Signup in meta-connect and this connection can be removed.
//
// The owner pastes their 360dialog API key. We point the number's webhook at wa-webhook with a
// fresh per-workspace secret header, keep only a hash of that secret, and store the API key in Vault.
import { admin, userClient, storeToken, json, cors } from "../_shared/db.ts";
import { sha256Hex } from "../_shared/webhook.ts";

const D360 = Deno.env.get("D360_BASE_URL") ?? "https://waba-v2.360dialog.io";

async function d360(path: string, apiKey: string, init: RequestInit = {}) {
  const res = await fetch(`${D360}${path}`, { ...init, headers: { "D360-API-KEY": apiKey, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const text = await res.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 200) }; }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error("360dialog rejected this API key. Copy it again from the 360dialog hub (API keys) and retry.");
    throw new Error(`360dialog ${res.status}: ${body?.meta?.developer_message ?? body?.error?.message ?? body?.message ?? "request failed"}`);
  }
  return body;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const body = await req.json().catch(() => ({}));
  const ws = String(body.workspace_id ?? "");
  const apiKey = String(body.api_key ?? "").trim();
  if (!ws) return json({ error: "workspace_id required" }, 400);
  if (apiKey.length < 10) return json({ error: "Paste the 360dialog API key for the WhatsApp number." }, 400);
  const { data: ok } = await userClient(req).rpc("can_manage", { ws });
  if (!ok) return json({ error: "Only a workspace owner or admin can connect accounts." }, 403);
  const db = admin();

  try {
    const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const hash = await sha256Hex(token);
    const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/wa-webhook`;

    // 1) Point the number's events at GrowthOS. Done first: if the key is wrong nothing is saved.
    await d360("/v1/configs/webhook", apiKey, { method: "POST", body: JSON.stringify({ url, headers: { "x-growthos-token": token } }) });

    // 2) Best effort: learn the WABA id for labelling. Numbers register themselves on the first event.
    let wabaId: string | null = null;
    try { const w = await d360("/waba_webhook", apiKey); wabaId = w?.waba_id ? String(w.waba_id) : null; } catch { /* optional */ }

    // 3) Save (or rotate) this workspace's 360dialog connection.
    const { data: existing, error: findError } = await db.from("connections").select("id,external_id")
      .eq("workspace_id", ws).eq("provider", "whatsapp").eq("meta->>via", "360dialog").maybeSingle();
    if (findError) throw new Error("could not check existing connections");
    const externalId = wabaId ? `360dialog:${wabaId}` : existing?.external_id ?? `360dialog:${hash.slice(0, 12)}`;
    const { data: clash } = await db.from("connections").select("workspace_id").eq("provider", "whatsapp").eq("external_id", externalId).maybeSingle();
    if (clash && clash.workspace_id !== ws) throw new Error("This WhatsApp account is already connected to another GrowthOS workspace.");

    const secret = await storeToken(db, `360dialog:${ws}:${Date.now()}`, apiKey);
    const row = {
      workspace_id: ws, provider: "whatsapp", external_id: externalId, label: "WhatsApp via 360dialog",
      token_secret_id: secret, status: "active", last_error: null,
      meta: { via: "360dialog", webhook_token_hash: hash, webhook_set_at: new Date().toISOString(), waba_id: wabaId },
    };
    const { error } = existing
      ? await db.from("connections").update(row).eq("id", existing.id)
      : await db.from("connections").insert(row);
    if (error) throw new Error("could not save the connection");
    return json({ ok: true, waba_id: wabaId });
  } catch (e) {
    return json({ error: String((e as Error).message).slice(0, 300) }, 502);
  }
});

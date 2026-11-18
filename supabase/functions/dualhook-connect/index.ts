// Connects a workspace's WhatsApp number through Dualhook (a Meta Tech Provider with Coexistence
// and "Webhook Override"). Bridge until itaOS has its own Tech Provider access.
//
// With Webhook Override, Meta itself sends messages / smb_message_echoes / history /
// smb_app_state_sync to the URL we hand out, in Meta's normal envelope. Meta signs those with
// Dualhook's app secret (which we never get), so the URL carries a per-workspace secret instead:
//   <SUPABASE_URL>/functions/v1/wa-webhook/dh/<token>
// plus a separate verify token for Meta's GET challenge. Only SHA-256 hashes of both are stored;
// the plain values are shown to the owner once. Calling this again rotates both.
import { admin, userClient, json, cors, storeToken, reanalyze } from "../_shared/db.ts";
import { backfillMedia } from "../_shared/media.ts";
import { sha256Hex } from "../_shared/webhook.ts";

const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const body = await req.json().catch(() => ({}));
  const ws = String(body.workspace_id ?? "");
  if (!ws) return json({ error: "workspace_id required" }, 400);
  const { data: ok } = await userClient(req).rpc("can_manage", { ws });
  if (!ok) return json({ error: "Only a workspace owner or admin can connect accounts." }, 403);
  const db = admin();

  // Save the Dualhook Outbound API key (dh_live_…) so itaOS can download customer images, then
  // fetch the images from the last 7 days that could not be saved yet.
  if (body.action === "set_api_key" || body.action === "backfill_media") {
    try {
      const { data: conn } = await db.from("connections").select("id,meta").eq("workspace_id", ws).eq("provider", "whatsapp").eq("meta->>via", "dualhook").maybeSingle();
      if (!conn) return json({ error: "Connect WhatsApp through Dualhook first." }, 400);
      if (body.action === "set_api_key") {
        const key = String(body.api_key ?? "").trim();
        if (!/^dh_live_[A-Za-z0-9_-]{8,200}$/.test(key)) return json({ error: "That doesn't look like a Dualhook key. It starts with dh_live_." }, 400);
        const check = await fetch("https://api.dualhook.com/v25.0/health", { headers: { Authorization: `Bearer ${key}` } }).catch(() => null);
        if (check && (check.status === 401 || check.status === 403)) return json({ error: "Dualhook rejected this key. Copy it again from Connection → Overview → Outbound API key." }, 400);
        const secretId = await storeToken(db, `dualhook_api_key:${conn.id}`, key);
        const { error } = await db.from("connections").update({ meta: { ...(conn.meta ?? {}), api_key_secret_id: secretId, api_key_last4: key.slice(-4), api_key_set_at: new Date().toISOString() } }).eq("id", conn.id);
        if (error) throw new Error("could not save the key");
      }
      const r = await backfillMedia(db, ws);
      if (r.conversations.length) await reanalyze(db, r.conversations);
      return json({ ok: true, key_saved: body.action === "set_api_key", images_saved: r.saved, images_failed: r.failed, last_error: r.last_error });
    } catch (e) {
      return json({ error: String((e as Error).message).slice(0, 300) }, 500);
    }
  }

  try {
    const token = hex(32);      // 64 hex chars; URL stays well under Meta's 200-char limit
    const verify = hex(16);
    const [tokenHash, verifyHash] = await Promise.all([sha256Hex(token), sha256Hex(verify)]);
    const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/wa-webhook/dh/${token}`;

    const { data: existing, error: findError } = await db.from("connections").select("id,external_id,meta")
      .eq("workspace_id", ws).eq("provider", "whatsapp").eq("meta->>via", "dualhook").maybeSingle();
    if (findError) throw new Error("could not check existing connections");

    const row = {
      workspace_id: ws, provider: "whatsapp", label: "WhatsApp via Dualhook",
      external_id: existing?.external_id ?? `dualhook:${tokenHash.slice(0, 12)}`,
      // The Connect page shows "waiting for the first message" until last_sync_at is set.
      status: "active", last_error: null,
      meta: { ...(existing?.meta ?? {}), via: "dualhook", webhook_token_hash: tokenHash, verify_token_hash: verifyHash, webhook_set_at: new Date().toISOString() },
    };
    const { error } = existing
      ? await db.from("connections").update(row).eq("id", existing.id)
      : await db.from("connections").insert(row);
    if (error) throw new Error("could not save the connection");
    return json({ ok: true, webhook_url: url, verify_token: verify, rotated: !!existing });
  } catch (e) {
    return json({ error: String((e as Error).message).slice(0, 300) }, 500);
  }
});

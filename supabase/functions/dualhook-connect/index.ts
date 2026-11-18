// Connects a workspace's WhatsApp number through Dualhook (a Meta Tech Provider with Coexistence
// and "Webhook Override"). Bridge until ItaOS has its own Tech Provider access.
//
// With Webhook Override, Meta itself sends messages / smb_message_echoes / history /
// smb_app_state_sync to the URL we hand out, in Meta's normal envelope. Meta signs those with
// Dualhook's app secret (which we never get), so the URL carries a per-workspace secret instead:
//   <SUPABASE_URL>/functions/v1/wa-webhook/dh/<token>
// plus a separate verify token for Meta's GET challenge. Only SHA-256 hashes of both are stored;
// the plain values are shown to the owner once. Calling this again rotates both.
import { admin, userClient, json, cors } from "../_shared/db.ts";
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

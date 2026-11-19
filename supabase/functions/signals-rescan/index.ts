// Re-read chats with the current payment rules (_shared/signals.ts) after the rules change.
// Called by: pg_cron / SQL net.http_post with x-cron-secret. Body: { "flagged_only": true } (default) re-reads
// chats flagged "says they paid" with no recorded sale; { "ids": [...] } re-reads those chats.
import { admin, json, cors, reanalyze } from "../_shared/db.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) return json({ error: "forbidden" }, 403);
  const body = await req.json().catch(() => ({}));
  const db = admin();
  let ids: string[] = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 2000) : [];
  if (!ids.length) {
    const { data, error } = await db.from("conversation_outcomes").select("id").eq("payment_signal", true).eq("paid_orders", 0).limit(2000);
    if (error) return json({ error: error.message }, 500);
    ids = (data ?? []).map((r: { id: string }) => r.id);
  }
  let done = 0, failed = 0;
  for (const id of ids) {
    try { await reanalyze(db, [id]); done++; } catch (e) { failed++; console.error("rescan", id, String((e as Error)?.message ?? e).slice(0, 200)); }
  }
  return json({ checked: ids.length, done, failed });
});

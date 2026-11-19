// Re-checks chats with the current rules ("Re-check all chats" on the Chats page, and the scheduled job).
// Uploading WhatsApp chat exports was removed (19 Nov 2026): chats come only from the live WhatsApp
// connection now. The function keeps its old name because the app and the schedule call it.
import { admin, userClient, reanalyze, json, cors } from "../_shared/db.ts";

/** The business's own mark: a ✅ in the saved contact name means "this customer bought". */
async function applyNameMarks(db: ReturnType<typeof admin>, ws: string) {
  const { data: marked } = await db.from("contacts").select("id").eq("workspace_id", ws).like("name", "%✅%").limit(5000);
  const ids = (marked ?? []).map((r) => r.id);
  for (let i = 0; i < ids.length; i += 200) {
    await db.from("conversations").update({ outcome_override: "sold" })
      .eq("workspace_id", ws).in("contact_id", ids.slice(i, i + 200)).is("outcome_override", null);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const body = await req.json().catch(() => ({}));
  const ws = body.workspace_id as string;
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("x-cron-secret") === cronSecret && body.action === "reanalyze") {
    const db = admin();
    const { data: wss } = await db.from("workspaces").select("id");
    let n = 0;
    for (const w of wss ?? []) {
      const { data: all } = await db.from("conversations").select("id").eq("workspace_id", w.id).limit(5000);
      const ids = (all ?? []).map((r) => r.id);
      await reanalyze(db, ids); await applyNameMarks(db, w.id); n += ids.length;
    }
    return json({ reanalyzed: n });
  }
  if (!ws) return json({ error: "workspace_id required" }, 400);
  const { data: ok } = await userClient(req).rpc("is_member", { ws });
  if (!ok) return json({ error: "not a member of this workspace" }, 403);
  if (body.action !== "reanalyze") return json({ error: "Uploading chat files has been removed. Chats come from your connected WhatsApp number." }, 410);

  const db = admin();
  const { data: all } = await db.from("conversations").select("id").eq("workspace_id", ws).limit(5000);
  const ids = (all ?? []).map((r) => r.id);
  await reanalyze(db, ids);
  await applyNameMarks(db, ws);
  return json({ reanalyzed: ids.length });
});

// Imports WhatsApp chat exports (parsed in the browser) into a workspace.
// Bridge until the WhatsApp connection is live: same tables, same analyzer.
import { admin, userClient, reanalyze, json, cors } from "../_shared/db.ts";

type InMsg = { direction: "in" | "out"; sent_at: string; body: string };
type InChat = { name: string; from_ad?: boolean; messages: InMsg[] };

/** Lead batch written in the saved contact name, e.g. "Mafinga Aug Mid TTS Leads 647✅" → "Aug Mid TTS Leads". */
function sourceLabel(name: string): string | null {
  const m = name.replace(/✅/g, "").match(/\b((?:jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec)[a-z]*\b.*leads.*)/i);
  const v = m ? m[1].replace(/[\s\d]+$/, "").trim() : "";
  return v || null;
}

async function sha(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

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
  const chats = (body.chats ?? []) as InChat[];
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

  const db = admin();

  // Re-run the analyzer over every chat in the workspace (after detection rules improve)
  if (body.action === "reanalyze") {
    const { data: all } = await db.from("conversations").select("id").eq("workspace_id", ws).limit(5000);
    const ids = (all ?? []).map((r) => r.id);
    await reanalyze(db, ids);
    await applyNameMarks(db, ws);
    return json({ reanalyzed: ids.length });
  }
  if (!Array.isArray(chats) || !chats.length) return json({ error: "No chats to import." }, 400);
  if (chats.length > 10) return json({ error: "Send at most 10 chats per request." }, 400);
  const touched: string[] = [];
  let imported = 0, messages = 0;
  try {
    for (const chat of chats) {
      const name = String(chat.name ?? "").trim().slice(0, 120);
      const msgs = (chat.messages ?? []).filter((m) =>
        (m.direction === "in" || m.direction === "out") && !isNaN(Date.parse(m.sent_at))).slice(0, 5000);
      if (!name || !msgs.length) continue;
      const key = "import:" + name.toLowerCase();
      const { data: c, error: e1 } = await db.from("contacts")
        .upsert({ workspace_id: ws, wa_id: key, name }, { onConflict: "workspace_id,wa_id" }).select("id").single();
      if (e1) throw new Error(e1.message);
      const { data: conv, error: e2 } = await db.from("conversations")
        .upsert({ workspace_id: ws, contact_id: c!.id, phone_number_id: "import", source_label: sourceLabel(name) }, { onConflict: "workspace_id,contact_id,phone_number_id" })
        .select("id,source,ad_signal").single();
      if (e2) throw new Error(e2.message);
      if (chat.from_ad && conv!.source !== "ad" && conv!.ad_signal !== "owner") await db.from("conversations").update({ source: "ad" }).eq("id", conv!.id);
      const rows = [];
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        const text = String(m.body ?? "").slice(0, 4000);
        rows.push({
          id: "imp_" + await sha([ws, key, i, m.sent_at, m.direction, text].join("|")),
          workspace_id: ws, conversation_id: conv!.id, direction: m.direction, origin: "import",
          sent_at: new Date(m.sent_at).toISOString(), type: "text", body: text,
        });
      }
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await db.from("messages").upsert(rows.slice(i, i + 500), { onConflict: "id", ignoreDuplicates: true });
        if (error) throw new Error(error.message);
      }
      touched.push(conv!.id); imported++; messages += rows.length;
    }
    await reanalyze(db, touched);
    await applyNameMarks(db, ws);
    return json({ imported, messages });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});

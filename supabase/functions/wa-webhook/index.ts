// WhatsApp Cloud API webhook (Coexistence-aware).
// Handles: messages (customer → business, incl. CTWA referral), smb_message_echoes (sent from the
// Business app on the phone), history (6-month backfill), smb_app_state_sync (contact names).
import { admin, reanalyze } from "../_shared/db.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

const APP_SECRET = Deno.env.get("META_APP_SECRET") ?? "";
const VERIFY_TOKEN = Deno.env.get("META_VERIFY_TOKEN") ?? "";

async function validSignature(raw: string, header: string | null) {
  if (!APP_SECRET || !header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  const hex = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice(7);
  if (given.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

function textOf(m: any): string | null {
  switch (m.type) {
    case "text": return m.text?.body ?? null;
    case "image": case "video": case "document": return m[m.type]?.caption ?? `[${m.type}]`;
    case "audio": return "[voice note]";
    case "button": return m.button?.text ?? null;
    case "interactive": return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
    case "reaction": return null;
    default: return `[${m.type}]`;
  }
}

type Ctx = { db: SupabaseClient; ws: string; pnid: string; touched: string[] };

async function conversationFor(ctx: Ctx, waId: string, name?: string | null) {
  const { db, ws, pnid } = ctx;
  const { data: c } = await db.from("contacts")
    .upsert({ workspace_id: ws, wa_id: waId, ...(name ? { name } : {}) }, { onConflict: "workspace_id,wa_id" })
    .select("id").single();
  const { data: conv } = await db.from("conversations")
    .upsert({ workspace_id: ws, contact_id: c!.id, phone_number_id: pnid }, { onConflict: "workspace_id,contact_id,phone_number_id", ignoreDuplicates: false })
    .select("id,ad_id,source,started_at").single();
  return conv!;
}

async function saveMessage(ctx: Ctx, convId: string, m: any, direction: "in" | "out", origin: string) {
  if (m.type === "reaction" || m.type === "unsupported" || !m.id) return;
  const { error } = await ctx.db.from("messages").upsert({
    id: m.id, workspace_id: ctx.ws, conversation_id: convId, direction, origin,
    sent_at: new Date(Number(m.timestamp) * 1000).toISOString(), type: m.type, body: textOf(m), raw: m,
  }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw error;
  ctx.touched.push(convId);
}

async function handleChange(db: SupabaseClient, field: string, value: any) {
  const pnid: string | undefined = value?.metadata?.phone_number_id;
  if (!pnid) return;
  const { data: num } = await db.from("wa_numbers").select("workspace_id,display_phone").eq("phone_number_id", pnid).maybeSingle();
  if (!num) { console.warn("unknown phone_number_id", pnid); return; }
  const ctx: Ctx = { db, ws: num.workspace_id, pnid, touched: [] };

  if (field === "messages") {
    const names = new Map<string, string>((value.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]));
    for (const m of value.messages ?? []) {
      const conv = await conversationFor(ctx, m.from, names.get(m.from));
      if (m.referral && !conv.ad_id) {
        const r = m.referral;
        await db.from("conversations").update({
          source: r.source_type === "ad" ? "ad" : "organic",
          ad_id: r.source_type === "ad" ? r.source_id : null,
          ctwa_clid: r.ctwa_clid ?? null, referral: r,
        }).eq("id", conv.id);
      } else if (conv.source === "unknown" && !conv.started_at) {
        await db.from("conversations").update({ source: "organic" }).eq("id", conv.id).eq("source", "unknown");
      }
      await saveMessage(ctx, conv.id, m, "in", "webhook");
    }
  } else if (field === "smb_message_echoes") {
    for (const m of value.message_echoes ?? []) {
      const conv = await conversationFor(ctx, m.to);
      await saveMessage(ctx, conv.id, m, "out", "app_echo");
    }
  } else if (field === "history") {
    for (const h of value.history ?? []) {
      if (h.errors?.length) {
        await db.from("wa_numbers").update({ history_status: "declined" }).eq("phone_number_id", pnid);
        continue;
      }
      for (const th of h.threads ?? []) {
        const conv = await conversationFor(ctx, th.id);
        for (const m of th.messages ?? []) {
          await saveMessage(ctx, conv.id, m, m.from === th.id ? "in" : "out", "history");
        }
      }
      const progress = Number(h.metadata?.progress ?? 0);
      await db.from("wa_numbers").update({ history_status: progress >= 100 ? "complete" : "receiving" }).eq("phone_number_id", pnid);
    }
  } else if (field === "smb_app_state_sync") {
    for (const s of value.state_sync ?? []) {
      if (s.type === "contact" && s.contact?.phone_number && s.action !== "remove") {
        await db.from("contacts").upsert({ workspace_id: ctx.ws, wa_id: s.contact.phone_number.replace(/\D/g, ""), name: s.contact.full_name ?? s.contact.first_name ?? null }, { onConflict: "workspace_id,wa_id" });
      }
    }
  }
  if (ctx.touched.length) await reanalyze(db, ctx.touched);
}

async function process(raw: string) {
  const db = admin();
  const body = JSON.parse(raw);
  for (const entry of body.entry ?? []) {
    for (const ch of entry.changes ?? []) {
      const v = ch.value ?? {};
      const key = [ch.field, v.metadata?.phone_number_id ?? entry.id,
        v.messages?.[0]?.id ?? v.message_echoes?.[0]?.id ?? v.statuses?.[0]?.id ?? "",
        v.statuses?.[0]?.status ?? "", JSON.stringify(v.history?.[0]?.metadata ?? ""), String(entry.time ?? "")].join("|");
      if (ch.field === "messages" && !v.messages) continue; // delivery statuses: not needed for analysis
      const { data: ins } = await db.from("raw_events")
        .upsert({ provider: "whatsapp", event_key: key, field: ch.field, payload: ch }, { onConflict: "provider,event_key", ignoreDuplicates: true })
        .select("id");
      if (!ins?.length) continue; // duplicate delivery
      try {
        await handleChange(db, ch.field, v);
        await db.from("raw_events").update({ processed_at: new Date().toISOString() }).eq("id", ins[0].id);
      } catch (e) {
        console.error("process error", ch.field, (e as Error).message);
        await db.from("raw_events").update({ error: String((e as Error).message).slice(0, 500) }).eq("id", ins[0].id);
      }
    }
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") {
    if (url.searchParams.get("hub.mode") === "subscribe" && VERIFY_TOKEN && url.searchParams.get("hub.verify_token") === VERIFY_TOKEN) {
      return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
    }
    return new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const raw = await req.text();
  if (!(await validSignature(raw, req.headers.get("x-hub-signature-256")))) return new Response("bad signature", { status: 401 });
  // Acknowledge fast; process after responding (Meta retries on slow/failed responses).
  // @ts-ignore EdgeRuntime is provided by Supabase
  EdgeRuntime.waitUntil(process(raw).catch((e) => console.error("webhook", e)));
  return new Response("ok", { status: 200 });
});

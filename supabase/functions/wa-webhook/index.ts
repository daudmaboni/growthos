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
  const { data: c, error: contactError } = await db.from("contacts")
    .upsert({ workspace_id: ws, wa_id: waId, ...(name ? { name } : {}) }, { onConflict: "workspace_id,wa_id" })
    .select("id").single();
  if (contactError || !c) throw new Error("could not resolve WhatsApp contact");
  const { data: conv, error: conversationError } = await db.from("conversations")
    .upsert({ workspace_id: ws, contact_id: c!.id, phone_number_id: pnid }, { onConflict: "workspace_id,contact_id,phone_number_id", ignoreDuplicates: false })
    .select("id,ad_id,source,started_at").single();
  if (conversationError || !conv) throw new Error("could not resolve conversation");
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
  if (!num) throw new Error("WhatsApp number is not connected to a workspace");
  const ctx: Ctx = { db, ws: num.workspace_id, pnid, touched: [] };

  if (field === "messages") {
    const names = new Map<string, string>((value.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]));
    for (const m of value.messages ?? []) {
      const conv = await conversationFor(ctx, m.from, names.get(m.from));
      if (m.referral && !conv.ad_id) {
        const r = m.referral;
        const { error } = await db.from("conversations").update({
          source: r.source_type === "ad" ? "ad" : "organic",
          ad_id: r.source_type === "ad" ? r.source_id : null,
          ctwa_clid: r.ctwa_clid ?? null, referral: r,
        }).eq("id", conv.id);
        if (error) throw error;
      } else if (conv.source === "unknown" && !conv.started_at) {
        const { error } = await db.from("conversations").update({ source: "organic" }).eq("id", conv.id).eq("source", "unknown");
        if (error) throw error;
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
        const { error } = await db.from("wa_numbers").update({ history_status: "declined" }).eq("phone_number_id", pnid);
        if (error) throw error;
        continue;
      }
      for (const th of h.threads ?? []) {
        const conv = await conversationFor(ctx, th.id);
        for (const m of th.messages ?? []) {
          await saveMessage(ctx, conv.id, m, m.from === th.id ? "in" : "out", "history");
        }
      }
      const progress = Number(h.metadata?.progress ?? 0);
      const { error } = await db.from("wa_numbers").update({ history_status: progress >= 100 ? "complete" : "receiving" }).eq("phone_number_id", pnid);
      if (error) throw error;
    }
  } else if (field === "smb_app_state_sync") {
    for (const s of value.state_sync ?? []) {
      if (s.type === "contact" && s.contact?.phone_number && s.action !== "remove") {
        const { error } = await db.from("contacts").upsert({ workspace_id: ctx.ws, wa_id: s.contact.phone_number.replace(/\D/g, ""), name: s.contact.full_name ?? s.contact.first_name ?? null }, { onConflict: "workspace_id,wa_id" });
        if (error) throw error;
      }
    }
  }
  if (ctx.touched.length) await reanalyze(db, ctx.touched);
}

async function eventKey(change: unknown) {
  const data = new TextEncoder().encode(JSON.stringify(change));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function processStored(db: ReturnType<typeof admin>, id: number) {
  const { data: claimed, error: claimError } = await db.rpc("claim_raw_event", { p_id: id });
  if (claimError) throw new Error("could not claim saved webhook event");
  if (!claimed) return false;
  try {
    const { data: row, error } = await db.from("raw_events").select("field,payload").eq("id", id).single();
    if (error || !row) throw new Error("saved webhook event is unavailable");
    await handleChange(db, row.field, row.payload?.value ?? {});
    const { error: doneError } = await db.from("raw_events").update({
      status: "processed", processed_at: new Date().toISOString(), error: null, last_error: null,
    }).eq("id", id);
    if (doneError) throw new Error("could not mark webhook event processed");
    return true;
  } catch (e) {
    const message = String((e as Error).message ?? "webhook processing failed").slice(0, 500);
    await db.from("raw_events").update({ status: "failed", error: message, last_error: message }).eq("id", id);
    console.error("webhook event failed", id, message);
    return false;
  }
}

async function persistChanges(raw: string) {
  const db = admin();
  const body = JSON.parse(raw);
  const ids: number[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      if (change.field === "messages" && !value.messages) continue; // delivery status is not needed for analysis
      const key = await eventKey(change);
      const phoneNumberId = value.metadata?.phone_number_id;
      let workspaceId: string | null = null;
      if (phoneNumberId) {
        const { data: number, error: lookupError } = await db.from("wa_numbers").select("workspace_id").eq("phone_number_id", phoneNumberId).maybeSingle();
        if (lookupError) throw new Error("could not resolve WhatsApp workspace");
        workspaceId = number?.workspace_id ?? null;
      }
      const { data: inserted, error: insertError } = await db.from("raw_events").upsert({
        provider: "whatsapp", event_key: key, field: change.field, payload: change, workspace_id: workspaceId,
        status: "pending", received_at: new Date().toISOString(),
      }, { onConflict: "provider,event_key", ignoreDuplicates: true }).select("id");
      if (insertError) throw new Error("could not persist WhatsApp event");
      if (inserted?.length) { ids.push(inserted[0].id); continue; }

      // A duplicate delivery is safe to ignore only after successful processing.
      const { data: existing, error } = await db.from("raw_events").select("id,processed_at,status").eq("provider", "whatsapp").eq("event_key", key).single();
      if (error || !existing) throw new Error("could not recover saved WhatsApp event");
      if (!existing.processed_at && existing.status !== "processing") ids.push(existing.id);
    }
  }
  return { db, ids };
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

  // Scheduled recovery path. The shared secret must be rotated because it was
  // committed to the public repository; this path is never exposed to browsers.
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("x-cron-secret") === cronSecret) {
    const body = await req.json().catch(() => ({}));
    if (body.action !== "retry_failed") return new Response("forbidden", { status: 403 });
    const db = admin();
    const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
    const [retryable, stale] = await Promise.all([
      db.from("raw_events").select("id").eq("provider", "whatsapp").is("processed_at", null)
        .in("status", ["pending", "failed"]).order("received_at").limit(50),
      db.from("raw_events").select("id").eq("provider", "whatsapp").is("processed_at", null)
        .eq("status", "processing").lt("last_attempt_at", staleBefore).order("received_at").limit(50),
    ]);
    if (retryable.error || stale.error) return new Response("retry query failed", { status: 500 });
    const rows = [...(retryable.data ?? []), ...(stale.data ?? [])].slice(0, 50);
    let processed = 0;
    for (const row of rows) if (await processStored(db, row.id)) processed++;
    return new Response(JSON.stringify({ processed, checked: rows.length }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  const raw = await req.text();
  if (!(await validSignature(raw, req.headers.get("x-hub-signature-256")))) return new Response("bad signature", { status: 401 });
  // Persist first; only acknowledge once the event is durable. Processing can
  // then continue in the background and be replayed by the scheduled worker.
  let saved: { db: ReturnType<typeof admin>; ids: number[] };
  try { saved = await persistChanges(raw); }
  catch (e) {
    console.error("webhook persistence failed", String((e as Error).message).slice(0, 200));
    return new Response("temporary persistence failure", { status: 500 });
  }
  // @ts-ignore EdgeRuntime is provided by Supabase
  EdgeRuntime.waitUntil(Promise.all(saved.ids.map((id) => processStored(saved.db, id))));
  return new Response("ok", { status: 200 });
});

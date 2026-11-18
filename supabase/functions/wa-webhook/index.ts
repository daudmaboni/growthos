// WhatsApp Cloud API webhook (Coexistence-aware).
// Handles: messages (customer → business, incl. CTWA referral), smb_message_echoes (sent from the
// Business app on the phone), history (6-month backfill), smb_app_state_sync (contact names).
//
// Two ways in:
//  - Meta delivers directly (our own Meta app): signed with x-hub-signature-256.
//  - A partner relays Meta's events while ItaOS's own Tech Provider access is pending. Those
//    events can only land in the workspace their secret belongs to:
//      · 360dialog: per-workspace secret in the x-growthos-token header (set by d360-connect).
//      · Dualhook (Webhook Override): Meta posts directly, signed with Dualhook's app secret, to
//        /wa-webhook/dh/<secret> (set by dualhook-connect). The path secret replaces the signature.
//
// Durability: every verified change is saved to raw_events BEFORE Meta gets a 200. Processing
// runs after the response and is idempotent; failed events are retried by the scheduled job
// (bounded by max_attempts) or replayed on request by a workspace owner/admin.
import { admin, userClient, reanalyze, json, cors } from "../_shared/db.ts";
import { eventKey, safeError, isRetryable, normalizeEnvelope, sha256Hex, type Envelope } from "../_shared/webhook.ts";
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
  // Upsert on the provider message id: a replayed event never creates a second copy.
  const { error } = await ctx.db.from("messages").upsert({
    id: m.id, workspace_id: ctx.ws, conversation_id: convId, direction, origin,
    sent_at: new Date(Number(m.timestamp) * 1000).toISOString(), type: m.type, body: textOf(m), raw: m,
  }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error("could not save message");
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
        if (error) throw new Error("could not save ad referral");
      } else if (conv.source === "unknown" && !conv.started_at) {
        const { error } = await db.from("conversations").update({ source: "organic" }).eq("id", conv.id).eq("source", "unknown");
        if (error) throw new Error("could not save conversation source");
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
        if (error) throw new Error("could not save history status");
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
      if (error) throw new Error("could not save history progress");
    }
  } else if (field === "smb_app_state_sync") {
    for (const s of value.state_sync ?? []) {
      if (s.type === "contact" && s.contact?.phone_number && s.action !== "remove") {
        const { error } = await db.from("contacts").upsert({ workspace_id: ctx.ws, wa_id: s.contact.phone_number.replace(/\D/g, ""), name: s.contact.full_name ?? s.contact.first_name ?? null }, { onConflict: "workspace_id,wa_id" });
        if (error) throw new Error("could not save contact name");
      }
    }
  }
  // Signals are recomputed from the full message history, so a partial earlier run is repaired here.
  if (ctx.touched.length) await reanalyze(db, ctx.touched);
}

/** Claim one saved event and process it. Returns true when it is now processed. */
async function processStored(db: SupabaseClient, id: number) {
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
    const message = safeError(e);
    // Transient errors stay inside the automatic retry budget; permanent ones wait for a replay.
    const patch: Record<string, unknown> = { status: "failed", error: message, last_error: message };
    if (!isRetryable(message)) {
      const { data: cur } = await db.from("raw_events").select("max_attempts").eq("id", id).single();
      if (cur) patch.attempts = cur.max_attempts;
    }
    await db.from("raw_events").update(patch).eq("id", id);
    console.error("webhook event failed", id, message);
    return false;
  }
}

async function persistChanges(body: Envelope | any) {
  const db = admin();
  const ids: number[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      if (change.field === "messages" && !value.messages) continue; // delivery statuses are not needed for analysis
      const key = await eventKey(entry.id, change);
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

      // Provider retry of a change we already hold: only skip it if it was fully processed.
      const { data: existing, error } = await db.from("raw_events").select("id,processed_at,status").eq("provider", "whatsapp").eq("event_key", key).single();
      if (error || !existing) throw new Error("could not recover saved WhatsApp event");
      if (!existing.processed_at && existing.status !== "processing") ids.push(existing.id);
    }
  }
  return { db, ids };
}

async function retryBatch(db: SupabaseClient, ws: string | null, limit: number) {
  const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
  let retryable = db.from("raw_events").select("id").eq("provider", "whatsapp").is("processed_at", null).in("status", ["pending", "failed"]).order("received_at").limit(limit);
  let stale = db.from("raw_events").select("id").eq("provider", "whatsapp").is("processed_at", null).eq("status", "processing").lt("last_attempt_at", staleBefore).order("received_at").limit(limit);
  if (ws) { retryable = retryable.eq("workspace_id", ws); stale = stale.eq("workspace_id", ws); }
  const [a, b] = await Promise.all([retryable, stale]);
  if (a.error || b.error) throw new Error("retry query failed");
  const rows = [...(a.data ?? []), ...(b.data ?? [])].slice(0, limit);
  let processed = 0;
  for (const row of rows) if (await processStored(db, row.id)) processed++;
  return { processed, checked: rows.length };
}

type Via = "360dialog" | "dualhook";

async function bridgeConnection(via: Via, token: string) {
  const hash = await sha256Hex(token);
  return await admin().from("connections").select("id,workspace_id,external_id,status,meta")
    .eq("provider", "whatsapp").eq("meta->>via", via).eq("meta->>webhook_token_hash", hash).maybeSingle();
}

/** Meta's GET challenge for a Dualhook Webhook Override URL. */
async function dualhookVerify(url: URL, token: string) {
  if (url.searchParams.get("hub.mode") !== "subscribe") return new Response("forbidden", { status: 403 });
  const { data: conn, error } = await bridgeConnection("dualhook", token);
  if (error) return new Response("temporary lookup failure", { status: 500 });
  const given = url.searchParams.get("hub.verify_token") ?? "";
  if (!conn || conn.status === "revoked" || !given || (await sha256Hex(given)) !== conn.meta?.verify_token_hash) {
    return new Response("forbidden", { status: 403 });
  }
  await admin().from("connections").update({ meta: { ...conn.meta, verified_at: new Date().toISOString() } }).eq("id", conn.id);
  return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
}

/**
 * Partner relay. The token identifies exactly one workspace connection. Numbers seen for the
 * first time are registered to that workspace; a number owned by another workspace is refused.
 */
async function bridgeDelivery(req: Request, via: Via, token: string) {
  const db = admin();
  const { data: conn, error } = await bridgeConnection(via, token);
  if (error) return new Response("temporary lookup failure", { status: 500 });
  if (!conn || conn.status === "revoked") return new Response("unknown token", { status: 401 });

  let body: unknown;
  try { body = JSON.parse(await req.text()); } catch { return new Response("bad json", { status: 400 }); }
  const { data: own } = await db.from("wa_numbers").select("phone_number_id,waba_id,display_phone").eq("connection_id", conn.id);
  const only = own?.length === 1 ? own[0] : null;
  const env = normalizeEnvelope(body, only ? { wabaId: only.waba_id, phoneNumberId: only.phone_number_id, displayPhone: only.display_phone } : {});

  const kept: Envelope = { entry: [] };
  try {
    for (const entry of env.entry) {
      const changes = [];
      for (const change of entry.changes) {
        const pnid: string | undefined = change.value?.metadata?.phone_number_id;
        if (!pnid) continue;
        const { data: owner, error: ownerError } = await db.from("wa_numbers").select("workspace_id").eq("phone_number_id", pnid).maybeSingle();
        if (ownerError) throw new Error("could not resolve WhatsApp workspace");
        if (owner && owner.workspace_id !== conn.workspace_id) { console.error("bridge: number belongs to another workspace; dropped"); continue; }
        if (!owner) {
          const { error: insertError } = await db.from("wa_numbers").insert({
            phone_number_id: pnid, workspace_id: conn.workspace_id, connection_id: conn.id,
            waba_id: String(entry.id ?? conn.external_id), display_phone: change.value?.metadata?.display_phone_number ?? null, coexistence: true,
          });
          if (insertError && !/duplicate/i.test(insertError.message)) throw new Error("could not register WhatsApp number");
        }
        changes.push(change);
      }
      if (changes.length) kept.entry.push({ id: entry.id, changes });
    }
    const firstWaba = kept.entry.find((e) => e.id)?.id;
    const wabaPatch = firstWaba && !conn.meta?.waba_id ? { meta: { ...conn.meta, waba_id: String(firstWaba) } } : {};
    await db.from("connections").update({ last_sync_at: new Date().toISOString(), last_error: null, status: "active", ...wabaPatch }).eq("id", conn.id);
    const saved = await persistChanges(kept);
    // @ts-ignore EdgeRuntime is provided by Supabase
    EdgeRuntime.waitUntil(Promise.all(saved.ids.map((id) => processStored(saved.db, id).catch((e) => console.error("background processing", safeError(e))))));
    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error("bridge persistence failed", safeError(e));
    return new Response("temporary persistence failure", { status: 500 }); // the partner retries
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // ---- Dualhook Webhook Override: /wa-webhook/dh/<secret> ----
  const dh = url.pathname.match(/\/dh\/([0-9a-f]{64})\/?$/);
  if (dh) {
    if (req.method === "GET") return await dualhookVerify(url, dh[1]);
    if (req.method === "POST") return await bridgeDelivery(req, "dualhook", dh[1]);
    return new Response("method not allowed", { status: 405 });
  }

  if (req.method === "GET") {
    if (url.searchParams.get("hub.mode") === "subscribe" && VERIFY_TOKEN && url.searchParams.get("hub.verify_token") === VERIFY_TOKEN) {
      return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
    }
    return new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  // ---- Scheduled recovery (shared secret; never exposed to browsers) ----
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("x-cron-secret") === cronSecret) {
    const body = await req.json().catch(() => ({}));
    if (body.action !== "retry_failed") return new Response("forbidden", { status: 403 });
    try { return json(await retryBatch(admin(), null, 50)); }
    catch { return new Response("retry failed", { status: 500 }); }
  }

  // ---- Controlled replay by a workspace owner/admin (user JWT) ----
  if (req.headers.get("content-type")?.includes("application/json") && req.headers.get("authorization")?.startsWith("Bearer ") && !req.headers.get("x-hub-signature-256")) {
    const body = await req.json().catch(() => ({}));
    if (body.action !== "replay") return json({ error: "unknown action" }, 400);
    const ws = String(body.workspace_id ?? "");
    if (!ws) return json({ error: "workspace_id required" }, 400);
    const { data: ok } = await userClient(req).rpc("can_manage", { ws });
    if (!ok) return json({ error: "Only a workspace owner or admin can replay events." }, 403);
    const db = admin();
    const { data: requeued, error } = await db.rpc("svc_requeue_failed_events", { p_ws: ws, p_limit: 200 });
    if (error) return json({ error: "could not requeue events" }, 500);
    try { return json({ requeued: requeued ?? 0, ...(await retryBatch(db, ws, 50)) }); }
    catch { return json({ error: "replay failed part-way; remaining events stay queued for the scheduled retry" }, 500); }
  }

  // ---- 360dialog relay (per-workspace token) ----
  const bridgeToken = req.headers.get("x-growthos-token");
  if (bridgeToken && !req.headers.get("x-hub-signature-256")) return await bridgeDelivery(req, "360dialog", bridgeToken);

  // ---- Meta delivery ----
  const raw = await req.text();
  if (!(await validSignature(raw, req.headers.get("x-hub-signature-256")))) return new Response("bad signature", { status: 401 });
  let saved: { db: SupabaseClient; ids: number[] };
  try { saved = await persistChanges(JSON.parse(raw)); }
  catch (e) {
    console.error("webhook persistence failed", safeError(e));
    return new Response("temporary persistence failure", { status: 500 }); // Meta will retry; nothing was acknowledged
  }
  // @ts-ignore EdgeRuntime is provided by Supabase
  EdgeRuntime.waitUntil(Promise.all(saved.ids.map((id) => processStored(saved.db, id).catch((e) => console.error("background processing", safeError(e))))));
  return new Response("ok", { status: 200 });
});

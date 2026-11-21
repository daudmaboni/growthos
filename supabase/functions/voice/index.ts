// Voice notes → text, so Kito can "hear" them (Soniox speech-to-text, Swahili + English).
//
// Runs every 2 minutes (cron), or on demand by Pondi staff. Each run:
//   1. Saves voice notes that were never downloaded while WhatsApp still serves them (media ids work ~7 days).
//   2. Sends saved voice notes that have no text yet to Soniox (async API, audio passed as a short-lived
//      signed URL from our private bucket), waits for the text and writes it on the message:
//        messages.body  = "[voice note] <what was said>"   ← Kito, Ask Kito, the word rules and search read this
//        messages.media.transcript = { text, model, at, seconds }
//      then asks Kito to re-read those chats.
// Cost is logged in api_usage (feature voice_transcription) in Soniox tokens, so it counts toward each
// business's monthly AI limit like everything else. A business paused for its AI limit is skipped.
import { admin, userClient } from "../_shared/db.ts";
import { captureMedia, dualhookKey } from "../_shared/media.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const KEY = Deno.env.get("SONIOX_API_KEY") ?? "";
const MODEL = Deno.env.get("SONIOX_MODEL") ?? "stt-async-v5";
const API = "https://api.soniox.com/v1";
const BUDGET_MS = 110_000;      // stay well inside the Edge Function time limit
const PER_RUN = 12;             // voice notes sent to Soniox per run (in parallel)
const MAX_TRIES = 3;

type Row = { id: string; workspace_id: string; conversation_id: string; media: any; sent_at: string };

async function soniox(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/** One voice note: start the job, wait for it, read the text, delete the job at Soniox. */
async function transcribe(url: string, deadline: number): Promise<{ text: string; ms: number | null } | { error: string }> {
  const start = await soniox("/transcriptions", {
    method: "POST",
    body: JSON.stringify({ model: MODEL, audio_url: url, language_hints: ["sw", "en"] }),
  });
  if (!start.ok || !start.body?.id) return { error: `start ${start.status}: ${String(start.body?.message ?? start.body?.error_message ?? JSON.stringify(start.body)).slice(0, 160)}` };
  const id = start.body.id as string;
  try {
    let info: any = start.body;
    while (info.status !== "completed") {
      if (info.status === "error") return { error: `soniox: ${String(info.error_message ?? "failed").slice(0, 160)}` };
      if (Date.now() > deadline) return { error: "timeout" };
      await new Promise((r) => setTimeout(r, 1500));
      const s = await soniox(`/transcriptions/${id}`);
      if (!s.ok) return { error: `status ${s.status}` };
      info = s.body;
    }
    const t = await soniox(`/transcriptions/${id}/transcript`);
    if (!t.ok) return { error: `transcript ${t.status}` };
    return { text: String(t.body?.text ?? "").trim(), ms: Number(info.audio_duration_ms) || null };
  } finally {
    soniox(`/transcriptions/${id}`, { method: "DELETE" }).catch(() => {});
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const body = await req.json().catch(() => ({}));
  const cronSecret = Deno.env.get("CRON_SECRET");
  const isCron = !!cronSecret && req.headers.get("x-cron-secret") === cronSecret;
  if (!isCron) {
    const { data: staff } = await userClient(req).rpc("is_platform_admin");
    if (staff !== true) return json({ error: "Pondi staff only." }, 403);
  }
  const db = admin();
  const started = Date.now();
  const out = { audio_saved: 0, audio_failed: 0, transcribed: 0, empty: 0, failed: 0, skipped_paused: 0, last_error: null as string | null };

  // 1. Voice notes never downloaded, newest first, while WhatsApp still serves them.
  const since = new Date(Date.now() - 7 * 864e5 + 1800e3).toISOString();
  const { data: missing } = await db.from("messages").select("id,workspace_id,raw").eq("type", "audio").is("media", null)
    .gte("sent_at", since).order("sent_at", { ascending: false }).limit(60);
  const keys = new Map<string, string | null>();
  for (const m of (missing ?? []) as any[]) {
    if (Date.now() - started > 45_000) break;
    if (!keys.has(m.workspace_id)) keys.set(m.workspace_id, await dualhookKey(db, m.workspace_id));
    const r = await captureMedia(db, m.workspace_id, m.id, m.raw, keys.get(m.workspace_id));
    if (r === "saved") out.audio_saved++;
    else if (r === "failed") out.audio_failed++;
    else await db.from("messages").update({ media: { error: "no media id" } }).eq("id", m.id);   // don't retry forever
  }

  // 2. Saved voice notes with no text yet.
  if (!KEY) return json({ ...out, note: "SONIOX_API_KEY is not set: voice notes are saved but not turned into text yet." });
  const { data: todo } = await db.from("messages").select("id,workspace_id,conversation_id,media,sent_at").eq("type", "audio")
    .not("media->>path", "is", null).is("media->transcript", null).order("sent_at", { ascending: false }).limit(80);
  const paused = new Map<string, boolean>();
  const batch: Row[] = [];
  for (const r of (todo ?? []) as Row[]) {
    if ((Number(r.media?.transcript_tries) || 0) >= MAX_TRIES) continue;
    if (r.media?.transcript_started && Date.now() - Date.parse(r.media.transcript_started) < 5 * 60e3) continue;   // another run has it
    if (!paused.has(r.workspace_id)) { const { data: p } = await db.rpc("svc_ai_paused", { p_ws: r.workspace_id }); paused.set(r.workspace_id, p === true); }
    if (paused.get(r.workspace_id)) { out.skipped_paused++; continue; }
    batch.push(r);
    if (batch.length >= PER_RUN) break;
  }
  // Claim them, so an overlapping run doesn't send the same voice note twice.
  for (const r of batch) { r.media = { ...r.media, transcript_started: new Date().toISOString() }; await db.from("messages").update({ media: r.media }).eq("id", r.id); }
  const deadline = started + BUDGET_MS;
  const reread = new Set<string>();
  await Promise.all(batch.map(async (r) => {
    const t0 = Date.now();
    const { data: signed } = await db.storage.from("wa-media").createSignedUrl(r.media.path, 900);
    const res = signed?.signedUrl ? await transcribe(signed.signedUrl, deadline) : { error: "could not sign the file" };
    if ("error" in res) {
      out.failed++; out.last_error = res.error;
      await db.from("messages").update({ media: { ...r.media, transcript_tries: (Number(r.media?.transcript_tries) || 0) + 1, transcript_error: res.error } }).eq("id", r.id);
      await logUsage(db, r.workspace_id, 0, 0, false, res.error, Date.now() - t0);
      return;
    }
    const seconds = res.ms ? Math.round(res.ms / 1000) : Math.round((Number(r.media?.bytes) || 0) / 2500);   // WhatsApp voice ≈ 2.5 KB/s
    const transcript = { text: res.text, model: MODEL, at: new Date().toISOString(), seconds };
    const update: Record<string, unknown> = { media: { ...r.media, transcript, transcript_error: null } };
    if (res.text) { update.body = `[voice note] ${res.text}`; reread.add(r.conversation_id); out.transcribed++; } else out.empty++;
    await db.from("messages").update(update).eq("id", r.id);
    // Soniox bills tokens: ~30,000 audio tokens per hour in, ~0.3 tokens per character out.
    await logUsage(db, r.workspace_id, Math.round(seconds * 30000 / 3600), Math.round(res.text.length * 0.3), true, null, Date.now() - t0);
  }));

  // 3. Kito re-reads the chats that gained text (now for up to 20, the 15-minute run picks up the rest).
  if (reread.size) {
    const ids = [...reread];
    await db.from("conversations").update({ kito_checked_at: null }).in("id", ids);
    if (cronSecret) {
      const p = fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/kito`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}`, "x-cron-secret": cronSecret },
        body: JSON.stringify({ conversation_ids: ids.slice(0, 20) }),
      }).catch(() => {});
      // Let Kito's read finish after this response is sent.
      (globalThis as any).EdgeRuntime?.waitUntil?.(p);
    }
  }
  return json(out);
});

async function logUsage(db: ReturnType<typeof admin>, ws: string, inTok: number, outTok: number, ok: boolean, error: string | null, ms: number) {
  const { error: e } = await db.from("api_usage").insert({
    workspace_id: ws, feature: "voice_transcription", model: `soniox-${MODEL}`, input_tokens: inTok, output_tokens: outTok,
    cache_read_tokens: 0, cache_write_tokens: 0, ok, status: ok ? 200 : null, error, attempt: 1, duration_ms: Math.round(ms), request_id: null,
  });
  if (e) console.error("api_usage log failed", e.message);
}

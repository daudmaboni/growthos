// Keeps each workspace's exchange rate (ad account currency -> workspace currency) up to date.
// Called by: pg_cron hourly (x-cron-secret, all workspaces with fx_auto, skips rates fetched in the last 6 h)
//            or the app (user JWT, one workspace, always refetches).
// Self-contained on purpose: no _shared imports, so it deploys as one file.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const FRESH_MS = 6 * 3600e3;

/** Units of `quote` per 1 `base`, from two free public sources (first that answers wins). */
async function fetchRate(base: string, quote: string): Promise<{ rate: number; source: string } | null> {
  try {
    const r = await fetch(`https://open.er-api.com/v6/latest/${base}`);
    const j = await r.json();
    const v = Number(j?.rates?.[quote]);
    if (r.ok && j?.result === "success" && v > 0) return { rate: v, source: "open.er-api.com" };
  } catch { /* try the next source */ }
  try {
    const b = base.toLowerCase(), q = quote.toLowerCase();
    const r = await fetch(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${b}.json`);
    const j = await r.json();
    const v = Number(j?.[b]?.[q]);
    if (r.ok && v > 0) return { rate: v, source: "currency-api" };
  } catch { /* none answered */ }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = Deno.env.get("SUPABASE_URL")!;
  const db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const body = await req.json().catch(() => ({}));
  const cronSecret = Deno.env.get("CRON_SECRET");
  const isCron = !!cronSecret && req.headers.get("x-cron-secret") === cronSecret;

  let q = db.from("workspaces").select("id,currency,fx_auto,fx_rate,fx_updated_at").eq("fx_auto", true);
  if (!isCron) {
    if (!body.workspace_id) return json({ error: "workspace_id required" }, 400);
    const user = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: ok } = await user.rpc("is_member", { ws: body.workspace_id });
    if (!ok) return json({ error: "not a member of this workspace" }, 403);
    q = q.eq("id", body.workspace_id);
  }
  const { data: wss, error } = await q;
  if (error) return json({ error: "could not load workspaces" }, 500);

  const cache = new Map<string, { rate: number; source: string } | null>();
  const out: any[] = [];
  for (const w of wss ?? []) {
    if (isCron && w.fx_rate && w.fx_updated_at && Date.now() - new Date(w.fx_updated_at).getTime() < FRESH_MS) continue;
    // The ad account's billing currency, from the newest synced ad day.
    const { data: last } = await db.from("ad_insights_daily").select("currency").eq("workspace_id", w.id).order("day", { ascending: false }).limit(1).maybeSingle();
    const base = String(last?.currency ?? "").toUpperCase();
    const quote = String(w.currency ?? "").toUpperCase();
    if (!base || base === quote) { out.push({ workspace_id: w.id, skipped: base ? "same currency" : "no ad data" }); continue; }
    const key = `${base}>${quote}`;
    if (!cache.has(key)) cache.set(key, await fetchRate(base, quote));
    const got = cache.get(key);
    if (!got) { out.push({ workspace_id: w.id, error: `no rate for ${key}` }); continue; }
    const rate = Math.round(got.rate * 100) / 100;
    const { error: upErr } = await db.from("workspaces")
      .update({ fx_rate: rate, fx_updated_at: new Date().toISOString(), fx_source: got.source, fx_base: base })
      .eq("id", w.id).eq("fx_auto", true); // an owner who just switched to manual wins
    out.push(upErr ? { workspace_id: w.id, error: upErr.message } : { workspace_id: w.id, base, quote, rate, source: got.source });
  }
  return json({ updated: out });
});

// Pulls ad-level daily insights from the Meta Marketing API into ad_insights_daily.
// Called by: pg_cron (service role, all connections) or the app (user JWT, one workspace).
import { admin, userClient, graph, readToken, json, cors } from "../_shared/db.ts";

const MSG_ACTIONS = new Set([
  "onsite_conversion.messaging_conversation_started_7d",
]);

function ymd(d: Date) { return d.toISOString().slice(0, 10); }

// Ads Manager totals include ads that were later paused, archived or deleted. The insights API
// leaves deleted/archived ads out unless asked, so ask for every status.
const ALL_STATUSES = ["ACTIVE", "PAUSED", "DELETED", "ARCHIVED", "CAMPAIGN_PAUSED", "ADSET_PAUSED",
  "PENDING_REVIEW", "DISAPPROVED", "PREAPPROVED", "PENDING_BILLING_INFO", "IN_PROCESS", "WITH_ISSUES"];
const MAX_DAYS = 400;   // Meta keeps 37 months; 400 covers "Last 90 days" plus its comparison period with room
const CHUNK_DAYS = 30;  // one Meta request per 30 days keeps large accounts under Meta's response limits

async function syncWindow(db: ReturnType<typeof admin>, conn: any, token: string, since: string, until: string, withFilter: boolean) {
  const params = new URLSearchParams({
    level: "ad", time_increment: "1", limit: "500",
    fields: "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,reach,clicks,actions,account_currency",
    time_range: JSON.stringify({ since, until }),
  });
  if (withFilter) params.set("filtering", JSON.stringify([{ field: "ad.effective_status", operator: "IN", value: ALL_STATUSES }]));
  let next: string | null = `${conn.external_id}/insights?${params}`;
  let rows = 0;
  while (next) {
    const page: any = await graph(next, token);
    const ads = new Map<string, any>();
    const ins: any[] = [];
    for (const r of page.data ?? []) {
      ads.set(r.ad_id, {
        workspace_id: conn.workspace_id, ad_id: r.ad_id, ad_account_id: conn.external_id, name: r.ad_name,
        adset_id: r.adset_id, adset_name: r.adset_name, campaign_id: r.campaign_id, campaign_name: r.campaign_name,
        updated_at: new Date().toISOString(),
      });
      const conv = (r.actions ?? []).filter((a: any) => MSG_ACTIONS.has(a.action_type)).reduce((s: number, a: any) => s + Number(a.value || 0), 0);
      ins.push({
        workspace_id: conn.workspace_id, ad_id: r.ad_id, day: r.date_start, spend: Number(r.spend || 0),
        currency: r.account_currency ?? "TZS", impressions: Number(r.impressions || 0), reach: Number(r.reach || 0),
        clicks: Number(r.clicks || 0), messaging_conversations: conv, raw: r, synced_at: new Date().toISOString(),
      });
    }
    if (ads.size) await db.from("ads").upsert([...ads.values()], { onConflict: "ad_id" });
    if (ins.length) {
      const { error } = await db.from("ad_insights_daily").upsert(ins, { onConflict: "ad_id,day" });
      if (error) throw new Error(error.message);
    }
    rows += ins.length;
    next = page.paging?.next ?? null;
  }
  return rows;
}

async function syncConnection(db: ReturnType<typeof admin>, conn: any, days: number) {
  const token = await readToken(db, conn.token_secret_id);
  // A day either side of "today" so every workspace time zone's local days are covered.
  const end = Date.now() + 864e5;
  const start = Date.now() - days * 864e5;
  let rows = 0;
  let withFilter = true;
  // Newest window first, so recent numbers land even if an old window fails.
  for (let hi = end; hi > start; hi -= CHUNK_DAYS * 864e5) {
    const lo = Math.max(start, hi - (CHUNK_DAYS - 1) * 864e5);
    const since = ymd(new Date(lo)), until = ymd(new Date(hi));
    try { rows += await syncWindow(db, conn, token, since, until, withFilter); }
    catch (e) {
      // If Meta ever rejects the status filter, carry on without it rather than syncing nothing.
      if (!withFilter || !/filtering|effective_status|code 100\b/i.test((e as Error).message)) throw e;
      withFilter = false;
      rows += await syncWindow(db, conn, token, since, until, false);
    }
  }
  await db.from("connections").update({ last_sync_at: new Date().toISOString(), status: "active", last_error: null }).eq("id", conn.id);
  return rows;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const db = admin();
  const body = await req.json().catch(() => ({}));
  const days = Math.min(Math.max(Math.round(Number(body.days ?? 30)) || 30, 1), MAX_DAYS);
  const auth = req.headers.get("Authorization") ?? "";
  const cronSecret = Deno.env.get("CRON_SECRET");
  const isCron = !!cronSecret && req.headers.get("x-cron-secret") === cronSecret;
  const isServiceRole = auth === `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`;

  let q = db.from("connections").select("*").eq("provider", "meta_ads").eq("status", "active");
  if (isCron) {
    if (body.action !== "sync_all") return json({ error: "scheduled sync action required" }, 403);
  } else if (isServiceRole) {
    // Internal first sync must name one authorized workspace and connection.
    if (!body.workspace_id || !body.connection_id) return json({ error: "workspace_id and connection_id required" }, 400);
    q = q.eq("workspace_id", body.workspace_id).eq("id", body.connection_id);
  } else {
    if (!body.workspace_id) return json({ error: "workspace_id required" }, 400);
    const { data: ok } = await userClient(req).rpc("is_member", { ws: body.workspace_id });
    if (!ok) return json({ error: "not a member of this workspace" }, 403);
    q = q.eq("workspace_id", body.workspace_id).in("status", ["active", "error"]);
  }
  const { data: conns, error: queryError } = await q;
  if (queryError) return json({ error: "could not load ad connections" }, 500);
  const results: any[] = [];
  for (const c of conns ?? []) {
    try { results.push({ account: c.external_id, rows: await syncConnection(db, c, days) }); }
    catch (e) {
      const msg = (e as Error).message;
      await db.from("connections").update({ status: /code 190/.test(msg) ? "error" : c.status, last_error: msg.slice(0, 300) }).eq("id", c.id);
      results.push({ account: c.external_id, error: msg });
    }
  }
  if (isCron && cronSecret) {
    // Reclaim webhook events that were durably saved but failed during background processing.
    const retry = fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/wa-webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cron-secret": cronSecret },
      body: JSON.stringify({ action: "retry_failed" }),
    }).catch(() => {});
    // @ts-ignore EdgeRuntime is provided by Supabase; keeps the request alive after we respond
    EdgeRuntime.waitUntil(retry);
  }
  return json({ synced: results });
});

// Loads everything the dashboard and the weekly report need for a period plus its comparison
// period, then runs the central metrics. One place, so both views agree.
import { useEffect, useRef, useState } from "react";
import { supabase, Workspace, Outcome, AdPerf, Order, localDay } from "./lib";
import { computeFunnel, comparisonOf, FunnelMetrics, DailyInsight, Expense } from "./metrics";
import { RangeSel, resolveRange } from "./ranges";

export type Conn = { id: string; provider: string; external_id: string; label: string | null; status: string; last_sync_at: string | null; last_error: string | null };
export type Num = { phone_number_id: string; display_phone: string | null; history_status: string | null; history_requested_at: string | null };
export type Health = { status: string; events: number; oldest: string | null; newest: string | null; exhausted: number };

export type GrowthData = {
  loading: boolean; err: string;
  mx: FunnelMetrics | null; prev: FunnelMetrics | null;
  convs: Outcome[]; ads: AdPerf[]; adsPrev: AdPerf[]; orders: Order[]; daily: DailyInsight[]; expenses: Expense[];
  conns: Conn[]; nums: Num[]; health: Health[]; importBatches: { kind: string; created_at: string; created_count: number }[];
  today: string;
};

// Only the columns the metrics, diagnosis and dashboard read. Leaves out Kito's long text
// (summary, next step, evidence, error) and override notes, which made each page several times heavier.
const OUTCOME_COLS = [
  "id", "contact_id", "contact_name", "started_at", "last_message_at", "source", "source_label", "ad_id", "ad_signal",
  "first_response_sec", "price_asked", "price_shared", "replied_after_price", "payment_signal", "payment_amount", "objections",
  "followed_up", "warm", "stage", "auto_outcome", "outcome_override", "label", "kito_outcome", "kito_label", "kito_amount",
  "kito_objections", "kito_tags", "kito_temp", "kito_blocker", "last_dir", "kito_confidence", "kito_checked_at", "outcome",
  "sale_amount", "sale_provenance", "override_by", "override_at", "paid_orders", "first_paid_at", "last_paid_at", "last_out_at",
  "pay_instructions",
].join(",");

// One request: the database scans once and returns columns as arrays (migration 0026).
// Falls back to paging the view if the function is missing.
export async function loadConversations(ws: string, fromIso: string): Promise<Outcome[]> {
  const { data, error } = await supabase.rpc("dashboard_conversations", { p_ws: ws, p_from: fromIso });
  if (!error && data && Array.isArray((data as any).id)) {
    const cols = data as Record<string, unknown[]>;
    const keys = Object.keys(cols);
    const n = cols.id.length;
    const rows = new Array(n);
    for (let i = 0; i < n; i++) {
      const r: Record<string, unknown> = {};
      for (const k of keys) r[k] = cols[k][i];
      rows[i] = r;
    }
    return rows as Outcome[];
  }
  return loadConversationsPaged(ws, fromIso);
}

// Old path: pages fetched 4 at a time.
async function loadConversationsPaged(ws: string, fromIso: string) {
  const PAGE = 1000, WAVE = 4;
  const rows: Outcome[] = [];
  const page = (start: number) => supabase.from("conversation_outcomes").select(OUTCOME_COLS)
    .eq("workspace_id", ws).gte("started_at", fromIso)
    .order("started_at", { ascending: true }).order("id", { ascending: true }).range(start, start + PAGE - 1);
  for (let start = 0; ; start += PAGE * WAVE) {
    const res = await Promise.all(Array.from({ length: WAVE }, (_, i) => page(start + i * PAGE)));
    let done = false;
    for (const r of res) {
      if (r.error) throw r.error;
      const data = ((r.data as unknown) as Outcome[]) ?? [];
      rows.push(...data);
      if (data.length < PAGE) { done = true; break; }
    }
    if (done) break;
  }
  return rows;
}

export function useGrowthData(ws: Workspace, range: RangeSel): GrowthData {
  const [state, setState] = useState<GrowthData>({ loading: true, err: "", mx: null, prev: null, convs: [], ads: [], adsPrev: [], orders: [], daily: [], expenses: [], conns: [], nums: [], health: [], importBatches: [], today: localDay(new Date(), ws.timezone) });
  // Background refresh: re-read every 2 min and whenever the tab comes back into view.
  // Refreshes are silent (no skeletons); only a new workspace or period shows the loading state.
  const [tick, setTick] = useState(0);
  const loadedKey = useRef("");
  useEffect(() => {
    const bump = () => { if (document.visibilityState === "visible") setTick((t) => t + 1); };
    const id = window.setInterval(bump, 120_000);
    document.addEventListener("visibilitychange", bump);
    window.addEventListener("focus", bump);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", bump); window.removeEventListener("focus", bump); };
  }, []);
  // Live: a new chat message, a Kito label or a recorded sale refreshes the numbers right away.
  useEffect(() => {
    let t: number | undefined;
    // Throttled, not debounced: at most one refresh per 5 s, however many chats change.
    // A tab in the background doesn't reload; it catches up when it comes back into view.
    const soon = () => { if (t !== undefined || document.visibilityState !== "visible") return; t = window.setTimeout(() => { t = undefined; setTick((x) => x + 1); }, 5000); };
    const ch = supabase.channel("growth-" + ws.id)
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations", filter: `workspace_id=eq.${ws.id}` }, soon)
      .on("postgres_changes", { event: "*", schema: "public", table: "orders", filter: `workspace_id=eq.${ws.id}` }, soon)
      .subscribe();
    return () => { window.clearTimeout(t); supabase.removeChannel(ch); };
  }, [ws.id]);
  // A refresh that arrives while a load is running no longer cancels it (that kept the cards on
  // skeletons while chats were changing every few seconds). It waits and runs once afterwards.
  const reqKey = useRef("");
  const busy = useRef(false);
  const again = useRef(false);
  useEffect(() => () => { reqKey.current = ""; }, []);
  useEffect(() => {
    const rk = JSON.stringify(range);
    const key = ws.id + "|" + rk + "|" + ws.timezone;
    const keyChanged = reqKey.current !== key;
    reqKey.current = key;
    if (!keyChanged && busy.current) { again.current = true; return; }
    const live = () => reqKey.current === key;
    const silent = loadedKey.current === key;
    busy.current = true;
    again.current = false;
    const tz = ws.timezone || "Africa/Dar_es_Salaam";
    const today = localDay(new Date(), tz);
    const period = resolveRange(range, today);
    const prevP = comparisonOf(period);
    const fromIso = new Date(new Date(prevP.from + "T00:00:00Z").getTime() - 2 * 864e5).toISOString(); // generous: filtered precisely by local day later
    if (!silent) setState((s) => ({ ...s, loading: true, err: "" }));
    (async () => {
      try {
        const [a, ap, c, d, o, e, cn, nm, h, ib] = await Promise.all([
          supabase.rpc("ad_performance", { p_ws: ws.id, p_from: period.from, p_to: period.to }),
          supabase.rpc("ad_performance", { p_ws: ws.id, p_from: prevP.from, p_to: prevP.to }),
          loadConversations(ws.id, fromIso),
          supabase.from("ad_insights_daily").select("day,spend,currency,impressions,clicks,messaging_conversations").eq("workspace_id", ws.id).gte("day", prevP.from).lte("day", period.to).limit(20000),
          supabase.from("orders").select("*, conv:conversations!orders_conversation_workspace_fk(source)").eq("workspace_id", ws.id).gte("occurred_at", fromIso).order("occurred_at", { ascending: false }).limit(5000),
          supabase.from("expenses").select("day,amount,currency,category").eq("workspace_id", ws.id).gte("day", prevP.from).lte("day", period.to).limit(5000),
          supabase.from("connections").select("id,provider,external_id,label,status,last_sync_at,last_error").eq("workspace_id", ws.id),
          supabase.from("wa_numbers").select("phone_number_id,display_phone,history_status,history_requested_at").eq("workspace_id", ws.id),
          supabase.rpc("webhook_health", { p_ws: ws.id }),
          supabase.from("import_batches").select("kind,created_at,created_count").eq("workspace_id", ws.id).order("created_at", { ascending: false }).limit(5),
        ]);
        if (!live()) return;
        // If the chat-source join is ever refused, fall back to plain orders so revenue still shows.
        let o2: any = o;
        if (o.error) o2 = await supabase.from("orders").select("*").eq("workspace_id", ws.id).gte("occurred_at", fromIso).order("occurred_at", { ascending: false }).limit(5000);
        if (!live()) return;
        loadedKey.current = key;
        const firstErr = [a, ap, d, o2, e, cn, nm, h, ib].find((r) => r.error)?.error;
        const daily = ((d.data as any[]) ?? []).map((r) => ({ day: r.day, spend: Number(r.spend), currency: r.currency, impressions: Number(r.impressions ?? 0), clicks: Number(r.clicks ?? 0), messaging_conversations: Number(r.messaging_conversations ?? 0) }));
        const orders = (((o2.data as any[]) ?? []).map(({ conv, ...r }) => ({ ...r, conv_source: conv?.source ?? null }))) as Order[];
        const expenses = ((e.data as any[]) ?? []).map((x) => ({ day: x.day, amount: Number(x.amount), currency: x.currency, category: x.category }));
        const base = { ws, conversations: c, daily, orders, expenses };
        const mx = computeFunnel({ ...base, period, ads: (a.data as AdPerf[]) ?? [] });
        const prev = computeFunnel({ ...base, period: prevP, ads: (ap.data as AdPerf[]) ?? [] });
        setState({
          loading: false, err: firstErr ? "Some data could not be loaded: " + firstErr.message : "",
          mx, prev, convs: c, ads: (a.data as AdPerf[]) ?? [], adsPrev: (ap.data as AdPerf[]) ?? [], orders, daily, expenses,
          conns: (cn.data as Conn[]) ?? [], nums: (nm.data as Num[]) ?? [], health: (h.data as Health[]) ?? [], importBatches: (ib.data as any[]) ?? [], today,
        });
      } catch (err) {
        if (live() && !silent) setState((s) => ({ ...s, loading: false, err: (err as Error).message }));
      } finally {
        if (live()) {
          busy.current = false;
          if (again.current) { again.current = false; setTick((x) => x + 1); }
        }
      }
    })();
  }, [ws.id, ws.timezone, ws.fx_rate, ws.unit_cost, ws.conversion_window_days, ws.follow_up_hours, JSON.stringify(range), tick]);
  return state;
}

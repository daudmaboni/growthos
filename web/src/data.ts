// Loads everything the dashboard and the weekly report need for a period plus its comparison
// period, then runs the central metrics. One place, so both views agree.
import { useEffect, useState } from "react";
import { supabase, Workspace, Outcome, AdPerf, Order, localDay } from "./lib";
import { computeFunnel, comparisonOf, periodEnding, FunnelMetrics, DailyInsight, Expense } from "./metrics";

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

export async function loadConversations(ws: string, fromIso: string) {
  const rows: Outcome[] = [];
  for (let start = 0; ; start += 1000) {
    const page = await supabase.from("conversation_outcomes").select("*")
      .eq("workspace_id", ws).gte("started_at", fromIso)
      .order("started_at", { ascending: true }).order("id", { ascending: true }).range(start, start + 999);
    if (page.error) throw page.error;
    rows.push(...((page.data as Outcome[]) ?? []));
    if (!page.data || page.data.length < 1000) break;
  }
  return rows;
}

export function useGrowthData(ws: Workspace, days: number): GrowthData {
  const [state, setState] = useState<GrowthData>({ loading: true, err: "", mx: null, prev: null, convs: [], ads: [], adsPrev: [], orders: [], daily: [], expenses: [], conns: [], nums: [], health: [], importBatches: [], today: localDay(new Date(), ws.timezone) });
  useEffect(() => {
    let live = true;
    const tz = ws.timezone || "Africa/Dar_es_Salaam";
    const today = localDay(new Date(), tz);
    const period = periodEnding(today, days, "current");
    const prevP = comparisonOf(period);
    const fromIso = new Date(new Date(prevP.from + "T00:00:00Z").getTime() - 2 * 864e5).toISOString(); // generous: filtered precisely by local day later
    setState((s) => ({ ...s, loading: true, err: "" }));
    (async () => {
      try {
        const [a, ap, c, d, o, e, cn, nm, h, ib] = await Promise.all([
          supabase.rpc("ad_performance", { p_ws: ws.id, p_from: period.from, p_to: period.to }),
          supabase.rpc("ad_performance", { p_ws: ws.id, p_from: prevP.from, p_to: prevP.to }),
          loadConversations(ws.id, fromIso),
          supabase.from("ad_insights_daily").select("day,spend,currency,impressions,clicks,messaging_conversations").eq("workspace_id", ws.id).gte("day", prevP.from).lte("day", period.to).limit(20000),
          supabase.from("orders").select("*").eq("workspace_id", ws.id).gte("occurred_at", fromIso).order("occurred_at", { ascending: false }).limit(5000),
          supabase.from("expenses").select("day,amount,currency,category").eq("workspace_id", ws.id).gte("day", prevP.from).lte("day", period.to).limit(5000),
          supabase.from("connections").select("id,provider,external_id,label,status,last_sync_at,last_error").eq("workspace_id", ws.id),
          supabase.from("wa_numbers").select("phone_number_id,display_phone,history_status,history_requested_at").eq("workspace_id", ws.id),
          supabase.rpc("webhook_health", { p_ws: ws.id }),
          supabase.from("import_batches").select("kind,created_at,created_count").eq("workspace_id", ws.id).order("created_at", { ascending: false }).limit(5),
        ]);
        if (!live) return;
        const firstErr = [a, ap, d, o, e, cn, nm, h, ib].find((r) => r.error)?.error;
        const daily = ((d.data as any[]) ?? []).map((r) => ({ day: r.day, spend: Number(r.spend), currency: r.currency, impressions: Number(r.impressions ?? 0), clicks: Number(r.clicks ?? 0), messaging_conversations: Number(r.messaging_conversations ?? 0) }));
        const orders = (o.data as Order[]) ?? [];
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
        if (live) setState((s) => ({ ...s, loading: false, err: (err as Error).message }));
      }
    })();
    return () => { live = false; };
  }, [ws.id, ws.timezone, ws.fx_rate, ws.unit_cost, ws.conversion_window_days, ws.follow_up_hours, days]);
  return state;
}

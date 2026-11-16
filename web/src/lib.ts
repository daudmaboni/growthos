import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);

export async function callFn<T = any>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let msg = error.message;
    try { const j = await (error as any).context?.json?.(); if (j?.error) msg = j.error; } catch { /* keep generic */ }
    throw new Error(msg);
  }
  if ((data as any)?.error) throw new Error((data as any).error);
  return data as T;
}

export type Workspace = { id: string; name: string; currency: string; language: "sw" | "en"; unit_cost: number | null; fx_rate: number | null };

export type Outcome = {
  id: string; contact_name: string | null; contact_id: string; started_at: string | null; last_message_at: string | null;
  source: string; source_label: string | null; ad_id: string | null; first_response_sec: number | null; price_asked: boolean; price_shared: boolean;
  replied_after_price: boolean; payment_signal: boolean; payment_amount: number | null; objections: string[];
  followed_up: boolean; warm: boolean; stage: string | null; auto_outcome: string | null; outcome_override: string | null;
  label: string | null; kito_outcome: string | null; kito_label: string | null; kito_amount: number | null; kito_objections: string[] | null; kito_tags: string[] | null; kito_temp: "hot" | "warm" | "cold" | null; kito_blocker: string | null; last_dir: "in" | "out" | null; kito_summary: string | null; kito_next: string | null; kito_confidence: string | null; kito_checked_at: string | null; kito_error: string | null; outcome: string | null; sale_amount: number | null; sale_provenance: string | null;
};

export type AdPerf = {
  ad_id: string; ad_name: string | null; campaign_name: string | null; spend: number; platform_conversations: number;
  chats: number; priced: number; sold: number; revenue: number; cost_per_sale: number | null;
};

export const fmt = (n: number | null | undefined) => (n == null || !isFinite(n) ? "–" : Math.round(n).toLocaleString("en-US"));
export const tzs = (n: number | null | undefined) => (n == null || !isFinite(n) ? "–" : "TZS " + fmt(n));
export const pct = (n: number | null | undefined) => (n == null || !isFinite(n) ? "–" : Math.round(n * 100) + "%");
export const dur = (sec: number | null | undefined) =>
  sec == null ? "–" : sec < 3600 ? Math.max(1, Math.round(sec / 60)) + " min" : (sec / 3600).toFixed(1) + " h";
export const median = (a: number[]) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const daysAgo = (n: number) => {
  const d = new Date(Date.now() - n * 864e5);
  return d.toISOString().slice(0, 10);
};

// Bilingual labels for stored codes
export const L = {
  en: {
    stage: { no_reply: "No reply", before_price: "Left before price", silent_after_price: "Silent after price", after_price_talk: "Stopped after price talk", paid: "Paid" } as Record<string, string>,
    obj: { price: "Price too high", think: "\"I'll think about it\"", money: "No money now", trust: "Trust / safety", delivery: "Location / delivery" } as Record<string, string>,
    outcome: { sold: "Sold", lost: "Lost", open: "Open" } as Record<string, string>,
    tag: { buyer: "Buyer", repeat_buyer: "Repeat buyer", price_sensitive: "Price-sensitive", needs_trust: "Needs trust", far_location: "Far location", pays_on_delivery: "Pays on delivery", slow_decider: "Slow decider", not_serious: "Not serious" } as Record<string, string>,
    temp: { hot: "Hot", warm: "Warm", cold: "Cold" } as Record<string, string>,
    blocker: { price: "Price", think: "Still deciding", money: "No money now", trust: "Needs proof / trust", delivery: "Distance / delivery", business_slow: "We replied late" } as Record<string, string>,
    label: { new: "New", talking: "Talking", priced: "Price given", awaiting_payment: "Awaiting payment", paid: "Paid", shipped: "Shipped", received: "Received", using: "Using product" } as Record<string, string>,
  },
  sw: {
    stage: { no_reply: "Hakujibiwa", before_price: "Aliondoka kabla ya bei", silent_after_price: "Kimya baada ya bei", after_price_talk: "Aliacha baada ya bei", paid: "Amelipa" } as Record<string, string>,
    obj: { price: "Bei ni kubwa", think: "\"Nitafikiria\"", money: "Hana pesa sasa", trust: "Wasiwasi / usalama", delivery: "Mahali / usafirishaji" } as Record<string, string>,
    outcome: { sold: "Ameuziwa", lost: "Amepotea", open: "Bado wazi" } as Record<string, string>,
    tag: { buyer: "Mnunuzi", repeat_buyer: "Mnunuzi wa kurudia", price_sensitive: "Anajali bei", needs_trust: "Anahitaji uhakika", far_location: "Yuko mbali", pays_on_delivery: "Analipa akipokea", slow_decider: "Anachelewa kuamua", not_serious: "Hayuko makini" } as Record<string, string>,
    temp: { hot: "Moto", warm: "Vuguvugu", cold: "Baridi" } as Record<string, string>,
    blocker: { price: "Bei", think: "Bado anafikiria", money: "Hana pesa sasa", trust: "Anahitaji uhakika", delivery: "Umbali / usafirishaji", business_slow: "Tulichelewa kujibu" } as Record<string, string>,
    label: { new: "Mpya", talking: "Mazungumzo", priced: "Amepewa bei", awaiting_payment: "Anasubiri malipo", paid: "Amelipa", shipped: "Ametumiwa mzigo", received: "Amepokea", using: "Anatumia dawa" } as Record<string, string>,
  },
};

/** Bare number in a currency's usual precision: whole shillings, cents for dollars. */
export const amt = (n: number | null | undefined, cur: string) =>
  n == null || !isFinite(n) ? "–" : cur === "TZS" || cur === "KES" || cur === "UGX"
    ? Math.round(n).toLocaleString("en-US")
    : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Number with its currency code, e.g. "USD 456.20" or "TZS 170,000". */
export const money = (n: number | null | undefined, cur: string) => (n == null || !isFinite(n) ? "–" : cur + " " + amt(n, cur));

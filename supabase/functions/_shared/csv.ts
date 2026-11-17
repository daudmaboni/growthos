// Pure validation for CSV imports (orders, expenses, inquiries). Shared by the csv-import
// Edge Function and the web tests; no Deno or Supabase imports here.

export type Kind = "orders" | "expenses" | "inquiries";
export const ORDER_STATUSES = ["paid", "pending", "refunded", "cancelled"] as const;
export const FULFILLMENT = ["not_applicable", "not_shipped", "shipped", "delivered", "returned"] as const;
export const EXPENSE_CATEGORIES = ["product", "delivery", "packaging", "staff", "ads_other", "other"] as const;

/** Canonical fields the client maps CSV columns onto. `phone` is used for matching only and never stored. */
export type OrderRow = { ref?: string; date?: string; amount?: string | number; currency?: string; status?: string; fulfillment?: string;
  product?: string; customer_name?: string; phone?: string; conversation_id?: string; discount?: string | number; notes?: string };
export type ExpenseRow = { ref?: string; date?: string; category?: string; amount?: string | number; currency?: string; note?: string };
export type InquiryRow = { ref?: string; date?: string; customer_name?: string; phone?: string; source?: string; source_label?: string; note?: string };

export type Validated<T> = { index: number; ok: true; row: T; dedupe_key: string } | { index: number; ok: false; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseAmount(v: unknown): number | null {
  if (v == null) return null;
  const s = String(v).trim().replace(/[,\s]/g, "").replace(/^(tzs|tsh|kes|ugx|usd|sh\.?)/i, "").replace(/(\/=|tzs|tsh)$/i, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Accepts ISO dates, 16/11/2026, 16-11-2026, 16.11.2026, 2026/11/16 and "16/11/2026 14:30". Day-first for ambiguous forms. */
export function parseDate(v: unknown): Date | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return build(+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0));
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})(?:[,\s]+(\d{1,2}):(\d{2}))?/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; return build(y, +m[2], +m[1], +(m[4] ?? 0), +(m[5] ?? 0)); }
  m = s.match(/^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})/);
  if (m) return build(+m[1], +m[2], +m[3], 0, 0);
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
}
function build(y: number, mo: number, d: number, h: number, mi: number): Date | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  if (h > 23 || mi > 59) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi));
  if (dt.getUTCDate() !== d || dt.getUTCMonth() !== mo - 1) return null; // e.g. 31/02
  // Business-local dates: treat as East Africa Time (UTC+3) so a day is not shifted when stored.
  dt.setUTCHours(dt.getUTCHours() - 3);
  return dt;
}

/** Digits only; Tanzanian local numbers get the country code so they match WhatsApp ids. */
export function normalizePhone(v: unknown): string | null {
  if (v == null) return null;
  let d = String(v).replace(/\D/g, "");
  if (!d) return null;
  if (d.length === 9 && /^[67]/.test(d)) d = "255" + d;
  else if (d.length === 10 && d.startsWith("0")) d = "255" + d.slice(1);
  return d.length >= 9 && d.length <= 15 ? d : null;
}

function clean(v: unknown, max = 200): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim().slice(0, max);
  return s || undefined;
}

export function validateOrder(r: OrderRow, i: number, currency: string): Validated<Required<Pick<OrderRow, "amount" | "date">> & OrderRow & { amount: number; discount: number; date: string }> {
  const amount = parseAmount(r.amount);
  if (amount == null || amount < 0) return { index: i, ok: false, reason: "amount must be a number of 0 or more" };
  const date = parseDate(r.date);
  if (!date) return { index: i, ok: false, reason: "date is missing or not recognised (use 2026-11-16 or 16/11/2026)" };
  if (date.getTime() > Date.now() + 864e5) return { index: i, ok: false, reason: "date is in the future" };
  const cur = (clean(r.currency) ?? currency).toUpperCase();
  if (cur !== currency.toUpperCase()) return { index: i, ok: false, reason: `currency must be ${currency}` };
  const status = (clean(r.status) ?? "paid").toLowerCase();
  if (!(ORDER_STATUSES as readonly string[]).includes(status)) return { index: i, ok: false, reason: `status must be one of ${ORDER_STATUSES.join(", ")}` };
  const fulfillment = clean(r.fulfillment)?.toLowerCase();
  if (fulfillment && !(FULFILLMENT as readonly string[]).includes(fulfillment)) return { index: i, ok: false, reason: `fulfillment must be one of ${FULFILLMENT.join(", ")}` };
  const discount = r.discount == null || String(r.discount).trim() === "" ? 0 : parseAmount(r.discount);
  if (discount == null || discount < 0 || discount > amount) return { index: i, ok: false, reason: "discount must be between 0 and the amount" };
  const conversation_id = clean(r.conversation_id);
  if (conversation_id && !UUID.test(conversation_id)) return { index: i, ok: false, reason: "conversation_id is not a valid ItaOS chat id" };
  const ref = clean(r.ref, 120);
  const dedupe_key = ref ? "ref:" + ref.toLowerCase() : "auto:" + [date.toISOString().slice(0, 10), amount, (clean(r.customer_name) ?? "").toLowerCase(), (clean(r.product) ?? "").toLowerCase()].join("|");
  return { index: i, ok: true, dedupe_key, row: { ...r, ref, amount, discount, date: date.toISOString(), currency: cur, status, fulfillment: fulfillment ?? "not_applicable", product: clean(r.product), customer_name: clean(r.customer_name, 120), notes: clean(r.notes, 500), conversation_id, phone: clean(r.phone, 40) } };
}

export function validateExpense(r: ExpenseRow, i: number, currency: string): Validated<ExpenseRow & { amount: number; date: string; category: string }> {
  const amount = parseAmount(r.amount);
  if (amount == null || amount < 0) return { index: i, ok: false, reason: "amount must be a number of 0 or more" };
  const date = parseDate(r.date);
  if (!date) return { index: i, ok: false, reason: "date is missing or not recognised" };
  const cur = (clean(r.currency) ?? currency).toUpperCase();
  if (cur !== currency.toUpperCase()) return { index: i, ok: false, reason: `currency must be ${currency}` };
  const category = (clean(r.category) ?? "other").toLowerCase().replace(/\s+/g, "_");
  if (!(EXPENSE_CATEGORIES as readonly string[]).includes(category)) return { index: i, ok: false, reason: `category must be one of ${EXPENSE_CATEGORIES.join(", ")}` };
  const ref = clean(r.ref, 120);
  const dedupe_key = ref ? "ref:" + ref.toLowerCase() : "auto:" + [date.toISOString().slice(0, 10), amount, category, (clean(r.note) ?? "").toLowerCase()].join("|");
  return { index: i, ok: true, dedupe_key, row: { ref, amount, date: date.toISOString(), currency: cur, category, note: clean(r.note, 300) } };
}

export function validateInquiry(r: InquiryRow, i: number): Validated<InquiryRow & { date: string; customer_name: string; source: string }> {
  const customer_name = clean(r.customer_name, 120);
  if (!customer_name) return { index: i, ok: false, reason: "customer_name is required" };
  const date = parseDate(r.date);
  if (!date) return { index: i, ok: false, reason: "date is missing or not recognised" };
  const source = (clean(r.source) ?? "unknown").toLowerCase();
  if (!["ad", "organic", "unknown"].includes(source)) return { index: i, ok: false, reason: "source must be ad, organic or unknown" };
  const ref = clean(r.ref, 120);
  const dedupe_key = ref ? "ref:" + ref.toLowerCase() : "auto:" + [date.toISOString().slice(0, 10), customer_name.toLowerCase()].join("|");
  return { index: i, ok: true, dedupe_key, row: { ref, date: date.toISOString(), customer_name, source, source_label: clean(r.source_label, 80), note: clean(r.note, 300), phone: clean(r.phone, 40) } };
}

/** Marks later rows that repeat an earlier row's dedupe key inside the same file. */
export function markFileDuplicates<T>(rows: Validated<T>[]): (Validated<T> | { index: number; ok: false; reason: string; duplicate_of: number })[] {
  const seen = new Map<string, number>();
  return rows.map((v) => {
    if (!v.ok) return v;
    const first = seen.get(v.dedupe_key);
    if (first != null) return { index: v.index, ok: false as const, reason: `duplicate of row ${first + 1} in this file`, duplicate_of: first };
    seen.set(v.dedupe_key, v.index);
    return v;
  });
}

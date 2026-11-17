import type { Outcome, Order } from "../src/lib";
let n = 0;
export const conv = (p: Partial<Outcome> = {}): Outcome => ({
  id: `c${++n}`, workspace_id: "w", contact_id: "x", contact_name: "C", source: "ad", ad_id: "ad1", source_label: null,
  started_at: "2026-11-10T09:00:00Z", last_message_at: "2026-11-10T10:00:00Z", first_response_sec: 300, price_asked: false, price_shared: false,
  payment_signal: false, payment_amount: null, warm: false, followed_up: false, stage: "talking", objections: [], label: "talking",
  auto_outcome: "open", outcome_override: null, kito_outcome: null, kito_label: null, kito_amount: null, kito_objections: null, kito_tags: null,
  kito_temp: null, kito_blocker: null, kito_summary: null, kito_next: null, kito_confidence: null, kito_checked_at: null, kito_error: null,
  outcome: "open", sale_amount: null, sale_provenance: null, kito_evidence: null, override_by: null, override_at: null, override_note: null,
  paid_orders: 0, first_paid_at: null, last_paid_at: null, last_out_at: null, last_dir: "out", pay_instructions: false,
  ...p,
} as unknown as Outcome);
export const order = (p: Partial<Order> = {}): Order => ({
  id: `o${++n}`, workspace_id: "w", conversation_id: null, ad_id: null, amount: 50000, discount: 0, refund_amount: 0, currency: "TZS",
  status: "paid", fulfillment_status: "not_applicable", product: null, notes: null, occurred_at: "2026-11-11T09:00:00Z", paid_at: "2026-11-11T09:00:00Z",
  provenance: "manual", inferred_from: null, external_ref: null, created_by: "u", updated_by: "u", created_at: "2026-11-11T09:00:00Z", updated_at: "2026-11-11T09:00:00Z",
  ...p,
});
export const WS = { currency: "TZS", timezone: "Africa/Dar_es_Salaam", fx_rate: 2600, unit_cost: null, conversion_window_days: 30, follow_up_hours: 24 };

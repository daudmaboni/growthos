// Orders for one chat: record, correct, reverse. Every change is audited by the database.
import { useEffect, useState } from "react";
import { supabase, Workspace, Order, Outcome, L, amt, when, orderNet, canEdit } from "./lib";

type Ev = { id: number; action: string; actor: string | null; at: string; before: any; after: any };

/** The owner answered "money did not come in" (or "didn't buy"): stop treating the chat as a payment to check. */
export const signalDismissed = (r: Pick<Outcome, "override_by" | "outcome_override">) =>
  !!r.override_by && (r.outcome_override === "open" || r.outcome_override === "lost");

export function inferredFrom(r: Outcome): "kito" | "rules" | "name_mark" | null {
  if (signalDismissed(r)) return null;
  if (r.kito_outcome === "sold" && r.kito_confidence !== "low") return "kito";
  if (r.payment_signal) return "rules";
  if (r.outcome_override === "sold") return "name_mark";
  return null;
}

export function OrderForm({ ws, r, onDone, onCancel }: { ws: Workspace; r: Outcome; onDone: () => void; onCancel: () => void }) {
  const lang = ws.language; const T = (en: string, sw: string) => (lang === "sw" ? sw : en);
  const [amount, setAmount] = useState(String(r.kito_amount ?? r.payment_amount ?? ""));
  const [discount, setDiscount] = useState("");
  const [date, setDate] = useState(() => (r.last_message_at ?? new Date().toISOString()).slice(0, 10));
  const [product, setProduct] = useState("");
  const [status, setStatus] = useState<Order["status"]>("paid");
  const [fulfil, setFulfil] = useState<Order["fulfillment_status"]>("not_applicable");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const a = Number(amount.replace(/[^\d.]/g, "")), d = discount ? Number(discount.replace(/[^\d.]/g, "")) : 0;
    if (!(a >= 0) || !isFinite(a)) return setErr(T("Enter the amount.", "Weka kiasi."));
    if (!(d >= 0) || d > a) return setErr(T("Discount must be between 0 and the amount.", "Punguzo liwe kati ya 0 na kiasi."));
    if (!date || Date.parse(date) > Date.now() + 864e5) return setErr(T("Enter a valid date.", "Weka tarehe sahihi."));
    setBusy(true); setErr("");
    const { data: user } = await supabase.auth.getUser();
    const occurred = new Date(date + "T12:00:00+03:00").toISOString();
    const { error } = await supabase.from("orders").insert({
      workspace_id: ws.id, conversation_id: r.id, amount: a, discount: d, currency: ws.currency, status, fulfillment_status: fulfil,
      product: product.trim() || null, notes: notes.trim() || null, occurred_at: occurred, paid_at: status === "paid" ? occurred : null,
      provenance: "manual", inferred_from: inferredFrom(r), created_by: user.user?.id,
    });
    setBusy(false);
    if (error) setErr(error.message); else onDone();
  }
  return (
    <form className="card" style={{ background: "var(--paper)", gap: 8 }} onSubmit={save}>
      <b>{T("Record an order for this chat", "Rekodi oda ya chat hii")}</b>
      {inferredFrom(r) && <span className="small muted">{T("A payment was inferred from the chat. Recording it here is what makes it a confirmed sale.", "Malipo yalikisiwa kutoka chat. Kuyarekodi hapa ndiko kunayafanya kuwa mauzo yaliyothibitishwa.")}</span>}
      <div className="map">
        <label>{T("Amount", "Kiasi")} ({ws.currency})<input inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label>{T("Discount", "Punguzo")}<input inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="0" /></label>
        <label>{T("Date", "Tarehe")}<input type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label>{T("Status", "Hali")}<select value={status} onChange={(e) => setStatus(e.target.value as any)}>{(["paid", "pending", "refunded", "cancelled"] as const).map((s) => <option key={s} value={s}>{L[lang].orderStatus[s]}</option>)}</select></label>
        <label>{T("Delivery", "Usafirishaji")}<select value={fulfil} onChange={(e) => setFulfil(e.target.value as any)}>{(["not_applicable", "not_shipped", "shipped", "delivered", "returned"] as const).map((s) => <option key={s} value={s}>{L[lang].fulfillment[s]}</option>)}</select></label>
        <label>{T("Product (optional)", "Bidhaa (si lazima)")}<input value={product} onChange={(e) => setProduct(e.target.value)} /></label>
        <label style={{ gridColumn: "1 / -1" }}>{T("Note (optional)", "Maelezo (si lazima)")}<input value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      </div>
      {err && <span className="err small">{err}</span>}
      <div className="row"><button className="primary small" disabled={busy}>{busy ? "…" : T("Save order", "Hifadhi oda")}</button><button type="button" className="small" onClick={onCancel}>{T("Cancel", "Ghairi")}</button></div>
    </form>
  );
}

export function OrderList({ ws, conversationId, onChange }: { ws: Workspace; conversationId: string; onChange: () => void }) {
  const lang = ws.language; const T = (en: string, sw: string) => (lang === "sw" ? sw : en);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [events, setEvents] = useState<Record<string, Ev[]>>({});
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [tick, setTick] = useState(0);
  const editor = canEdit(ws);
  useEffect(() => {
    supabase.from("orders").select("*").eq("workspace_id", ws.id).eq("conversation_id", conversationId).order("occurred_at", { ascending: false })
      .then(({ data, error }) => { if (error) setErr(error.message); setOrders((data as Order[]) ?? []); });
  }, [ws.id, conversationId, tick]);
  async function update(o: Order, patch: Partial<Order>) {
    setBusy(o.id); setErr("");
    const { error } = await supabase.from("orders").update(patch).eq("id", o.id).eq("workspace_id", ws.id);
    setBusy("");
    if (error) setErr(error.message); else { setTick((t) => t + 1); onChange(); }
  }
  async function toggleHistory(o: Order) {
    if (events[o.id]) { const e = { ...events }; delete e[o.id]; setEvents(e); return; }
    const { data } = await supabase.from("order_events").select("id,action,actor,at,before,after").eq("order_id", o.id).order("at", { ascending: false }).limit(30);
    setEvents({ ...events, [o.id]: (data as Ev[]) ?? [] });
  }
  if (!orders) return <span className="small muted">…</span>;
  if (!orders.length) return <span className="small muted">{T("No orders recorded for this chat.", "Hakuna oda zilizorekodiwa kwa chat hii.")}</span>;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {err && <span className="err small">{err}</span>}
      {orders.map((o) => (
        <div key={o.id} className="evidence" style={{ borderLeftColor: o.status === "paid" ? "var(--good)" : "var(--line-2)" }}>
          <div className="row between">
            <span><b>{amt(orderNet(o), o.currency)} {o.currency}</b> <span className={"pill " + (o.status === "paid" ? "sold" : o.status === "pending" ? "open" : "lost")}>{L[lang].orderStatus[o.status]}</span> <span className="chip">{L[lang].provenance[o.provenance]}{o.inferred_from ? ` · ${T("confirmed from", "kutoka")} ${o.inferred_from === "kito" ? "Kito" : o.inferred_from === "rules" ? T("rules", "kanuni") : "✅"}` : ""}</span>{o.fulfillment_status !== "not_applicable" && <span className="chip">{L[lang].fulfillment[o.fulfillment_status]}</span>}</span>
            <span className="small muted">{o.paid_at ? T("paid", "imelipwa") + " " + when(o.paid_at) : when(o.occurred_at)}{o.product ? ` · ${o.product}` : ""}{o.external_ref && !o.external_ref.startsWith("auto:") ? ` · ref ${o.external_ref}` : ""}</span>
          </div>
          {(Number(o.discount) > 0 || Number(o.refund_amount) > 0) && <span className="small muted">{T("gross", "jumla")} {amt(Number(o.amount), o.currency)}{Number(o.discount) > 0 ? ` − ${T("discount", "punguzo")} ${amt(Number(o.discount), o.currency)}` : ""}{Number(o.refund_amount) > 0 ? ` − ${T("refund", "marejesho")} ${amt(Number(o.refund_amount), o.currency)}` : ""}</span>}
          {o.notes && <span className="small">{o.notes}</span>}
          <span className="small muted">{T("last change", "badiliko la mwisho")} {when(o.updated_at)} · <button className="small" style={{ padding: 0, border: 0, background: "none", color: "var(--accent)" }} onClick={() => toggleHistory(o)}>{events[o.id] ? T("hide history", "ficha historia") : T("history", "historia")}</button></span>
          {events[o.id] && <div className="small muted" style={{ display: "grid", gap: 2 }}>{events[o.id].map((e) => <span key={e.id}>{when(e.at)} · {e.action}{e.action === "update" && e.before && e.after ? ": " + Object.keys(e.after).filter((k) => JSON.stringify(e.before[k]) !== JSON.stringify(e.after[k]) && !["updated_at", "updated_by"].includes(k)).map((k) => `${k} ${JSON.stringify(e.before[k])} → ${JSON.stringify(e.after[k])}`).join(", ") : ""}{e.actor ? "" : T(" (server)", " (mfumo)")}</span>)}</div>}
          {editor && (
            <div className="row" style={{ gap: 6 }}>
              {o.status !== "paid" && <button className="small" disabled={busy === o.id} onClick={() => update(o, { status: "paid", paid_at: new Date().toISOString() })}>{T("Mark paid", "Weka imelipwa")}</button>}
              {o.status === "paid" && <button className="small" disabled={busy === o.id} onClick={() => { const v = prompt(T("Refund amount", "Kiasi cha marejesho"), String(orderNet(o))); const n = v == null ? NaN : Number(v.replace(/[^\d.]/g, "")); if (n >= 0 && n <= orderNet(o)) update(o, { status: "refunded", refund_amount: Number(o.refund_amount) + n }); }}>{T("Refund", "Rudisha pesa")}</button>}
              {o.status !== "cancelled" && <button className="small" disabled={busy === o.id} onClick={() => confirm(T("Cancel this order? It stays in the history as cancelled.", "Ghairi oda hii? Itabaki kwenye historia kama iliyoghairiwa.")) && update(o, { status: "cancelled" })}>{T("Cancel order", "Ghairi oda")}</button>}
              <select value={o.fulfillment_status} disabled={busy === o.id} onChange={(e) => update(o, { fulfillment_status: e.target.value as any })} style={{ padding: "3px 8px" }}>{(["not_applicable", "not_shipped", "shipped", "delivered", "returned"] as const).map((s) => <option key={s} value={s}>{L[lang].fulfillment[s]}</option>)}</select>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

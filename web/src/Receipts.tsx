// "Find a payment" (Tafuta malipo): type our receipt number (Kumbukumbu Na., e.g. KH-000123) or the
// payment's transaction code (namba ya muamala, e.g. TKL8XJ2Q4P) and see the whole payment: the customer,
// what they bought, how much, when they paid, how they paid, and the screenshot / SMS that proves it.
// The search runs in the database (find_payment, migration 0047), only over this business's sales.
import { useEffect, useRef, useState } from "react";
import { supabase, Workspace, money, orderNet } from "./lib";
import ReceiptPrint from "./ReceiptPrint";

type Found = {
  order: null | {
    id: string; receipt_no: string | null; amount: number; discount: number; refund_amount: number; currency: string;
    status: string; items: { name?: string; qty?: number }[] | null; product: string | null; notes: string | null;
    paid_at: string | null; occurred_at: string; created_at: string; provenance: string; inferred_from: string | null;
    payment_ref: string | null; fulfillment_status: string;
  };
  conversation_id: string | null;
  customer: { name: string | null; phone: string | null } | null;
  evidence: null | {
    message_id: string; sent_at: string; direction: string; text: string;
    receipt: null | { amount?: number | null; currency?: string | null; txn_code?: string | null; provider?: string | null; paid_to?: string | null; sender?: string | null; paid_at?: string | null };
  };
};
type Recent = { id: string; receipt_no: string; amount: number; discount: number; refund_amount: number; currency: string; paid_at: string | null; product: string | null };

const fmt = (iso: string | null | undefined) => iso
  ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Dar_es_Salaam" })
  : "–";

export default function Receipts({ ws }: { ws: Workspace }) {
  const sw = ws.language === "sw";
  const T = (en: string, s: string) => (sw ? s : en);
  const [q, setQ] = useState(() => decodeURIComponent(location.hash.match(/#receipts\/q=([^&]+)/)?.[1] ?? ""));
  const [res, setRes] = useState<Found[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [recent, setRecent] = useState<Recent[]>([]);
  const seq = useRef(0);
  const [printId, setPrintId] = useState<string | null>(null);

  useEffect(() => {
    supabase.from("orders").select("id,receipt_no,amount,discount,refund_amount,currency,paid_at,product").eq("workspace_id", ws.id)
      .not("receipt_no", "is", null).order("receipt_seq", { ascending: false }).limit(8)
      .then(({ data }) => setRecent((data as Recent[]) ?? []));
  }, [ws.id]);

  // Search as you type (after a short pause); 3 characters or more.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 3) { setRes(null); setErr(""); return; }
    const my = ++seq.current;
    const t = window.setTimeout(async () => {
      setBusy(true); setErr("");
      const { data, error } = await supabase.rpc("find_payment", { p_ws: ws.id, p_q: term });
      if (my !== seq.current) return;
      setBusy(false);
      if (error) { setErr(error.message); setRes([]); return; }
      setRes((data as Found[]) ?? []);
    }, 350);
    return () => window.clearTimeout(t);
  }, [q, ws.id]);

  return (
    <div className="stack" style={{ display: "grid", gap: 16 }}>
      <section className="card" style={{ display: "grid", gap: 10 }}>
        <div>
          <h2 style={{ margin: 0 }}>{T("Find a payment", "Tafuta malipo")}</h2>
          <span className="small muted">{T("Type a receipt number or the payment's transaction code. You'll see who paid, for what, how much, when and the proof.",
            "Andika kumbukumbu namba ya risiti au namba ya muamala. Utaona nani alilipa, alinunua nini, kiasi gani, lini na uthibitisho.")}</span>
        </div>
        <label className="small muted" htmlFor="pay-q">{T("Receipt no. or transaction code", "Kumbukumbu Na. au namba ya muamala")}</label>
        <input id="pay-q" type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" spellCheck={false}
          placeholder={T("e.g. KH-000123 or TKL8XJ2Q4P", "mfano KH-000123 au TKL8XJ2Q4P")} style={{ fontSize: 18, padding: "12px 14px", textTransform: "uppercase" }} />
        {busy && <span className="small muted">{T("Searching…", "Inatafuta…")}</span>}
        {err && <span className="err small">{T("Couldn't search right now. Try again in a moment.", "Imeshindwa kutafuta sasa. Jaribu tena baada ya muda.")}</span>}
      </section>

      {res && !busy && !err && res.length === 0 && (
        <div className="empty">{T(`Nothing found for “${q.trim()}”. Check the number, or search part of it (e.g. the last 4 characters).`,
          `Hakuna kilichopatikana kwa “${q.trim()}”. Hakiki namba, au tafuta sehemu yake (mfano herufi 4 za mwisho).`)}</div>
      )}

      {res?.map((f, i) => <PaymentCard key={(f.order?.id ?? f.evidence?.message_id ?? "") + i} f={f} T={T} onPrint={setPrintId} />)}

      {printId && <ReceiptPrint ws={ws} orderId={printId} onClose={() => setPrintId(null)} />}

      {!res && recent.length > 0 && (
        <section className="card" style={{ display: "grid", gap: 0 }}>
          <style>{`.rcpt-row{all:unset;box-sizing:border-box;width:100%;display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:12px 4px;border-bottom:1px solid var(--line);cursor:pointer;text-align:left;color:inherit;font:inherit}
            .rcpt-row:last-child{border-bottom:0}.rcpt-row:hover{background:var(--hover, rgba(0,0,0,.03))}.rcpt-row:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:8px}`}</style>
          <h3 style={{ margin: "0 0 4px" }}>{T("Latest receipts", "Risiti za karibuni")}</h3>
          {recent.map((r) => (
            <button key={r.id} type="button" className="rcpt-row" onClick={() => setQ(r.receipt_no)}>
              <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
                <b>{r.receipt_no}</b>
                <span className="small muted" style={{ overflowWrap: "anywhere" }}>{r.product || T("Products not recorded", "Bidhaa hazijaandikwa")}</span>
                <span className="small muted">{fmt(r.paid_at)}</span>
              </span>
              <b style={{ whiteSpace: "nowrap" }}>{money(orderNet(r), r.currency)}</b>
            </button>
          ))}
        </section>
      )}
    </div>
  );
}

function PaymentCard({ f, T, onPrint }: { f: Found; T: (en: string, s: string) => string; onPrint: (id: string) => void }) {
  const o = f.order, ev = f.evidence, rc = ev?.receipt ?? null;
  const items = o?.items?.length ? o.items.map((x) => `${x.name ?? "?"}${x.qty && x.qty > 1 ? ` × ${x.qty}` : ""}`).join(", ") : o?.product ?? null;
  const status = !o ? T("Payment message — not recorded as a sale", "Ujumbe wa malipo — haujarekodiwa kama mauzo")
    : o.status === "paid" ? T("Paid", "Imelipwa") : o.status === "refunded" ? T("Refunded", "Imerudishwa") : o.status === "cancelled" ? T("Cancelled", "Imeghairiwa") : T("Pending", "Inasubiri");
  const how = o?.inferred_from === "tick" ? T("your ✅ price message", "ujumbe wako wa bei wenye ✅")
    : o?.inferred_from === "kito" ? T("Kito, confirmed by you", "Kito, umethibitisha")
    : o?.inferred_from === "rules" ? T("chat rules, confirmed by you", "kanuni za chat, umethibitisha")
    : o?.provenance === "csv_import" ? T("imported", "imeingizwa") : T("recorded by hand", "imerekodiwa kwa mkono");
  const Row = ({ k, v }: { k: string; v: React.ReactNode }) => v == null || v === "" ? null : (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
      <span className="muted">{k}</span><span style={{ textAlign: "right", fontWeight: 600 }}>{v}</span>
    </div>
  );
  return (
    <section className="card" style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "grid", gap: 2 }}>
          <span className="small muted">{T("Receipt no.", "Kumbukumbu Na.")}</span>
          <b style={{ fontSize: 24 }}>{o?.receipt_no ?? "—"}</b>
        </div>
        <div style={{ display: "grid", gap: 4, justifyItems: "end" }}>
          <span className={"pill " + (o?.status === "paid" ? "sold" : o ? "lost" : "open")}>{status}</span>
          {o && <b style={{ fontSize: 22 }}>{money(orderNet(o), o.currency)}</b>}
        </div>
      </div>
      <div className="small">
        <Row k={T("Customer", "Mteja")} v={f.customer?.name || (f.customer?.phone ? "+" + f.customer.phone : null)} />
        <Row k={T("Phone", "Simu")} v={f.customer?.phone ? "+" + f.customer.phone : null} />
        <Row k={T("Bought", "Alinunua")} v={items} />
        <Row k={T("Paid on", "Alilipa")} v={o ? fmt(o.paid_at) : ev ? fmt(ev.sent_at) : null} />
        {o && (Number(o.discount) > 0 || Number(o.refund_amount) > 0) && <Row k={T("Before discount / refund", "Kabla ya punguzo / marejesho")} v={money(Number(o.amount), o.currency)} />}
        <Row k={T("Transaction code", "Namba ya muamala")} v={o?.payment_ref ?? rc?.txn_code ?? null} />
        <Row k={T("Paid with", "Amelipa kwa")} v={rc?.provider ?? null} />
        <Row k={T("Sent by (on receipt)", "Aliyetuma (kwenye risiti)")} v={rc?.sender ?? null} />
        <Row k={T("Paid to (on receipt)", "Aliyelipwa (kwenye risiti)")} v={rc?.paid_to ?? null} />
        <Row k={T("Amount on receipt", "Kiasi kwenye risiti")} v={rc?.amount != null ? money(rc.amount, rc.currency || o?.currency || "TZS") : null} />
        <Row k={T("How the sale was recorded", "Mauzo yalirekodiwa vipi")} v={o ? `${how} · ${fmt(o.created_at)}` : null} />
        <Row k={T("Notes", "Maelezo")} v={o?.notes ?? null} />
      </div>
      {ev && (
        <div className="evidence small" style={{ display: "grid", gap: 4 }}>
          <span className="muted">{rc ? T("Payment screenshot", "Picha ya malipo") : T("Payment message", "Ujumbe wa malipo")} · {fmt(ev.sent_at)}</span>
          {ev.text && <span>{ev.text}</span>}
        </div>
      )}
      {!ev && o && <span className="small muted">{T("No receipt screenshot or payment SMS found in the chat for this sale.", "Hakuna picha ya risiti wala SMS ya malipo kwenye chat kwa mauzo haya.")}</span>}
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        {o && o.status === "paid" && <button type="button" className="primary" onClick={() => onPrint(o.id)}>{T("Print receipt", "Chapisha risiti")}</button>}
        {f.conversation_id && <a href={"#chats/ids=" + f.conversation_id}>{T("Open the chat →", "Fungua chat →")}</a>}
      </div>
    </section>
  );
}

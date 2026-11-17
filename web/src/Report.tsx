// Weekly diagnosis: deterministic findings with their evidence, ranked by urgency, each linked
// to the chats and orders behind it. AI does not write anything on this page.
import { useMemo, useState } from "react";
import { enterCards, enterRows, usePageEnter, select } from "./motion";
import { Workspace, fmt, pct, money, dur } from "./lib";
import { useGrowthData } from "./data";
import { diagnose, Finding } from "./diagnosis";
import { delta, Metric } from "./metrics";
import { SourceBadge } from "./Provenance";

export default function Report({ ws }: { ws: Workspace }) {
  const [days, setDays] = useState(7);
  const lang = ws.language;
  const T = (en: string, sw: string) => (lang === "sw" ? sw : en);
  const g = useGrowthData(ws, days);
  const { mx, prev } = g;
  const findings = useMemo(() => (mx ? diagnose(mx, g.convs, g.orders, ws.timezone) : []), [mx, g.convs, g.orders, ws.timezone]);
  const pageRef = usePageEnter<HTMLDivElement>((root) => {
    if (g.loading) return;
    enterCards(select(root, ":scope > .card, .hero"), { stagger: 0.06 });
    enterRows(select(root, ".finding"), { delay: 0.3, x: -8, y: 0, stagger: 0.05 });
  }, [g.loading, days]);

  if (g.loading || !mx || !prev) return <div className="skeletons" aria-busy="true"><div className="skeleton" style={{ minHeight: 120 }} /><div className="skeleton" style={{ minHeight: 300 }} /></div>;

  const rows: [string, Metric, Metric, (n: number | null) => string][] = [
    [T("Ad spend", "Matumizi ya matangazo"), mx.spend, prev.spend, (n) => money(n, mx.adCurrency)],
    [T("Chats (Meta-reported)", "Chats (Meta)"), mx.platformConversations, prev.platformConversations, fmt],
    [T("Chats received (WhatsApp)", "Chats zilizopokelewa"), mx.chats, prev.chats, fmt],
    [T("From ads (matched)", "Kutoka matangazo"), mx.adChats, prev.adChats, fmt],
    [T("Got a reply", "Zilijibiwa"), mx.replied, prev.replied, fmt],
    [T("Price shared", "Bei ilitolewa"), mx.priced, prev.priced, fmt],
    [T("Payment signals (inferred)", "Dalili za malipo"), mx.paymentSignals, prev.paymentSignals, fmt],
    [T("Attributed sales", "Mauzo yaliyounganishwa"), mx.attributedSales, prev.attributedSales, fmt],
    [T("Paid orders (recorded)", "Oda zilizolipwa"), mx.ordersPaid, prev.ordersPaid, fmt],
    [T("Revenue (confirmed)", "Mapato"), mx.revenue, prev.revenue, (n) => money(n, ws.currency)],
    [T("Reply rate", "Kiwango cha kujibu"), mx.replyRate, prev.replyRate, pct],
    [T("Chat → attributed sale", "Chat → mauzo"), mx.saleRate, prev.saleRate, pct],
    [T("Cost per chat (Meta)", "Gharama kwa chat"), mx.costPerPlatformConversation, prev.costPerPlatformConversation, (n) => money(n, mx.adCurrency)],
    [T("Cost per attributed sale", "Gharama kwa mauzo"), mx.costPerAttributedSale, prev.costPerAttributedSale, (n) => money(n, mx.adCurrency)],
    [T("Median first reply", "Wastani wa jibu la kwanza"), mx.medianFirstReply, prev.medianFirstReply, dur],
  ];

  return (
    <div className="shell-grid" ref={pageRef}>
      <div className="hero">
        <div style={{ display: "grid", gap: 4 }}>
          <h2>{T("Weekly diagnosis", "Uchunguzi wa wiki")}</h2>
          <div className="sub"><span>{mx.period.from} → {mx.period.to}</span><span>{T("vs", "dhidi ya")} {prev.period.from} → {prev.period.to}</span><span>{ws.timezone} · {ws.currency}</span></div>
        </div>
        <div className="seg" role="group" aria-label="Period">{[7, 14, 30].map((d) => <button key={d} className={days === d ? "on" : ""} onClick={() => setDays(d)} aria-pressed={days === d}>{d} {T("days", "siku")}</button>)}</div>
      </div>
      {g.err && <p className="err">{g.err}</p>}

      <section className="card">
        <div><h2>{T("Most likely bottleneck", "Kikwazo kikubwa zaidi")}</h2><span className="small muted">{T("Ranked by how many customers it touches and how urgent it is. Observed facts come first; the interpretation is labelled as a hypothesis.", "Zimepangwa kwa idadi ya wateja na uharaka. Ukweli ulioonekana unakuja kwanza; tafsiri imeandikwa kama dhana.")}</span></div>
        {findings.length === 0 && <div className="empty">{T("Not enough chats in this period to diagnose anything.", "Hakuna chats za kutosha kipindi hiki.")}</div>}
        {findings.map((f, i) => <FindingCard key={f.kind} f={f} rank={i + 1} lang={lang} />)}
      </section>

      <section className="card">
        <h2>{T("Recommended next actions", "Hatua zinazopendekezwa")}</h2>
        <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 6 }}>
          {findings.filter((f) => f.kind !== "healthy").map((f) => (
            <li key={f.kind}><b>{f.action[lang]}</b> <span className="small muted">— {f.title[lang]} · {T("urgency", "uharaka")}: {f.severity === "bad" ? T("high", "juu") : f.severity === "warn" ? T("medium", "kati") : T("low", "chini")}</span></li>
          ))}
          {!findings.some((f) => f.kind !== "healthy") && <li className="muted">{T("Nothing urgent. Keep going.", "Hakuna la haraka. Endelea.")}</li>}
        </ol>
      </section>

      <section className="card">
        <h2>{T("Funnel: this period vs the one before", "Mchakato: kipindi hiki dhidi ya kilichopita")}</h2>
        <div className="scroll"><table>
          <thead><tr><th>{T("Metric", "Kipimo")}</th><th className="n">{T("This period", "Kipindi hiki")}</th><th className="n">{T("Before", "Kilichopita")}</th><th className="n">{T("Change", "Badiliko")}</th><th>{T("Source", "Chanzo")}</th></tr></thead>
          <tbody>{rows.map(([l, a, b, f]) => {
            const d = delta(a, b);
            return <tr key={l}><td>{l}</td><td className="n"><b>{f(a.value)}</b></td><td className="n muted">{f(b.value)}</td><td className="n">{d == null ? "–" : <span className={"delta " + (d > 0 ? "up" : "down")}>{d > 0 ? "↑" : "↓"} {Math.abs(Math.round(d * 100))}%</span>}</td><td><SourceBadge p={a.provenance} lang={lang} /></td></tr>;
          })}</tbody>
        </table></div>
        <p className="small muted" style={{ margin: 0 }}>{T(`Chats are counted in the period they started (${ws.timezone}). Attributed sales are paid orders linked to those chats within ${ws.conversion_window_days} days. Revenue counts orders by the date they were paid. Inferred signals never enter revenue or cost per sale.`, `Chats zinahesabiwa kwenye kipindi zilipoanza (${ws.timezone}). Mauzo yaliyounganishwa ni oda zilizolipwa ndani ya siku ${ws.conversion_window_days}. Mapato yanahesabu oda kwa tarehe ya malipo. Dalili hazihesabiwi kwenye mapato.`)}</p>
      </section>
    </div>
  );
}

function FindingCard({ f, rank, lang }: { f: Finding; rank: number; lang: "sw" | "en" }) {
  const T = (en: string, sw: string) => (lang === "sw" ? sw : en);
  const link = f.conversationIds.length ? "#chats/ids=" + f.conversationIds.join(",") : null;
  return (
    <div className={"finding " + f.severity}>
      <div className="row between"><b>{rank}. {f.title[lang]}</b><span className={"chip conf-" + f.confidence}>{T("confidence", "uhakika")}: {f.confidence}</span></div>
      <span className="small"><b>{T("Observed", "Imeonekana")}:</b> {f.observed[lang]}</span>
      <span className="small"><b>{T("Hypothesis", "Dhana")}:</b> {f.hypothesis[lang]}</span>
      <span className="small"><b>{T("Do next", "Fanya")}:</b> {f.action[lang]}</span>
      <span className="small muted">
        {T("Count", "Idadi")}: {f.count}{f.sample ? ` / ${f.sample}` : ""} · {T("source", "chanzo")}: {f.source}
        {f.missing.length > 0 && <> · {T("missing", "inakosekana")}: {f.missing.join("; ")}</>}
      </span>
      <span className="small">
        {link && <a href={link}>{T(`Open the ${Math.min(f.conversationIds.length, 50)} chats behind this →`, `Fungua chats ${Math.min(f.conversationIds.length, 50)} →`)}</a>}
        {f.orderIds?.length ? <> · <a href={"#chats/orders=" + f.orderIds.join(",")}>{T(`${f.orderIds.length} orders →`, `Oda ${f.orderIds.length} →`)}</a></> : null}
      </span>
    </div>
  );
}

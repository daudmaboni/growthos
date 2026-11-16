import { useEffect, useMemo, useRef, useState } from "react";
import { countTo, enterCards, enterRows, growBars, usePageEnter, select } from "./motion";
import { Workspace, fmt, pct, dur, L, amt, money, ago, localDay } from "./lib";
import { TrendChart, SpendSplit, CostBars } from "./Charts";
import { useGrowthData } from "./data";
import { Metric, delta, DEFINITIONS } from "./metrics";
import { diagnose } from "./diagnosis";
import { SourceBadge, ProvenanceLegend } from "./Provenance";

export default function Dashboard({ ws }: { ws: Workspace }) {
  const [days, setDays] = useState(14);
  const lang = ws.language;
  const T = (en: string, sw: string) => (lang === "sw" ? sw : en);
  const D = (k: string) => DEFINITIONS[k]?.[lang] ?? "";
  const g = useGrowthData(ws, days);
  const { mx, prev, ads, daily, loading, err } = g;
  const adCur = mx?.adCurrency ?? ws.currency;

  const findings = useMemo(() => (mx ? diagnose(mx, g.convs, g.orders, ws.timezone).slice(0, 4) : []), [mx, g.convs, g.orders, ws.timezone]);

  const costBars = useMemo(() => {
    const withSales = ads.filter((a) => Number(a.sold) > 0);
    if (withSales.length) return { kind: "sale" as const, items: withSales.map((a) => ({ name: a.ad_name ?? a.ad_id, cost: Number(a.spend) / Number(a.sold), note: `${amt(Number(a.spend), adCur)} · ${a.sold} ${T("attributed sales", "mauzo")}` })).sort((x, y) => x.cost - y.cost).slice(0, 8) };
    return { kind: "chat" as const, items: ads.filter((a) => Number(a.platform_conversations) > 0 && Number(a.spend) > 0).map((a) => ({ name: a.ad_name ?? a.ad_id, cost: Number(a.spend) / Number(a.platform_conversations), note: `${amt(Number(a.spend), adCur)} · ${fmt(a.platform_conversations)} chats` })).sort((x, y) => x.cost - y.cost).slice(0, 8) };
  }, [ads, lang, adCur]);

  const trend = useMemo(() => {
    if (!mx || !prev) return { labels: [], cur: [], prev: [], total: 0, change: null as number | null };
    const byDay: Record<string, number> = {};
    for (const r of daily) byDay[r.day] = (byDay[r.day] ?? 0) + r.spend;
    const dayList = (from: string, n: number) => Array.from({ length: n }, (_, i) => new Date(new Date(from + "T00:00:00Z").getTime() + i * 864e5).toISOString().slice(0, 10));
    const labels = dayList(mx.period.from, days), prevDays = dayList(prev.period.from, days);
    const cur = labels.map((d) => byDay[d] ?? 0), pv = prevDays.map((d) => byDay[d] ?? 0);
    return { labels, cur, prev: pv, total: mx.spend.value ?? 0, change: delta(mx.spend, prev.spend) };
  }, [daily, mx, prev, days]);

  const noData = !loading && !ads.length && !g.convs.length && !g.orders.length;
  const pageRef = usePageEnter<HTMLDivElement>((root) => {
    if (loading) return;
    enterRows(select(root, ".hero > *"), { y: 10, stagger: 0.08 });
    enterCards(select(root, ".kpis > .kpi, .shell-grid > .card, .two > .card, .empty"), { stagger: 0.06, delay: 0.1 });
    growBars(select(root, ".fstep .bar > i, .costrow .bar > i"), { axis: "x", delay: 0.5, stagger: 0.07 });
    enterRows(select(root, "table tbody tr"), { delay: 0.45, stagger: 0.04 });
    enterRows(select(root, ".finding, .legend .li"), { delay: 0.4, x: -8, y: 0, stagger: 0.05 });
  }, [loading, days, noData]);
  const totalRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!loading) countTo(totalRef.current, trend.total, (n) => money(n, adCur), { duration: 1.2, delay: 0.35 }); }, [loading, trend.total, adCur]);

  if (loading || !mx || !prev) return (
    <div className="skeletons" aria-busy="true" aria-label="Loading">
      <div className="kpis">{[0, 1, 2, 3, 4, 5, 6].map((i) => <div className="skeleton" key={i} />)}</div>
      <div className="two"><div className="skeleton" style={{ minHeight: 300 }} /><div className="skeleton" style={{ minHeight: 300 }} /></div>
    </div>
  );

  const adsConn = g.conns.filter((c) => c.provider === "meta_ads");
  const waConn = g.conns.filter((c) => c.provider === "whatsapp");
  const failed = g.health.find((h) => h.status === "failed");
  const lastSync = adsConn.map((c) => c.last_sync_at).filter(Boolean).sort().pop() ?? null;
  const funnel: [string, Metric, string][] = [
    [T("Chats received", "Chats zilizopokelewa"), mx.chats, ""], [T("Got a reply", "Walijibiwa"), mx.replied, ""],
    [T("Price shared", "Bei ilitolewa"), mx.priced, ""], [T("Payment signal", "Dalili ya malipo"), mx.paymentSignals, "warn"],
    [T("Confirmed paid (attributed)", "Oda zilizolipwa (zimeunganishwa)"), mx.attributedSales, "good"],
  ];

  return (
    <div className="shell-grid" ref={pageRef}>
      <div className="hero">
        <div style={{ display: "grid", gap: 4 }}>
          <h2>{greeting(lang, ws.timezone)}</h2>
          <div className="sub">
            <span><span className={"dot" + (adsConn.length ? "" : " off")} />{adsConn.length ? `${T("Ads synced", "Matangazo yamesawazishwa")} ${ago(lastSync)}` : T("Ad account not connected", "Akaunti ya matangazo haijaunganishwa")}</span>
            <span>{waConn.length ? `WhatsApp ${T("connected", "imeunganishwa")}` : T("WhatsApp: chat uploads only", "WhatsApp: chats zilizopakiwa tu")}</span>
            <span>{mx.period.from} → {mx.period.to} · {ws.timezone} · {ws.currency}{adCur !== ws.currency ? ` (${T("ads in", "matangazo kwa")} ${adCur})` : ""}</span>
          </div>
        </div>
        <div className="row">
          <div className="seg" role="group" aria-label="Period">
            {[7, 14, 30].map((d) => <button key={d} className={days === d ? "on" : ""} onClick={() => setDays(d)} aria-pressed={days === d}>{d} {T("days", "siku")}</button>)}
          </div>
        </div>
      </div>
      {err && <p className="err">{err}</p>}
      {failed && failed.events > 0 && <div className="finding warn"><b>{T(`${failed.events} WhatsApp events failed to process`, `Matukio ${failed.events} ya WhatsApp hayajachakatwa`)}</b><span className="small">{T("Some chats may be incomplete. Replay them from ", "Baadhi ya chats zinaweza kuwa hazijakamilika. Zirudie kutoka ")}<a href="#connect">Connections</a>.</span></div>}
      {noData ? (
        <div className="empty">{T("No data yet. Connect the ad account and WhatsApp, or upload chats and import orders, in ", "Bado hakuna data. Unganisha matangazo na WhatsApp, au pakia chats na uingize oda, kwenye ")}<a href="#connect">{T("Connections", "Connections")}</a>.</div>
      ) : (<>
        <div className="kpis">
          <Kpi k={T("Ad spend", "Matumizi ya matangazo")} v={money(mx.spend.value, adCur)} n={mx.spend.value} f={(x) => money(x, adCur)} s={`${fmt(mx.platformConversations.value)} ${T("chats (Meta)", "chats (Meta)")}`} d={delta(mx.spend, prev.spend)} src={mx.spend.provenance} title={D("spend")} />
          <Kpi k={T("Cost per chat", "Gharama kwa chat")} v={money(mx.costPerPlatformConversation.value, adCur)} n={mx.costPerPlatformConversation.value} f={(x) => money(x, adCur)} s={T("As in Ads Manager", "Kama Ads Manager")} d={delta(mx.costPerPlatformConversation, prev.costPerPlatformConversation)} invert src="platform" title={D("costPerPlatformConversation")} />
          <Kpi k={T("Cost per qualified inquiry", "Gharama kwa mteja aliyepewa bei")} v={money(mx.costPerQualifiedInquiry.value, adCur)} s={mx.costPerQualifiedInquiry.value == null ? T("No ad chats with a price yet", "Bado hakuna chat za tangazo zilizopewa bei") : `${mx.costPerQualifiedInquiry.d} ${T("ad chats priced", "chats za tangazo zilizopewa bei")}`} d={delta(mx.costPerQualifiedInquiry, prev.costPerQualifiedInquiry)} invert src="matched" title={D("costPerQualifiedInquiry")} />
          <Kpi k={T("Cost per attributed sale", "Gharama kwa mauzo yaliyounganishwa")} v={money(mx.costPerAttributedSale.value, adCur)} n={mx.costPerAttributedSale.value} f={(x) => money(x, adCur)} s={`${mx.attributedAdSales.value} ${T("paid orders from ad chats", "oda kutoka chats za matangazo")}`} d={delta(mx.costPerAttributedSale, prev.costPerAttributedSale)} invert cls={mx.costPerAttributedSale.value == null ? "" : "ok"} src="matched" title={D("costPerAttributedSale")} />
          <Kpi k={T("Revenue", "Mapato")} v={money(mx.revenue.value, ws.currency)} n={mx.revenue.value} f={(x) => money(x, ws.currency)} s={`${mx.ordersPaid.value} ${T("paid orders", "oda zilizolipwa")}${mx.unconfirmedSignals.value ? ` · ${mx.unconfirmedSignals.value} ${T("unconfirmed signals", "dalili bila uthibitisho")}` : ""}`} d={delta(mx.revenue, prev.revenue)} src="confirmed" title={D("revenue")} />
          <Kpi k={T("Return on ad spend", "Mapato kwa shilingi ya tangazo")} v={mx.returnOnAdSpend.value == null ? "–" : mx.returnOnAdSpend.value.toFixed(1) + "×"} s={mx.returnOnAdSpend.value == null ? (mx.returnOnAdSpend.note === "needs exchange rate" ? T("Set the exchange rate in Settings → Rules", "Weka kiwango cha kubadilisha kwenye Mipangilio") : T("No ad spend this period", "Hakuna matumizi ya matangazo")) : money(mx.attributedRevenue.value, ws.currency) + T(" attributed revenue", " mapato yaliyounganishwa")} src="matched" title={D("returnOnAdSpend")} />
          <Kpi k={T("Contribution", "Faida ya mchango")} v={money(mx.contribution.value, ws.currency)} s={mx.contribution.value == null ? (mx.contribution.note === "needs exchange rate" ? T("Needs the exchange rate", "Inahitaji kiwango cha kubadilisha") : mx.contribution.note === "no paid orders in period" ? T("No paid orders this period", "Hakuna oda zilizolipwa") : T("Set cost per order in Settings or import expenses", "Weka gharama kwa oda au uingize matumizi")) : T("after ad spend and costs", "baada ya matangazo na gharama")} src="derived" title={D("contribution")} />
          <Kpi k={T("Median first reply", "Muda wa kujibu")} v={dur(mx.medianFirstReply.value)} s={`${mx.over1h.value} ${T("waited over 1 h", "zilisubiri > saa 1")}${mx.noReply.value ? ` · ${mx.noReply.value} ${T("no reply", "hazikujibiwa")}` : ""}`} cls={mx.medianFirstReply.value != null && mx.medianFirstReply.value > 900 ? "flag" : ""} src="observed" />
          <Kpi k={T("Warm, waiting for follow-up", "Wenye nia, wanasubiri ufuatiliaji")} v={fmt(mx.warmNoFollowUp.value)} n={mx.warmNoFollowUp.value} f={(x) => fmt(Math.round(x))} s={`${T("of", "kati ya")} ${mx.warmNoFollowUp.n} ${T("warm", "wenye nia")} · ${T("rule", "kanuni")}: ${ws.follow_up_hours} h`} cls={mx.warmNoFollowUp.value ? "flag" : "ok"} src="inferred" />
        </div>

        <div className="two">
          <section className="card">
            <div className="row between">
              <div><h2>{T("Ad spend per day", "Matumizi ya matangazo kwa siku")}</h2><span className="small muted">{T("Solid: this period. Dashed: the one before.", "Mstari kamili: kipindi hiki. Wenye nukta: kilichopita.")} <SourceBadge p="platform" lang={lang} /></span></div>
              {trend.change != null && <span className={"delta " + (trend.change > 0 ? "up" : "down")}>{trend.change > 0 ? "↑" : "↓"} {Math.abs(Math.round(trend.change * 100))}%</span>}
            </div>
            <div className="big" ref={totalRef}>{money(trend.total, adCur)}</div>
            {trend.labels.length ? <TrendChart days={trend.labels} cur={trend.cur} prev={trend.prev} /> : <span className="small muted">–</span>}
          </section>
          <section className="card">
            <div><h2>{T("Where chats stop", "Chats zinaishia wapi")}</h2><span className="small muted">{T("Chats started in this period, compared with the period before.", "Chats zilizoanza kipindi hiki, ikilinganishwa na kilichopita.")}</span></div>
            {funnel.map(([l, v, c]) => {
              const pv = { chats: prev.chats, replied: prev.replied, priced: prev.priced, paymentSignals: prev.paymentSignals, attributedSales: prev.attributedSales } as Record<string, Metric>;
              const key = v === mx.chats ? "chats" : v === mx.replied ? "replied" : v === mx.priced ? "priced" : v === mx.paymentSignals ? "paymentSignals" : "attributedSales";
              const d = delta(v, pv[key]);
              const share = mx.chats.value ? Number(v.value) / Number(mx.chats.value) : 0;
              return (
                <div className="fstep" key={l}><span>{l} <SourceBadge p={v.provenance} lang={lang} compact /></span>
                  <div className={"bar " + c}><i style={{ width: `${share * 100}%` }} /></div>
                  <span className="num" style={{ textAlign: "right" }}>{v.value} · {pct(share)}{d != null && <span className={"small " + (d >= 0 ? "ok" : "err")}> {d >= 0 ? "↑" : "↓"}{Math.abs(Math.round(d * 100))}%</span>}</span></div>
              );
            })}
            <p className="small muted" style={{ margin: 0 }}>{T(`Sources: ${fmt(mx.adChats.value)} from ads · ${fmt(mx.organicChats.value)} organic · ${fmt(mx.unknownChats.value)} unknown. Attributed = paid within ${ws.conversion_window_days} days of the chat starting.`, `Vyanzo: ${fmt(mx.adChats.value)} matangazo · ${fmt(mx.organicChats.value)} moja kwa moja · ${fmt(mx.unknownChats.value)} haijulikani. Zimeunganishwa = zililipwa ndani ya siku ${ws.conversion_window_days} tangu chat ianze.`)}</p>
          </section>
        </div>

        <div className="two">
          <section className="card">
            <div className="row between"><h2>{T("What to fix this week", "Cha kurekebisha wiki hii")}</h2><a href="#report" className="small">{T("Full diagnosis →", "Uchunguzi kamili →")}</a></div>
            {findings.map((f) => (
              <div className={"finding " + f.severity} key={f.kind}>
                <b>{f.title[lang]}</b>
                <span className="small">{f.observed[lang]}</span>
                <span className="small muted">{T("Suggested", "Pendekezo")}: {f.action[lang]} · <span className={"chip conf-" + f.confidence}>{T("confidence", "uhakika")}: {f.confidence}</span></span>
              </div>
            ))}
            {(mx.warmNoFollowUp.value ?? 0) > 0 && <a href="#actions" className="small">{T("Open the follow-up queue →", "Fungua foleni ya ufuatiliaji →")}</a>}
          </section>
          <section className="card">
            <h2>{T("Data coverage & sources", "Ukamilifu wa data na vyanzo")}</h2>
            <Cov label={T("Ad account", "Akaunti ya matangazo")} ok={adsConn.length > 0 && adsConn.every((c) => c.status === "active")} note={adsConn.length ? `${T("last successful sync", "usawazishaji wa mwisho")} ${ago(lastSync)}${adsConn.some((c) => c.last_error) ? " · " + T("last run had an error", "mara ya mwisho kulikuwa na hitilafu") : ""}` : T("not connected", "haijaunganishwa")} />
            <Cov label="WhatsApp" ok={waConn.length > 0} note={waConn.length ? `${g.nums.map((n) => n.display_phone ?? n.phone_number_id).join(", ")} · ${T("history", "historia")}: ${g.nums[0]?.history_status ?? "–"}` : T("not connected; using uploaded chat exports", "haijaunganishwa; chats zilizopakiwa tu")} />
            <Cov label={T("Webhook events", "Matukio ya webhook")} ok={!failed || failed.events === 0} note={g.health.length ? g.health.map((h) => `${h.status}: ${h.events}`).join(" · ") : T("none received yet", "hakuna bado")} />
            <Cov label={T("Chat sources known", "Vyanzo vya chats vinajulikana")} ok={(mx.coverage.knownSourceShare ?? 0) >= 0.5} note={mx.coverage.knownSourceShare == null ? "–" : pct(mx.coverage.knownSourceShare) + " " + T("of chats have a known source", "ya chats zina chanzo")} />
            <Cov label={T("Read by Kito", "Zimesomwa na Kito")} ok={(mx.coverage.kitoReadShare ?? 0) >= 0.7} note={mx.coverage.kitoReadShare == null ? "–" : pct(mx.coverage.kitoReadShare) + " " + T("of chats this period", "ya chats kipindi hiki")} />
            <Cov label={T("Exchange rate", "Kiwango cha kubadilisha")} ok={!mx.coverage.fxNeeded || mx.coverage.fxSet} note={!mx.coverage.fxNeeded ? T("not needed", "haihitajiki") : mx.coverage.fxSet ? `1 ${adCur} = ${fmt(ws.fx_rate)} ${ws.currency}` : T("needed for return on ad spend", "inahitajika kwa mapato kwa tangazo")} />
            <Cov label={T("Costs", "Gharama")} ok={mx.coverage.unitCostSet || mx.coverage.expensesCount > 0} note={mx.coverage.unitCostSet ? `${T("cost per order", "gharama kwa oda")} ${money(ws.unit_cost, ws.currency)}` : mx.coverage.expensesCount ? `${mx.coverage.expensesCount} ${T("imported expenses", "matumizi yaliyoingizwa")}` : T("none; contribution hidden", "hakuna; faida haionyeshwi")} />
            <Cov label={T("Orders", "Oda")} ok={(mx.ordersPaid.value ?? 0) > 0 || (mx.chats.value ?? 0) === 0} note={`${fmt(mx.ordersPaid.value)} ${T("paid", "zilizolipwa")} · ${money(mx.revenueManual.value, ws.currency)} ${T("confirmed by you", "umethibitisha")} · ${money(mx.revenueImported.value, ws.currency)} ${T("imported", "zimeingizwa")}${mx.ordersUnlinked.value ? ` · ${mx.ordersUnlinked.value} ${T("not linked to a chat", "hazijaunganishwa na chat")}` : ""}`} />
            <ProvenanceLegend lang={lang} />
          </section>
        </div>

        <section className="card">
          {costBars.kind === "sale" ? (
            <div><h2>{T("What an attributed sale costs", "Mauzo moja yanagharimu kiasi gani")}</h2><span className="small muted">{T("Spend ÷ paid orders from the ad's chats, " + adCur + ". Shorter is cheaper. A matched estimate.", "Matumizi ÷ oda zilizolipwa kutoka chats za tangazo, " + adCur + ". Fupi ni nafuu. Ni makadirio.")}</span></div>
          ) : (
            <div><h2>{T("What a chat costs", "Chat moja inagharimu kiasi gani")}</h2><span className="small muted">{T("No paid orders linked to ad chats yet, so this shows cost per chat started (Meta), " + adCur + ". Record orders in Chats to see cost per sale.", "Bado hakuna oda zilizounganishwa na matangazo, kwa hiyo hii ni gharama kwa chat (Meta), " + adCur + ". Rekodi oda kwenye Chats kuona gharama kwa mauzo.")}</span></div>
          )}
          {costBars.items.length ? <CostBars items={costBars.items} bestLabel={T("best", "bora")} f={(n) => amt(n, adCur)} /> : <span className="small muted">–</span>}
        </section>

        <div className="two">
          <section className="card">
            <div><h2>{T("Where the money went", "Pesa ilienda wapi")}</h2><span className="small muted">{T("Spend by ad, ", "Matumizi kwa tangazo, ") + adCur}</span></div>
            <SpendSplit total={mx.spend.value ?? 0} f={(n) => amt(n, adCur)} items={ads.filter((a) => Number(a.spend) > 0).map((a) => ({ name: a.ad_name ?? a.ad_id, value: Number(a.spend) }))} />
          </section>
          <section className="card">
            <h2>{T("Objections in unsold chats", "Pingamizi kwenye chats zisizouza")}</h2>
            <Objections convs={g.convs} mx={mx} lang={lang} tz={ws.timezone} />
          </section>
        </div>

        <section className="card">
          <h2>{T("Ads: chats vs confirmed paying customers", "Matangazo: chats dhidi ya wateja waliothibitishwa")}</h2>
          <div className="scroll"><table>
            <thead><tr><th>#</th><th>Ad</th><th className="n">Spend ({adCur})</th><th className="n">Clicks</th><th className="n">Chats (Meta)</th><th className="n">Chats seen</th><th className="n">Price shared</th><th className="n">{T("Signals", "Dalili")}</th><th className="n">{T("Paid (confirmed)", "Oda zilizolipwa")}</th><th className="n">{T("Cost / sale", "Gharama / mauzo")}</th></tr></thead>
            <tbody>
              {ads.map((a, i) => (
                <tr key={a.ad_id}>
                  <td className="rank">{String(i + 1).padStart(2, "0")}</td>
                  <td><b>{a.ad_name ?? a.ad_id}</b><div className="small muted">{a.campaign_name}</div></td>
                  <td className="n">{amt(Number(a.spend), adCur)}</td><td className="n">{fmt(a.clicks)}</td><td className="n">{fmt(a.platform_conversations)}</td><td className="n">{fmt(a.chats)}</td>
                  <td className="n">{fmt(a.priced)}</td><td className="n muted">{fmt(a.payment_signals)}</td><td className="n"><b>{fmt(a.sold)}</b></td>
                  <td className="n">{!(Number(a.sold) > 0) ? (a.spend > 0 && a.chats > 0 ? <span className="chip bad">{T("no confirmed sales", "hakuna mauzo yaliyothibitishwa")}</span> : "–") : amt(Number(a.spend) / Number(a.sold), adCur)}</td>
                </tr>
              ))}
              {!ads.length && <tr><td colSpan={10} className="muted small">{T("No ad data for this period.", "Hakuna data ya matangazo kipindi hiki.")}</td></tr>}
            </tbody>
          </table></div>
          <p className="small muted" style={{ margin: 0 }}>{T("“Chats seen” are chats GrowthOS linked to the ad through WhatsApp’s ad referral: a matched link, not proof the ad caused a purchase. “Signals” are inferred payments (words, screenshots, Kito) and are not counted as sales. Cost per sale uses only paid orders recorded in GrowthOS and paid within the conversion window.", "“Chats seen” ni chats ambazo GrowthOS imeziunganisha na tangazo kupitia referral ya WhatsApp: ni uhusiano, si uthibitisho kuwa tangazo limesababisha ununuzi. “Dalili” ni malipo yaliyokisiwa (maneno, picha, Kito) na hayahesabiwi kama mauzo. Gharama kwa mauzo hutumia oda zilizolipwa na kurekodiwa GrowthOS ndani ya dirisha la uthibitisho.")}</p>
        </section>
      </>)}
    </div>
  );
}

function Objections({ convs, mx, lang, tz }: { convs: any[]; mx: any; lang: "sw" | "en"; tz: string }) {
  const list = useMemo(() => {
    const inP = convs.filter((c) => c.started_at && localDay(c.started_at, tz) >= mx.period.from && localDay(c.started_at, tz) <= mx.period.to);
    const tally: Record<string, number> = {};
    for (const c of inP) if (c.outcome !== "sold") for (const o of new Set([...(c.objections ?? []), ...(c.kito_objections ?? [])])) tally[o as string] = (tally[o as string] ?? 0) + 1;
    return Object.entries(tally).sort((a, b) => b[1] - a[1]);
  }, [convs, mx.period.from, mx.period.to, tz]);
  if (!list.length) return <span className="small muted">–</span>;
  return <>{list.map(([k, n]) => <div className="row between small" key={k}><span>{L[lang].obj[k] ?? k}</span><b>{n}</b></div>)}</>;
}

function Cov({ label, ok, note }: { label: string; ok: boolean; note: string }) {
  return <div className="row between small" style={{ gap: 8 }}><span><span className={"status-dot " + (ok ? "on" : "err")} /> {label}</span><span className="muted" style={{ textAlign: "right" }}>{note}</span></div>;
}

/** KPI tile. Pass `n` + `f` to count the value up on load instead of showing `v` at once. */
function Kpi({ k, v, s, cls = "", n, f, d, invert, src, title }: { k: string; v: string; s?: string; cls?: string; n?: number | null; f?: (x: number) => string; d?: number | null; invert?: boolean; src?: string; title?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => { if (n != null && isFinite(n) && f) countTo(ref.current, n, f, { duration: 1.2, delay: 0.3 }); }, [n, f]);
  const good = d == null ? null : invert ? d < 0 : d > 0;
  return (
    <div className={"kpi " + cls} title={title}>
      <span className="k">{src && <SourceBadge p={src as any} lang="en" />}<span>{k}</span></span>
      <span className="v" ref={ref}>{v}</span>
      <span className="s">{d != null && <span className={"delta " + (good ? "down" : "up")}>{d > 0 ? "↑" : "↓"} {Math.abs(Math.round(d * 100))}%</span>}{s && <span>{s}</span>}</span>
    </div>
  );
}

/** Greeting by the hour in the business's timezone (falls back to the device clock). */
function greeting(lang: "sw" | "en", tz?: string | null) {
  let h = new Date().getHours();
  try { if (tz) h = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(new Date())); } catch { /* bad tz: keep device hour */ }
  if (lang === "sw") return h < 5 ? "Habari za usiku" : h < 12 ? "Habari za asubuhi" : h < 16 ? "Habari za mchana" : h < 19 ? "Habari za jioni" : "Habari za usiku";
  return h < 5 ? "Hello, night owl" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

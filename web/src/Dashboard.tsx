import { useEffect, useMemo, useRef, useState } from "react";
import { countTo, enterCards, enterRows, growBars, usePageEnter, select } from "./motion";
import { supabase, Workspace, Outcome, AdPerf, fmt, tzs, pct, dur, median, daysAgo, L, amt, money } from "./lib";
import { TrendChart, SpendSplit, CostBars } from "./Charts";

export default function Dashboard({ ws }: { ws: Workspace }) {
  const [days, setDays] = useState(14);
  const [lang, setLang] = useState<"sw" | "en">(ws.language);
  const [ads, setAds] = useState<AdPerf[]>([]);
  const [convs, setConvs] = useState<Outcome[]>([]);
  const [daily, setDaily] = useState<{ day: string; spend: number }[]>([]);
  const [adCur, setAdCur] = useState<string>(ws.currency);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const T = (en: string, sw: string) => (lang === "sw" ? sw : en);

  useEffect(() => {
    let live = true;
    setLoading(true); setErr("");
    const from = daysAgo(days - 1), to = daysAgo(0);
    Promise.all([
      supabase.rpc("ad_performance", { p_ws: ws.id, p_from: from, p_to: to }),
      supabase.from("conversation_outcomes").select("*").eq("workspace_id", ws.id).gte("started_at", from + "T00:00:00+03:00").limit(5000),
      supabase.from("ad_insights_daily").select("day,spend,currency").eq("workspace_id", ws.id).gte("day", daysAgo(days * 2 - 1)).lte("day", to).limit(10000),
    ]).then(([a, c, d]) => {
      if (!live) return;
      if (a.error || c.error) setErr((a.error || c.error)!.message);
      setAds((a.data as AdPerf[]) ?? []); setConvs((c.data as Outcome[]) ?? []);
      const rows = (d.data as any[]) ?? [];
      setDaily(rows.map((r) => ({ day: r.day, spend: Number(r.spend) })));
      if (rows.length) setAdCur(rows[rows.length - 1].currency || ws.currency);
      setLoading(false);
    });
    return () => { live = false; };
  }, [ws.id, days]);

  const m = useMemo(() => {
    const spend = ads.reduce((s, a) => s + Number(a.spend), 0);
    const platformConv = ads.reduce((s, a) => s + Number(a.platform_conversations), 0);
    const adChats = convs.filter((c) => c.source === "ad");
    const sold = convs.filter((c) => c.outcome === "sold");
    const adSold = adChats.filter((c) => c.outcome === "sold");
    const revenue = sold.reduce((s, c) => s + Number(c.sale_amount ?? c.kito_amount ?? c.payment_amount ?? 0), 0);
    const adRevenue = adSold.reduce((s, c) => s + Number(c.sale_amount ?? c.kito_amount ?? c.payment_amount ?? 0), 0);
    const frt = convs.map((c) => c.first_response_sec).filter((x): x is number => x != null);
    const warm = convs.filter((c) => (c.kito_temp ? c.kito_temp !== "cold" : c.warm) && c.outcome !== "sold");
    const warmNoFollow = warm.filter((c) => !c.followed_up);
    const objections: Record<string, number> = {};
    for (const c of convs) if (c.outcome !== "sold") for (const o of new Set([...(c.objections ?? []), ...(c.kito_objections ?? [])])) objections[o] = (objections[o] ?? 0) + 1;
    const stages: Record<string, number> = {};
    for (const c of convs) if (c.outcome === "lost" && c.stage) stages[c.stage] = (stages[c.stage] ?? 0) + 1;
    const unconfirmed = convs.filter((c) => c.payment_signal && c.sale_provenance !== "owner_confirmed").length;
    return {
      spend, platformConv, chats: convs.length, adChats: adChats.length, replied: convs.filter((c) => c.first_response_sec != null).length,
      priced: convs.filter((c) => c.price_shared).length, sold: sold.length, adSold: adSold.length, revenue, adRevenue,
      conv: convs.length ? sold.length / convs.length : 0, adConv: adChats.length ? adSold.length / adChats.length : null,
      costPerChat: platformConv ? spend / platformConv : null, costPerSale: adSold.length ? spend / adSold.length : null,
      roas: spend && (adCur === ws.currency || ws.fx_rate) ? adRevenue / (spend * (adCur === ws.currency ? 1 : Number(ws.fx_rate))) : null, frtMedian: median(frt), over1h: frt.filter((x) => x > 3600).length,
      noReply: convs.filter((c) => c.stage === "no_reply").length, warm: warm.length, warmNoFollow,
      silentAfterPrice: convs.filter((c) => c.stage === "silent_after_price" && c.outcome !== "sold").length,
      objections: Object.entries(objections).sort((a, b) => b[1] - a[1]), stages, unconfirmed,
      soldAfterFollow: sold.filter((c) => c.followed_up).length,
    };
  }, [ads, convs, adCur, ws.currency, ws.fx_rate]);

  const costBars = useMemo(() => {
    const withSales = ads.filter((a) => Number(a.sold) > 0);
    if (withSales.length) return { kind: "sale" as const, items: withSales.map((a) => ({ name: a.ad_name ?? a.ad_id, cost: Number(a.spend) / Number(a.sold), note: `${amt(Number(a.spend), adCur)} · ${a.sold} ${lang === "sw" ? "mauzo" : "sales"}` })).sort((x, y) => x.cost - y.cost).slice(0, 8) };
    return { kind: "chat" as const, items: ads.filter((a) => Number(a.platform_conversations) > 0 && Number(a.spend) > 0).map((a) => ({ name: a.ad_name ?? a.ad_id, cost: Number(a.spend) / Number(a.platform_conversations), note: `${amt(Number(a.spend), adCur)} · ${fmt(a.platform_conversations)} chats` })).sort((x, y) => x.cost - y.cost).slice(0, 8) };
  }, [ads, lang, adCur]);

  const trend = useMemo(() => {
    const byDay: Record<string, number> = {};
    for (const r of daily) byDay[r.day] = (byDay[r.day] ?? 0) + r.spend;
    const cur: number[] = [], prev: number[] = [], labels: string[] = [];
    for (let i = days - 1; i >= 0; i--) { labels.push(daysAgo(i)); cur.push(byDay[daysAgo(i)] ?? 0); prev.push(byDay[daysAgo(i + days)] ?? 0); }
    const sc = cur.reduce((a, b) => a + b, 0), sp = prev.reduce((a, b) => a + b, 0);
    return { labels, cur, prev, total: sc, change: sp ? (sc - sp) / sp : null };
  }, [daily, days]);

  const findings = useMemo(() => {
    const f: [string, string, string][] = [];
    if (m.spend && m.costPerChat && m.adConv != null && m.adConv < 0.2 && m.adChats >= 5)
      f.push(["bad", T("Ads bring chats cheaply. Chats aren't turning into sales.", "Matangazo yanaleta chats kwa bei nafuu. Chats hazigeuki mauzo."),
        T(`${money(m.costPerChat, adCur)} per chat, but only ${pct(m.adConv)} of ad chats paid. Fix the sales conversation before raising the budget.`,
          `${money(m.costPerChat, adCur)} kwa chat, lakini ${pct(m.adConv)} tu ya chats za matangazo walilipa. Rekebisha mazungumzo ya mauzo kabla ya kuongeza bajeti.`)]);
    if (m.warmNoFollow.length) f.push(["bad", T(`${m.warmNoFollow.length} warm leads have no follow-up`, `Wateja moto ${m.warmNoFollow.length} hawajafuatiliwa`),
      T(`They asked the price, raised a doubt or said "later", and heard nothing after going quiet.${m.soldAfterFollow ? ` ${m.soldAfterFollow} sales this period came after a follow-up.` : ""}`,
        `Waliuliza bei, walikuwa na wasiwasi au walisema "baadae", na hawakupata ujumbe baada ya kunyamaza.${m.soldAfterFollow ? ` Mauzo ${m.soldAfterFollow} kipindi hiki yalikuja baada ya ufuatiliaji.` : ""}`)]);
    const top = m.objections[0];
    if (top && top[1] >= 2) f.push(["warn", T(`Top objection: ${L.en.obj[top[0]]}`, `Pingamizi kuu: ${L.sw.obj[top[0]]}`), T(`${top[1]} unsold chats. Prepare one tested reply for it.`, `Chats ${top[1]} ambazo hazikuuza. Andaa jibu moja lililojaribiwa.`)]);
    if (m.silentAfterPrice >= 2) f.push(["warn", T(`${m.silentAfterPrice} customers went silent right after the price`, `Wateja ${m.silentAfterPrice} walinyamaza baada ya bei`), T("Explain the result and proof before the number, and end the price message with a question.", "Eleza faida na ushahidi kabla ya bei, na umalize ujumbe wa bei kwa swali.")]);
    if (m.frtMedian != null && (m.frtMedian > 900 || m.over1h >= 2)) f.push(["warn", T("Replies are slow in some chats", "Majibu yanachelewa kwenye baadhi ya chats"), T(`Median first reply ${dur(m.frtMedian)}; ${m.over1h} chats waited over an hour${m.noReply ? `, ${m.noReply} never got a reply` : ""}.`, `Wastani wa kujibu ${dur(m.frtMedian)}; chats ${m.over1h} zilisubiri zaidi ya saa moja${m.noReply ? `, ${m.noReply} hazikujibiwa` : ""}.`)]);
    if (m.unconfirmed) f.push(["", T(`${m.unconfirmed} sales detected but not confirmed`, `Mauzo ${m.unconfirmed} yamegunduliwa bila kuthibitishwa`), T("Confirm them in Chats so cost per sale is exact.", "Yathibitishe kwenye Chats ili gharama kwa mauzo iwe sahihi.")]);
    if (!f.length && m.chats) f.push(["good", T("No major leak found this period", "Hakuna tatizo kubwa kipindi hiki"), T("Keep watching follow-ups and reply speed.", "Endelea kufuatilia wateja na kasi ya kujibu.")]);
    return f;
  }, [m, lang]);

  const noData = !ads.length && !convs.length;
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

  if (loading) return (
    <div className="skeletons" aria-busy="true" aria-label="Loading">
      <div className="kpis">{[0, 1, 2, 3, 4, 5, 6].map((i) => <div className="skeleton" key={i} />)}</div>
      <div className="two"><div className="skeleton" style={{ minHeight: 300 }} /><div className="skeleton" style={{ minHeight: 300 }} /></div>
    </div>
  );

  return (
    <div className="shell-grid" ref={pageRef}>
      <div className="hero">
        <div style={{ display: "grid", gap: 4 }}>
          <h2>{greeting(lang)}</h2>
          <div className="sub">
            <span><span className="dot" />{ads.filter((a) => Number(a.spend) > 0).length} {T("ads with spend", "matangazo yenye matumizi")}</span>
            <span>{fmt(m.chats)} {T("chats seen", "chats zimeonekana")}</span>
            <span>{fmt(m.sold)} {T("sales", "mauzo")}</span>
          </div>
        </div>
        <div className="row">
          <div className="seg" role="group" aria-label="Period">
            {[7, 14, 30].map((d) => <button key={d} className={days === d ? "on" : ""} onClick={() => setDays(d)} aria-pressed={days === d}>{d} {T("days", "siku")}</button>)}
          </div>
          <div className="seg" role="group" aria-label="Language">
            <button className={lang === "sw" ? "on" : ""} onClick={() => setLang("sw")} aria-pressed={lang === "sw"}>SW</button>
            <button className={lang === "en" ? "on" : ""} onClick={() => setLang("en")} aria-pressed={lang === "en"}>EN</button>
          </div>
        </div>
      </div>
      {err && <p className="err">{err}</p>}
      {noData ? (
        <div className="empty">{T("No data yet. Connect the ad account and WhatsApp in ", "Bado hakuna data. Unganisha matangazo na WhatsApp kwenye ")}<a href="#connect">{T("Connections", "Connections")}</a>.</div>
      ) : (<>
        <div className="kpis">
          <Kpi k={T("Ad spend", "Matumizi ya matangazo")} v={money(m.spend, adCur)} n={m.spend} f={(x) => money(x, adCur)} s={`${fmt(m.platformConv)} ${T("chats (Meta)", "chats (Meta)")}`} />
          <Kpi k={T("Cost per chat", "Gharama kwa chat")} v={money(m.costPerChat, adCur)} n={m.costPerChat} f={(x) => money(x, adCur)} s={T("What Ads Manager shows", "Kile Ads Manager inaonyesha")} />
          <Kpi k={T("Cost per sale", "Gharama kwa mauzo")} v={money(m.costPerSale, adCur)} n={m.costPerSale} f={(x) => money(x, adCur)} s={`${m.adSold} ${T("sales from ad chats", "mauzo kutoka matangazo")}`} cls={m.costPerSale == null ? "" : "ok"} />
          <Kpi k={T("Ad chats → paid", "Chats za matangazo → walilipa")} v={pct(m.adConv)} s={`${m.adSold} / ${m.adChats}`} cls={m.adConv != null && m.adConv < 0.15 ? "flag" : ""} />
          <Kpi k={T("Return on ad spend", "Mapato kwa kila shilingi ya tangazo")} v={m.roas == null ? "–" : m.roas.toFixed(1) + "×"} s={m.roas == null && m.adRevenue > 0 ? T("Set the exchange rate in Connections", "Weka kiwango cha kubadilisha kwenye Connections") : tzs(m.adRevenue) + T(" revenue", " mapato")} />
          <Kpi k={T("Median first reply", "Muda wa kujibu")} v={dur(m.frtMedian)} s={`${m.over1h} ${T("waited over 1 h", "zilisubiri > saa 1")}`} cls={m.frtMedian != null && m.frtMedian > 900 ? "flag" : ""} />
          <Kpi k={T("Warm leads, no follow-up", "Wateja moto bila ufuatiliaji")} v={fmt(m.warmNoFollow.length)} n={m.warmNoFollow.length} f={(x) => fmt(Math.round(x))} s={`${T("of", "kati ya")} ${m.warm}`} cls={m.warmNoFollow.length ? "flag" : "ok"} />
        </div>

        <div className="two">
          <section className="card">
            <div className="row between">
              <div><h2>{T("Ad spend per day", "Matumizi ya matangazo kwa siku")}</h2><span className="small muted">{T("Solid: this period. Dashed: the one before.", "Mstari kamili: kipindi hiki. Wenye nukta: kilichopita.")}</span></div>
              {trend.change != null && <span className={"delta " + (trend.change > 0 ? "up" : "down")}>{trend.change > 0 ? "↑" : "↓"} {Math.abs(Math.round(trend.change * 100))}%</span>}
            </div>
            <div className="big" ref={totalRef}>{money(trend.total, adCur)}</div>
            <TrendChart days={trend.labels} cur={trend.cur} prev={trend.prev} />
          </section>
          <section className="card">
            <div><h2>{T("Where the money went", "Pesa ilienda wapi")}</h2><span className="small muted">{T("Spend by ad, ", "Matumizi kwa tangazo, ") + adCur}</span></div>
            <SpendSplit total={m.spend} f={(n) => amt(n, adCur)} items={ads.filter((a) => Number(a.spend) > 0).map((a) => ({ name: a.ad_name ?? a.ad_id, value: Number(a.spend) }))} />
          </section>
        </div>

        <section className="card">
          {costBars.kind === "sale" ? (
            <div><h2>{T("What a sale costs", "Mauzo moja yanagharimu kiasi gani")}</h2><span className="small muted">{T("Spend ÷ paying customers, per ad, " + adCur + ". Shorter is cheaper.", "Matumizi ÷ wateja waliolipa, kwa tangazo, " + adCur + ". Fupi ni nafuu.")}</span></div>
          ) : (
            <div><h2>{T("What a chat costs", "Chat moja inagharimu kiasi gani")}</h2><span className="small muted">{T("No sales linked to ads yet, so this shows cost per chat started (Meta), " + adCur + ". Upload or connect chats to see cost per sale.", "Bado hakuna mauzo yaliyounganishwa na matangazo, kwa hiyo hii ni gharama kwa chat (Meta), " + adCur + ". Weka au unganisha chats kuona gharama kwa mauzo.")}</span></div>
          )}
          {costBars.items.length ? <CostBars items={costBars.items} bestLabel={T("best", "bora")} f={(n) => amt(n, adCur)} /> : <span className="small muted">–</span>}
        </section>

        <section className="card">
          <h2>{T("Ads: chats vs paying customers", "Matangazo: chats dhidi ya wateja waliolipa")}</h2>
          <div className="scroll"><table>
            <thead><tr><th>#</th><th>Ad</th><th className="n">Spend ({adCur})</th><th className="n">Chats (Meta)</th><th className="n">Chats seen</th><th className="n">Price shared</th><th className="n">Paid</th><th className="n">Cost / sale</th></tr></thead>
            <tbody>
              {ads.map((a, i) => (
                <tr key={a.ad_id}>
                  <td className="rank">{String(i + 1).padStart(2, "0")}</td>
                  <td><b>{a.ad_name ?? a.ad_id}</b><div className="small muted">{a.campaign_name}</div></td>
                  <td className="n">{amt(Number(a.spend), adCur)}</td><td className="n">{fmt(a.platform_conversations)}</td><td className="n">{fmt(a.chats)}</td>
                  <td className="n">{fmt(a.priced)}</td><td className="n"><b>{fmt(a.sold)}</b></td>
                  <td className="n">{!(Number(a.sold) > 0) ? (a.spend > 0 && a.chats > 0 ? <span className="chip bad">{T("no sales", "hakuna mauzo")}</span> : "–") : amt(Number(a.spend) / Number(a.sold), adCur)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <p className="small muted" style={{ margin: 0 }}>{T("\"Chats seen\" are chats GrowthOS linked to the ad through WhatsApp's ad referral. Sales are confirmed or detected payments.", "\"Chats seen\" ni chats ambazo GrowthOS imeziunganisha na tangazo kupitia WhatsApp. Mauzo ni malipo yaliyothibitishwa au kugunduliwa.")}</p>
        </section>

        <div className="two">
          <section className="card">
            <h2>{T("Where chats stop", "Chats zinaishia wapi")}</h2>
            {[
              [T("Chats", "Chats"), m.chats, ""], [T("Got a reply", "Walijibiwa"), m.replied, ""],
              [T("Price shared", "Bei ilitolewa"), m.priced, ""], [T("Paid", "Walilipa"), m.sold, "good"],
            ].map(([l, v, c]) => (
              <div className="fstep" key={l as string}><span>{l}</span>
                <div className={"bar " + c}><i style={{ width: `${m.chats ? (Number(v) / m.chats) * 100 : 0}%` }} /></div>
                <span className="num" style={{ textAlign: "right" }}>{v} · {pct(m.chats ? Number(v) / m.chats : 0)}</span></div>
            ))}
            <h3>{T("Objections in unsold chats", "Pingamizi kwenye chats zisizouza")}</h3>
            {m.objections.length ? m.objections.map(([k, n]) => <div className="row between small" key={k}><span>{L[lang].obj[k]}</span><b>{n}</b></div>) : <span className="small muted">–</span>}
          </section>
          <section className="card">
            <h2>{T("What to fix", "Cha kurekebisha")}</h2>
            {findings.map(([c, h, b], i) => <div className={"finding " + c} key={i}><b>{h}</b><span className="small">{b}</span></div>)}
            {m.warmNoFollow.length > 0 && <a href="#chats" className="small">{T("Open warm leads →", "Fungua wateja moto →")}</a>}
          </section>
        </div>
      </>)}
    </div>
  );
}

/** KPI tile. Pass `n` + `f` to count the value up on load instead of showing `v` at once. */
function Kpi({ k, v, s, cls = "", n, f }: { k: string; v: string; s?: string; cls?: string; n?: number | null; f?: (x: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => { if (n != null && isFinite(n) && f) countTo(ref.current, n, f, { duration: 1.2, delay: 0.3 }); }, [n, f]);
  return <div className={"kpi " + cls}><span className="k">{k}</span><span className="v" ref={ref}>{v}</span>{s && <span className="s">{s}</span>}</div>;
}

function greeting(lang: "sw" | "en") {
  const h = new Date().getHours();
  if (lang === "sw") return h < 12 ? "Habari za asubuhi" : h < 16 ? "Habari za mchana" : "Habari za jioni";
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

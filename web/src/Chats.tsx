import { enterCards, enterRows, usePageEnter, select } from "./motion";
import { useEffect, useState } from "react";
import { supabase, callFn, Workspace, Outcome, Task, dur, fmt, L, when, canEdit, canManage } from "./lib";
import { OrderForm, OrderList, inferredFrom } from "./Orders";

type Filter = "follow" | "lost" | "open" | "sold" | "signals" | "all" | "ids";
type Source = "any" | "live" | "import";
type Lite = { id: string; outcome: string | null; kito_temp: string | null; warm: boolean; paid_orders: number; payment_signal: boolean; kito_outcome: string | null; outcome_override: string | null; phone_number_id: string };

/** Same rules as the database filters below, used to count each tab. */
const inFilter = (r: Lite, f: Filter) =>
  f === "all" ? true
  : f === "follow" ? r.outcome !== "sold" && (r.kito_temp === "hot" || r.kito_temp === "warm" || (r.kito_temp == null && r.warm))
  : f === "signals" ? Number(r.paid_orders) === 0 && (r.payment_signal || r.kito_outcome === "sold" || r.outcome_override === "sold")
  : r.outcome === f;
const inSource = (r: Lite, s: Source) => s === "any" || (s === "import" ? r.phone_number_id === "import" : r.phone_number_id !== "import");
type Run = { id: number; trigger: "auto" | "manual"; ran_at: string; checked: number; failed: number; remaining: number; note: string | null };
type Msg = { id: string; direction: "in" | "out"; sent_at: string; body: string | null; origin: string };

const hashIds = () => {
  const m = location.hash.match(/#chats\/ids=([0-9a-f,-]+)/i);
  return m ? m[1].split(",").filter(Boolean).slice(0, 100) : null;
};

export default function Chats({ ws }: { ws: Workspace }) {
  const [ids, setIds] = useState<string[] | null>(hashIds());
  const [filter, setFilter] = useState<Filter>(ids ? "ids" : "all");
  const [rows, setRows] = useState<Outcome[]>([]);
  const [src, setSrc] = useState<Source>("any");
  const [lite, setLite] = useState<Lite[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [adNames, setAdNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [runs, setRuns] = useState<Run[]>([]);
  const [tasks, setTasks] = useState<Record<string, Task>>({});
  const [autoDone, setAutoDone] = useState(false);
  const [err, setErr] = useState("");
  const lang = ws.language;
  const T = (en: string, sw: string) => (lang === "sw" ? sw : en);

  useEffect(() => {
    const onHash = () => { const i = hashIds(); setIds(i); if (i) setFilter("ids"); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    setLoading(true); setErr("");
    let q = supabase.from("conversation_outcomes").select("*").eq("workspace_id", ws.id).order("last_message_at", { ascending: false }).limit(300);
    if (filter !== "ids" && src === "import") q = q.eq("phone_number_id", "import");
    else if (filter !== "ids" && src === "live") q = q.neq("phone_number_id", "import");
    if (filter === "ids" && ids) q = q.in("id", ids);
    else if (filter === "follow") q = q.neq("outcome", "sold").or("kito_temp.in.(hot,warm),and(kito_temp.is.null,warm.eq.true)");
    else if (filter === "signals") q = q.eq("paid_orders", 0).or("payment_signal.eq.true,kito_outcome.eq.sold,outcome_override.eq.sold");
    else if (filter !== "all") q = q.eq("outcome", filter);
    supabase.from("kito_runs").select("id,trigger,ran_at,checked,failed,remaining,note").eq("workspace_id", ws.id).order("ran_at", { ascending: false }).limit(20)
      .then(({ data }) => setRuns((data as Run[]) ?? []));
    supabase.from("conversation_outcomes").select("id,outcome,kito_temp,warm,paid_orders,payment_signal,kito_outcome,outcome_override,phone_number_id").eq("workspace_id", ws.id).limit(2000)
      .then(({ data }) => setLite((data as Lite[]) ?? []));
    Promise.all([
      q,
      supabase.from("ads").select("ad_id,name").eq("workspace_id", ws.id),
      supabase.from("follow_up_tasks").select("*").eq("workspace_id", ws.id).in("status", ["open", "snoozed"]),
    ]).then(([c, a, t]) => {
      if (c.error) setErr(c.error.message);
      let list = (c.data as Outcome[]) ?? [];
      if (filter === "follow") {
        const rank = (r: Outcome) => (tempOf(r) === "hot" ? 0 : 1) * 10 + (r.last_dir === "in" ? 0 : 1);
        list = [...list].sort((a, b) => rank(a) - rank(b) || Date.parse(a.last_message_at ?? "") - Date.parse(b.last_message_at ?? ""));
      }
      setRows(list);
      setAdNames(Object.fromEntries((a.data ?? []).map((x: any) => [x.ad_id, x.name])));
      setTasks(Object.fromEntries(((t.data ?? []) as Task[]).map((task) => [task.conversation_id, task])));
      setLoading(false);
    });
  }, [ws.id, filter, ids, tick, src]);

  const refresh = () => setTick((t) => t + 1);
  const [rechecking, setRechecking] = useState(false);
  const [note, setNote] = useState("");
  async function runKito(quiet = false) {
    setRechecking(true); setNote(quiet ? "Kito is reading new chats…" : "Kito is reading the chats…");
    try {
      let total = 0;
      for (let i = 0; i < 10; i++) {
        const r = await callFn<{ checked: number; failed: number; remaining: number; last_error?: string }>("kito", { workspace_id: ws.id });
        total += r.checked;
        if (r.failed && r.last_error) { setNote(`Kito checked ${total} chats, then stopped: ${r.last_error}`); refresh(); setRechecking(false); return; }
        if (!r.remaining || !r.checked) break;
        setNote(`Kito has checked ${total} chats, ${r.remaining} to go…`);
      }
      setNote(total ? `Kito checked ${total} chats.` : quiet ? "" : "Kito is up to date. No new or changed chats."); refresh();
    } catch (e) { setNote(quiet ? "" : (e as Error).message); }
    setRechecking(false);
  }
  useEffect(() => {
    if (autoDone) return;
    setAutoDone(true);
    (async () => {
      const { data } = await supabase.from("conversations").select("id,label,last_message_at,kito_checked_at").eq("workspace_id", ws.id).limit(1000);
      const all = data ?? [];
      try {
        if (all.some((c) => c.label == null && c.last_message_at)) { await callFn("chat-import", { workspace_id: ws.id, action: "reanalyze" }); refresh(); }
        if (all.some((c) => c.last_message_at && (!c.kito_checked_at || Date.parse(c.last_message_at) > Date.parse(c.kito_checked_at)))) await runKito(true);
      } catch { /* the 15-minute background run will pick it up */ }
    })();
  }, [ws.id]);
  async function recheck() {
    setRechecking(true); setNote("");
    try { const r = await callFn<{ reanalyzed: number }>("chat-import", { workspace_id: ws.id, action: "reanalyze" }); setNote(`Re-checked ${r.reanalyzed} chats.`); refresh(); }
    catch (e) { setNote((e as Error).message); }
    setRechecking(false);
  }

  const pageRef = usePageEnter<HTMLElement>((root) => {
    if (loading) return;
    enterCards(root, { y: 18 });
    enterRows(select(root, "table tbody tr"), { delay: 0.3, stagger: 0.04 });
  }, [loading, filter]);
  const pick = (f: Filter) => { setIds(null); setFilter(f); if (location.hash !== "#chats") history.replaceState(null, "", "#chats"); };
  const pool = lite.filter((r) => inSource(r, src));
  const count = (f: Filter) => pool.filter((r) => inFilter(r, f)).length;
  const imported = lite.filter((r) => r.phone_number_id === "import").length;
  // Everything first, then what needs me now, then where each chat stands.
  const groups: [Filter, string][][] = [
    [["all", T("All", "Wote")]],
    [["follow", T("To follow up", "Wa kufuatilia")], ["signals", T("Payments to confirm", "Malipo ya kuthibitisha")]],
    [["open", T("Open", "Bado wazi")], ["sold", T("Sold", "Waliouziwa")], ["lost", T("Lost", "Waliopotea")]],
  ];
  async function deleteImported() {
    const list = lite.filter((r) => r.phone_number_id === "import").map((r) => r.id);
    if (!list.length) return;
    if (!confirm(T(`Delete all ${list.length} imported chats (chat exports and CSV) and their messages? Recorded orders are kept. This cannot be undone.`,
      `Futa chat ${list.length} zote zilizoingizwa (chat export na CSV) pamoja na ujumbe wake? Oda zilizorekodiwa zitabaki. Haiwezi kurudishwa.`))) return;
    setDeleting(true); setErr("");
    const { data, error } = await supabase.rpc("delete_chats", { p_ws: ws.id, p_ids: list.slice(0, 1000), p_via: "chats_page", p_request: "Chats page: delete imported" });
    setDeleting(false);
    if (error) setErr(error.message);
    else { setNote(T(`Deleted ${(data as any).deleted} imported chats.`, `Chat ${(data as any).deleted} zilizoingizwa zimefutwa.`)); setSrc("any"); refresh(); }
  }
  return (
    <section className="card" ref={pageRef}>
      <div className="chats-head">
        <div>
          <h2 style={{ margin: 0 }}>Chats <span className="muted chats-total">{fmt(lite.length)}</span></h2>
          {filter === "ids" && ids && <span className="small muted">{T(`Showing ${ids.length} chats from Kito or a report`, `Inaonyesha chat ${ids.length} kutoka Kito au ripoti`)} · <a href="#chats" onClick={() => { setIds(null); setFilter("all"); }}>{T("show all", "onyesha zote")}</a></span>}
        </div>
        <div className="row chats-tools">
          <button className="small" onClick={recheck} disabled={rechecking} title={T("Run the latest detection rules over every chat", "Endesha kanuni mpya kwenye chat zote")}>{rechecking ? T("Working…", "Inafanya kazi…") : T("Re-check rules", "Kagua kanuni upya")}</button>
          <button className="small primary" onClick={() => runKito()} disabled={rechecking} title={T("Kito (AI) reads new or changed chats and labels them. It also runs by itself every 15 minutes.", "Kito (AI) anasoma chat mpya au zilizobadilika na kuziwekea alama. Pia hujiendesha kila dakika 15.")}>✦ {T("Run Kito now", "Endesha Kito sasa")}</button>
        </div>
      </div>
      <div className="chats-bar">
        <div className="seg chats-filters" role="tablist" aria-label={T("Filter chats", "Chuja chat")}>
          {groups.map((g, gi) => (
            <span key={gi} className="chats-group">
              {g.map(([f, label]) => (
                <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "on" : ""} onClick={() => pick(f)}>
                  {label}<span className="cnt">{count(f)}</span>
                </button>
              ))}
            </span>
          ))}
        </div>
        <label className="chats-src small">
          <span className="muted">{T("Source", "Chanzo")}</span>
          <select value={src} onChange={(e) => { setSrc(e.target.value as Source); if (filter === "ids") pick("all"); }}>
            <option value="any">{T("All chats", "Chat zote")}</option>
            <option value="live">{T("Live WhatsApp", "WhatsApp hai")}</option>
            <option value="import">{T(`Imported (${imported})`, `Zilizoingizwa (${imported})`)}</option>
          </select>
        </label>
      </div>
      {src === "import" && imported > 0 && canManage(ws) && (
        <div className="row small" style={{ gap: 8 }}>
          <span className="muted">{T("Chats from uploaded chat exports and CSV files.", "Chat kutoka chat export na faili za CSV.")}</span>
          <button className="small danger" disabled={deleting} onClick={deleteImported}>{deleting ? T("Deleting…", "Inafuta…") : T(`Delete all ${imported} imported`, `Futa zote ${imported} zilizoingizwa`)}</button>
        </div>
      )}
      <p className="small muted" style={{ margin: 0 }}>{T("A chat counts as a sale only when an order is recorded. Detected payments, Kito's reading and ✅ marks are hints you confirm or correct here.", "Chat inahesabiwa kama mauzo tu oda ikirekodiwa. Malipo yaliyogunduliwa, usomaji wa Kito na alama ✅ ni dalili unazothibitisha au kusahihisha hapa.")} <a href="#connect" className="small">{T("Import orders from CSV →", "Ingiza oda kutoka CSV →")}</a></p>
      {note && <p className="small muted" style={{ margin: 0 }}>{note}</p>}
      {err && <p className="err small" style={{ margin: 0 }}>{err}</p>}
      <details>
        <summary>Kito log{runs[0] ? ` · last ran ${when(runs[0].ran_at)}` : ""}</summary>
        <p className="small muted" style={{ margin: "6px 0" }}>Kito checks by itself every 15 minutes. It only reads chats that are new or have new messages, so quiet checks cost nothing and are not listed.</p>
        {runs.length === 0 ? <p className="small muted">No runs yet.</p> : (
          <div className="scroll"><table>
            <thead><tr><th>When</th><th>How</th><th className="n">Chats read</th><th className="n">Failed</th><th className="n">Waiting</th><th>Note</th></tr></thead>
            <tbody>{runs.map((k) => (
              <tr key={k.id}><td className="small">{when(k.ran_at)}</td><td className="small">{k.trigger === "auto" ? "Automatic" : "Button"}</td>
                <td className="n">{k.checked}</td><td className="n">{k.failed || ""}</td><td className="n">{k.remaining || ""}</td><td className="small muted">{k.note ?? ""}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </details>
      {loading ? <p className="muted">Loading…</p> : rows.length === 0 ? <div className="empty">{filter === "follow" ? T("Nobody to follow up right now.", "Hakuna wa kufuatilia kwa sasa.") : filter === "signals" ? T("No detected payments waiting for confirmation.", "Hakuna malipo yaliyogunduliwa yanayosubiri uthibitisho.") : T("No chats here yet.", "Hakuna chat hapa bado.")}</div> : (
        <div className="scroll"><table>
          <thead><tr><th>{T("Customer", "Mteja")}</th><th>{T("Source", "Chanzo")}</th><th>{T("What happened", "Kilichotokea")}</th><th className="n">{T("1st reply", "Jibu la 1")}</th><th>{T("Why / next step", "Kwa nini / hatua")}</th><th>{T("Action", "Kitendo")}</th></tr></thead>
          <tbody>{rows.map((r) => <Row key={r.id} r={r} lang={lang} adName={r.ad_id ? adNames[r.ad_id] : undefined} ws={ws} task={tasks[r.id]} onChange={refresh} startOpen={filter === "ids" && rows.length <= 3} />)}</tbody>
        </table></div>
      )}
    </section>
  );
}

const tempOf = (r: Outcome): "hot" | "warm" | "cold" | null => r.kito_temp ?? (r.warm ? "warm" : null);
const daysSince = (iso: string | null) => (iso ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 864e5)) : 0);

/** Where the displayed outcome comes from, in order of precedence (mirrors the SQL view). */
function outcomeSource(r: Outcome, T: (en: string, sw: string) => string): { label: string; kind: "confirmed" | "override" | "kito" | "rules" | "stale" } {
  if (Number(r.paid_orders) > 0) return { label: T(`Confirmed: ${r.paid_orders} paid order${r.paid_orders > 1 ? "s" : ""}`, `Imethibitishwa: oda ${r.paid_orders}`), kind: "confirmed" };
  if (r.outcome_override) return { label: r.override_by ? T(`Your correction${r.override_at ? " · " + when(r.override_at) : ""}`, `Marekebisho yako${r.override_at ? " · " + when(r.override_at) : ""}`) : T("From ✅ in the saved name (not confirmed)", "Kutoka ✅ kwenye jina (haijathibitishwa)"), kind: "override" };
  if (r.kito_outcome && (r.kito_confidence === "high" || r.kito_confidence === "medium")) return { label: T(`Kito's reading (${r.kito_confidence} confidence)`, `Usomaji wa Kito (uhakika ${r.kito_confidence})`), kind: "kito" };
  if (r.auto_outcome === "open" && r.last_message_at && Date.now() - Date.parse(r.last_message_at) > 2 * 864e5) return { label: T("Rules: open chat quiet for 2+ days counts as lost", "Kanuni: chat iliyo wazi bila ujumbe siku 2+ ni iliyopotea"), kind: "stale" };
  return { label: T("Keyword rules", "Kanuni za maneno"), kind: "rules" };
}

function Row({ r, lang, adName, ws, task, onChange, startOpen }: { r: Outcome; lang: "sw" | "en"; adName?: string; ws: Workspace; task?: Task; onChange: () => void; startOpen?: boolean }) {
  const [open, setOpen] = useState(!!startOpen);
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const editor = canEdit(ws);
  const T = (en: string, sw: string) => (lang === "sw" ? sw : en);

  useEffect(() => { if (open && !msgs) loadMsgs(); }, [open]);
  async function loadMsgs() {
    const { data } = await supabase.from("messages").select("id,direction,sent_at,body,origin").eq("conversation_id", r.id).order("sent_at").limit(500);
    setMsgs((data as Msg[]) ?? []);
  }
  async function setOverride(v: "lost" | "open" | null) {
    const noteText = v ? prompt(T("Why? (optional, kept with the correction)", "Kwa nini? (si lazima)")) ?? "" : "";
    setBusy(true); setErr("");
    const { error } = await supabase.from("conversations").update({ outcome_override: v, override_note: noteText.trim().slice(0, 300) || null }).eq("id", r.id);
    if (!error && v === "lost" && task) await supabase.from("follow_up_tasks").update({ status: "dismissed" }).eq("id", task.id).eq("workspace_id", ws.id);
    setBusy(false); if (error) setErr(error.message); else onChange();
  }
  async function createFollowUp() {
    setBusy(true); setErr("");
    const { data: user } = await supabase.auth.getUser();
    const { error } = await supabase.from("follow_up_tasks").insert({
      workspace_id: ws.id, conversation_id: r.id, title: `Follow up with ${r.contact_name ?? "customer"}`,
      draft: r.kito_next ? T("Suggested next step: ", "Hatua inayopendekezwa: ") + r.kito_next : null, draft_source: r.kito_next ? "kito" : null, due_at: new Date().toISOString(), created_by: user.user?.id,
    });
    setBusy(false); if (error) setErr(error.code === "23505" ? T("A follow-up task already exists.", "Tayari kuna kazi ya kufuatilia.") : error.message); else onChange();
  }
  async function updateTask(status: "done" | "dismissed") {
    if (!task) return;
    setBusy(true); setErr("");
    const { error } = await supabase.from("follow_up_tasks").update({ status }).eq("id", task.id).eq("workspace_id", ws.id);
    setBusy(false); if (error) setErr(error.message); else onChange();
  }

  const outcome = r.outcome ?? "open";
  const src = outcomeSource(r, T);
  const temp = tempOf(r);
  const blocker = r.kito_temp ? r.kito_blocker : (r.objections ?? [])[0] ?? null;
  const days = daysSince(r.last_message_at);
  const dtxt = days === 0 ? T("today", "leo") : T(`${days} days`, `siku ${days}`);
  const waiting = r.last_dir === "in";
  const confirmed = Number(r.paid_orders) > 0;
  const signal = inferredFrom(r);
  return (
    <>
      <tr>
        <td><b>{r.contact_name ?? "Customer"}</b><div><button className="small" onClick={() => setOpen(!open)} aria-expanded={open} style={{ padding: "0", border: 0, background: "none", color: "var(--accent)" }}>{open ? T("Hide details", "Ficha maelezo") : T("View chat & details", "Ona chat na maelezo")}</button></div></td>
        <td className="small">
          {r.source === "ad" && <span className="chip">{adName ?? "Ad"}</span>}
          {r.source_label ? <span className="chip">{r.source_label}</span> : r.source !== "ad" && <span className="muted">{r.source}</span>}
        </td>
        <td><span className={"pill " + outcome}>{L[lang].outcome[outcome] ?? outcome}</span>{r.sale_amount != null && <div className="small num">{fmt(r.sale_amount)} {ws.currency}</div>}
          <div className={"small " + (src.kind === "confirmed" ? "ok" : "muted")}>{src.label}</div>
          {!confirmed && signal && <div className="small warnt">{T("Payment detected, not confirmed", "Malipo yamegunduliwa, hayajathibitishwa")} ({signal === "kito" ? "Kito" : signal === "rules" ? T("words/screenshot", "maneno/picha") : "✅"})</div>}
          {outcome === "sold" && !confirmed && r.kito_outcome && r.kito_outcome !== "sold" && <div className="small warnt">{T("Kito sees no payment in the chat", "Kito haoni malipo kwenye chat")}</div>}
          {(r.kito_label ?? r.label) && <div><span className={"chip" + (outcome === "sold" ? " ok" : "")}>{L[lang].label[(r.kito_label ?? r.label)!] ?? r.kito_label ?? r.label}</span></div>}
          {r.kito_summary ? <div className="small" style={{ marginTop: 4, minWidth: 220, whiteSpace: "normal" }}>{r.kito_summary}</div>
            : <div className="small muted" style={{ marginTop: 4 }}>{T("Kito has not read this chat yet", "Kito bado hajasoma chat hii")}</div>}</td>
        <td className="n">{dur(r.first_response_sec)}</td>
        <td style={{ minWidth: 220, whiteSpace: "normal" }}>
          {outcome === "sold" ? (
            <>
              {r.kito_temp === "hot" && <span className="chip ok">{T("Likely to reorder", "Anaweza kununua tena")}</span>}
              {(r.kito_tags ?? []).includes("repeat_buyer") && <span className="chip ok">{L[lang].tag.repeat_buyer}</span>}
            </>
          ) : (
            <>
              {temp && <span className={"temp " + temp + (r.kito_temp ? "" : " guess")} title={r.kito_temp ? "" : T("Keyword guess. Kito has not read this chat yet.", "Makisio ya maneno. Kito bado hajasoma.")}>{L[lang].temp[temp]}</span>}
              {blocker && <span className={"chip" + (blocker === "business_slow" ? " bad" : "") + (r.kito_temp ? "" : " guess")}>{L[lang].blocker[blocker] ?? blocker}</span>}
              <div className={"small " + (waiting ? "err" : days >= 3 ? "warnt" : "muted")} style={{ marginTop: 3 }}>
                {waiting ? T(`Customer is waiting for a reply · ${dtxt}`, `Mteja anasubiri jibu · ${dtxt}`)
                  : days >= 3 ? T(`Not followed up for ${days} days`, `Hajafuatiliwa kwa siku ${days}`)
                  : T(`We wrote last · ${dtxt}`, `Tulimwandikia mwisho · ${dtxt}`)}
              </div>
            </>
          )}
          {r.kito_next && <div className="small" style={{ marginTop: 3 }}>→ {r.kito_next}</div>}
        </td>
        <td>
          {task ? (
            <div className="small">
              <b>{task.title}</b> <a href="#actions" className="small">{T("open in Actions", "fungua Vitendo")}</a>
              {editor && <div className="row" style={{ gap: 6, marginTop: 4 }}>
                <button className="small" disabled={busy} onClick={() => updateTask("done")}>{T("Done", "Imekamilika")}</button>
                <button className="small" disabled={busy} onClick={() => updateTask("dismissed")}>{T("Dismiss", "Ondoa")}</button>
              </div>}
            </div>
          ) : editor && outcome !== "sold" && (temp === "hot" || temp === "warm") ? (
            <button className="small" disabled={busy} onClick={createFollowUp}>{T("Create follow-up task", "Tengeneza kazi ya kufuatilia")}</button>
          ) : null}
          {editor && (
            <div className="row" style={{ gap: 6, marginTop: 4 }}>
              <button className="small primary" disabled={busy} onClick={() => { setRecording(true); setOpen(true); }}>{confirmed ? T("Add order", "Ongeza oda") : T("Record sale", "Rekodi mauzo")}</button>
              {!confirmed && outcome !== "lost" && <button className="small" disabled={busy} onClick={() => setOverride("lost")}>{T("Lost", "Amepotea")}</button>}
              {!confirmed && r.outcome_override && <button className="small" disabled={busy} onClick={() => setOverride(null)}>{T("Undo correction", "Tengua marekebisho")}</button>}
            </div>
          )}
          {err && <div className="err small">{err}</div>}
        </td>
      </tr>
      {open && (
        <tr><td colSpan={6}>
          <div style={{ display: "grid", gap: 10 }}>
            {recording && <OrderForm ws={ws} r={r} onDone={() => { setRecording(false); onChange(); }} onCancel={() => setRecording(false)} />}
            <div className="two">
              <div className="evidence">
                <b>{T("Why this chat is labelled", "Kwa nini chat hii imewekewa alama hii")} “{L[lang].outcome[outcome] ?? outcome}”</b>
                <span>{src.label}{r.override_note ? ` — “${r.override_note}”` : ""}</span>
                {r.kito_outcome && <span className="small muted">Kito: {L[lang].outcome[r.kito_outcome]} ({r.kito_confidence}){r.kito_label ? ` · ${L[lang].label[r.kito_label]}` : ""}{r.kito_amount ? ` · ${fmt(r.kito_amount)}` : ""}</span>}
                <span className="small muted">{T("Rules", "Kanuni")}: {r.auto_outcome ?? "–"}{r.stage ? ` · ${L[lang].stage[r.stage] ?? r.stage}` : ""}{r.payment_signal ? ` · ${T("payment words/screenshot found", "maneno/picha ya malipo yameonekana")}` : ""}{r.payment_amount ? ` · ${fmt(r.payment_amount)}` : ""}</span>
                {(r.kito_evidence ?? []).length > 0 && <span className="small"><b>{T("Evidence Kito quoted", "Ushahidi wa Kito")}:</b> {(r.kito_evidence ?? []).map((q, i) => <q key={i} style={{ display: "block" }}>{q}</q>)}</span>}
                {(r.kito_objections ?? r.objections ?? []).length > 0 && <span className="small muted">{T("Objections", "Pingamizi")}: {[...new Set([...(r.objections ?? []), ...(r.kito_objections ?? [])])].map((o) => L[lang].obj[o] ?? o).join(" · ")}</span>}
                {(r.kito_tags ?? []).length > 0 && <span className="small muted">{T("Kito's notes", "Maelezo ya Kito")}: {(r.kito_tags ?? []).map((t) => L[lang].tag[t] ?? t).join(" · ")}</span>}
                {editor && !confirmed && (
                  <span className="row small" style={{ gap: 6 }}>{T("Correct it:", "Sahihisha:")}
                    <button className="small" disabled={busy} onClick={() => { setRecording(true); }}>{T("It was sold → record order", "Iliuzwa → rekodi oda")}</button>
                    {outcome !== "lost" && <button className="small" disabled={busy} onClick={() => setOverride("lost")}>{T("Lost", "Imepotea")}</button>}
                    {outcome !== "open" && <button className="small" disabled={busy} onClick={() => setOverride("open")}>{T("Still open", "Bado wazi")}</button>}
                  </span>
                )}
              </div>
              <div>
                <b className="small">{T("Orders for this chat", "Oda za chat hii")}</b>
                <OrderList ws={ws} conversationId={r.id} onChange={onChange} />
              </div>
            </div>
            {!msgs ? <span className="muted">Loading…</span> : msgs.length === 0 ? <span className="small muted">{T("No messages stored for this chat (imported inquiry).", "Hakuna ujumbe uliohifadhiwa (uliingizwa kutoka CSV).")}</span> : (
              <div className="bubbles">{msgs.map((m) => (
                <div key={m.id} className={"bub " + m.direction}>
                  <span className="t">{m.direction === "in" ? r.contact_name ?? "Customer" : ws.name}{m.origin === "app_echo" ? " (phone)" : ""} · {when(m.sent_at)}</span>
                  {m.body ?? ""}
                </div>
              ))}</div>
            )}
          </div>
        </td></tr>
      )}
    </>
  );
}

// Chats: one card per customer, written so anyone can read it at a glance.
// Each card answers three questions: who is this, where do things stand, and what should I do now.
// The technical detail (which rule or Kito reading decided the label) is still there, tucked away.
import { enterRows, usePageEnter, select } from "./motion";
import { useEffect, useRef, useState } from "react";
import { supabase, callFn, Workspace, Outcome, Task, dur, fmt, L, when, canEdit, canManage, money } from "./lib";
import { OrderForm, OrderList, inferredFrom, signalDismissed } from "./Orders";

type Filter = "follow" | "lost" | "open" | "sold" | "signals" | "all" | "ids";
type Source = "any" | "live" | "import";
type Run = { id: number; trigger: "auto" | "manual"; ran_at: string; checked: number; failed: number; remaining: number; note: string | null };
type Receipt = { is_receipt: boolean; amount: number | null; currency: string | null; txn_code: string | null; provider: string | null; paid_to: string | null; sender: string | null; paid_at: string | null; confidence: string; notes: string | null };
type Msg = { id: string; direction: "in" | "out"; sent_at: string; body: string | null; origin: string; type: string; media: { path?: string; mime?: string; receipt?: Receipt | null; error?: string } | null };
type Lite = { id: string; outcome: string | null; kito_temp: string | null; warm: boolean; paid_orders: number; payment_signal: boolean; kito_outcome: string | null; outcome_override: string | null; override_by: string | null; phone_number_id: string };
type Tr = (en: string, sw: string) => string;

/** Same rules as the database filters below, used to count each tab. */
const inFilter = (r: Lite, f: Filter) =>
  f === "all" ? true
  : f === "follow" ? r.outcome !== "sold" && (r.kito_temp === "hot" || r.kito_temp === "warm" || (r.kito_temp == null && r.warm))
  : f === "signals" ? Number(r.paid_orders) === 0 && !signalDismissed(r) && (r.payment_signal || r.kito_outcome === "sold" || r.outcome_override === "sold")
  : r.outcome === f;
const inSource = (r: Lite, s: Source) => s === "any" || (s === "import" ? (r as any).phone_number_id === "import" : r.phone_number_id !== "import");

const PAGE = 100;

/** Group heading for a chat's last message, in the workspace time zone. */
export function timeGroup(iso: string | null, tz: string, T: Tr, now = new Date()): string {
  if (!iso) return T("Older", "Zamani");
  const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const a = Date.parse(day(new Date(iso)) + "T00:00:00Z"), b = Date.parse(day(now) + "T00:00:00Z");
  const days = Math.round((b - a) / 864e5);
  if (days <= 0) return T("Today", "Leo");
  if (days === 1) return T("Yesterday", "Jana");
  if (days < 7) return T("Earlier this week", "Wiki hii");
  if (days < 30) return T("Earlier this month", "Mwezi huu");
  return T("Older", "Zamani");
}

/** On Android, open the chat in WhatsApp Business (falls back to wa.me if it isn't installed). */
export function waLink(phone: string) {
  const web = `https://wa.me/${phone}`;
  if (typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent))
    return `intent://send/?phone=${phone}#Intent;scheme=whatsapp;package=com.whatsapp.w4b;S.browser_fallback_url=${encodeURIComponent(web)};end`;
  return web;
}

const hashIds = () => {
  const m = location.hash.match(/#chats\/ids=([0-9a-f,-]+)/i);
  return m ? m[1].split(",").filter(Boolean).slice(0, 100) : null;
};

/** "3 min ago" / "dakika 3 zilizopita" */
function agoT(iso: string | null, T: Tr) {
  if (!iso) return "";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return T("just now", "sasa hivi");
  if (m < 60) return T(`${m} min ago`, `dakika ${m} zilizopita`);
  if (m < 48 * 60) { const h = Math.round(m / 60); return T(`${h} h ago`, `saa ${h} zilizopita`); }
  const d = Math.round(m / 1440); return T(`${d} days ago`, `siku ${d} zilizopita`);
}

type Status = { key: string; text: string; tone: "good" | "warn" | "bad" | "info" | "muted"; icon: string };
/** Where this customer stands, in one plain sentence. Order matters: the most useful truth wins. */
function statusOf(r: Outcome, T: Tr, currency: string): Status {
  if (Number(r.paid_orders) > 0) return { key: "bought", icon: "✓", tone: "good", text: T("Bought", "Amenunua") + (r.sale_amount != null ? ` · ${money(Number(r.sale_amount), currency)}` : "") };
  if (inferredFrom(r)) return { key: "check", icon: "!", tone: "warn", text: T("Says they paid — check your money came in", "Anasema amelipa — hakikisha pesa imeingia") };
  if (r.outcome === "lost") return { key: "lost", icon: "×", tone: "muted", text: T("Didn't buy", "Hakununua") };
  if (r.last_dir === "in") return { key: "waiting", icon: "●", tone: "bad", text: T("Waiting for your reply", "Anasubiri umjibu") };
  if (r.pay_instructions) return { key: "paynum", icon: "●", tone: "info", text: T("Has your payment number, hasn't paid yet", "Ana namba ya malipo, bado hajalipa") };
  if (r.price_shared) return { key: "priced", icon: "●", tone: "info", text: T("Got the price, still deciding", "Amepata bei, bado anaamua") };
  return { key: "new", icon: "●", tone: "info", text: T("Just started talking", "Ndio ameanza kuongea") };
}

/** Kito's reading is older than the chat's last message (the customer wrote again since). */
const kitoStale = (r: Outcome) => !!r.last_message_at && (r.kito_checked_at
  ? Date.parse(r.last_message_at) > Date.parse(r.kito_checked_at)
  : Date.now() - Date.parse(r.last_message_at) < 3600e3);   // new chat Kito hasn't read yet
const interest = (r: Outcome): "hot" | "warm" | "cold" | null => (kitoStale(r) ? null : r.kito_temp) ?? (r.warm ? "warm" : null);
const phoneOf = (waId: string | undefined) => (waId && /^\+?\d{9,15}$/.test(waId) ? waId.replace(/\D/g, "") : null);

export default function Chats({ ws }: { ws: Workspace }) {
  const [ids, setIds] = useState<string[] | null>(hashIds());
  const [filter, setFilter] = useState<Filter>(ids ? "ids" : "all");
  const [src, setSrc] = useState<Source>("any");
  const [rows, setRows] = useState<Outcome[]>([]);
  const [lite, setLite] = useState<Lite[]>([]);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openConfirm, setOpenConfirm] = useState(false);
  const [adNames, setAdNames] = useState<Record<string, string>>({});
  const [phones, setPhones] = useState<Record<string, string>>({});
  const [tasks, setTasks] = useState<Record<string, Task>>({});
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [autoDone, setAutoDone] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const lang = ws.language;
  const T: Tr = (en, sw) => (lang === "sw" ? sw : en);
  const refresh = () => setTick((t) => t + 1);
  const [quiet, setQuiet] = useState(false);   // live refresh: update in place, no "Loading…"
  const [live, setLive] = useState(false);

  // Live: new WhatsApp messages, Kito's labels and recorded sales appear without reloading.
  useEffect(() => {
    let timer: number | undefined, kitoTimer: number | undefined;
    // At most one reload every 5 s: a newly connected number backfills thousands of rows at once.
    let last = 0;
    const bump = () => {
      if (timer) return;
      const wait = Math.max(800, 5000 - (Date.now() - last));
      timer = window.setTimeout(() => { timer = undefined; last = Date.now(); setQuiet(true); refresh(); window.dispatchEvent(new Event("itaos:live")); }, wait);
    };
    const ch = supabase.channel("chats-" + ws.id)
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations", filter: `workspace_id=eq.${ws.id}` }, (p: any) => {
        // A chat changes whenever a message lands (its summary is recomputed), so this covers new messages too.
        // The messages table itself is not streamed: backfills write thousands of rows at once.
        bump();
        // Let Kito read the new message shortly after it lands — only when the chat has news Kito hasn't read
        // (Kito's own label updates also change the chat; those must not wake it again).
        const c = p?.new;
        if (!c?.last_message_at || (c.kito_checked_at && Date.parse(c.last_message_at) <= Date.parse(c.kito_checked_at))) return;
        window.clearTimeout(kitoTimer); kitoTimer = window.setTimeout(() => { callFn("kito", { workspace_id: ws.id }).then(() => { setQuiet(true); refresh(); }).catch(() => {}); }, 20000);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "orders", filter: `workspace_id=eq.${ws.id}` }, bump)
      .subscribe((status) => setLive(status === "SUBSCRIBED"));
    return () => { window.clearTimeout(timer); window.clearTimeout(kitoTimer); supabase.removeChannel(ch); };
  }, [ws.id]);

  useEffect(() => {
    const onHash = () => { const i = hashIds(); setIds(i); if (i) setFilter("ids"); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (!quiet) setLoading(true);
    setQuiet(false); setErr("");
    let q = supabase.from("conversation_outcomes").select("*").eq("workspace_id", ws.id).order("last_message_at", { ascending: false, nullsFirst: false }).limit(limit);
    if (filter !== "ids" && src === "import") q = q.eq("phone_number_id", "import");
    else if (filter !== "ids" && src === "live") q = q.neq("phone_number_id", "import");
    if (filter === "ids" && ids) q = q.in("id", ids);
    else if (filter === "follow") q = q.neq("outcome", "sold").or("kito_temp.in.(hot,warm),and(kito_temp.is.null,warm.eq.true)");
    else if (filter === "signals") q = q.eq("paid_orders", 0).or("payment_signal.eq.true,kito_outcome.eq.sold,outcome_override.eq.sold").or("override_by.is.null,outcome_override.eq.sold");
    else if (filter !== "all") q = q.eq("outcome", filter);
    supabase.from("kito_runs").select("id,trigger,ran_at,checked,failed,remaining,note").eq("workspace_id", ws.id).order("ran_at", { ascending: false }).limit(20)
      .then(({ data }) => setRuns((data as Run[]) ?? []));
    // Tab counts are worked out in the database (the browser can only read 1,000 rows at a time).
    supabase.rpc("chat_counts", { p_ws: ws.id, p_src: src }).then(({ data, error }) => {
      if (!error && data) { setCounts(data as Record<string, number>); return; }
      setCounts(null);
      supabase.from("conversation_outcomes").select("id,outcome,kito_temp,warm,paid_orders,payment_signal,kito_outcome,outcome_override,override_by,phone_number_id").eq("workspace_id", ws.id).limit(1000)
        .then(({ data }) => setLite((data as Lite[]) ?? []));
    });
    Promise.all([
      q,
      supabase.from("ads").select("ad_id,name").eq("workspace_id", ws.id),
      supabase.from("follow_up_tasks").select("*").eq("workspace_id", ws.id).in("status", ["open", "snoozed"]),
    ]).then(async ([c, a, t]) => {
      if (c.error) setErr(c.error.message);
      let list = (c.data as Outcome[]) ?? [];
      if (filter === "follow") {
        const rank = (r: Outcome) => (interest(r) === "hot" ? 0 : 1) * 10 + (r.last_dir === "in" ? 0 : 1);
        list = [...list].sort((x, y) => rank(x) - rank(y) || Date.parse(y.last_message_at ?? "") - Date.parse(x.last_message_at ?? ""));
      }
      const contactIds = [...new Set(list.map((r) => r.contact_id))];
      const { data: cts } = contactIds.length ? await supabase.from("contacts").select("id,wa_id").eq("workspace_id", ws.id).in("id", contactIds) : { data: [] };
      setPhones(Object.fromEntries((cts ?? []).map((x: any) => [x.id, x.wa_id])));
      setRows(list);
      if (filter === "ids" && list.length && list.length <= 3) setOpenId((cur) => cur ?? list[0].id);
      setAdNames(Object.fromEntries((a.data ?? []).map((x: any) => [x.ad_id, x.name])));
      setTasks(Object.fromEntries(((t.data ?? []) as Task[]).map((task) => [task.conversation_id, task])));
      setLoading(false);
    });
  }, [ws.id, filter, ids, tick, src, limit]);

  async function runKito(quiet = false) {
    setRechecking(true); setNote(quiet ? T("Kito is reading new chats…", "Kito anasoma chat mpya…") : T("Kito is reading the chats…", "Kito anasoma chat…"));
    try {
      let total = 0;
      for (let i = 0; i < 10; i++) {
        const r = await callFn<{ checked: number; failed: number; remaining: number; last_error?: string }>("kito", { workspace_id: ws.id });
        total += r.checked;
        if (r.failed && r.last_error) { setNote(T(`Kito read ${total} chats, then stopped: ${r.last_error}`, `Kito amesoma chat ${total}, kisha akasimama: ${r.last_error}`)); refresh(); setRechecking(false); return; }
        if (!r.remaining || !r.checked) break;
        setNote(T(`Kito has read ${total} chats, ${r.remaining} to go…`, `Kito amesoma chat ${total}, zimebaki ${r.remaining}…`));
      }
      setNote(total ? T(`Kito read ${total} chats.`, `Kito amesoma chat ${total}.`) : quiet ? "" : T("Kito is up to date. No new messages.", "Kito yuko sawa. Hakuna ujumbe mpya.")); refresh();
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
    try { const r = await callFn<{ reanalyzed: number }>("chat-import", { workspace_id: ws.id, action: "reanalyze" }); setNote(T(`Checked ${r.reanalyzed} chats again.`, `Chat ${r.reanalyzed} zimekaguliwa upya.`)); refresh(); }
    catch (e) { setNote((e as Error).message); }
    setRechecking(false);
  }
  async function deleteImported() {
    const { data: imp } = await supabase.from("conversations").select("id").eq("workspace_id", ws.id).eq("phone_number_id", "import").limit(1000);
    const list = (imp ?? []).map((r) => r.id as string);
    if (!list.length) return;
    if (!confirm(T(`Delete all ${list.length} imported chats and their messages? Recorded sales are kept. This cannot be undone.`,
      `Futa chat ${list.length} zote zilizoingizwa pamoja na ujumbe wake? Mauzo yaliyorekodiwa yatabaki. Haiwezi kurudishwa.`))) return;
    setDeleting(true); setErr("");
    const { data, error } = await supabase.rpc("delete_chats", { p_ws: ws.id, p_ids: list.slice(0, 1000), p_via: "chats_page", p_request: "Chats page: delete imported" });
    setDeleting(false);
    if (error) setErr(error.message);
    else { setNote(T(`Deleted ${(data as any).deleted} imported chats.`, `Chat ${(data as any).deleted} zilizoingizwa zimefutwa.`)); setSrc("any"); refresh(); }
  }

  const pageRef = usePageEnter<HTMLElement>((root) => {
    if (loading) return;
    enterRows(select(root, ".cc"), { delay: 0.1, stagger: 0.04 });
  }, [loading, filter]);

  const pick = (f: Filter) => { setIds(null); setFilter(f); setLimit(PAGE); if (location.hash !== "#chats") history.replaceState(null, "", "#chats"); };
  const pool = lite.filter((r) => inSource(r, src));
  const count = (f: Filter) => counts ? Number(counts[f] ?? 0) : pool.filter((r) => inFilter(r, f)).length;
  const imported = counts ? Number(counts.imported ?? 0) : lite.filter((r) => (r as any).phone_number_id === "import").length;
  const total = counts ? Number(counts.all ?? 0) : lite.length;
  const shownTotal = filter === "ids" ? rows.length : count(filter);
  const tz = ws.timezone || "Africa/Dar_es_Salaam";
  const openRow = openId ? rows.find((x) => x.id === openId) ?? null : null;
  const tabs: [Filter, string, string][] = [
    ["all", T("All", "Wote"), T("Every customer", "Wateja wote")],
    ["follow", T("Follow up", "Wafuatilie"), T("Interested — talk to them again", "Wana hamu — waongeleshe tena")],
    ["signals", T("Check payment", "Hakiki malipo"), T("Said they paid — confirm the money came in", "Wamesema wamelipa — hakikisha pesa imeingia")],
    ["open", T("Still talking", "Bado mnaongea"), T("No decision yet", "Bado hawajaamua")],
    ["sold", T("Bought", "Wamenunua"), T("Paid and recorded", "Wamelipa na imerekodiwa")],
    ["lost", T("Didn't buy", "Hawakununua"), T("Went quiet or said no", "Wamekaa kimya au wamekataa")],
  ];
  const emptyText = filter === "follow" ? T("Nobody to follow up right now.", "Hakuna wa kufuatilia kwa sasa.")
    : filter === "signals" ? T("No payments to check.", "Hakuna malipo ya kuhakiki.")
    : T("No chats here yet.", "Hakuna chat hapa bado.");

  return (
    <section className="card chats" ref={pageRef}>
      <div className="chats-head">
        <div>
          <h2 style={{ margin: 0 }}>{T("Customers", "Wateja")} <span className="muted chats-total">{fmt(total)}</span>{live && <span className="live-dot" title={T("Live: updates by itself when a message arrives", "Hai: inajisasisha ujumbe ukiingia")}>{T("Live", "Hai")}</span>}</h2>
          <span className="small muted">{T("Everyone who messaged you on WhatsApp, and where each one stands.", "Kila aliyekutumia ujumbe WhatsApp, na amefika wapi.")}</span>
        </div>
        <button className="small primary" onClick={() => runKito()} disabled={rechecking} title={T("Kito reads new messages and updates every card. It also does this by itself every 15 minutes.", "Kito anasoma ujumbe mpya na kusasisha kila kadi. Pia hufanya hivi mwenyewe kila dakika 15.")}>
          {rechecking ? <span className="kito-spin sm" aria-hidden /> : "✦ "}{rechecking ? T("Kito is reading…", "Kito anasoma…") : T("Update with Kito", "Sasisha na Kito")}
        </button>
      </div>

      <div className="chats-bar">
        <div className="chips-tabs" role="tablist" aria-label={T("Show", "Onyesha")}>
          {tabs.map(([f, label, hint]) => (
            <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "on" : ""} onClick={() => pick(f)} title={hint}>
              {label}<span className="cnt">{count(f)}</span>
            </button>
          ))}
        </div>
        <select className="chats-src" value={src} aria-label={T("Where from", "Wametoka wapi")} onChange={(e) => { setSrc(e.target.value as Source); setLimit(PAGE); if (filter === "ids") pick("all"); }}>
          <option value="any">{T("From: everywhere", "Kutoka: kote")}</option>
          <option value="live">{T("From: WhatsApp", "Kutoka: WhatsApp")}</option>
          <option value="import">{T(`From: uploaded files (${imported})`, `Kutoka: faili zilizopakiwa (${imported})`)}</option>
        </select>
      </div>
      {filter !== "ids" && <p className="small muted" style={{ margin: 0 }}>{tabs.find((t) => t[0] === filter)?.[2]}</p>}
      {filter === "ids" && ids && <p className="small" style={{ margin: 0 }}>{T(`Showing ${ids.length} customers Kito picked`, `Inaonyesha wateja ${ids.length} aliowachagua Kito`)} · <a href="#chats" onClick={() => pick("all")}>{T("show everyone", "onyesha wote")}</a></p>}
      {src === "import" && imported > 0 && canManage(ws) && (
        <div className="row small" style={{ gap: 8 }}>
          <span className="muted">{T("These came from chat files you uploaded, not live WhatsApp.", "Hizi zimetoka kwenye faili ulizopakia, si WhatsApp moja kwa moja.")}</span>
          <button className="small danger" disabled={deleting} onClick={deleteImported}>{deleting ? T("Deleting…", "Inafuta…") : T(`Delete all ${imported}`, `Futa zote ${imported}`)}</button>
        </div>
      )}
      {note && <p className="small muted" style={{ margin: 0 }}>{note}</p>}
      {err && <p className="err small" style={{ margin: 0 }}>{err}</p>}

      {loading ? <div className="cc-list" aria-busy="true">{[0, 1, 2, 3].map((i) => <div className="skeleton cc-skel" key={i} />)}</div>
        : rows.length === 0 ? <div className="empty">{err ? T("Couldn't load the chats. Try again in a moment.", "Imeshindwa kupakia chat. Jaribu tena baada ya muda.") : emptyText}</div> : (
        <div className={"inbox" + (openRow ? " has-pane" : "")}>
        <div className="cc-list">
          {rows.map((r, i) => {
            // Newest first, grouped by when they last wrote (the follow-up list is sorted by priority instead).
            const g = filter === "follow" ? null : timeGroup(r.last_message_at, tz, T);
            const head = g && (i === 0 || timeGroup(rows[i - 1].last_message_at, tz, T) !== g);
            return (
              <div key={r.id} style={{ display: "contents" }}>
                {head && <h3 className="cc-group">{g}</h3>}
                <Card r={r} ws={ws} T={T} adName={r.ad_id ? adNames[r.ad_id] : undefined} phone={phoneOf(phones[r.contact_id])}
                  task={tasks[r.id]} selected={openId === r.id} onOpen={(c) => { setOpenId(r.id); setOpenConfirm(!!c); }} />
              </div>
            );
          })}
          {filter !== "ids" && rows.length >= limit && rows.length < shownTotal && (
            <button className="cc-more" onClick={() => { setQuiet(true); setLimit((n) => n + PAGE); }}>
              {T(`Show ${Math.min(PAGE, shownTotal - rows.length)} more`, `Onyesha ${Math.min(PAGE, shownTotal - rows.length)} zaidi`)} <span className="muted">· {fmt(rows.length)} {T("of", "kati ya")} {fmt(shownTotal)}</span>
            </button>
          )}
        </div>
        {openRow && <ChatPane key={openRow.id} r={openRow} ws={ws} T={T} adName={openRow.ad_id ? adNames[openRow.ad_id] : undefined} phone={phoneOf(phones[openRow.contact_id])}
          task={tasks[openRow.id]} onChange={refresh} onClose={() => setOpenId(null)} startConfirm={openConfirm} />}
        </div>
      )}

      <details className="chats-how">
        <summary className="small muted">{T("How this page works", "Ukurasa huu unafanyaje kazi")}{runs[0] ? ` · ${T("Kito last updated", "Kito alisasisha")} ${when(runs[0].ran_at)}` : ""}</summary>
        <div className="small" style={{ display: "grid", gap: 6, marginTop: 8 }}>
          <span>{T("Kito, the assistant inside itaOS, reads every WhatsApp chat and writes what happened and what to do next. It updates by itself every 15 minutes.",
            "Kito, msaidizi ndani ya itaOS, anasoma kila chat ya WhatsApp na kuandika kilichotokea na hatua inayofuata. Anajisasisha mwenyewe kila dakika 15.")}</span>
          <span>{T("A customer only counts as \"Bought\" after you record the sale. If someone says they paid, check your M-Pesa / bank first, then press \"Yes, record sale\".",
            "Mteja anahesabiwa \"Amenunua\" pale tu unaporekodi mauzo. Mtu akisema amelipa, angalia M-Pesa / benki kwanza, kisha bonyeza \"Ndiyo, rekodi mauzo\".")}</span>
          <span><a href="#connect">{T("Import past sales from a CSV file →", "Ingiza mauzo ya zamani kutoka faili la CSV →")}</a></span>
          <span className="row" style={{ gap: 6 }}>
            <button className="small" onClick={recheck} disabled={rechecking}>{T("Re-check all chats with the latest rules", "Kagua chat zote upya kwa kanuni mpya")}</button>
          </span>
          {runs.length > 0 && (
            <div className="scroll"><table>
              <thead><tr><th>{T("When", "Lini")}</th><th>{T("How", "Vipi")}</th><th className="n">{T("Chats read", "Chat zilizosomwa")}</th><th className="n">{T("Failed", "Zilizoshindwa")}</th><th>{T("Note", "Maelezo")}</th></tr></thead>
              <tbody>{runs.slice(0, 8).map((k) => (
                <tr key={k.id}><td className="small">{when(k.ran_at)}</td><td className="small">{k.trigger === "auto" ? T("By itself", "Mwenyewe") : T("Button", "Kitufe")}</td>
                  <td className="n">{k.checked}</td><td className="n">{k.failed || ""}</td><td className="small muted">{k.note ?? ""}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      </details>
    </section>
  );
}

/** One customer in the list. Clicking it opens the chat on the right (full screen on a phone). */
function Card({ r, ws, T, adName, phone, task, selected, onOpen }: { r: Outcome; ws: Workspace; T: Tr; adName?: string; phone: string | null; task?: Task; selected: boolean; onOpen: (confirm?: boolean) => void }) {
  const editor = canEdit(ws);
  const st = statusOf(r, T, ws.currency);
  const temp = interest(r);
  const confirmed = Number(r.paid_orders) > 0;
  const name = nameOf(r, T);
  const why = r.kito_temp && !kitoStale(r) ? r.kito_blocker : (r.objections ?? [])[0] ?? null;
  const main = !editor ? null
    : st.key === "check" ? <button className="small primary" onClick={() => onOpen(true)}>{T("Check payment", "Hakiki malipo")}</button>
    : st.key === "bought" || st.key === "lost" ? null
    : phone ? <a className="btn small primary" href={waLink(phone)} target="_blank" rel="noopener noreferrer">{st.key === "waiting" ? T("Reply on WhatsApp ↗", "Mjibu WhatsApp ↗") : T("Message on WhatsApp ↗", "Mtumie ujumbe WhatsApp ↗")}</a>
    : null;
  return (
    <article className={"cc " + st.tone + (selected ? " sel" : "")} aria-current={selected || undefined}>
      <div className="cc-top" onClick={() => onOpen()} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}>
        <div className="cc-avatar" aria-hidden>{name.slice(0, 1).toUpperCase()}</div>
        <div className="cc-main">
          <div className="cc-line1">
            <b className="cc-name">{name}</b>
            {!confirmed && st.key !== "lost" && temp && <span className={"cc-heat " + temp}>{temp === "hot" ? T("Very interested", "Ana hamu sana") : temp === "warm" ? T("Interested", "Ana hamu") : T("Not very interested", "Hana hamu sana")}</span>}
            <span className="cc-time small muted">{agoT(r.last_message_at, T)}</span>
          </div>
          <div className="small muted cc-from">{fromOf(r, T, adName)}</div>
          <div className={"cc-status " + st.tone}>{st.icon === "●" ? <span className="cc-dot" /> : <span className="cc-ico">{st.icon}</span>}{st.text}{st.key === "lost" && why ? ` · ${lostWhy(why, T)}` : ""}</div>
          {kitoStale(r) ? <div className="cc-sum cc-reading">✦ {T("Kito is reading the new messages…", "Kito anasoma ujumbe mpya…")}</div>
            : r.kito_summary && <div className="cc-sum">{r.kito_summary}</div>}
          {!kitoStale(r) && r.kito_next && st.key !== "bought" && <div className="cc-next"><b>{T("Next:", "Fanya:")}</b> {r.kito_next}</div>}
          {task && <div className="small cc-task">⏰ {T("Reminder set", "Kikumbusho kipo")}</div>}
        </div>
        <div className="cc-act" onClick={(e) => e.stopPropagation()}>
          {main}
          <button className="small" onClick={() => onOpen()}>{T("Open chat", "Fungua chat")}</button>
        </div>
      </div>
    </article>
  );
}

const nameOf = (r: Outcome, T: Tr) => (r.contact_name ?? "").replace(/✅/g, "").trim() || T("Customer", "Mteja");
const fromOf = (r: Outcome, T: Tr, adName?: string) => r.source === "ad" ? T(`From the ad "${adName ?? r.source_label ?? "ad"}"`, `Kutoka tangazo "${adName ?? r.source_label ?? "tangazo"}"`)
  : r.source_label ? T(`From ${r.source_label}`, `Kutoka ${r.source_label}`)
  : r.source === "organic" ? T("Messaged you directly", "Alikutumia ujumbe moja kwa moja") : T("Source unknown", "Chanzo hakijulikani");
const prettyPhone = (p: string) => (p.length === 12 && p.startsWith("255") ? `+255 ${p.slice(3, 6)} ${p.slice(6, 9)} ${p.slice(9)}` : "+" + p);

/** The open chat, laid out like WhatsApp: header with ✕, the whole conversation as bubbles grouped by
 *  day, and beside it what to do about this customer (a sheet on smaller screens). itaOS never sends,
 *  so the bottom bar hands over to WhatsApp. */
function ChatPane({ r, ws, T, adName, phone, task, onChange, onClose, startConfirm }: { r: Outcome; ws: Workspace; T: Tr; adName?: string; phone: string | null; task?: Task; onChange: () => void; onClose: () => void; startConfirm?: boolean }) {
  const lang = ws.language;
  const tz = ws.timezone || "Africa/Dar_es_Salaam";
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [recording, setRecording] = useState(false);
  const [confirming, setConfirming] = useState(!!startConfirm);
  const [side, setSide] = useState(!!startConfirm);   // details sheet on smaller screens
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const thread = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const editor = canEdit(ws);
  const st = statusOf(r, T, ws.currency);
  const confirmed = Number(r.paid_orders) > 0;
  const name = nameOf(r, T);
  // On a computer, bring the whole chat (down to the reply bar) into view when it opens.
  useEffect(() => {
    const el = pane.current;
    if (!el || window.innerWidth < 900) return;
    const b = el.getBoundingClientRect();
    if (b.top < 0 || b.bottom > window.innerHeight) window.scrollBy({ top: b.top - 12, behavior: "smooth" });
  }, []);
  const why = r.kito_temp && !kitoStale(r) ? r.kito_blocker : (r.objections ?? [])[0] ?? null;

  async function loadMsgs() {
    const { data } = await supabase.from("messages").select("id,direction,sent_at,body,origin,type,media").eq("conversation_id", r.id).order("sent_at", { ascending: false }).limit(1000);
    setMsgs(((data as Msg[]) ?? []).reverse());
  }
  useEffect(() => {
    loadMsgs();
    const on = () => loadMsgs();
    window.addEventListener("itaos:live", on);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !(e.target as HTMLElement)?.closest?.("input,textarea,select")) onClose(); };
    window.addEventListener("keydown", esc);
    document.body.classList.add("wa-open");
    return () => { window.removeEventListener("itaos:live", on); window.removeEventListener("keydown", esc); document.body.classList.remove("wa-open"); };
  }, [r.id]);
  // Newest message in view, like WhatsApp.
  useEffect(() => { const el = thread.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs?.length]);

  async function setOverride(v: "lost" | "open" | null) {
    setBusy(true); setErr("");
    const { error } = await supabase.from("conversations").update({ outcome_override: v, override_note: null }).eq("id", r.id);
    if (!error && v === "lost" && task) await supabase.from("follow_up_tasks").update({ status: "dismissed" }).eq("id", task.id).eq("workspace_id", ws.id);
    setBusy(false); if (error) setErr(error.message); else onChange();
  }
  async function remind() {
    setBusy(true); setErr("");
    const { data: user } = await supabase.auth.getUser();
    const { error } = await supabase.from("follow_up_tasks").insert({
      workspace_id: ws.id, conversation_id: r.id, title: `Follow up with ${name}`,
      draft: r.kito_next ?? null, draft_source: r.kito_next ? "kito" : null, due_at: new Date().toISOString(), created_by: user.user?.id,
    });
    setBusy(false); if (error) setErr(error.code === "23505" ? T("A reminder already exists.", "Tayari kuna kikumbusho.") : error.message); else onChange();
  }

  const dayKey = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  const today = dayKey(new Date().toISOString()), yest = dayKey(new Date(Date.now() - 864e5).toISOString());
  const dayLabel = (k: string) => k === today ? T("Today", "Leo") : k === yest ? T("Yesterday", "Jana")
    : new Date(k + "T12:00:00Z").toLocaleDateString(lang === "sw" ? "sw-TZ" : "en-GB", { weekday: Date.now() - Date.parse(k) < 6 * 864e5 ? "long" : undefined, day: "numeric", month: "long", year: k.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric", timeZone: "UTC" });
  const hhmm = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  const sideLabel = st.key === "check" ? T("Check payment", "Hakiki malipo") : confirmed ? T("Sale", "Mauzo") : T("Did they buy?", "Amenunua?");

  let lastDay = "", lastDir = "";
  return (
    <div ref={pane} className={"wa-pane" + (side ? " side-open" : "")} role="dialog" aria-label={T(`Chat with ${name}`, `Chat na ${name}`)}>
      <header className="wa-head">
        <button className="wa-back" onClick={onClose} aria-label={T("Back to chats", "Rudi kwenye chats")}>←</button>
        <div className="cc-avatar" aria-hidden>{name.slice(0, 1).toUpperCase()}</div>
        <div className="wa-head-main">
          <b>{name}</b>
          <span className="small muted">{[phone ? prettyPhone(phone) : null, r.last_message_at ? T(`last message ${agoT(r.last_message_at, T)}`, `ujumbe wa mwisho ${agoT(r.last_message_at, T)}`) : null].filter(Boolean).join(" · ")}</span>
        </div>
        <div className="wa-head-act">
          {phone && <a className="btn small primary wa-reply" href={waLink(phone)} target="_blank" rel="noopener noreferrer">{T("Reply on WhatsApp ↗", "Mjibu WhatsApp ↗")}</a>}
          <button className={"small wa-side-btn" + (st.key === "check" ? " warn" : "")} onClick={() => setSide(!side)} aria-expanded={side}>{sideLabel}</button>
          <button className="icon wa-x" onClick={onClose} aria-label={T("Close chat", "Funga chat")} title={T("Close (Esc)", "Funga (Esc)")}>✕</button>
        </div>
      </header>
      <div className="wa-body">
        <div className="wa-chat">
          <div className="wa-thread" ref={thread}>
            {!msgs ? <div className="wa-sys">{T("Loading the chat…", "Inapakia chat…")}</div>
              : msgs.length === 0 ? <div className="wa-sys">{T("No messages saved for this customer.", "Hakuna ujumbe uliohifadhiwa kwa mteja huyu.")}</div>
              : msgs.map((m) => {
                const k = dayKey(m.sent_at);
                const sep = k !== lastDay; lastDay = k;
                const tail = sep || m.direction !== lastDir; lastDir = m.direction;
                return (
                  <div key={m.id} style={{ display: "contents" }}>
                    {sep && <div className="wa-day"><span>{dayLabel(k)}</span></div>}
                    <div className={"wa-msg " + m.direction + (tail ? " tail" : "")}>
                      <div className="wa-bub">
                        {m.media?.path ? <MediaView m={m} T={T} /> : <span className={"wa-text" + (special(m) ? " wa-special" : "")}>{special(m) ?? m.body ?? ""}</span>}
                        <span className="wa-meta">{m.origin === "itaos" && <span className="wa-via" title={T("Sent from itaOS", "Imetumwa kutoka itaOS")}>itaOS · </span>}{hhmm(m.sent_at)}{m.direction === "out" && <span className="wa-ticks" aria-hidden>✓✓</span>}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>
          <Composer r={r} ws={ws} T={T} phone={phone} msgs={msgs} onSent={loadMsgs} />
        </div>
        <aside className="wa-side" aria-label={T("About this customer", "Kuhusu mteja huyu")}>
          <div className="wa-side-head"><b>{T("This customer", "Mteja huyu")}</b><button className="icon wa-side-x" onClick={() => setSide(false)} aria-label={T("Hide", "Ficha")}>✕</button></div>
          <div className="wa-card">
            <div className={"cc-status " + st.tone}>{st.icon === "●" ? <span className="cc-dot" /> : <span className="cc-ico">{st.icon}</span>}{st.text}{st.key === "lost" && why ? ` · ${lostWhy(why, T)}` : ""}</div>
            <span className="small muted">{fromOf(r, T, adName)}</span>
            {kitoStale(r) && <p className="wa-sum cc-reading">✦ {T("New messages since Kito's last read. Kito is reading them now; this updates by itself.", "Kuna ujumbe mpya tangu Kito asome. Kito anausoma sasa; hii itajisasisha yenyewe.")}</p>}
            {r.kito_summary && <p className={"wa-sum" + (kitoStale(r) ? " stale" : "")}>{r.kito_summary}</p>}
            {r.kito_next && st.key !== "bought" && <p className={"cc-next" + (kitoStale(r) ? " stale" : "")}><b>{T("Next:", "Fanya:")}</b> {r.kito_next}</p>}
          </div>
          {editor && st.key === "check" && (confirming || !recording) && <ConfirmPayment r={r} ws={ws} T={T} msgs={msgs} onDone={() => { setConfirming(false); onChange(); }} />}
          {editor && !confirmed && st.key !== "check" && !recording && (
            <div className="cc-ask">
              <b>{T("Did they buy?", "Amenunua?")}</b>
              <div className="cc-ask-btns">
                <button className="small primary" disabled={busy} onClick={() => setRecording(true)}>{T("Yes, record sale", "Ndiyo, rekodi mauzo")}</button>
                <button className={"small" + (r.outcome === "open" ? " on" : "")} disabled={busy} onClick={() => setOverride("open")}>{T("Not yet", "Bado")}</button>
                <button className={"small" + (r.outcome === "lost" ? " on" : "")} disabled={busy} onClick={() => setOverride("lost")}>{T("No", "Hapana")}</button>
              </div>
              {r.outcome_override && r.override_by && <button className="linkish small" disabled={busy} onClick={() => setOverride(null)}>{T("Undo my answer", "Futa jibu langu")}</button>}
            </div>
          )}
          {recording && <OrderForm ws={ws} r={r} onDone={() => { setRecording(false); onChange(); }} onCancel={() => setRecording(false)} />}
          <div className="wa-card">
            <b className="small">{T("Sales from this customer", "Mauzo kwa mteja huyu")}</b>
            <OrderList ws={ws} conversationId={r.id} onChange={onChange} />
          </div>
          {editor && !task && !confirmed && st.key !== "lost" && <button className="small" style={{ justifySelf: "start" }} disabled={busy} onClick={remind}>⏰ {T("Remind me to follow up", "Nikumbushe kumfuatilia")}</button>}
          {task && <span className="small cc-task">⏰ {T("Reminder set", "Kikumbusho kipo")} · <a href="#actions">{T("see reminders", "ona vikumbusho")}</a></span>}
          <details className="cc-why">
            <summary className="small muted">{T("How itaOS decided this", "itaOS imeamuaje hili")}</summary>
            <div className="small muted" style={{ display: "grid", gap: 4, marginTop: 6 }}>
              <span>{whySource(r, T)}</span>
              {r.first_response_sec != null && <span>{T("You first replied after", "Ulijibu mara ya kwanza baada ya")} {dur(r.first_response_sec)}</span>}
              {r.kito_outcome && <span>Kito: {L[lang].outcome[r.kito_outcome]} ({T("sure", "uhakika")}: {r.kito_confidence}){r.kito_label ? ` · ${L[lang].label[r.kito_label]}` : ""}</span>}
              {r.stage && <span>{T("Keyword check", "Ukaguzi wa maneno")}: {L[lang].stage[r.stage] ?? r.stage}</span>}
              {(r.kito_evidence ?? []).length > 0 && <span>{T("Messages Kito based this on:", "Ujumbe aliotumia Kito:")} {(r.kito_evidence ?? []).map((q, i) => <q key={i} style={{ display: "block" }}>{q}</q>)}</span>}
              {(r.kito_tags ?? []).length > 0 && <span>{(r.kito_tags ?? []).map((t) => L[lang].tag[t] ?? t).join(" · ")}</span>}
            </div>
          </details>
          {err && <div className="err small">{err}</div>}
        </aside>
      </div>
    </div>
  );
}

/** WhatsApp gives no text for some messages: show what they are instead of "[errors]". */
function special(m: Msg): string | null {
  const b = (m.body ?? "").trim();
  if (m.type === "audio" || b === "[voice note]") return "🎤 Voice message";
  if (m.type === "errors" || b === "[errors]" || m.type === "unsupported") return "⚠ Message WhatsApp didn't share (e.g. a poll, view-once or a newer message type)";
  if (m.type === "sticker" || b === "[sticker]") return "🙂 Sticker";
  if (m.type === "video" && b === "[video]") return "🎬 Video";
  if (m.type === "image" && b === "[image]") return "🖼 Photo (not saved)";
  if (m.type === "document" && b === "[document]") return "📄 Document (not saved)";
  if (m.type === "location" || b === "[location]") return "📍 Location";
  if (m.type === "contacts" || b === "[contacts]") return "👤 Contact card";
  return null;
}

/** Reply box at the bottom of the chat, like WhatsApp's. Sends from the business's own number through
 *  the wa-send function. WhatsApp allows free replies only within 24 h of the customer's last message. */
function Composer({ r, ws, T, phone, msgs, onSent }: { r: Outcome; ws: Workspace; T: Tr; phone: string | null; msgs: Msg[] | null; onSent: () => Promise<void> | void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [err, setErr] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setText(""); setErr(""); }, [r.id]);
  useEffect(() => { const el = box.current; if (el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 160) + "px"; } }, [text]);

  const openWa = phone && <a className="btn small" href={waLink(phone)} target="_blank" rel="noopener noreferrer">{T("Open WhatsApp ↗", "Fungua WhatsApp ↗")}</a>;
  if (!canManage(ws) || ws.send_enabled === false || (r as any).phone_number_id === "import") {
    return (
      <div className="wa-compose">
        <span>{(r as any).phone_number_id === "import" ? T("This chat came from an uploaded file. Reply from WhatsApp.", "Chat hii imetoka kwenye faili. Jibu kupitia WhatsApp.")
          : !canManage(ws) ? T("Only the owner or an admin can reply from itaOS.", "Mmiliki au admin pekee anaweza kujibu kutoka itaOS.")
          : T("Replying from itaOS is turned off in Settings.", "Kujibu kutoka itaOS kumezimwa kwenye Mipangilio.")}</span>
        {openWa}
      </div>
    );
  }
  const lastIn = msgs ? [...msgs].reverse().find((m) => m.direction === "in") : null;
  const left = lastIn ? 24 * 3600e3 - (Date.now() - Date.parse(lastIn.sent_at)) : -1;
  if (msgs && left <= 0) {
    return (
      <div className="wa-compose closed">
        <span>{T("24 hours have passed since their last message, so WhatsApp only allows approved template messages. Reply from the WhatsApp app.", "Zimepita saa 24 tangu ujumbe wake wa mwisho, kwa hiyo WhatsApp inaruhusu ujumbe wa template tu. Jibu kupitia app ya WhatsApp.")}</span>
        {openWa}
      </div>
    );
  }
  async function send() {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true); setErr("");
    try {
      await callFn("wa-send", { workspace_id: ws.id, conversation_id: r.id, text: t });
      setText(""); await onSent();
    } catch (e) { setErr((e as Error).message); }
    setSending(false); box.current?.focus();
  }
  async function draft() {
    setDrafting(true); setErr("");
    try {
      const d = await callFn<{ draft_sw: string; draft_en: string }>("kito", { workspace_id: ws.id, action: "draft_reply", conversation_id: r.id });
      setText(ws.language === "en" ? d.draft_en || d.draft_sw : d.draft_sw || d.draft_en); box.current?.focus();
    } catch (e) { setErr((e as Error).message); }
    setDrafting(false);
  }
  const hours = Math.floor(left / 3600e3), mins = Math.max(1, Math.round((left % 3600e3) / 60000));
  return (
    <div className="wa-compose open">
      {(err || (msgs && left < 3 * 3600e3)) && (
        <div className={"wa-compose-note small" + (err ? " err" : "")}>{err || T(`The 24-hour window closes in ${hours ? `${hours} h ` : ""}${mins} min. After that, only template messages.`, `Dirisha la saa 24 linafungwa baada ya ${hours ? `saa ${hours} ` : ""}dakika ${mins}. Baada ya hapo, template tu.`)}</div>
      )}
      <div className="wa-compose-row">
        <button className="wa-kito" onClick={draft} disabled={drafting || sending} title={T("Kito writes a reply from this chat. You check it before sending.", "Kito anaandika jibu kutoka chat hii. Unaliangalia kabla ya kutuma.")}>
          {drafting ? <span className="kito-spin sm" aria-hidden style={{ marginRight: 0 }} /> : "✦"}<span>{drafting ? T("Writing…", "Anaandika…") : "Kito"}</span>
        </button>
        <textarea ref={box} rows={1} value={text} placeholder={T("Type a message", "Andika ujumbe")} aria-label={T("Message", "Ujumbe")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && window.innerWidth >= 900) { e.preventDefault(); send(); } }} />
        <button className="wa-send" onClick={send} disabled={!text.trim() || sending} aria-label={T("Send", "Tuma")} title={T("Send from your WhatsApp number", "Tuma kutoka namba yako ya WhatsApp")}>
          {sending ? <span className="wa-spin" /> : <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12.6 2-12.6 2z" /></svg>}
        </button>
      </div>
    </div>
  );
}

function whySource(r: Outcome, T: Tr) {
  if (Number(r.paid_orders) > 0) return T("You recorded a sale for this customer.", "Umerekodi mauzo kwa mteja huyu.");
  if (r.outcome_override) return r.override_by ? T(`You set this yourself${r.override_at ? " on " + when(r.override_at) : ""}.`, `Umeweka hili mwenyewe${r.override_at ? " " + when(r.override_at) : ""}.`) : T("There is a ✅ in the saved contact name.", "Kuna ✅ kwenye jina la mteja.");
  if (r.kito_outcome && (r.kito_confidence === "high" || r.kito_confidence === "medium")) return T("Kito read the chat and decided.", "Kito amesoma chat na kuamua.");
  if (r.auto_outcome === "open" && r.last_message_at && Date.now() - Date.parse(r.last_message_at) > 2 * 864e5) return T("No messages for 2+ days, so it counts as didn't buy.", "Hakuna ujumbe siku 2+, kwa hiyo inahesabiwa hakununua.");
  return T("Based on words in the chat (Kito wasn't sure).", "Kutokana na maneno kwenye chat (Kito hakuwa na uhakika).");
}

function lostWhy(why: string, T: Tr) {
  const m: Record<string, [string, string]> = {
    price: ["said the price is too high", "alisema bei ni kubwa"], think: ["said they'd think about it", "alisema atafikiria"],
    money: ["no money right now", "hana pesa kwa sasa"], trust: ["wasn't sure to trust it yet", "hakuwa na uhakika bado"],
    delivery: ["too far / delivery problem", "yuko mbali / usafirishaji"], business_slow: ["we replied too late", "tulichelewa kujibu"],
  };
  return m[why] ? T(m[why][0], m[why][1]) : why;
}

/** The price the business last sent in the chat, e.g. "155,000" or "Ni TSh 35,000" → 155000. */
function lastPriceSent(msgs: Msg[] | null): number | null {
  for (const m of [...(msgs ?? [])].reverse()) {
    if (m.direction !== "out" || !m.body) continue;
    const nums = [...m.body.replace(/(\+?255|0)[67]\d{2}[ -]?\d{3}[ -]?\d{3}/g, "").replace(/\d{7,}/g, "").matchAll(/(\d{1,3}(?:[,.\s]\d{3})+|(?<![\d,.])\d{4,6})(?![\d,.]?\d)/g)]
      .map((x) => Number(x[1].replace(/[,.\s]/g, ""))).filter((n) => n >= 500 && n <= 50_000_000);
    if (nums.length) return nums[nums.length - 1];
  }
  return null;
}

/** "Says they paid": the owner checks their own M-Pesa / bank, then confirms in one tap. */
function ConfirmPayment({ r, ws, T, msgs, onDone }: { r: Outcome; ws: Workspace; T: Tr; msgs: Msg[] | null; onDone: () => void }) {
  const rc = [...(msgs ?? [])].reverse().find((m) => m.direction === "in" && m.media?.receipt?.is_receipt);
  const receipt = rc?.media?.receipt ?? null;
  const guess = receipt?.amount ?? r.kito_amount ?? r.payment_amount ?? lastPriceSent(msgs);
  const priced = lastPriceSent(msgs);
  const [amount, setAmount] = useState("");
  const [code, setCode] = useState("");
  useEffect(() => { if (!code && receipt?.txn_code) setCode(receipt.txn_code); }, [receipt?.txn_code]);
  // Fraud checks: the same receipt sent in another chat, or already used for a recorded sale.
  const [reused, setReused] = useState<{ otherChats: number; usedInSale: boolean }>({ otherChats: 0, usedInSale: false });
  useEffect(() => {
    const c = receipt?.txn_code; if (!c) return;
    Promise.all([
      supabase.from("messages").select("conversation_id").eq("workspace_id", ws.id).eq("direction", "in").ilike("body", `%${c.replace(/[%_]/g, "")}%`).neq("conversation_id", r.id).limit(50),
      supabase.from("orders").select("id").eq("workspace_id", ws.id).eq("external_ref", "txn:" + c.toUpperCase()).limit(1),
    ]).then(([m, o]) => setReused({ otherChats: new Set((m.data ?? []).map((x: any) => x.conversation_id)).size, usedInSale: !!o.data?.length }));
  }, [receipt?.txn_code, r.id]);
  const receiptDay = (() => {   // "14/08/2026, 04:52 Pm" → Date (day first, as Tanzanian receipts print it)
    const m = receipt?.paid_at?.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/); if (!m) return null;
    const y = Number(m[3].length === 2 ? "20" + m[3] : m[3]); const d = new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[1])));
    return isNaN(d.getTime()) ? null : d;
  })();
  const sentAt = rc ? Date.parse(rc.sent_at) : Date.now();
  const daysOld = receiptDay ? Math.floor((sentAt - receiptDay.getTime()) / 864e5) : null;
  const notDone = !!receipt?.notes && /(kuchakatwa|processing|pending|inasubiri|not (yet )?complete|failed|imeshindwa)/i.test(receipt.notes);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { if (!amount && guess) setAmount(Math.round(Number(guess)).toLocaleString("en-US")); }, [guess]);

  async function yes() {
    const a = Number(amount.replace(/[^\d.]/g, ""));
    if (!(a > 0)) return setErr(T("Enter the amount that came in.", "Weka kiasi kilichoingia."));
    const txn = code.trim().toUpperCase().replace(/\s+/g, "");
    setBusy(true); setErr("");
    const { data: user } = await supabase.auth.getUser();
    const now = new Date().toISOString();
    const { error } = await supabase.from("orders").insert({
      workspace_id: ws.id, conversation_id: r.id, amount: a, discount: 0, currency: ws.currency, status: "paid", fulfillment_status: "not_shipped",
      occurred_at: now, paid_at: now, provenance: "manual", inferred_from: inferredFrom(r), created_by: user.user?.id,
      external_ref: txn ? "txn:" + txn : null, notes: txn ? `Transaction ${txn}` : null,
    });
    setBusy(false);
    if (error) setErr(error.code === "23505" ? T(`Transaction ${txn} is already recorded for another sale. The same payment can't count twice.`, `Muamala ${txn} tayari umerekodiwa kwa mauzo mengine. Malipo hayo hayawezi kuhesabiwa mara mbili.`) : error.message);
    else onDone();
  }
  async function no() {
    setBusy(true); setErr("");
    const { error } = await supabase.from("conversations").update({ outcome_override: "open", override_note: "payment not received" }).eq("id", r.id);
    setBusy(false); if (error) setErr(error.message); else onDone();
  }

  return (
    <div className="cc-ask cc-pay">
      <b>{T("Did the money really come in?", "Pesa imeingia kweli?")}</b>
      {receipt && (
        <div className="cc-receipt small">
          <b>{T("Kito read the screenshot:", "Kito amesoma picha:")}</b>
          <span>{[receipt.provider, receipt.amount ? money(receipt.amount, receipt.currency ?? ws.currency) : null, receipt.txn_code ? T(`code ${receipt.txn_code}`, `muamala ${receipt.txn_code}`) : null].filter(Boolean).join(" · ")}</span>
          {receipt.paid_to && <span>{T("Paid to", "Imelipwa kwa")}: {receipt.paid_to}</span>}
          {receipt.paid_at && <span>{T("Time on receipt", "Muda kwenye risiti")}: {receipt.paid_at}</span>}
          {priced && receipt.amount && Math.round(receipt.amount) !== priced && <span className="warnt">⚠ {T(`Amount differs from the price you sent (${money(priced, ws.currency)}).`, `Kiasi ni tofauti na bei uliyotuma (${money(priced, ws.currency)}).`)}</span>}
          {daysOld != null && daysOld >= 2 && <span className="err">⚠ {T(`This receipt is dated ${daysOld} days before the customer sent it. It may be an old screenshot.`, `Risiti hii ni ya siku ${daysOld} kabla mteja hajaituma. Inaweza kuwa picha ya zamani.`)}</span>}
          {reused.usedInSale && <span className="err">⚠ {T("This transaction code is already recorded for another sale.", "Namba hii ya muamala tayari imerekodiwa kwa mauzo mengine.")}</span>}
          {reused.otherChats > 0 && <span className="err">⚠ {T(`The same receipt was also sent in ${reused.otherChats} other chat${reused.otherChats > 1 ? "s" : ""}.`, `Risiti hiyo hiyo imetumwa pia kwenye chat ${reused.otherChats} nyingine.`)}</span>}
          {notDone && <span className="warnt">⚠ {T("The receipt doesn't show the payment as completed.", "Risiti haionyeshi kwamba malipo yamekamilika.")}</span>}
          {receipt.confidence === "low" && <span className="warnt">⚠ {T("Hard to read — check carefully.", "Haisomeki vizuri — kagua kwa makini.")}</span>}
          {receipt.notes && <span className="muted">{receipt.notes}</span>}
        </div>
      )}
      <ol className="small cc-steps">
        <li>{T("A screenshot can be edited or reused. Open your own M-Pesa / Lipa namba / bank messages or app — not the customer's screenshot.", "Picha inaweza kughushiwa au kutumwa tena. Fungua ujumbe au app YAKO ya M-Pesa / Lipa namba / benki — si picha ya mteja.")}</li>
        <li>{T("Find a payment with the same amount, around the same time, from this customer's name or number.", "Tafuta malipo ya kiasi hicho, muda huo huo, kutoka jina au namba ya mteja huyu.")}</li>
        <li>{T("Copy its transaction code (e.g. QK41ABC9XY) below.", "Nakili namba ya muamala (mf. QK41ABC9XY) hapa chini.")}</li>
      </ol>
      <div className="cc-pay-fields">
        <label className="small">{T("Amount received", "Kiasi kilichoingia")} ({ws.currency})<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="155,000" /></label>
        <label className="small">{T("Transaction code", "Namba ya muamala")}<input value={code} maxLength={40} onChange={(e) => setCode(e.target.value)} placeholder="QK41ABC9XY" /></label>
      </div>
      <div className="cc-ask-btns">
        <button className="small primary" disabled={busy} onClick={yes}>✓ {T("Yes, money received", "Ndiyo, pesa imeingia")}</button>
        <button className="small" disabled={busy} onClick={no}>✗ {T("No, nothing came in", "Hapana, haijaingia")}</button>
      </div>
      <span className="small muted">{T("\"Yes\" records the sale, so it shows in your revenue right away.", "\"Ndiyo\" inarekodi mauzo, na yanaonekana kwenye mapato papo hapo.")}</span>
      {err && <span className="err small">{err}</span>}
    </div>
  );
}

/** A saved image or PDF from the customer, with what Kito read from it. */
function MediaView({ m, T }: { m: Msg; T: Tr }) {
  const [url, setUrl] = useState<string | null>(null);
  const [big, setBig] = useState(false);
  useEffect(() => {
    if (!m.media?.path) return;
    supabase.storage.from("wa-media").createSignedUrl(m.media.path, 3600).then(({ data }) => setUrl(data?.signedUrl ?? null));
  }, [m.media?.path]);
  const r = m.media?.receipt;
  const isPdf = m.media?.mime === "application/pdf";
  const caption = (m.body ?? "").split("\n").filter((l) => !l.startsWith("[picha")).join("\n");
  return (
    <span className="mv">
      {url && (isPdf
        ? <a href={url} target="_blank" rel="noopener noreferrer">📄 {T("Open PDF", "Fungua PDF")}</a>
        : <img src={url} alt={T("Image from customer", "Picha kutoka kwa mteja")} className={big ? "big" : ""} onClick={() => setBig(!big)} />)}
      {caption && <span>{caption}</span>}
      {r?.is_receipt ? <span className="mv-tag">🧾 {T("Payment screenshot", "Picha ya malipo")}{r.amount ? ` · ${Math.round(r.amount).toLocaleString("en-US")}` : ""}{r.txn_code ? ` · ${r.txn_code}` : ""}</span>
        : r ? <span className="mv-tag muted">{r.notes ?? T("Not a payment", "Si malipo")}</span> : null}
    </span>
  );
}

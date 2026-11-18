// Chats: one card per customer, written so anyone can read it at a glance.
// Each card answers three questions: who is this, where do things stand, and what should I do now.
// The technical detail (which rule or Kito reading decided the label) is still there, tucked away.
import { enterRows, usePageEnter, select } from "./motion";
import { useEffect, useState } from "react";
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
const inSource = (r: Lite, s: Source) => s === "any" || (s === "import" ? r.phone_number_id === "import" : r.phone_number_id !== "import");

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

const interest = (r: Outcome): "hot" | "warm" | "cold" | null => r.kito_temp ?? (r.warm ? "warm" : null);
const phoneOf = (waId: string | undefined) => (waId && /^\+?\d{9,15}$/.test(waId) ? waId.replace(/\D/g, "") : null);

export default function Chats({ ws }: { ws: Workspace }) {
  const [ids, setIds] = useState<string[] | null>(hashIds());
  const [filter, setFilter] = useState<Filter>(ids ? "ids" : "all");
  const [src, setSrc] = useState<Source>("any");
  const [rows, setRows] = useState<Outcome[]>([]);
  const [lite, setLite] = useState<Lite[]>([]);
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
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations", filter: `workspace_id=eq.${ws.id}` }, bump)
      .on("postgres_changes", { event: "*", schema: "public", table: "orders", filter: `workspace_id=eq.${ws.id}` }, bump)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `workspace_id=eq.${ws.id}` }, (p: any) => {
        if (p?.new?.origin === "history") return; // old chats being backfilled, not new messages
        bump();
        // Let Kito read the new message shortly after it lands (it only reads changed chats).
        window.clearTimeout(kitoTimer); kitoTimer = window.setTimeout(() => { callFn("kito", { workspace_id: ws.id }).then(() => { setQuiet(true); refresh(); }).catch(() => {}); }, 20000);
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages", filter: `workspace_id=eq.${ws.id}` }, () => window.dispatchEvent(new Event("itaos:live")))
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
    let q = supabase.from("conversation_outcomes").select("*").eq("workspace_id", ws.id).order("last_message_at", { ascending: false }).limit(300);
    if (filter !== "ids" && src === "import") q = q.eq("phone_number_id", "import");
    else if (filter !== "ids" && src === "live") q = q.neq("phone_number_id", "import");
    if (filter === "ids" && ids) q = q.in("id", ids);
    else if (filter === "follow") q = q.neq("outcome", "sold").or("kito_temp.in.(hot,warm),and(kito_temp.is.null,warm.eq.true)");
    else if (filter === "signals") q = q.eq("paid_orders", 0).or("payment_signal.eq.true,kito_outcome.eq.sold,outcome_override.eq.sold").or("override_by.is.null,outcome_override.eq.sold");
    else if (filter !== "all") q = q.eq("outcome", filter);
    supabase.from("kito_runs").select("id,trigger,ran_at,checked,failed,remaining,note").eq("workspace_id", ws.id).order("ran_at", { ascending: false }).limit(20)
      .then(({ data }) => setRuns((data as Run[]) ?? []));
    supabase.from("conversation_outcomes").select("id,outcome,kito_temp,warm,paid_orders,payment_signal,kito_outcome,outcome_override,override_by,phone_number_id").eq("workspace_id", ws.id).limit(2000)
      .then(({ data }) => setLite((data as Lite[]) ?? []));
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
      setAdNames(Object.fromEntries((a.data ?? []).map((x: any) => [x.ad_id, x.name])));
      setTasks(Object.fromEntries(((t.data ?? []) as Task[]).map((task) => [task.conversation_id, task])));
      setLoading(false);
    });
  }, [ws.id, filter, ids, tick, src]);

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
    const list = lite.filter((r) => r.phone_number_id === "import").map((r) => r.id);
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

  const pick = (f: Filter) => { setIds(null); setFilter(f); if (location.hash !== "#chats") history.replaceState(null, "", "#chats"); };
  const pool = lite.filter((r) => inSource(r, src));
  const count = (f: Filter) => pool.filter((r) => inFilter(r, f)).length;
  const imported = lite.filter((r) => r.phone_number_id === "import").length;
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
          <h2 style={{ margin: 0 }}>{T("Customers", "Wateja")} <span className="muted chats-total">{fmt(lite.length)}</span>{live && <span className="live-dot" title={T("Live: updates by itself when a message arrives", "Hai: inajisasisha ujumbe ukiingia")}>{T("Live", "Hai")}</span>}</h2>
          <span className="small muted">{T("Everyone who messaged you on WhatsApp, and where each one stands.", "Kila aliyekutumia ujumbe WhatsApp, na amefika wapi.")}</span>
        </div>
        <button className="small primary" onClick={() => runKito()} disabled={rechecking} title={T("Kito reads new messages and updates every card. It also does this by itself every 15 minutes.", "Kito anasoma ujumbe mpya na kusasisha kila kadi. Pia hufanya hivi mwenyewe kila dakika 15.")}>
          ✦ {rechecking ? T("Kito is reading…", "Kito anasoma…") : T("Update with Kito", "Sasisha na Kito")}
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
        <select className="chats-src" value={src} aria-label={T("Where from", "Wametoka wapi")} onChange={(e) => { setSrc(e.target.value as Source); if (filter === "ids") pick("all"); }}>
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

      {loading ? <p className="muted">{T("Loading…", "Inapakia…")}</p> : rows.length === 0 ? <div className="empty">{emptyText}</div> : (
        <div className="cc-list">
          {rows.map((r) => <Card key={r.id} r={r} ws={ws} T={T} adName={r.ad_id ? adNames[r.ad_id] : undefined} phone={phoneOf(phones[r.contact_id])}
            task={tasks[r.id]} onChange={refresh} startOpen={filter === "ids" && rows.length <= 3} />)}
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

function Card({ r, ws, T, adName, phone, task, onChange, startOpen }: { r: Outcome; ws: Workspace; T: Tr; adName?: string; phone: string | null; task?: Task; onChange: () => void; startOpen?: boolean }) {
  const lang = ws.language;
  const [open, setOpen] = useState(!!startOpen);
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [recording, setRecording] = useState(false);
  const [confirming, setConfirming] = useState(!!startOpen && !!inferredFrom(r));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const editor = canEdit(ws);
  const st = statusOf(r, T, ws.currency);
  const temp = interest(r);
  const confirmed = Number(r.paid_orders) > 0;
  const name = (r.contact_name ?? "").replace(/✅/g, "").trim() || T("Customer", "Mteja");
  const from = r.source === "ad" ? T(`From the ad "${adName ?? r.source_label ?? "ad"}"`, `Kutoka tangazo "${adName ?? r.source_label ?? "tangazo"}"`)
    : r.source_label ? T(`From ${r.source_label}`, `Kutoka ${r.source_label}`)
    : r.source === "organic" ? T("Messaged you directly", "Alikutumia ujumbe moja kwa moja") : T("Source unknown", "Chanzo hakijulikani");
  const why = r.kito_temp ? r.kito_blocker : (r.objections ?? [])[0] ?? null;

  useEffect(() => { if (open && !msgs) loadMsgs(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const on = () => loadMsgs();
    window.addEventListener("itaos:live", on);
    return () => window.removeEventListener("itaos:live", on);
  }, [open]);
  async function loadMsgs() {
    const { data } = await supabase.from("messages").select("id,direction,sent_at,body,origin,type,media").eq("conversation_id", r.id).order("sent_at").limit(500);
    setMsgs((data as Msg[]) ?? []);
  }
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

  // The one button that matters most for this customer right now.
  const main = !editor ? null
    : st.key === "check" ? <button className="small primary" disabled={busy} onClick={() => { setConfirming(true); setOpen(true); }}>{T("Check payment", "Hakiki malipo")}</button>
    : st.key === "bought" || st.key === "lost" ? null
    : phone ? <a className="btn small primary" href={`https://wa.me/${phone}`} target="_blank" rel="noopener noreferrer">{st.key === "waiting" ? T("Reply on WhatsApp ↗", "Mjibu WhatsApp ↗") : T("Message on WhatsApp ↗", "Mtumie ujumbe WhatsApp ↗")}</a>
    : null;

  return (
    <article className={"cc " + st.tone + (open ? " open" : "")}>
      <div className="cc-top" onClick={() => setOpen(!open)} role="button" tabIndex={0} aria-expanded={open}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!open); } }}>
        <div className="cc-avatar" aria-hidden>{name.slice(0, 1).toUpperCase()}</div>
        <div className="cc-main">
          <div className="cc-line1">
            <b className="cc-name">{name}</b>
            {!confirmed && st.key !== "lost" && temp && <span className={"cc-heat " + temp}>{temp === "hot" ? T("Very interested", "Ana hamu sana") : temp === "warm" ? T("Interested", "Ana hamu") : T("Not very interested", "Hana hamu sana")}</span>}
            <span className="cc-time small muted">{agoT(r.last_message_at, T)}</span>
          </div>
          <div className="small muted">{from}</div>
          <div className={"cc-status " + st.tone}>{st.icon === "●" ? <span className="cc-dot" /> : <span className="cc-ico">{st.icon}</span>}{st.text}{st.key === "lost" && why ? ` · ${lostWhy(why, T)}` : ""}</div>
          {r.kito_summary && <div className="cc-sum">{r.kito_summary}</div>}
          {r.kito_next && st.key !== "bought" && <div className="cc-next"><b>{T("Next:", "Fanya:")}</b> {r.kito_next}</div>}
          {task && <div className="small cc-task">⏰ {T("Reminder set", "Kikumbusho kipo")} · <a href="#actions" onClick={(e) => e.stopPropagation()}>{T("see reminders", "ona vikumbusho")}</a></div>}
        </div>
        <div className="cc-act" onClick={(e) => e.stopPropagation()}>
          {main}
          <button className="small" onClick={() => setOpen(!open)}>{open ? T("Close", "Funga") : T("Open chat", "Fungua chat")}</button>
        </div>
      </div>

      {open && (
        <div className="cc-body">
          <div className="cc-conv">
            <b className="small">{T("The conversation", "Mazungumzo")}</b>
            {!msgs ? <span className="muted small">{T("Loading…", "Inapakia…")}</span> : msgs.length === 0 ? <span className="small muted">{T("No messages saved for this customer.", "Hakuna ujumbe uliohifadhiwa kwa mteja huyu.")}</span> : (
              <div className="bubbles">{msgs.map((m) => (
                <div key={m.id} className={"bub " + m.direction}>
                  <span className="t">{m.direction === "in" ? name : T("You", "Wewe")} · {when(m.sent_at)}</span>
                  {m.media?.path ? <MediaView m={m} T={T} /> : (m.body ?? "")}
                </div>
              ))}</div>
            )}
          </div>

          <div className="cc-side">
            {editor && st.key === "check" && (confirming || !recording) && <ConfirmPayment r={r} ws={ws} T={T} msgs={msgs} onDone={() => { setConfirming(false); onChange(); }} />}
            {editor && !confirmed && st.key !== "check" && (
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
            <div style={{ display: "grid", gap: 4 }}>
              <b className="small">{T("Sales from this customer", "Mauzo kwa mteja huyu")}</b>
              <OrderList ws={ws} conversationId={r.id} onChange={onChange} />
            </div>
            {editor && !task && !confirmed && st.key !== "lost" && <button className="small" style={{ justifySelf: "start" }} disabled={busy} onClick={remind}>⏰ {T("Remind me to follow up", "Nikumbushe kumfuatilia")}</button>}
            {phone && <a className="small" href={`https://wa.me/${phone}`} target="_blank" rel="noopener noreferrer">{T("Open in WhatsApp ↗", "Fungua WhatsApp ↗")}</a>}
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
          </div>
        </div>
      )}
    </article>
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

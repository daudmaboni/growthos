import { enterCards, enterRows, usePageEnter, select } from "./motion";
import { useEffect, useState } from "react";
import { supabase, callFn, Workspace, Outcome, dur, fmt, L } from "./lib";

type Filter = "follow" | "lost" | "open" | "sold" | "all";
type Run = { id: number; trigger: "auto" | "manual"; ran_at: string; checked: number; failed: number; remaining: number; note: string | null };
type Msg = { id: string; direction: "in" | "out"; sent_at: string; body: string | null; origin: string };

export default function Chats({ ws }: { ws: Workspace }) {
  const [filter, setFilter] = useState<Filter>("follow");
  const [rows, setRows] = useState<Outcome[]>([]);
  const [adNames, setAdNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [runs, setRuns] = useState<Run[]>([]);
  const [autoDone, setAutoDone] = useState(false);
  const lang = ws.language;
  const T = (en: string, sw: string) => (lang === "sw" ? sw : en);

  useEffect(() => {
    setLoading(true);
    let q = supabase.from("conversation_outcomes").select("*").eq("workspace_id", ws.id).order("last_message_at", { ascending: false }).limit(300);
    if (filter === "follow") q = q.neq("outcome", "sold").or("kito_temp.in.(hot,warm),and(kito_temp.is.null,warm.eq.true)");
    else if (filter !== "all") q = q.eq("outcome", filter);
    supabase.from("kito_runs").select("id,trigger,ran_at,checked,failed,remaining,note").eq("workspace_id", ws.id).order("ran_at", { ascending: false }).limit(20)
      .then(({ data }) => setRuns((data as Run[]) ?? []));
    Promise.all([q, supabase.from("ads").select("ad_id,name").eq("workspace_id", ws.id)]).then(([c, a]) => {
      let list = (c.data as Outcome[]) ?? [];
      if (filter === "follow") {
        // Call list: hottest first, then customers still waiting for our reply, then longest ignored
        const rank = (r: Outcome) => (tempOf(r) === "hot" ? 0 : 1) * 10 + (r.last_dir === "in" ? 0 : 1);
        list = [...list].sort((a, b) => rank(a) - rank(b) || Date.parse(a.last_message_at ?? "") - Date.parse(b.last_message_at ?? ""));
      }
      setRows(list);
      setAdNames(Object.fromEntries((a.data ?? []).map((x: any) => [x.ad_id, x.name])));
      setLoading(false);
    });
  }, [ws.id, filter, tick]);

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
  // Automatic: on opening the page, bring stale chats up to date without any button press.
  useEffect(() => {
    if (autoDone) return;
    setAutoDone(true);
    (async () => {
      const { data } = await supabase.from("conversations").select("id,label,last_message_at,kito_checked_at").eq("workspace_id", ws.id).limit(1000);
      const all = data ?? [];
      try {
        if (all.some((c) => c.label == null)) { await callFn("chat-import", { workspace_id: ws.id, action: "reanalyze" }); refresh(); }
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
  return (
    <section className="card" ref={pageRef}>
      <div className="row between">
        <h2>Chats</h2>
        <div className="row" role="tablist">
          {(["warm", "lost", "open", "sold", "all"] as Filter[]).map((f) => (
            <button key={f} className={"small" + (filter === f ? " primary" : "")} onClick={() => setFilter(f)} aria-pressed={filter === f}>
              {{ follow: T("To follow up", "Wa kufuatilia"), lost: T("Lost", "Waliopotea"), open: T("Open", "Bado wazi"), sold: T("Sold", "Waliouziwa"), all: T("All", "Wote") }[f]}
            </button>
          ))}
          <button className="small primary" onClick={() => runKito()} disabled={rechecking} title="Kito (AI) reads new or changed chats and labels them. It also runs by itself every 15 minutes.">Run Kito now</button>
          <button className="small" onClick={recheck} disabled={rechecking} title="Run the latest detection rules over every chat">{rechecking ? "Re-checking…" : "Re-check all chats"}</button>
        </div>
      </div>
      {note && <p className="small muted" style={{ margin: 0 }}>{note}</p>}
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
      {loading ? <p className="muted">Loading…</p> : rows.length === 0 ? <div className="empty">{filter === "follow" ? T("Nobody to follow up right now.", "Hakuna wa kufuatilia kwa sasa.") : T("No chats here yet.", "Hakuna chat hapa bado.")}</div> : (
        <div className="scroll"><table>
          <thead><tr><th>{T("Customer", "Mteja")}</th><th>{T("Source", "Chanzo")}</th><th>{T("What happened", "Kilichotokea")}</th><th className="n">{T("1st reply", "Jibu la 1")}</th><th>{T("Why / next step", "Kwa nini / hatua")}</th><th>{T("Action", "Kitendo")}</th></tr></thead>
          <tbody>{rows.map((r) => <Row key={r.id} r={r} lang={lang} adName={r.ad_id ? adNames[r.ad_id] : undefined} ws={ws} onChange={refresh} />)}</tbody>
        </table></div>
      )}
    </section>
  );
}

/** Kito's temperature; before Kito has read the chat, fall back to the keyword guess. */
const tempOf = (r: Outcome): "hot" | "warm" | "cold" | null => r.kito_temp ?? (r.warm ? "warm" : null);
const daysSince = (iso: string | null) => (iso ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 864e5)) : 0);

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

function Row({ r, lang, adName, ws, onChange }: { r: Outcome; lang: "sw" | "en"; adName?: string; ws: Workspace; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [amount, setAmount] = useState<string>(String(r.sale_amount ?? r.kito_amount ?? r.payment_amount ?? ""));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function toggle() {
    const next = !open; setOpen(next);
    if (next && !msgs) {
      const { data } = await supabase.from("messages").select("id,direction,sent_at,body,origin").eq("conversation_id", r.id).order("sent_at").limit(500);
      setMsgs((data as Msg[]) ?? []);
    }
  }
  async function confirmSale() {
    const amt = Number(amount.replace(/[^\d]/g, ""));
    if (!amt) return setErr("Enter the amount paid.");
    setBusy(true); setErr("");
    const { error } = await supabase.from("sales").upsert({ workspace_id: ws.id, conversation_id: r.id, amount: amt, currency: ws.currency, provenance: "owner_confirmed", confirmed_by: (await supabase.auth.getUser()).data.user?.id }, { onConflict: "conversation_id" });
    setBusy(false); if (error) setErr(error.message); else onChange();
  }
  async function setOverride(v: "lost" | "open" | null) {
    setBusy(true); setErr("");
    if (r.sale_amount != null) await supabase.from("sales").delete().eq("conversation_id", r.id);
    const { error } = await supabase.from("conversations").update({ outcome_override: v }).eq("id", r.id);
    setBusy(false); if (error) setErr(error.message); else onChange();
  }

  const outcome = r.outcome ?? "open";
  const T = (en: string, sw: string) => (lang === "sw" ? sw : en);
  const temp = tempOf(r);
  const blocker = r.kito_temp ? r.kito_blocker : (r.objections ?? [])[0] ?? null;
  const days = daysSince(r.last_message_at);
  const dtxt = days === 0 ? T("today", "leo") : T(`${days} days`, `siku ${days}`);
  const waiting = r.last_dir === "in";
  return (
    <>
      <tr>
        <td><b>{r.contact_name ?? "Customer"}</b><div><button className="small" onClick={toggle} aria-expanded={open} style={{ padding: "0", border: 0, background: "none", color: "var(--accent)" }}>{open ? T("Hide chat", "Ficha chat") : T("View chat", "Ona chat")}</button></div></td>
        <td className="small">
          {r.source === "ad" && <span className="chip">{adName ?? "Ad"}</span>}
          {r.source_label ? <span className="chip">{r.source_label}</span> : r.source !== "ad" && <span className="muted">{r.source}</span>}
        </td>
        <td><span className={"pill " + outcome}>{L[lang].outcome[outcome] ?? outcome}</span>{r.sale_amount != null && <div className="small num">{fmt(r.sale_amount)}</div>}
          {r.sale_provenance === null && !r.outcome_override && r.kito_outcome && r.kito_confidence !== "low" ? <div className="small muted">{T("Read by Kito", "Imesomwa na Kito")}</div>
            : r.sale_provenance === null && r.payment_signal && <div className="small muted">{T("detected", "imegunduliwa")}</div>}
          {r.sale_provenance === null && !r.payment_signal && r.outcome_override === "sold" && <div className="small muted">{T("from ✅ in name", "kutoka ✅ kwenye jina")}</div>}
          {outcome === "sold" && r.sale_provenance === null && r.kito_outcome && r.kito_outcome !== "sold" && <div className="small warnt">{T("Kito sees no payment in the chat", "Kito haoni malipo kwenye chat")}</div>}
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
          {r.sale_provenance === "owner_confirmed" ? (
            <button className="small" disabled={busy} onClick={() => setOverride(null)}>{T("Undo sale", "Tengua mauzo")}</button>
          ) : (
            <div className="row" style={{ gap: 6 }}>
              <input aria-label="Amount paid" inputMode="numeric" style={{ width: 100, padding: "4px 6px" }} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="TZS" />
              <button className="small primary" disabled={busy} onClick={confirmSale}>{T("Sold", "Ameuziwa")}</button>
              {outcome !== "lost" && <button className="small" disabled={busy} onClick={() => setOverride("lost")}>{T("Lost", "Amepotea")}</button>}
            </div>
          )}
          {err && <div className="err">{err}</div>}
        </td>
      </tr>
      {open && (
        <tr><td colSpan={6}>
          {(r.kito_tags ?? []).length > 0 && <p className="small muted" style={{ margin: "0 0 8px" }}>{T("Kito's notes on this customer", "Maelezo ya Kito kuhusu mteja")}: {(r.kito_tags ?? []).map((t) => L[lang].tag[t] ?? t).join(" · ")}</p>}
          {!msgs ? <span className="muted">Loading…</span> : (
            <div className="bubbles">{msgs.map((m) => (
              <div key={m.id} className={"bub " + m.direction}>
                <span className="t">{m.direction === "in" ? r.contact_name ?? "Customer" : ws.name}{m.origin === "app_echo" ? " (phone)" : ""} · {new Date(m.sent_at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                {m.body ?? ""}
              </div>
            ))}</div>
          )}
        </td></tr>
      )}
    </>
  );
}

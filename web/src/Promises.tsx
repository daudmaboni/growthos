// Ahadi: customer promises Kito found in chats ("nitalipa Ijumaa", "nipigie saa kumi").
// Kito only PROPOSES; the owner confirms the day (or picks one) or dismisses. Confirmed promises ring the
// phone when due (push-send, migration 0046). itaOS never messages the customer: drafts are copied and
// sent by the owner from WhatsApp. A recorded paid order closes the chat's promises automatically.
import { useEffect, useState } from "react";
import { supabase, callFn, Workspace, Outcome, Task, ago, when } from "./lib";
import { KitoLoader } from "./KitoLoader";
import { toLocalInput, fromLocalInput } from "./Orders";

type Kind = NonNullable<Task["kind"]>;
const KINDS: Kind[] = ["pay", "call", "collect", "come_back", "other"];
const DAY = 864e5;

export function kindLabel(k: Task["kind"], sw: boolean) {
  switch (k) {
    case "pay": return sw ? "Atalipa" : "Will pay";
    case "call": return sw ? "Apigiwe simu" : "Call them";
    case "collect": return sw ? "Atachukua / atapita" : "Will collect";
    case "come_back": return sw ? "Atarudi" : "Will come back";
    default: return sw ? "Ahadi" : "Promise";
  }
}

/** "YYYY-MM-DD" in East Africa time, `days` from today. */
const eatDay = (days: number, from = Date.now()) => toLocalInput(new Date(from + days * DAY).toISOString()).slice(0, 10);
const lastOfMonth = () => {
  const [y, m] = eatDay(0).split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** When a task is due, as East Africa dates: "overdue" | "today" | "upcoming". */
export function dueBucket(t: Task, now = Date.now()): "overdue" | "today" | "upcoming" | "undated" {
  const at = t.status === "snoozed" && t.snoozed_until ? t.snoozed_until : t.due_at;
  if (!at) return "undated";
  const d = toLocalInput(at).slice(0, 10), today = eatDay(0, now);
  return d < today ? "overdue" : d === today ? "today" : "upcoming";
}

export function PromiseCard({ t, r, ws, editor, onChange }: { t: Task; r?: Outcome; ws: Workspace; editor: boolean; onChange: () => void | Promise<void> }) {
  const sw = ws.language === "sw";
  const T = (en: string, s: string) => (sw ? s : en);
  const proposed = t.status === "proposed";
  const at = t.status === "snoozed" && t.snoozed_until ? t.snoozed_until : t.due_at;
  const [due, setDue] = useState(at ? toLocalInput(at) : "");
  const [kind, setKind] = useState<Kind>(t.kind ?? "other");
  const [doing, setDoing] = useState<string | null>(null);   // which button is working (shows the spinner)
  const busy = doing !== null;
  const [msg, setMsg] = useState("");
  const [moving, setMoving] = useState(false);   // "Postponed": pick the new day
  const [draft, setDraft] = useState(t.draft ?? "");
  const [writing, setWriting] = useState(false);
  useEffect(() => { setDue(at ? toLocalInput(at) : ""); setKind(t.kind ?? "other"); setDraft(t.draft ?? ""); }, [t.id, at, t.kind, t.draft]);

  const name = r?.contact_name ?? T("Customer", "Mteja");
  const quick = (d: string) => setDue(`${d}T${kind === "call" ? "10:00" : "09:00"}`);

  // Keeps the spinner on the clicked button until the list has reloaded and this card has moved.
  async function run(which: string, p: PromiseLike<{ error: any }>, ok?: string) {
    setDoing(which); setMsg("");
    const { error } = await p;
    if (error) { setDoing(null); setMsg(error.message); return; }
    if (ok) setMsg(ok);
    try { await onChange(); } finally { setDoing(null); }
  }
  const patch = (which: string, p: Partial<Task>, ok?: string) => run(which, supabase.from("follow_up_tasks").update(p).eq("id", t.id).eq("workspace_id", ws.id), ok);
  const confirm = () => {
    if (!due) { setMsg(T("Pick a day first.", "Chagua siku kwanza.")); return; }
    return run("remind", supabase.rpc("confirm_promise", { p_task: t.id, p_due: fromLocalInput(due), p_kind: kind }));
  };
  const spin = (which: string) => doing === which && <span className="kito-spin sm" aria-hidden />;
  async function askKito() {
    setWriting(true); setMsg("");
    try {
      const d = await callFn<{ draft_sw: string; draft_en: string }>("kito", { workspace_id: ws.id, action: "draft_reply", conversation_id: t.conversation_id });
      const text = sw ? d.draft_sw : d.draft_en;
      setDraft(text);
      await supabase.from("follow_up_tasks").update({ draft: text, draft_source: "kito" }).eq("id", t.id).eq("workspace_id", ws.id);
    } catch (e) { setMsg((e as Error).message); }
    setWriting(false);
  }
  const copy = async () => { try { await navigator.clipboard.writeText(draft); setMsg(T("Copied. Paste it in WhatsApp and send it yourself.", "Imenakiliwa. Bandika WhatsApp na utume mwenyewe.")); } catch { setMsg(T("Could not copy.", "Haikunakiliwa.")); } };

  const bucket = dueBucket(t);
  return (
    <div className={"qitem promise" + (proposed ? " proposed" : "") + (bucket === "overdue" && !proposed ? " overdue" : "")}>
      <div>
        <b>{name}</b>
        <div className="small" style={{ marginTop: 3 }}>
          {!proposed && <span className="chip">{kindLabel(t.kind, sw)}</span>}
          {t.when_text && <span className="chip">{t.when_text}</span>}
          {!proposed && at && <span className={"chip " + (bucket === "overdue" ? "bad" : bucket === "today" ? "ok" : "")}>{bucket === "overdue" ? T("overdue · ", "imepita · ") : bucket === "today" ? T("today · ", "leo · ") : ""}{when(at)}</span>}
          {t.result === "no_answer" && <span className="chip">{T("no answer last time", "hakupokea mara iliyopita")}</span>}
          {t.result === "postponed" && <span className="chip">{T("postponed", "ameahirisha")}</span>}
        </div>
        {t.promise_text && <div className="promise-quote">“{t.promise_text}”</div>}
        <div className="small muted">{T("said", "alisema")} {ago(t.promise_at ?? t.created_at)}{r?.kito_summary ? ` · ${r.kito_summary}` : ""}</div>
        <a className="small" href={"#chats/open=" + t.conversation_id}>{T("Open chat →", "Fungua chat →")}</a>
      </div>

      {proposed ? (
        <div className="small" style={{ display: "grid", gap: 6, alignContent: "start" }}>
          <span className="muted">{t.needs_date
            ? T("Kito couldn't tell the day. Pick one:", "Kito hakujua siku. Chagua:")
            : T("Kito read this day. Fix it if it's wrong:", "Kito amesoma siku hii. Rekebisha kama si sahihi:")}</span>
          {editor && <>
            <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
              <button className="small" onClick={() => quick(eatDay(1))}>{T("Tomorrow", "Kesho")}</button>
              <button className="small" onClick={() => quick(eatDay(3))}>{T("In 3 days", "Siku 3")}</button>
              <button className="small" onClick={() => quick(eatDay(7))}>{T("Next week", "Wiki ijayo")}</button>
              <button className="small" onClick={() => quick(lastOfMonth())}>{T("End of month", "Mwisho wa mwezi")}</button>
            </div>
            <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
            <label className="muted">{T("Type", "Aina")}{" "}
              <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>{KINDS.map((k) => <option key={k} value={k}>{kindLabel(k, sw)}</option>)}</select>
            </label>
          </>}
        </div>
      ) : (
        <div>
          <div className="draft-label">{T("Draft — not sent", "Rasimu — haijatumwa")}</div>
          <textarea value={draft} disabled={!editor} onChange={(e) => setDraft(e.target.value)} placeholder={T("Ask Kito for a message that mentions their promise, or write your own.", "Muombe Kito ujumbe unaotaja ahadi yake, au andika wako.")} />
          {editor && <div className="row" style={{ gap: 6, marginTop: 6 }}>
            <button className="small" disabled={writing} onClick={askKito}>{writing ? <><KitoLoader size="sm" />{T("Kito is writing…", "Kito anaandika…")}</> : T("Ask Kito for a draft", "Muombe Kito rasimu")}</button>
            <button className="small" disabled={!draft} onClick={copy}>{T("Copy", "Nakili")}</button>
          </div>}
          {moving && editor && (
            <div className="row" style={{ gap: 6, marginTop: 6 }}>
              <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
              <button className="small primary" disabled={busy || !due} onClick={() => { setMoving(false); patch("move", { status: "open", due_at: fromLocalInput(due), snoozed_until: null, result: "postponed" }); }}>{spin("move")}{T("Save new day", "Hifadhi siku mpya")}</button>
            </div>
          )}
        </div>
      )}

      {editor && (
        <div className={"promise-acts" + (proposed ? " proposed" : "")}>
          {proposed ? <>
            <button className="small primary" disabled={busy} aria-busy={doing === "remind"} onClick={confirm}>{spin("remind")}{doing === "remind" ? T("Saving…", "Inahifadhi…") : T("Remind me", "Nikumbushe")}</button>
            <button className="linkish small" disabled={busy} onClick={() => patch("dismiss", { status: "dismissed" })}>{spin("dismiss")}{T("Not a promise", "Si ahadi")}</button>
          </> : <>
            <button className="small primary" disabled={busy} onClick={() => { patch("paid", { status: "done", result: "paid" }); location.hash = "#chats/open=" + t.conversation_id; }} title={T("Opens the chat so you can record the sale", "Inafungua chat ili urekodi mauzo")}>{spin("paid")}{T("Paid → record sale", "Amelipa → rekodi mauzo")}</button>
            <button className="small" disabled={busy} onClick={() => patch("called", { status: "done", result: "called" })}>{spin("called")}{T("Talked to them", "Nimeongea naye")}</button>
            <button className="small" disabled={busy} onClick={() => patch("snooze", { status: "snoozed", snoozed_until: new Date(Date.now() + DAY).toISOString(), result: "no_answer" })}>{spin("snooze")}{T("No answer — tomorrow", "Hakupokea — kesho")}</button>
            <button className="small" disabled={busy} onClick={() => setMoving((m) => !m)}>{T("Postponed…", "Ameahirisha…")}</button>
            <button className="small" disabled={busy} onClick={() => patch("lost", { status: "dismissed", result: "not_interested" })}>{spin("lost")}{T("Not interested", "Hana nia")}</button>
          </>}
        </div>
      )}
      {msg && <div className={"small " + (/Copied|Imenakiliwa/.test(msg) ? "ok" : "err")} style={{ gridColumn: "1 / -1" }}>{msg}</div>}
    </div>
  );
}

export function PromiseList({ tasks, rows, ws, editor, onChange }: { tasks: Task[]; rows: Outcome[]; ws: Workspace; editor: boolean; onChange: () => void | Promise<void> }) {
  const sw = ws.language === "sw";
  const T = (en: string, s: string) => (sw ? s : en);
  const mine = tasks.filter((t) => t.source === "kito_promise");
  const proposed = mine.filter((t) => t.status === "proposed").sort((a, b) => Date.parse(b.promise_at ?? b.created_at) - Date.parse(a.promise_at ?? a.created_at));
  const live = mine.filter((t) => t.status === "open" || t.status === "snoozed");
  const due = (t: Task) => Date.parse((t.status === "snoozed" && t.snoozed_until) || t.due_at || "") || 0;
  const by = (b: ReturnType<typeof dueBucket>) => live.filter((t) => dueBucket(t) === b).sort((x, y) => due(x) - due(y));
  const groups: [string, Task[]][] = [
    [T("Overdue", "Zimepita"), by("overdue")],
    [T("Due today", "Leo"), by("today")],
    [T("Coming up", "Zijazo"), by("upcoming")],
  ];
  const card = (t: Task) => <PromiseCard key={t.id} t={t} r={rows.find((x) => x.id === t.conversation_id)} ws={ws} editor={editor} onChange={onChange} />;
  return (
    <>
      <section className="card flat">
        <div><h2>{T("Kito found these promises", "Kito amepata ahadi hizi")} ({proposed.length})</h2>
          <span className="small muted">{T("Customers who said when they'll pay, call or come. Confirm the day and itaOS reminds you on your phone, or dismiss it.", "Wateja waliosema lini watalipa, wapigiwe au watakuja. Thibitisha siku na itaOS itakukumbusha kwenye simu, au iondoe.")}</span></div>
        {proposed.length === 0 ? <div className="empty">{T("Nothing new. Kito checks every chat that gets a new message.", "Hakuna mpya. Kito anaangalia kila chat inayopata ujumbe mpya.")}</div>
          : <div className="queue">{proposed.map(card)}</div>}
      </section>
      <section className="card flat">
        <div><h2>{T("Your reminders", "Vikumbusho vyako")} ({live.length})</h2></div>
        {live.length === 0 ? <div className="empty">{T("No confirmed promises yet.", "Hakuna ahadi zilizothibitishwa bado.")}</div> : groups.map(([label, list]) => list.length > 0 && (
          <div key={label}><h3>{label} ({list.length})</h3><div className="queue">{list.map(card)}</div></div>
        ))}
      </section>
    </>
  );
}

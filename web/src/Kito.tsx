// Ask Kito: any question about the business, in Kiswahili or English. Kito answers from the
// workspace's own data and shows the chats, ads and numbers behind the answer, with buttons to act.
// Read only: Kito never sends WhatsApp messages or changes anything.
import { useEffect, useRef, useState } from "react";
import { enterCards, usePageEnter, select } from "./motion";
import { supabase, callFn, Workspace, L, ago, money, fmt, canEdit } from "./lib";

type ChatItem = {
  chat_id: string; name: string | null; wa_id: string | null; last_message_at: string | null; last_dir: "in" | "out" | null;
  outcome: string | null; label: string | null; temp: "hot" | "warm" | "cold" | null; blocker: string | null; summary: string | null; next: string | null;
  payment_details_sent: boolean; payment_signal: boolean; paid_orders: number; paid_amount: number | null; why: string | null;
};
type AdItem = { ad_id: string; name: string; campaign: string | null; spend_30d: number; chats_30d: number; priced_30d: number; sales_30d: number; revenue_30d: number; cost_per_sale_30d: number | null; why: string | null };
type Block =
  | { kind: "chats"; title: string; items: ChatItem[] }
  | { kind: "ads"; title: string; items: AdItem[]; spend_currency?: string }
  | { kind: "table"; title: string; columns: string[]; labels: string[]; rows: unknown[][]; total: number; chat_ids?: string[] }
  | { kind: "stats"; title: string; items: { label: string; value: unknown }[] };
type Query = { purpose: string; sql: string; rows: number; error: string | null };
export type Answer = { id: string | null; created_at: string; question: string; answer: string; blocks: Block[]; caveats: string[]; follow_ups: string[]; queries: Query[] };
type Turn = { question: string; answer?: Answer; error?: string; pending?: boolean };

const SUGGEST = {
  en: [
    "Who did I send Lipa namba to but hasn't paid?",
    "Which ads are bringing paying customers this month?",
    "What do customers who paid have in common?",
    "Which hot chats are waiting for our reply?",
    "Why do people go quiet after the price?",
    "How much did we sell this week compared to last week?",
  ],
  sw: [
    "Nani nilimtumia Lipa namba lakini hajalipa?",
    "Matangazo gani yanaleta wateja wanaolipa mwezi huu?",
    "Wateja waliolipa wanafanana kwa nini?",
    "Chat zipi za moto zinasubiri tuwajibu?",
    "Kwa nini watu wanakaa kimya baada ya bei?",
    "Tumeuza kiasi gani wiki hii ukilinganisha na wiki iliyopita?",
  ],
};

export default function Kito({ ws }: { ws: Workspace }) {
  const lang = ws.language;
  const T = (en: string, sw: string) => (lang === "sw" ? sw : en);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [recent, setRecent] = useState<Answer[]>([]);
  const busy = turns.some((t) => t.pending);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pageRef = usePageEnter<HTMLDivElement>((root) => { enterCards(select(root, ":scope > .card")); }, []);

  useEffect(() => {
    supabase.from("kito_asks").select("id,created_at,question,answer,queries").eq("workspace_id", ws.id).not("answer", "is", null)
      .order("created_at", { ascending: false }).limit(15)
      .then(({ data }) => setRecent((data ?? []).map((r: any) => ({ id: r.id, created_at: r.created_at, question: r.question, queries: r.queries ?? [], ...r.answer }))));
  }, [ws.id]);

  useEffect(() => { if (turns.length) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [turns]);

  async function ask(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    setQ("");
    const history = turns.filter((t) => t.answer).slice(-4).map((t) => ({ question: t.question, answer: t.answer!.answer }));
    setTurns((ts) => [...ts, { question: text, pending: true }]);
    try {
      const a = await callFn<Answer>("kito-ask", { workspace_id: ws.id, question: text, history });
      setTurns((ts) => ts.map((t, i) => (i === ts.length - 1 ? { question: text, answer: a } : t)));
      setRecent((r) => [a, ...r.filter((x) => x.id !== a.id)].slice(0, 15));
    } catch (e) {
      setTurns((ts) => ts.map((t, i) => (i === ts.length - 1 ? { question: text, error: (e as Error).message } : t)));
    }
    inputRef.current?.focus();
  }

  return (
    <div className="shell-grid" ref={pageRef}>
      <div className="hero">
        <div>
          <h2>{T("Ask Kito", "Muulize Kito")}</h2>
          <div className="sub"><span>{T("Ask anything about your chats, customers, ads and sales. Kito answers from your own data.", "Uliza chochote kuhusu chat, wateja, matangazo na mauzo yako. Kito anajibu kutoka kwenye data yako.")}</span></div>
        </div>
        {turns.length > 0 && <button className="small" onClick={() => setTurns([])} disabled={busy}>{T("New conversation", "Mazungumzo mapya")}</button>}
      </div>

      {turns.length === 0 && (
        <div className="card">
          <b>{T("Try asking", "Jaribu kuuliza")}</b>
          <div className="kito-suggest">
            {SUGGEST[lang].map((s) => <button key={s} className="small" onClick={() => ask(s)}>{s}</button>)}
          </div>
          {recent.length > 0 && (<>
            <b>{T("Your recent questions", "Maswali yako ya karibuni")}</b>
            <div className="kito-recent">
              {recent.map((r) => (
                <button key={r.id ?? r.created_at} className="kito-recent-item" onClick={() => setTurns([{ question: r.question, answer: r }])}>
                  <span>{r.question}</span><span className="small muted">{ago(r.created_at)}</span>
                </button>
              ))}
            </div>
          </>)}
        </div>
      )}

      {turns.map((t, i) => (
        <div key={i} className="kito-turn">
          <div className="kito-q">{t.question}</div>
          {t.pending && <div className="card kito-thinking"><span className="dot" />{T("Kito is looking through your data…", "Kito anapitia data yako…")}</div>}
          {t.error && <div className="card"><p className="err" style={{ margin: 0 }}>{t.error}</p></div>}
          {t.answer && <AnswerCard a={t.answer} ws={ws} onAsk={ask} stale={!!t.answer.id && i === 0 && turns.length === 1 && Date.now() - Date.parse(t.answer.created_at) > 3600e3} />}
        </div>
      ))}
      <div ref={endRef} />

      <form className="kito-ask card" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <textarea ref={inputRef} rows={2} value={q} maxLength={1500} disabled={busy}
          placeholder={T("e.g. Which customers asked for the price yesterday and never replied?", "mf. Wateja gani waliuliza bei jana na hawakujibu tena?")}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(q); } }} />
        <button className="primary" disabled={busy || q.trim().length < 2}>{busy ? T("Thinking…", "Anafikiri…") : T("Ask", "Uliza")}</button>
      </form>
      <p className="small muted" style={{ margin: 0 }}>{T("Kito only reads. It never sends messages or changes your data. Confirmed sales come from recorded orders only.", "Kito anasoma tu. Hatumi ujumbe wala kubadilisha data yako. Mauzo yaliyothibitishwa ni oda zilizorekodiwa tu.")}</p>
    </div>
  );
}

function AnswerCard({ a, ws, onAsk, stale }: { a: Answer; ws: Workspace; onAsk: (q: string) => void; stale: boolean }) {
  const T = (en: string, sw: string) => (ws.language === "sw" ? sw : en);
  return (
    <div className="card kito-answer">
      {stale && <p className="small muted" style={{ margin: 0 }}>{T(`Saved answer from ${ago(a.created_at)}. Ask again for fresh numbers.`, `Jibu lililohifadhiwa ${ago(a.created_at)}. Uliza tena kupata takwimu mpya.`)}</p>}
      <Prose text={a.answer} />
      {a.blocks.map((b, i) => <BlockView key={i} b={b} ws={ws} />)}
      {a.caveats.length > 0 && (
        <div className="evidence">
          <b className="small">{T("Keep in mind", "Zingatia")}</b>
          {a.caveats.map((c, i) => <span key={i}>{c}</span>)}
        </div>
      )}
      {a.follow_ups.length > 0 && (
        <div className="kito-suggest">
          {a.follow_ups.map((f) => <button key={f} className="small" onClick={() => onAsk(f)}>{f}</button>)}
        </div>
      )}
      {a.queries.length > 0 && (
        <details className="kito-how">
          <summary className="small muted">{T(`How Kito found this (${a.queries.length} ${a.queries.length === 1 ? "query" : "queries"})`, `Kito amepataje hili (maswali ${a.queries.length} kwenye data)`)}</summary>
          {a.queries.map((qq, i) => (
            <div key={i} className="kito-query">
              <span className="small"><b>{i + 1}.</b> {qq.purpose} · {qq.error ? <span className="err">{T("failed, retried", "ilishindwa, akajaribu tena")}</span> : `${fmt(qq.rows)} ${T("rows", "mistari")}`}</span>
              <pre>{qq.sql}</pre>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

/** Minimal formatting: paragraphs, "- " bullets and **bold**. No HTML from the AI is ever rendered. */
function Prose({ text }: { text: string }) {
  const bold = (s: string) => s.split(/(\*\*[^*]+\*\*)/g).map((p, i) => (p.startsWith("**") && p.endsWith("**") ? <b key={i}>{p.slice(2, -2)}</b> : <span key={i}>{p}</span>));
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="kito-prose">
      {blocks.map((blk, i) => {
        const lines = blk.split("\n").filter((l) => l.trim());
        if (lines.length && lines.every((l) => /^\s*([-•*]|\d+[.)])\s+/.test(l))) {
          return <ul key={i}>{lines.map((l, j) => <li key={j}>{bold(l.replace(/^\s*([-•*]|\d+[.)])\s+/, ""))}</li>)}</ul>;
        }
        return <p key={i}>{lines.map((l, j) => <span key={j}>{j > 0 && <br />}{bold(l)}</span>)}</p>;
      })}
    </div>
  );
}

function BlockView({ b, ws }: { b: Block; ws: Workspace }) {
  if (b.kind === "chats") return <ChatsBlock b={b} ws={ws} />;
  if (b.kind === "ads") return <AdsBlock b={b} ws={ws} />;
  if (b.kind === "stats") return (
    <div className="kito-block">
      {b.title && <h3>{b.title}</h3>}
      <div className="kpis">{b.items.map((s, i) => <div key={i} className="kpi"><div className="k">{s.label}</div><div className="v">{cell(s.value)}</div></div>)}</div>
    </div>
  );
  return <TableBlock b={b} ws={ws} />;
}

function cell(v: unknown): string {
  if (v == null) return "–";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (typeof v === "boolean") return v ? "✓" : "–";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function TableBlock({ b, ws }: { b: Extract<Block, { kind: "table" }>; ws: Workspace }) {
  const T = (en: string, sw: string) => (ws.language === "sw" ? sw : en);
  const [all, setAll] = useState(false);
  const rows = all ? b.rows : b.rows.slice(0, 12);
  return (
    <div className="kito-block">
      <div className="row between"><h3>{b.title}</h3>{b.chat_ids && b.chat_ids.length > 0 && <a className="small" href={"#chats/ids=" + b.chat_ids.slice(0, 100).join(",")}>{T("Open these chats", "Fungua chat hizi")} →</a>}</div>
      <div className="scroll">
        <table>
          <thead><tr>{b.labels.map((l, i) => <th key={i}>{l}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={typeof v === "number" ? "n" : ""}>{cell(v)}</td>)}</tr>)}</tbody>
        </table>
      </div>
      {b.rows.length > 12 && <button className="small" onClick={() => setAll(!all)}>{all ? T("Show less", "Onyesha machache") : T(`Show all ${b.rows.length}`, `Onyesha zote ${b.rows.length}`)}</button>}
      {b.total > b.rows.length && <span className="small muted">{T(`Showing ${b.rows.length} of ${b.total}.`, `Inaonyesha ${b.rows.length} kati ya ${b.total}.`)}</span>}
    </div>
  );
}

function ChatsBlock({ b, ws }: { b: Extract<Block, { kind: "chats" }>; ws: Workspace }) {
  const T = (en: string, sw: string) => (ws.language === "sw" ? sw : en);
  const [all, setAll] = useState(false);
  const items = all ? b.items : b.items.slice(0, 8);
  const ids = b.items.map((c) => c.chat_id);
  return (
    <div className="kito-block">
      <div className="row between">
        <h3>{b.title} <span className="muted">· {b.items.length}</span></h3>
        {ids.length > 1 && <a className="small" href={"#chats/ids=" + ids.slice(0, 100).join(",")}>{T("Open all in Chats", "Fungua zote kwenye Chats")} →</a>}
      </div>
      {b.items.length === 0 && <div className="empty">{T("No chats match.", "Hakuna chat inayolingana.")}</div>}
      <div className="kito-chats">{items.map((c) => <ChatCard key={c.chat_id} c={c} ws={ws} />)}</div>
      {b.items.length > 8 && <button className="small" onClick={() => setAll(!all)}>{all ? T("Show less", "Onyesha machache") : T(`Show all ${b.items.length}`, `Onyesha zote ${b.items.length}`)}</button>}
    </div>
  );
}

type Draft = { draft_sw: string; draft_en: string; why: string; missing: string[] };

function ChatCard({ c, ws }: { c: ChatItem; ws: Workspace }) {
  const lang = ws.language;
  const T = (en: string, sw: string) => (lang === "sw" ? sw : en);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const wa = c.wa_id ? c.wa_id.replace(/\D/g, "") : null;
  const draftText = draft ? (lang === "sw" ? draft.draft_sw : draft.draft_en) : "";

  async function makeDraft() {
    setBusy(true); setErr("");
    try { setDraft(await callFn<Draft>("kito", { workspace_id: ws.id, action: "draft_reply", conversation_id: c.chat_id })); }
    catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }
  async function copy() {
    try { await navigator.clipboard.writeText(draftText); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  }

  return (
    <div className="kito-chat">
      <div className="row between">
        <div className="row" style={{ gap: 6 }}>
          <b>{c.name ?? T("Customer", "Mteja")}</b>
          {c.temp && <span className={"temp " + c.temp}>{L[lang].temp[c.temp]}</span>}
          {Number(c.paid_orders) > 0 ? <span className="pill sold">{T("Paid", "Amelipa")}{c.paid_amount ? " · " + money(Number(c.paid_amount), ws.currency) : ""}</span>
            : c.payment_signal ? <span className="chip">{T("Payment detected, not confirmed", "Malipo yameonekana, hayajathibitishwa")}</span>
            : c.outcome ? <span className={"pill " + c.outcome}>{L[lang].outcome[c.outcome] ?? c.outcome}</span> : null}
          {c.label && <span className="chip">{L[lang].label[c.label] ?? c.label}</span>}
        </div>
        <span className="small muted">{c.last_dir === "in" ? T("Customer wrote ", "Mteja aliandika ") : T("We wrote ", "Tuliandika ")}{ago(c.last_message_at)}</span>
      </div>
      {(c.why || c.summary) && <div className="small">{c.why ?? c.summary}</div>}
      {c.why && c.summary && <div className="small muted">{c.summary}</div>}
      {c.next && <div className="small"><span className="muted">{T("Next step: ", "Hatua inayofuata: ")}</span>{c.next}</div>}
      <div className="row" style={{ gap: 6 }}>
        <a className="btn small" href={"#chats/ids=" + c.chat_id}>{T("Open chat", "Fungua chat")}</a>
        {wa && <a className="btn small" href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer">WhatsApp ↗</a>}
        {canEdit(ws) && !draft && <button className="small" disabled={busy} onClick={makeDraft}>{busy ? T("Writing…", "Anaandika…") : T("Draft a follow-up", "Andaa ujumbe wa kufuatilia")}</button>}
      </div>
      {err && <p className="err small" style={{ margin: 0 }}>{err}</p>}
      {draft && (
        <div className="evidence">
          <span className="draft-label">{T("Draft — review before sending", "Rasimu — kagua kabla ya kutuma")}</span>
          <span style={{ whiteSpace: "pre-wrap" }}>{draftText}</span>
          {draft.missing.length > 0 && <span className="small muted">{T("Fill in: ", "Jaza: ")}{draft.missing.join(", ")}</span>}
          <div className="row" style={{ gap: 6 }}>
            <button className="small" onClick={copy}>{copied ? T("Copied", "Imenakiliwa") : T("Copy", "Nakili")}</button>
            {wa && <a className="btn small" href={`https://wa.me/${wa}?text=${encodeURIComponent(draftText)}`} target="_blank" rel="noopener noreferrer">{T("Open in WhatsApp with this text ↗", "Fungua WhatsApp na ujumbe huu ↗")}</a>}
          </div>
        </div>
      )}
    </div>
  );
}

function AdsBlock({ b, ws }: { b: Extract<Block, { kind: "ads" }>; ws: Workspace }) {
  const T = (en: string, sw: string) => (ws.language === "sw" ? sw : en);
  const cur = b.spend_currency ?? ws.currency;
  return (
    <div className="kito-block">
      <h3>{b.title}</h3>
      <div className="scroll">
        <table>
          <thead><tr>
            <th>{T("Ad", "Tangazo")}</th><th className="n">{T("Spend 30d", "Matumizi siku 30")}</th><th className="n">Chats</th>
            <th className="n">{T("Priced", "Bei")}</th><th className="n">{T("Paid sales", "Mauzo")}</th><th className="n">{T("Revenue", "Mapato")}</th><th className="n">{T("Cost / sale", "Gharama / mauzo")}</th>
          </tr></thead>
          <tbody>{b.items.map((a) => (
            <tr key={a.ad_id}>
              <td><b>{a.name}</b>{a.campaign && <div className="small muted">{a.campaign}</div>}{a.why && <div className="small">{a.why}</div>}</td>
              <td className="n">{money(Number(a.spend_30d), cur)}</td><td className="n">{fmt(a.chats_30d)}</td><td className="n">{fmt(a.priced_30d)}</td>
              <td className="n">{fmt(a.sales_30d)}</td><td className="n">{money(Number(a.revenue_30d), ws.currency)}</td>
              <td className="n">{a.cost_per_sale_30d == null ? "–" : money(Number(a.cost_per_sale_30d), cur)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <span className="small muted">{T("Last 30 days. Paid sales are orders matched to chats from the ad (an estimate, not proof).", "Siku 30 zilizopita. Mauzo ni oda zilizounganishwa na chat za tangazo (makisio, si uthibitisho).")}</span>
      <a className="small" href="#dashboard">{T("See all ads on the Dashboard", "Ona matangazo yote kwenye Dashboard")} →</a>
    </div>
  );
}

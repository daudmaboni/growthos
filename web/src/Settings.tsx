import { useEffect, useState } from "react";
import { supabase, Workspace } from "./lib";
import { enterCards, enterRows, flash, shake, usePageEnter, select } from "./motion";

type Tab = "business" | "appearance" | "rates" | "account";
const TABS: [Tab, string, string][] = [["business", "Business", "Biashara"], ["appearance", "Appearance", "Muonekano"], ["rates", "Rates", "Viwango"], ["account", "Account", "Akaunti"]];
const CURRENCIES = ["TZS", "KES", "UGX", "RWF", "USD"];

export default function Settings({ ws, onWs, theme, onTheme }: { ws: Workspace; onWs: (w: Workspace) => void; theme: "dark" | "light"; onTheme: (t: "dark" | "light", from?: HTMLElement | null) => void }) {
  const [tab, setTab] = useState<Tab>(() => (location.hash.split("/")[1] as Tab) || "business");
  const [email, setEmail] = useState("");
  const lang = ws.language;
  const T = (en: string, sw: string) => (lang === "sw" ? sw : en);
  useEffect(() => { supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? "")); }, []);
  useEffect(() => { history.replaceState(null, "", "#settings/" + tab); }, [tab]);
  const pageRef = usePageEnter<HTMLDivElement>((root) => {
    enterCards(select(root, ":scope > .card"), { stagger: 0.07 });
    enterRows(select(root, ".field"), { delay: 0.25, y: 8, stagger: 0.04 });
  }, [tab]);

  return (
    <div className="shell-grid" ref={pageRef}>
      <div className="hero">
        <div style={{ display: "grid", gap: 4 }}>
          <h2>{T("Settings", "Mipangilio")}</h2>
          <div className="sub"><span>{ws.name} · {T("changes apply to everyone in this workspace.", "mabadiliko yanawahusu wote kwenye workspace hii.")}</span></div>
        </div>
      </div>
      <nav className="tabs subtabs" aria-label="Settings sections">
        {TABS.map(([k, en, sw]) => <a key={k} href={"#settings/" + k} className={tab === k ? "on" : ""} onClick={(e) => { e.preventDefault(); setTab(k); }}>{T(en, sw)}</a>)}
      </nav>
      {tab === "business" && <Business ws={ws} onWs={onWs} T={T} />}
      {tab === "appearance" && <Appearance ws={ws} onWs={onWs} theme={theme} onTheme={onTheme} T={T} />}
      {tab === "rates" && <Rates ws={ws} onWs={onWs} T={T} />}
      {tab === "account" && <Account email={email} T={T} />}
    </div>
  );
}

type Tr = (en: string, sw: string) => string;

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return <div className="field"><label htmlFor={id}>{label}</label>{children}{hint && <span className="small muted">{hint}</span>}</div>;
}

function useSave<T extends Partial<Workspace>>(ws: Workspace, onWs: (w: Workspace) => void) {
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [busy, setBusy] = useState(false);
  async function save(patch: T, form: HTMLFormElement | null, okText: string) {
    setBusy(true); setMsg({});
    const { error } = await supabase.from("workspaces").update(patch).eq("id", ws.id);
    setBusy(false);
    if (error) { shake(form); setMsg({ err: error.message }); return false; }
    onWs({ ...ws, ...patch });
    setMsg({ ok: okText }); flash(form?.querySelector(".savemsg") ?? null);
    return true;
  }
  return { msg, busy, save };
}

function Business({ ws, onWs, T }: { ws: Workspace; onWs: (w: Workspace) => void; T: Tr }) {
  const [name, setName] = useState(ws.name);
  const [currency, setCurrency] = useState(ws.currency);
  const [unit, setUnit] = useState(ws.unit_cost != null ? String(ws.unit_cost) : "");
  const { msg, busy, save } = useSave(ws, onWs);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const u = unit.trim() === "" ? null : Number(unit.replace(/,/g, ""));
    if (u !== null && !(u >= 0)) return;
    await save({ name: name.trim(), currency, unit_cost: u }, e.currentTarget, T("Saved.", "Imehifadhiwa."));
  }
  return (
    <form className="card" onSubmit={submit}>
      <div><h2>{T("Business", "Biashara")}</h2><span className="small muted">{T("As it appears in the app and reports", "Jinsi inavyoonekana kwenye app na ripoti")}</span></div>
      <Field id="s-name" label={T("Business name", "Jina la biashara")}><input id="s-name" required value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field id="s-cur" label={T("Sales currency", "Sarafu ya mauzo")} hint={T("What customers pay in. Ad spend may be in another currency; set the rate under Rates.", "Wateja wanalipa kwa sarafu hii. Matangazo yanaweza kuwa sarafu nyingine; weka kiwango kwenye Viwango.")}>
        <select id="s-cur" value={currency} onChange={(e) => setCurrency(e.target.value)}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
      </Field>
      <Field id="s-unit" label={T("Cost per order", "Gharama kwa oda") + ` (${currency})`} hint={T("Product + delivery cost for one order. Optional; used for profit per sale later.", "Gharama ya bidhaa + usafirishaji kwa oda moja. Si lazima; itatumika kwa faida kwa mauzo.")}>
        <input id="s-unit" inputMode="decimal" placeholder="e.g. 18000" value={unit} onChange={(e) => setUnit(e.target.value)} />
      </Field>
      <SaveRow busy={busy} msg={msg} T={T} />
    </form>
  );
}

function Appearance({ ws, onWs, theme, onTheme, T }: { ws: Workspace; onWs: (w: Workspace) => void; theme: "dark" | "light"; onTheme: (t: "dark" | "light", from?: HTMLElement | null) => void; T: Tr }) {
  const { msg, busy, save } = useSave(ws, onWs);
  return (
    <>
      <section className="card">
        <div><h2>{T("Theme", "Mandhari")}</h2><span className="small muted">{T("Saved on this device only.", "Inahifadhiwa kwenye kifaa hiki tu.")}</span></div>
        <div className="seg" role="group" aria-label="Theme">
          <button type="button" className={theme === "dark" ? "on" : ""} aria-pressed={theme === "dark"} onClick={(e) => onTheme("dark", e.currentTarget)}>{T("Dark", "Giza")}</button>
          <button type="button" className={theme === "light" ? "on" : ""} aria-pressed={theme === "light"} onClick={(e) => onTheme("light", e.currentTarget)}>{T("Light", "Mwanga")}</button>
        </div>
      </section>
      <form className="card" onSubmit={(e) => e.preventDefault()}>
        <div><h2>{T("Language", "Lugha")}</h2><span className="small muted">{T("Default language for the dashboard and Kito's notes. Everyone in the workspace sees this.", "Lugha chaguo-msingi ya dashibodi na maelezo ya Kito. Wote kwenye workspace wanaiona.")}</span></div>
        <div className="seg" role="group" aria-label="Language">
          {(["sw", "en"] as const).map((l) => <button key={l} type="button" disabled={busy} className={ws.language === l ? "on" : ""} aria-pressed={ws.language === l} onClick={(e) => save({ language: l }, e.currentTarget.closest("form"), l === "sw" ? "Imehifadhiwa." : "Saved.")}>{l === "sw" ? "Kiswahili" : "English"}</button>)}
        </div>
        <SaveRow busy={busy} msg={msg} T={T} noButton />
      </form>
    </>
  );
}

function Rates({ ws, onWs, T }: { ws: Workspace; onWs: (w: Workspace) => void; T: Tr }) {
  const [rate, setRate] = useState(ws.fx_rate ? String(ws.fx_rate) : "");
  const { msg, busy, save } = useSave(ws, onWs);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = rate.trim() === "" ? null : Number(rate.replace(/,/g, ""));
    if (v !== null && !(v > 0)) { shake(e.currentTarget); return; }
    await save({ fx_rate: v }, e.currentTarget, T("Saved. Return on ad spend now uses this rate.", "Imehifadhiwa. Mapato kwa tangazo sasa yanatumia kiwango hiki."));
  }
  return (
    <form className="card" onSubmit={submit}>
      <div><h2>{T("Exchange rate", "Kiwango cha kubadilisha")}</h2><span className="small muted">{T(`Only needed when the ad account is billed in another currency (for example US dollars) and sales are in ${ws.currency}. Used for return on ad spend.`, `Inahitajika tu kama akaunti ya matangazo inalipwa kwa sarafu nyingine (mfano dola) na mauzo ni ${ws.currency}. Inatumika kwa mapato kwa tangazo.`)}</span></div>
      <Field id="s-fx" label={T("1 unit of ad currency =", "Kitengo 1 cha sarafu ya tangazo =")}>
        <div className="row"><input id="s-fx" inputMode="decimal" style={{ width: 160 }} placeholder="e.g. 2600" value={rate} onChange={(e) => setRate(e.target.value)} /><span>{ws.currency}</span></div>
      </Field>
      <SaveRow busy={busy} msg={msg} T={T} />
    </form>
  );
}

function Account({ email, T }: { email: string; T: Tr }) {
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setMsg({});
    if (pw.length < 8) { shake(e.currentTarget); return setMsg({ err: T("Use at least 8 characters.", "Tumia herufi 8 au zaidi.") }); }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) { shake(e.currentTarget); setMsg({ err: error.message }); } else { setPw(""); setMsg({ ok: T("Password changed.", "Nenosiri limebadilishwa.") }); }
  }
  return (
    <>
      <form className="card" onSubmit={submit}>
        <div><h2>{T("Your account", "Akaunti yako")}</h2><span className="small muted">{email}</span></div>
        <Field id="s-pw" label={T("New password", "Nenosiri jipya")} hint={T("At least 8 characters.", "Herufi 8 au zaidi.")}>
          <input id="s-pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
        <SaveRow busy={busy} msg={msg} T={T} label={T("Change password", "Badilisha nenosiri")} />
      </form>
      <section className="card">
        <div className="row between">
          <div><h2>{T("Sign out", "Toka")}</h2><span className="small muted">{T("Signs you out on this device.", "Inakutoa kwenye kifaa hiki.")}</span></div>
          <button type="button" onClick={() => supabase.auth.signOut()}>{T("Sign out", "Toka")}</button>
        </div>
      </section>
    </>
  );
}

function SaveRow({ busy, msg, T, label, noButton }: { busy: boolean; msg: { ok?: string; err?: string }; T: Tr; label?: string; noButton?: boolean }) {
  return (
    <div className="row between saverow">
      <span className={"savemsg " + (msg.err ? "err" : "ok")}>{msg.err ?? msg.ok ?? ""}</span>
      {!noButton && <button className="primary" disabled={busy}>{busy ? T("Saving…", "Inahifadhi…") : label ?? T("Save changes", "Hifadhi mabadiliko")}</button>}
    </div>
  );
}

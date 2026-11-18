import { useEffect, useState } from "react";
import { supabase, Workspace, canManage, canEdit, when } from "./lib";
import { enterCards, enterRows, flash, shake, usePageEnter, select } from "./motion";

type Tab = "business" | "profile" | "appearance" | "rules" | "account";
const TABS: [Tab, string, string][] = [["business", "Business", "Biashara"], ["profile", "Business profile", "Wasifu wa biashara"], ["appearance", "Appearance", "Muonekano"], ["rules", "Rules & rates", "Kanuni na viwango"], ["account", "Account", "Akaunti"]];
const CURRENCIES = ["TZS", "KES", "UGX", "RWF", "USD"];

export default function Settings({ ws, onWs, theme, onTheme }: { ws: Workspace; onWs: (w: Workspace) => void; theme: "dark" | "light"; onTheme: (t: "dark" | "light", from?: HTMLElement | null) => void }) {
  const [tab, setTab] = useState<Tab>(() => { const t = location.hash.split("/")[1]; return t === "rates" ? "rules" : TABS.some(([k]) => k === t) ? (t as Tab) : "business"; });
  const [email, setEmail] = useState("");
  const lang = ws.language;
  const T = (en: string, sw: string) => (lang === "sw" ? sw : en);
  useEffect(() => { supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? "")); }, []);
  useEffect(() => { history.replaceState(null, "", "#settings/" + tab); }, [tab]);
  useEffect(() => { document.querySelector("nav.subtabs a.on")?.scrollIntoView({ block: "nearest", inline: "center" }); }, [tab]);
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
      {!canManage(ws) && tab !== "profile" && tab !== "account" && tab !== "appearance" && <p className="small muted">{T("Only an owner or admin can change these settings.", "Mmiliki au msimamizi tu anaweza kubadilisha mipangilio hii.")}</p>}
      {tab === "business" && <Business ws={ws} onWs={onWs} T={T} />}
      {tab === "profile" && <Profile ws={ws} T={T} />}
      {tab === "appearance" && <Appearance ws={ws} onWs={onWs} theme={theme} onTheme={onTheme} T={T} />}
      {tab === "rules" && <Rates ws={ws} onWs={onWs} T={T} />}
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
  const manager = canManage(ws);
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
      <Field id="s-name" label={T("Business name", "Jina la biashara")}><input id="s-name" required value={name} disabled={!manager} onChange={(e) => setName(e.target.value)} /></Field>
      <Field id="s-cur" label={T("Sales currency", "Sarafu ya mauzo")} hint={T("What customers pay in. Ad spend may be in another currency; set the rate under Rates.", "Wateja wanalipa kwa sarafu hii. Matangazo yanaweza kuwa sarafu nyingine; weka kiwango kwenye Viwango.")}>
        <select id="s-cur" value={currency} disabled={!manager} onChange={(e) => setCurrency(e.target.value)}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
      </Field>
      <Field id="s-unit" label={T("Cost per order", "Gharama kwa oda") + ` (${currency})`} hint={T("Product + delivery cost for one order. Optional; when set, the dashboard shows contribution after ad spend.", "Gharama ya bidhaa + usafirishaji kwa oda moja. Si lazima; ikiwekwa, dashibodi inaonyesha faida ya mchango.")}>
        <input id="s-unit" inputMode="decimal" placeholder="e.g. 18000" value={unit} disabled={!manager} onChange={(e) => setUnit(e.target.value)} />
      </Field>
      {manager && <SaveRow busy={busy} msg={msg} T={T} />}
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
      <FontPicker T={T} />
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
  const [hours, setHours] = useState(String(ws.follow_up_hours ?? 24));
  const [win, setWin] = useState(String(ws.conversion_window_days ?? 30));
  const [tz, setTz] = useState(ws.timezone ?? "Africa/Dar_es_Salaam");
  const { msg, busy, save } = useSave(ws, onWs);
  const manager = canManage(ws);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = rate.trim() === "" ? null : Number(rate.replace(/,/g, ""));
    const h = Number(hours), w = Number(win);
    if ((v !== null && !(v > 0)) || !(h >= 1 && h <= 720) || !(w >= 1 && w <= 180)) { shake(e.currentTarget); return; }
    try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { shake(e.currentTarget); return; }
    await save({ fx_rate: v, follow_up_hours: h, conversion_window_days: w, timezone: tz }, e.currentTarget, T("Saved. Reports now use these rules.", "Imehifadhiwa. Ripoti sasa zinatumia kanuni hizi."));
  }
  return (
    <form className="card" onSubmit={submit}>
      <div><h2>{T("Reporting rules", "Kanuni za ripoti")}</h2><span className="small muted">{T("These rules decide how figures are counted. They are applied the same way everywhere and never by AI.", "Kanuni hizi zinaamua jinsi takwimu zinavyohesabiwa. Zinatumika sawa kila mahali, si kwa AI.")}</span></div>
      <Field id="s-fx" label={T("Exchange rate: 1 unit of ad currency =", "Kiwango: kitengo 1 cha sarafu ya tangazo =")} hint={T(`Only needed when the ad account is billed in another currency (for example US dollars) and sales are in ${ws.currency}. Used for return on ad spend and contribution.`, `Inahitajika tu kama matangazo yanalipwa kwa sarafu nyingine na mauzo ni ${ws.currency}.`)}>
        <div className="row"><input id="s-fx" inputMode="decimal" style={{ width: 160 }} placeholder="e.g. 2600" value={rate} disabled={!manager} onChange={(e) => setRate(e.target.value)} /><span>{ws.currency}</span></div>
      </Field>
      <Field id="s-fu" label={T("Follow-up is due after (hours)", "Ufuatiliaji unafika baada ya (saa)")} hint={T("A warm chat with no message from you for this long appears in Actions.", "Chat yenye nia bila ujumbe wako kwa muda huu inaonekana kwenye Vitendo.")}>
        <input id="s-fu" inputMode="numeric" style={{ width: 160 }} value={hours} disabled={!manager} onChange={(e) => setHours(e.target.value)} />
      </Field>
      <Field id="s-win" label={T("Conversion window (days)", "Dirisha la uthibitisho (siku)")} hint={T("A paid order counts for a chat only if it was paid within this many days of the chat starting.", "Oda inahesabiwa kwa chat tu ikilipwa ndani ya siku hizi tangu chat ianze.")}>
        <input id="s-win" inputMode="numeric" style={{ width: 160 }} value={win} disabled={!manager} onChange={(e) => setWin(e.target.value)} />
      </Field>
      <Field id="s-tz" label={T("Timezone", "Saa za eneo")} hint={T("Days and periods are counted in this timezone.", "Siku na vipindi vinahesabiwa kwa saa hizi.")}>
        <input id="s-tz" style={{ width: 260 }} value={tz} disabled={!manager} onChange={(e) => setTz(e.target.value)} />
      </Field>
      {manager && <SaveRow busy={busy} msg={msg} T={T} />}
    </form>
  );
}

type ProfileRow = { products: { name: string; price: string; note: string }[]; delivery_areas: string; payment_methods: string; tone: string; faqs: { q: string; a: string }[]; constraints: string; updated_at?: string };
const emptyProfile = (): ProfileRow => ({ products: [], delivery_areas: "", payment_methods: "", tone: "", faqs: [], constraints: "" });

function Profile({ ws, T }: { ws: Workspace; T: Tr }) {
  const [p, setP] = useState<ProfileRow | null>(null);
  const [exists, setExists] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [busy, setBusy] = useState(false);
  const editor = canEdit(ws);
  useEffect(() => {
    supabase.from("business_profiles").select("*").eq("workspace_id", ws.id).maybeSingle().then(({ data, error }) => {
      if (error) setMsg({ err: error.message });
      if (data) { setExists(true); setP({ products: (data.products ?? []).map((x: any) => ({ name: x.name ?? "", price: x.price == null ? "" : String(x.price), note: x.note ?? "" })), delivery_areas: data.delivery_areas ?? "", payment_methods: data.payment_methods ?? "", tone: data.tone ?? "", faqs: (data.faqs ?? []).map((x: any) => ({ q: x.q ?? "", a: x.a ?? "" })), constraints: data.constraints ?? "", updated_at: data.updated_at }); }
      else setP(emptyProfile());
    });
  }, [ws.id]);
  if (!p) return <div className="skeleton" style={{ minHeight: 200 }} />;
  const set = (patch: Partial<ProfileRow>) => setP({ ...p, ...patch });
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setMsg({});
    const row = {
      workspace_id: ws.id,
      products: p!.products.filter((x) => x.name.trim()).map((x) => ({ name: x.name.trim().slice(0, 80), price: x.price.trim().slice(0, 40), note: x.note.trim().slice(0, 160) })),
      delivery_areas: p!.delivery_areas.trim().slice(0, 600) || null, payment_methods: p!.payment_methods.trim().slice(0, 400) || null, tone: p!.tone.trim().slice(0, 300) || null,
      faqs: p!.faqs.filter((x) => x.q.trim()).map((x) => ({ q: x.q.trim().slice(0, 200), a: x.a.trim().slice(0, 500) })), constraints: p!.constraints.trim().slice(0, 800) || null,
    };
    const { error } = exists ? await supabase.from("business_profiles").update(row).eq("workspace_id", ws.id) : await supabase.from("business_profiles").insert(row);
    setBusy(false);
    if (error) { shake(e.currentTarget); setMsg({ err: error.message }); } else { setExists(true); setMsg({ ok: T("Saved. Kito uses this when drafting replies and content.", "Imehifadhiwa. Kito anatumia hii kuandika rasimu.") }); flash(e.currentTarget.querySelector(".savemsg")); }
  }
  return (
    <form className="card" onSubmit={submit}>
      <div><h2>{T("Business profile", "Wasifu wa biashara")}</h2><span className="small muted">{T("The only facts Kito may state when drafting replies or content ideas. Visible to everyone in this workspace and to nobody else.", "Ukweli pekee ambao Kito anaweza kutaja akiandika rasimu. Inaonekana kwa wote wa workspace hii tu.")}{p.updated_at ? ` · ${T("last edited", "imehaririwa")} ${when(p.updated_at)}` : ""}</span></div>
      <div><h3>{T("Products and prices", "Bidhaa na bei")}</h3>
        {p.products.map((x, i) => (
          <div className="row" key={i} style={{ marginTop: 6 }}>
            <input placeholder={T("Product", "Bidhaa")} value={x.name} disabled={!editor} onChange={(e) => set({ products: p.products.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)) })} />
            <input placeholder={T("Price", "Bei")} style={{ width: 120 }} value={x.price} disabled={!editor} onChange={(e) => set({ products: p.products.map((y, j) => (j === i ? { ...y, price: e.target.value } : y)) })} />
            <input placeholder={T("Note (size, pack, what it is for)", "Maelezo")} value={x.note} disabled={!editor} onChange={(e) => set({ products: p.products.map((y, j) => (j === i ? { ...y, note: e.target.value } : y)) })} />
            {editor && <button type="button" className="small" onClick={() => set({ products: p.products.filter((_, j) => j !== i) })}>×</button>}
          </div>
        ))}
        {editor && <button type="button" className="small" style={{ marginTop: 6 }} onClick={() => set({ products: [...p.products, { name: "", price: "", note: "" }] })}>{T("+ Add product", "+ Ongeza bidhaa")}</button>}
      </div>
      <Field id="bp-del" label={T("Delivery areas, cost and time", "Maeneo, gharama na muda wa usafirishaji")}><textarea id="bp-del" rows={2} value={p.delivery_areas} disabled={!editor} onChange={(e) => set({ delivery_areas: e.target.value })} /></Field>
      <Field id="bp-pay" label={T("Payment methods", "Njia za malipo")} hint={T("e.g. M-Pesa Lipa Namba, Tigo Pesa, cash on delivery in Dar", "mfano M-Pesa Lipa Namba, Tigo Pesa, cash ukipokea Dar")}><input id="bp-pay" value={p.payment_methods} disabled={!editor} onChange={(e) => set({ payment_methods: e.target.value })} /></Field>
      <Field id="bp-tone" label={T("Tone", "Sauti")} hint={T("How you talk to customers: formal/relaxed, Kiswahili/English, greetings you use", "Jinsi unavyoongea na wateja")}><input id="bp-tone" value={p.tone} disabled={!editor} onChange={(e) => set({ tone: e.target.value })} /></Field>
      <div><h3>{T("Common questions and your answers", "Maswali ya kawaida na majibu yako")}</h3>
        {p.faqs.map((x, i) => (
          <div className="row" key={i} style={{ marginTop: 6 }}>
            <input placeholder={T("Question", "Swali")} value={x.q} disabled={!editor} onChange={(e) => set({ faqs: p.faqs.map((y, j) => (j === i ? { ...y, q: e.target.value } : y)) })} />
            <input placeholder={T("Answer", "Jibu")} style={{ flex: 1, minWidth: 200 }} value={x.a} disabled={!editor} onChange={(e) => set({ faqs: p.faqs.map((y, j) => (j === i ? { ...y, a: e.target.value } : y)) })} />
            {editor && <button type="button" className="small" onClick={() => set({ faqs: p.faqs.filter((_, j) => j !== i) })}>×</button>}
          </div>
        ))}
        {editor && <button type="button" className="small" style={{ marginTop: 6 }} onClick={() => set({ faqs: [...p.faqs, { q: "", a: "" }] })}>{T("+ Add question", "+ Ongeza swali")}</button>}
      </div>
      <Field id="bp-con" label={T("Things never to promise / service constraints", "Mambo ya kutoahidi / vikwazo")} hint={T("e.g. no medical claims, no same-day delivery outside Dar, no discounts below list price", "mfano hakuna madai ya kiafya, hakuna delivery siku hiyo nje ya Dar")}><textarea id="bp-con" rows={2} value={p.constraints} disabled={!editor} onChange={(e) => set({ constraints: e.target.value })} /></Field>
      {editor ? <SaveRow busy={busy} msg={msg} T={T} /> : <p className="small muted">{T("Viewer role: read-only.", "Nafasi ya kutazama tu.")}</p>}
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

const FONTS: { id: string; name: string; family: string; note: [string, string] }[] = [
  { id: "geist", name: "Geist", family: '"Geist", system-ui, sans-serif', note: ["Default · same as ponditech.com", "Ya kawaida · kama ponditech.com"] },
  { id: "urbanist", name: "Urbanist", family: '"Urbanist", system-ui, sans-serif', note: ["Rounded, friendly", "Ya mviringo"] },
  { id: "inter", name: "Inter", family: '"Inter", system-ui, sans-serif', note: ["Clean · easy to read numbers", "Safi · namba zinasomeka vizuri"] },
];

function FontPicker({ T }: { T: Tr }) {
  const read = () => { try { return localStorage.getItem("itaos-font") || "geist"; } catch { return "geist"; } };
  const [font, setFont] = useState(read);
  const pick = (id: string) => {
    setFont(id);
    if (id === "geist") delete document.documentElement.dataset.font; else document.documentElement.dataset.font = id;
    try { localStorage.setItem("itaos-font", id); } catch { /* storage unavailable */ }
  };
  return (
    <section className="card">
      <div><h2>{T("Font", "Herufi")}</h2><span className="small muted">{T("Saved on this device only.", "Inahifadhiwa kwenye kifaa hiki tu.")}</span></div>
      <div className="fontpick" role="group" aria-label="Font">
        {FONTS.map((f) => (
          <button key={f.id} type="button" className={font === f.id ? "on" : ""} aria-pressed={font === f.id} onClick={() => pick(f.id)} style={{ fontFamily: f.family }}>
            <span className="fp-sample">USD 462.71</span>
            <span>{f.name}</span>
            <span className="fp-name">{T(f.note[0], f.note[1])}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

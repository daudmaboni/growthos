import { useEffect, useRef, useState } from "react";
import { enterShell, enterTiles, shake, switchTheme, usePageEnter, select } from "./motion";
import type { Session } from "@supabase/supabase-js";
import { supabase, Workspace, WS_COLUMNS, Role } from "./lib";
import Dashboard from "./Dashboard";
import Chats from "./Chats";
import Connect from "./Connect";
import Settings from "./Settings";
import Report from "./Report";
import Actions from "./Actions";
import Content from "./Content";
import Kito from "./Kito";
import Logo from "./Logo";
import { hidePreloader } from "./preloader";

type View = "dashboard" | "kito" | "report" | "actions" | "chats" | "content" | "connect" | "settings";
const VIEWS: View[] = ["dashboard", "kito", "report", "actions", "chats", "content", "connect", "settings"];
const viewFromHash = (): View => {
  const h = location.hash.replace("#", "").split("/")[0];
  return (VIEWS as string[]).includes(h) ? (h as View) : "dashboard";
};

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [ws, setWs] = useState<Workspace | null | undefined>(undefined);
  const [view, setView] = useState<View>(viewFromHash());
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try { return localStorage.getItem("growthos-theme") === "light" ? "light" : "dark"; } catch { return "dark"; }
  });
  useEffect(() => { document.documentElement.dataset.theme = theme; }, []);
  const themeBtn = useRef<HTMLButtonElement>(null);
  const setThemeFrom = (n: "dark" | "light", from?: HTMLElement | null) => {
    if (n === theme) return;
    switchTheme(n, from ?? themeBtn.current); // circular wipe from the button, then the attribute + storage are set
    setTheme(n);
  };
  const toggleTheme = () => setThemeFrom(theme === "dark" ? "light" : "dark");
  const setLanguage = async (l: "sw" | "en") => {
    if (!ws || ws.language === l) return;
    setWs({ ...ws, language: l }); // instant; everyone in the workspace sees the new default
    const { error } = await supabase.from("workspaces").update({ language: l }).eq("id", ws.id);
    if (error) setWs(ws);
  };
  const shellRef = usePageEnter<HTMLDivElement>((root) => { enterShell(root); }, [!!session && !!ws]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    const onHash = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHash);
    return () => { sub.subscription.unsubscribe(); window.removeEventListener("hashchange", onHash); };
  }, []);

  useEffect(() => {
    if (!session) { setWs(undefined); return; }
    supabase.from("workspaces").select(WS_COLUMNS).order("created_at").limit(1).then(async ({ data }) => {
      const w = (data?.[0] as unknown as Workspace) ?? null;
      if (w) { const { data: role } = await supabase.rpc("member_role", { ws: w.id }); w.role = (role as Role) ?? "viewer"; }
      setWs(w);
    });
  }, [session]);

  // Keep the bouncing dots up until we know whether to show login, workspace setup or the dashboard.
  useEffect(() => { if (session === null || (session && ws !== undefined)) hidePreloader(); }, [session, ws]);

  if (session === undefined) return <div className="center muted">Loading…</div>;
  if (!session) return <Login />;
  if (ws === undefined) return <div className="center muted">Loading workspace…</div>;
  if (ws === null) return <CreateWorkspace onDone={setWs} />;

  return (
    <div className="shell" ref={shellRef}>
      <header className="topbar">
        <div className="brand"><a className="home" href="#dashboard" aria-label="GrowthOS, go to dashboard" onClick={() => window.scrollTo({ top: 0 })}><Logo size={34} /><span className="brand-text"><h1>GrowthOS</h1><span className="ws" title={ws.name}>{ws.name}</span></span></a></div>
        <nav className="tabs" aria-label="Sections">
          <a href="#dashboard" className={view === "dashboard" ? "on" : ""}>Dashboard</a>
          <a href="#kito" className={view === "kito" ? "on" : ""}>{ws.language === "sw" ? "Muulize Kito" : "Ask Kito"}</a>
          <a href="#report" className={view === "report" ? "on" : ""}>{ws.language === "sw" ? "Uchunguzi" : "Diagnosis"}</a>
          <a href="#actions" className={view === "actions" ? "on" : ""}>{ws.language === "sw" ? "Vitendo" : "Actions"}</a>
          <a href="#chats" className={view === "chats" ? "on" : ""}>Chats</a>
          <a href="#content" className={view === "content" ? "on" : ""}>{ws.language === "sw" ? "Maudhui" : "Content"}</a>
          <a href="#connect" className={view === "connect" ? "on" : ""}>Connections</a>
        </nav>
        <div className="actions">
          <div className="seg" role="group" aria-label="Language">
            {(["sw", "en"] as const).map((l) => <button key={l} type="button" className={ws.language === l ? "on" : ""} aria-pressed={ws.language === l} onClick={() => setLanguage(l)}>{l.toUpperCase()}</button>)}
          </div>
          <button ref={themeBtn} className="icon" onClick={toggleTheme} aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} title="Light / dark">{theme === "dark" ? "☀" : "☾"}</button>
          <a href="#settings" className={"icon gear" + (view === "settings" ? " on" : "")} aria-label="Settings" title="Settings"><GearIcon /></a>
        </div>
      </header>
      <BottomNav view={view} sw={ws.language === "sw"} />
      {view === "dashboard" && <Dashboard ws={ws} />}
      {view === "kito" && <Kito ws={ws} />}
      {view === "report" && <Report ws={ws} />}
      {view === "actions" && <Actions ws={ws} />}
      {view === "chats" && <Chats ws={ws} />}
      {view === "content" && <Content ws={ws} />}
      {view === "connect" && <Connect ws={ws} />}
      {view === "settings" && <Settings ws={ws} onWs={setWs} theme={theme} onTheme={setThemeFrom} />}
    </div>
  );
}

function GearIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"password" | "link">("password");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const formRef = usePageEnter<HTMLFormElement>((f) => { enterTiles(select(f, ":scope > *"), { stagger: 0.06 }); });
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(""); setBusy(true);
    if (mode === "password") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      setBusy(false);
      if (error) { shake(formRef.current); setErr(error.message === "Invalid login credentials" ? "Wrong email or password." : error.message); }
      return;
    }
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin } });
    setBusy(false);
    if (error) setErr(/rate limit/i.test(error.message) ? "Too many emails sent. Wait an hour or sign in with your password." : error.message); else setSent(true);
  }
  return (
    <div className="center">
      <form className="card auth" ref={formRef} onSubmit={submit}>
        <div className="row"><Logo size={44} /><h1>GrowthOS</h1></div>
        <p className="muted" style={{ margin: 0 }}>See which ads bring paying customers, not just chats.</p>
        {sent ? <p className="ok">Check {email} for a sign-in link.</p> : (<>
          <label htmlFor="email"><b>Email</b></label>
          <input id="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@business.co.tz" />
          {mode === "password" && (<>
            <label htmlFor="pw"><b>Password</b></label>
            <input id="pw" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </>)}
          <button className="primary" disabled={busy}>{busy ? "Please wait…" : mode === "password" ? "Sign in" : "Email me a sign-in link"}</button>
          <button type="button" className="small" onClick={() => { setMode(mode === "password" ? "link" : "password"); setErr(""); }}>
            {mode === "password" ? "Use an email link instead" : "Use a password instead"}
          </button>
          {err && <p className="err">{err}</p>}
        </>)}
      </form>
    </div>
  );
}

function CreateWorkspace({ onDone }: { onDone: (w: Workspace) => void }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const formRef = usePageEnter<HTMLFormElement>((f) => { enterTiles(select(f, ":scope > *"), { stagger: 0.06 }); });
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr("");
    const { data: id, error } = await supabase.rpc("create_workspace", { p_name: name.trim() });
    if (error) return setErr(error.message);
    const { data } = await supabase.from("workspaces").select(WS_COLUMNS).eq("id", id).single();
    onDone({ ...(data as unknown as Workspace), role: "owner" });
  }
  return (
    <div className="center">
      <form className="card auth" ref={formRef} onSubmit={submit}>
        <h2>Name your business</h2>
        <label htmlFor="wsname" className="small muted">This is the workspace your ads and WhatsApp connect to.</label>
        <input id="wsname" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Kayani Herbs" />
        <button className="primary">Create workspace</button>
        {err && <p className="err">{err}</p>}
      </form>
    </div>
  );
}

const ORDER: View[] = ["dashboard", "kito", "chats"];
const SLOTS = ORDER.length + 1; // + More

/** Phone navigation: four main sections plus "More". Hidden on wider screens, where the top tabs show. */
export function BottomNav({ view, sw }: { view: View; sw: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener("hashchange", close);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("hashchange", close); window.removeEventListener("keydown", esc); };
  }, []);
  const L = (en: string, s: string) => (sw ? s : en);
  const main: [View, string, JSX.Element][] = [
    ["dashboard", L("Home", "Nyumbani"), <Ico d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />],
    ["kito", "Kito", <Ico d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9zM19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />],
    ["chats", "Chats", <Ico d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5A8 8 0 1 1 21 12z" />],
  ];
  const more: [View, string, string, JSX.Element][] = [
    ["report", L("Diagnosis", "Uchunguzi"), L("What is working this week", "Kinachofanya kazi wiki hii"), <Ico d="M3 12h4l3-8 4 16 3-8h4" />],
    ["actions", L("Actions", "Vitendo"), L("Follow-ups, tasks and Kito drafts", "Ufuatiliaji, kazi na rasimu za Kito"), <Ico d="M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9" />],
    ["content", L("Content", "Maudhui"), L("Posts and what they bring in", "Machapisho na matokeo yake"), <Ico d="M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5" />],
    ["connect", L("Connections", "Miunganisho"), L("Ad account and WhatsApp", "Akaunti ya matangazo na WhatsApp"), <Ico d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />],
    ["settings", L("Settings", "Mipangilio"), L("Business, appearance, rules", "Biashara, muonekano, kanuni"), <GearIcon />],
  ];
  const moreOn = more.some(([v]) => v === view);
  const idx = open || moreOn ? SLOTS - 1 : Math.max(0, ORDER.indexOf(view));
  const navRef = useRef<HTMLElement>(null);
  const suppressClick = useRef(false);
  const setLens = (i: number, dragging: boolean) => {
    const n = navRef.current; if (!n) return;
    n.style.setProperty("--i", String(i));
    n.classList.toggle("dragging", dragging);
  };
  useEffect(() => { setLens(idx, false); }, [idx]);
  const go = (i: number) => {
    if (i >= SLOTS - 1) { setOpen(true); setLens(SLOTS - 1, false); return; }
    setOpen(false);
    if (ORDER[i] !== view) { window.scrollTo({ top: 0 }); location.hash = ORDER[i]; } else setLens(i, false);
  };

  // Drag along the bar: the lens follows the finger and snaps to the tab where it is released.
  const onBarDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const n = navRef.current; if (!n) return;
    const r = n.getBoundingClientRect(), slot = (r.width - 12) / SLOTS, x0 = e.clientX;
    let moved = false, frac = idx;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 8) return;
      moved = true;
      frac = Math.min(SLOTS - 1, Math.max(0, (ev.clientX - r.left - 6 - slot / 2) / slot));
      setLens(frac, true);
    };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up);
      if (!moved) return;
      suppressClick.current = true; setTimeout(() => (suppressClick.current = false), 350);
      go(Math.round(frac));
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
  };

  // Swipe the page left/right to move between the four main sections; the lens tracks the swipe.
  useEffect(() => {
    const cur = ORDER.indexOf(view);
    if (cur < 0 || open) return;
    let x0 = 0, y0 = 0, t0 = 0, mode: "" | "h" | "v" = "", dx = 0;
    const blocked = (el: EventTarget | null) => {
      for (let n = el as HTMLElement | null; n && n !== document.body; n = n.parentElement) {
        if (n.matches("input, textarea, select, .seg, .bottomnav, .sheet, [data-noswipe]")) return true;
        const ox = getComputedStyle(n).overflowX;
        if ((ox === "auto" || ox === "scroll") && n.scrollWidth > n.clientWidth + 2) return true;
      }
      return false;
    };
    const start = (e: TouchEvent) => {
      if (e.touches.length !== 1 || blocked(e.target)) { mode = "v"; return; }
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now(); mode = ""; dx = 0;
    };
    const move = (e: TouchEvent) => {
      if (mode === "v") return;
      dx = e.touches[0].clientX - x0; const dy = e.touches[0].clientY - y0;
      if (!mode) { if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return; mode = Math.abs(dx) > Math.abs(dy) * 1.4 ? "h" : "v"; if (mode === "v") return; }
      const w = window.innerWidth;
      setLens(Math.min(ORDER.length - 1, Math.max(0, cur - dx / w * 1.2)), true);
    };
    const end = () => {
      if (mode !== "h") return;
      const fast = Math.abs(dx) / Math.max(1, Date.now() - t0) > 0.5;
      const next = Math.abs(dx) > window.innerWidth * 0.28 || (fast && Math.abs(dx) > 40) ? cur + (dx < 0 ? 1 : -1) : cur;
      mode = "";
      if (next >= 0 && next < ORDER.length && next !== cur) go(next); else setLens(cur, false);
    };
    window.addEventListener("touchstart", start, { passive: true });
    window.addEventListener("touchmove", move, { passive: true });
    window.addEventListener("touchend", end);
    window.addEventListener("touchcancel", end);
    return () => { window.removeEventListener("touchstart", start); window.removeEventListener("touchmove", move); window.removeEventListener("touchend", end); window.removeEventListener("touchcancel", end); };
  }, [view, open]);

  return (
    <>
      {open && <div className="sheet-back" onClick={() => setOpen(false)} />}
      {open && (
        <div className="sheet" role="dialog" aria-label={L("More", "Zaidi")}>
          <span className="sheet-grip" aria-hidden="true" />
          {more.map(([v, label, note, icon]) => (
            <a key={v} href={"#" + v} className={"sheet-item" + (view === v ? " on" : "")}>
              <span className="sheet-ico">{icon}</span>
              <span><b>{label}</b><span className="small muted">{note}</span></span>
            </a>
          ))}
        </div>
      )}
      <nav className="bottomnav" aria-label="Sections" ref={navRef} style={{ ["--n" as any]: SLOTS }} onPointerDown={onBarDown}
        onClickCapture={(e) => { if (suppressClick.current) { e.preventDefault(); e.stopPropagation(); } }}>
        <span className="lens" aria-hidden="true" />
        {main.map(([v, label, icon]) => (
          <a key={v} href={"#" + v} className={view === v && !open ? "on" : ""} aria-current={view === v ? "page" : undefined} onClick={() => window.scrollTo({ top: 0 })}>{icon}<span>{label}</span></a>
        ))}
        <button type="button" className={moreOn || open ? "on" : ""} aria-expanded={open} onClick={() => setOpen(!open)}>
          <Ico d="M5 12h.01M12 12h.01M19 12h.01" w={3} /><span>{L("More", "Zaidi")}</span>
        </button>
      </nav>
    </>
  );
}

function Ico({ d, w = 2 }: { d: string; w?: number }) {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}

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
import Logo from "./Logo";

type View = "dashboard" | "report" | "actions" | "chats" | "content" | "connect" | "settings";
const VIEWS: View[] = ["dashboard", "report", "actions", "chats", "content", "connect", "settings"];
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
          <a href="#settings" className={"icon" + (view === "settings" ? " on" : "")} aria-label="Settings" title="Settings"><GearIcon /></a>
        </div>
      </header>
      {view === "dashboard" && <Dashboard ws={ws} />}
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

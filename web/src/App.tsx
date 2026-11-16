import { useEffect, useRef, useState } from "react";
import { enterShell, enterTiles, shake, switchTheme, usePageEnter, select } from "./motion";
import type { Session } from "@supabase/supabase-js";
import { supabase, Workspace } from "./lib";
import Dashboard from "./Dashboard";
import Chats from "./Chats";
import Connect from "./Connect";
import Settings from "./Settings";
import Logo from "./Logo";

type View = "dashboard" | "chats" | "connect" | "settings";
const viewFromHash = (): View => {
  const h = location.hash.replace("#", "").split("/")[0];
  return h === "chats" || h === "connect" || h === "settings" ? h : "dashboard";
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
    supabase.from("workspaces").select("id,name,currency,language,unit_cost,fx_rate").order("created_at").limit(1)
      .then(({ data }) => setWs((data?.[0] as Workspace) ?? null));
  }, [session]);

  if (session === undefined) return <div className="center muted">Loading…</div>;
  if (!session) return <Login />;
  if (ws === undefined) return <div className="center muted">Loading workspace…</div>;
  if (ws === null) return <CreateWorkspace onDone={setWs} />;

  return (
    <div className="shell" ref={shellRef}>
      <header className="topbar">
        <div className="brand"><a className="home" href="#dashboard" aria-label="GrowthOS, go to dashboard" onClick={() => window.scrollTo({ top: 0 })}><Logo size={34} /><h1>GrowthOS</h1></a><span className="ws">{ws.name}</span></div>
        <nav className="tabs" aria-label="Sections">
          <a href="#dashboard" className={view === "dashboard" ? "on" : ""}>Dashboard</a>
          <a href="#chats" className={view === "chats" ? "on" : ""}>Chats</a>
          <a href="#connect" className={view === "connect" ? "on" : ""}>Connections</a>
          <a href="#settings" className={view === "settings" ? "on" : ""} aria-label="Settings">Settings</a>
        </nav>
        <div className="actions">
          <button ref={themeBtn} className="icon" onClick={toggleTheme} aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} title="Light / dark">{theme === "dark" ? "☀" : "☾"}</button>
        </div>
      </header>
      {view === "dashboard" && <Dashboard ws={ws} />}
      {view === "chats" && <Chats ws={ws} />}
      {view === "connect" && <Connect ws={ws} />}
      {view === "settings" && <Settings ws={ws} onWs={setWs} theme={theme} onTheme={setThemeFrom} />}
    </div>
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
    const { data } = await supabase.from("workspaces").select("id,name,currency,language,unit_cost,fx_rate").eq("id", id).single();
    onDone(data as Workspace);
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

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { staffSupabase as supabase } from "./adminClient";
import { hidePreloader } from "./preloader";
import Admin from "./Admin";

/** Pondi staff area at "/app/admin": its own sign-in, separate from business accounts. */
export default function AdminPage() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    document.title = "ItaOS Staff";
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => { if (session !== undefined) hidePreloader(); }, [session]);

  if (session === undefined) return null;
  if (!session) return <StaffSignIn />;
  return <Admin supabase={supabase} backHref="/app" onSignOut={() => { void supabase.auth.signOut(); }} />;
}

function StaffSignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr("");
    if (!email.trim() || !password) return setErr("Enter your staff email and password.");
    setBusy(true);
    const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    if (error) {
      setBusy(false);
      return setErr(/invalid login/i.test(error.message) ? "Wrong email or password."
        : /not confirmed/i.test(error.message) ? "This staff account isn't confirmed yet. Confirm it in Supabase → Authentication → Users."
        : /failed to fetch|network/i.test(error.message) ? "Couldn't reach ItaOS. Check your internet connection." : error.message);
    }
    // Only platform admins may stay signed in here.
    const { data: ok } = await supabase.rpc("is_platform_admin");
    if (ok !== true) {
      await supabase.auth.signOut();
      setBusy(false);
      return setErr(`${data.user?.email ?? "This account"} isn't a Pondi staff account. Business owners sign in on the main sign-in page.`);
    }
    // onAuthStateChange shows the dashboard.
  }

  return (
    <div className="st">
      <style>{CSS}</style>
      <form className="st-card" onSubmit={submit} noValidate>
        <div className="st-brand"><span className="st-mark">ita.</span><span>Staff</span></div>
        <h1>Pondi staff sign-in</h1>
        <p className="st-sub">For the ItaOS team only. Business owners sign in on the <a href="/app">main sign-in page</a>.</p>
        <label className="st-field"><span>Staff email</span>
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="hello@ponditech.com" autoFocus /></label>
        <label className="st-field"><span>Password</span>
          <div className="st-pw"><input type={show ? "text" : "password"} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <button type="button" onClick={() => setShow(!show)} aria-pressed={show}>{show ? "Hide" : "Show"}</button></div></label>
        <button className="st-btn" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        {err && <p className="st-err" role="alert">{err}</p>}
        <a className="st-back" href="/app">← Business sign-in</a>
      </form>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600..800&family=Instrument+Sans:wght@400..700&display=swap');
.st{min-height:100vh;display:grid;place-items:center;padding:20px;background:#16224A;font:14px/1.5 'Instrument Sans',system-ui,sans-serif;color:#141B34}
.st *{box-sizing:border-box}
.st-card{width:min(400px,100%);background:#fff;border-radius:22px;padding:28px;display:grid;gap:14px;box-shadow:0 30px 80px -30px rgba(0,0,0,.6)}
.st-brand{display:flex;align-items:center;gap:10px;font:600 14px 'Bricolage Grotesque',system-ui,sans-serif;color:#5D6580}
.st-mark{background:#F7C948;color:#16224A;font:800 17px/1 'Bricolage Grotesque',system-ui,sans-serif;padding:8px 8px 9px;border-radius:9px;letter-spacing:-.04em}
.st h1{margin:4px 0 0;font:700 24px/1.15 'Bricolage Grotesque',system-ui,sans-serif;letter-spacing:-.02em}
.st-sub{margin:0;color:#5D6580;font-size:13px}.st-sub a{color:#2C5A8C;font-weight:600}
.st-field{display:grid;gap:6px}.st-field>span{font-size:12.5px;font-weight:600;color:#5D6580}
.st input{font:inherit;width:100%;color:#141B34;background:#F1F2F6;border:1px solid transparent;border-radius:10px;padding:10px 12px}
.st input:focus{outline:0;border-color:#16224A;background:#fff}
.st-pw{position:relative}.st-pw input{padding-right:64px}
.st-pw button{position:absolute;right:6px;top:50%;transform:translateY(-50%);border:0;background:none;font-family:inherit;font-weight:600;font-size:12.5px;color:#2C5A8C;cursor:pointer;padding:6px}
.st-btn{font-family:inherit;font-weight:600;font-size:14px;border:0;border-radius:10px;padding:11px;background:#16224A;color:#fff;cursor:pointer}
.st-btn:hover:not(:disabled){background:#22336B}.st-btn:disabled{opacity:.6}
.st-err{margin:0;color:#C8372D;font-size:13px}
.st-back{text-align:center;color:#5D6580;font-size:13px;text-decoration:none}.st-back:hover{text-decoration:underline}
.st :focus-visible{outline:2px solid #F7C948;outline-offset:2px}
`;

import { useState } from "react";
import { supabase, AUTH_LINK_ERROR } from "./lib";
import { enterTiles, shake, usePageEnter, select } from "./motion";
import Logo from "./Logo";

/* ---------- language (before a workspace exists) ---------- */
export type Lang = "sw" | "en";
const LANG_KEY = "itaos-lang";
export function initialLang(): Lang {
  try { const v = localStorage.getItem(LANG_KEY); if (v === "sw" || v === "en") return v; } catch { /* storage unavailable */ }
  return "sw";
}
function saveLang(l: Lang) { try { localStorage.setItem(LANG_KEY, l); } catch { /* storage unavailable */ } }

const T = {
  tagline: { en: "See which ads bring paying customers, not just chats.", sw: "Ona matangazo yapi yanaleta wateja wanaolipa, si gumzo tu." },
  signIn: { en: "Sign in", sw: "Ingia" },
  createAccount: { en: "Create account", sw: "Fungua akaunti" },
  business: { en: "Business name", sw: "Jina la biashara" },
  businessPh: { en: "e.g. Kayani Herbs", sw: "mf. Kayani Herbs" },
  email: { en: "Email", sw: "Barua pepe" },
  password: { en: "Password", sw: "Nenosiri" },
  newPassword: { en: "New password", sw: "Nenosiri jipya" },
  pwHint: { en: "At least 8 characters", sw: "Angalau herufi 8" },
  show: { en: "Show", sw: "Onyesha" }, hide: { en: "Hide", sw: "Ficha" },
  forgot: { en: "Forgot password?", sw: "Umesahau nenosiri?" },
  useLink: { en: "Email me a sign-in link instead", sw: "Nitumie kiungo cha kuingia kwa barua pepe" },
  usePassword: { en: "Sign in with password instead", sw: "Ingia kwa nenosiri badala yake" },
  sendLink: { en: "Email me a sign-in link", sw: "Nitumie kiungo cha kuingia" },
  sendReset: { en: "Email me a reset link", sw: "Nitumie kiungo cha kubadilisha" },
  resetTitle: { en: "Reset your password", sw: "Badilisha nenosiri lako" },
  resetBody: { en: "Enter the email you signed up with. We'll send a link to set a new password.", sw: "Weka barua pepe uliyojisajili nayo. Tutakutumia kiungo cha kuweka nenosiri jipya." },
  back: { en: "Back to sign in", sw: "Rudi kuingia" },
  wait: { en: "Please wait…", sw: "Subiri kidogo…" },
  noAccount: { en: "New to ItaOS?", sw: "Mgeni kwenye ItaOS?" },
  haveAccount: { en: "Already have an account?", sw: "Tayari una akaunti?" },
  terms: { en: "By creating an account you agree to our", sw: "Kwa kufungua akaunti unakubali" },
  termsLink: { en: "terms", sw: "masharti yetu" },
  home: { en: "← Back to home", sw: "← Rudi mwanzo" },
  staff: { en: "Pondi staff? Staff sign-in", sw: "Mfanyakazi wa Pondi? Ingia hapa" },
  staffAccount: { en: "This is a Pondi staff account. Staff sign in on the staff page.", sw: "Hii ni akaunti ya wafanyakazi wa Pondi. Wafanyakazi huingia kwenye ukurasa wa wafanyakazi." },
  openStaff: { en: "Go to staff sign-in", sw: "Nenda kwa wafanyakazi" },
  // results
  checkTitle: { en: "Check your email", sw: "Angalia barua pepe yako" },
  checkSignup: { en: "We sent a confirmation link to {e}. Open it to finish creating your account. Your business will be ready when you come back.", sw: "Tumetuma kiungo cha uthibitisho kwa {e}. Kifungue ili kumaliza kufungua akaunti. Biashara yako itakuwa tayari ukirudi." },
  checkLink: { en: "We sent a sign-in link to {e}. Open it on this phone or computer.", sw: "Tumetuma kiungo cha kuingia kwa {e}. Kifungue kwenye simu au kompyuta hii." },
  checkReset: { en: "If {e} has an ItaOS account, a reset link is on its way. Open it to set a new password.", sw: "Kama {e} ina akaunti ya ItaOS, kiungo cha kubadilisha kiko njiani. Kifungue uweke nenosiri jipya." },
  spam: { en: "Not there after a minute? Check Spam or Promotions.", sw: "Hukioni baada ya dakika moja? Angalia Spam au Promotions." },
  resend: { en: "Send it again", sw: "Tuma tena" },
  resent: { en: "Sent again.", sw: "Imetumwa tena." },
  // errors
  wrong: { en: "Wrong email or password.", sw: "Barua pepe au nenosiri si sahihi." },
  unconfirmed: { en: "Confirm your email first. We can send the confirmation link again.", sw: "Thibitisha barua pepe yako kwanza. Tunaweza kutuma kiungo cha uthibitisho tena." },
  exists: { en: "An account with this email already exists. Sign in instead.", sw: "Akaunti yenye barua pepe hii tayari ipo. Ingia badala yake." },
  noSuchAccount: { en: "No ItaOS account uses this email. Check the spelling or create an account.", sw: "Hakuna akaunti ya ItaOS yenye barua pepe hii. Hakiki tahajia au fungua akaunti." },
  short: { en: "Use at least 8 characters for your password.", sw: "Tumia angalau herufi 8 kwa nenosiri." },
  needName: { en: "Enter your business name.", sw: "Weka jina la biashara yako." },
  needEmail: { en: "Enter a valid email address, like you@business.co.tz.", sw: "Weka barua pepe sahihi, mf. wewe@biashara.co.tz." },
  needPassword: { en: "Enter your password.", sw: "Weka nenosiri lako." },
  rate: { en: "Too many emails were sent just now. Wait a few minutes, or sign in with your password.", sw: "Barua pepe nyingi zimetumwa sasa hivi. Subiri dakika chache, au ingia kwa nenosiri." },
  offline: { en: "Couldn't reach ItaOS. Check your internet connection and try again.", sw: "Imeshindwa kufikia ItaOS. Hakiki intaneti yako ujaribu tena." },
  linkExpired: { en: "That email link has expired or was already used. Sign in, or ask for a new link.", sw: "Kiungo hicho kimeisha muda au kimeshatumika. Ingia, au omba kiungo kipya." },
  // set new password
  setTitle: { en: "Set a new password", sw: "Weka nenosiri jipya" },
  setBody: { en: "Choose a new password for {e}.", sw: "Chagua nenosiri jipya la {e}." },
  save: { en: "Save password", sw: "Hifadhi nenosiri" },
  saved: { en: "Password saved. Opening your business…", sw: "Nenosiri limehifadhiwa. Tunafungua biashara yako…" },
  // workspace
  wsTitle: { en: "Name your business", sw: "Taja jina la biashara yako" },
  wsBody: { en: "This is the workspace your ads and WhatsApp connect to.", sw: "Hapa ndipo matangazo yako na WhatsApp vitaunganishwa." },
  wsCreate: { en: "Create workspace", sw: "Fungua biashara" },
  wsCreating: { en: "Creating…", sw: "Tunafungua…" },
  wsFail: { en: "Couldn't create the workspace. Please try again.", sw: "Imeshindwa kufungua biashara. Tafadhali jaribu tena." },
  wsLost: { en: "Your email is confirmed, but this browser lost your sign-in. Please sign in again to continue.", sw: "Barua pepe yako imethibitishwa, ila kivinjari hiki kimepoteza uingiaji wako. Tafadhali ingia tena uendelee." },
  signInAgain: { en: "Sign in again", sw: "Ingia tena" },
} as const;
type Key = keyof typeof T;
export const tr = (lang: Lang, k: Key, vars: Record<string, string> = {}) =>
  Object.entries(vars).reduce<string>((s, [n, v]) => s.replace(`{${n}}`, v), T[k][lang]);

export function LangToggle({ lang, onChange }: { lang: Lang; onChange: (l: Lang) => void }) {
  return (
    <div className="seg auth-lang" role="group" aria-label="Language / Lugha">
      {(["sw", "en"] as const).map((l) => (
        <button key={l} type="button" className={lang === l ? "on" : ""} aria-pressed={lang === l} onClick={() => { saveLang(l); onChange(l); }}>
          {l === "sw" ? "Kiswahili" : "English"}
        </button>
      ))}
    </div>
  );
}

function friendly(lang: Lang, msg: string): string {
  if (/invalid login credentials/i.test(msg)) return tr(lang, "wrong");
  if (/email not confirmed/i.test(msg)) return tr(lang, "unconfirmed");
  if (/already registered|already exists/i.test(msg)) return tr(lang, "exists");
  if (/signups? not allowed|user not found/i.test(msg)) return tr(lang, "noSuchAccount");
  if (/rate limit|too many|security purposes/i.test(msg)) return tr(lang, "rate");
  if (/password should be at least|weak password/i.test(msg)) return tr(lang, "short");
  if (/failed to fetch|network/i.test(msg)) return tr(lang, "offline");
  return msg;
}

/* ---------- sign in / create account ---------- */
type Mode = "signin" | "signup" | "link" | "forgot";
type Sent = { kind: "signup" | "link" | "reset"; email: string } | null;

export function AuthScreen() {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [mode, setMode] = useState<Mode>(() => (/[?&]signup\b/.test(location.search) ? "signup" : "signin"));
  const [business, setBusiness] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState(AUTH_LINK_ERROR ? "LINK" : "");
  const [canResend, setCanResend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Sent>(null);
  const [resent, setResent] = useState(false);
  const formRef = usePageEnter<HTMLFormElement>((f) => { enterTiles(select(f, ":scope > *"), { stagger: 0.05 }); }, [mode, !!sent]);
  const t = (k: Key, v?: Record<string, string>) => tr(lang, k, v);
  const redirect = location.origin + "/app";

  const go = (m: Mode) => { setMode(m); setErr(""); setCanResend(false); };
  const fail = (msg: string) => {
    setBusy(false); shake(formRef.current);
    setCanResend(/email not confirmed/i.test(msg));
    setErr(friendly(lang, msg));
    if (/already registered|already exists/i.test(msg)) setMode("signin");
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(""); setCanResend(false);
    const em = email.trim().toLowerCase();
    if (mode === "signup" && !business.trim()) return fail(t("needName"));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return fail(t("needEmail"));
    if (mode === "signin" && !password) return fail(t("needPassword"));
    if (mode === "signup" && password.length < 8) return fail(t("short"));
    setBusy(true);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email: em, password });
        if (error) return fail(error.message);
        return; // App takes over on the auth event
      }
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email: em, password,
          options: { emailRedirectTo: redirect, data: { business_name: business.trim(), language: lang } } });
        if (error) return fail(error.message);
        // With email confirmation on, an existing address comes back as a user with no identities.
        if (data.user && (data.user.identities?.length ?? 0) === 0) return fail("already registered");
        setBusy(false);
        if (!data.session) setSent({ kind: "signup", email: em });
        return;
      }
      if (mode === "link") {
        const { error } = await supabase.auth.signInWithOtp({ email: em, options: { shouldCreateUser: false, emailRedirectTo: redirect } });
        if (error) return fail(error.message);
        setBusy(false); setSent({ kind: "link", email: em }); return;
      }
      const { error } = await supabase.auth.resetPasswordForEmail(em, { redirectTo: redirect });
      if (error && !/user not found/i.test(error.message)) return fail(error.message);
      setBusy(false); setSent({ kind: "reset", email: em });
    } catch (x) { fail(x instanceof Error ? x.message : String(x)); }
  }

  async function resend(target: string) {
    setResent(false); setBusy(true);
    const { error } = await supabase.auth.resend({ type: "signup", email: target, options: { emailRedirectTo: redirect } });
    setBusy(false);
    if (error) setErr(friendly(lang, error.message)); else { setResent(true); setErr(""); }
  }

  if (sent) {
    const body = sent.kind === "signup" ? "checkSignup" : sent.kind === "link" ? "checkLink" : "checkReset";
    return (
      <div className="center">
        <form className="card auth" ref={formRef} onSubmit={(e) => e.preventDefault()}>
          <div className="auth-top"><div className="row"><Logo size={36} /><b className="auth-brand">ItaOS</b></div><LangToggle lang={lang} onChange={setLang} /></div>
          <div className="auth-mail" aria-hidden="true">✉</div>
          <h2 style={{ margin: 0 }}>{t("checkTitle")}</h2>
          <p style={{ margin: 0 }}>{t(body, { e: sent.email })}</p>
          <p className="muted small" style={{ margin: 0 }}>{t("spam")}</p>
          {sent.kind === "signup" && <button type="button" disabled={busy} onClick={() => resend(sent.email)}>{t("resend")}</button>}
          {resent && <p className="ok" role="status">{t("resent")}</p>}
          {err && <p className="err" role="alert">{err}</p>}
          <button type="button" className="small link-btn" onClick={() => { setSent(null); setResent(false); go("signin"); }}>{t("back")}</button>
        </form>
      </div>
    );
  }

  const tabbed = mode === "signin" || mode === "signup";
  return (
    <div className="center">
      <form className="card auth" ref={formRef} onSubmit={submit} noValidate>
        <div className="auth-top"><div className="row"><Logo size={36} /><b className="auth-brand">ItaOS</b></div><LangToggle lang={lang} onChange={setLang} /></div>
        {tabbed ? (
          <>
            <p className="muted" style={{ margin: 0 }}>{t("tagline")}</p>
            <div className="seg auth-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={mode === "signin"} className={mode === "signin" ? "on" : ""} onClick={() => go("signin")}>{t("signIn")}</button>
              <button type="button" role="tab" aria-selected={mode === "signup"} className={mode === "signup" ? "on" : ""} onClick={() => go("signup")}>{t("createAccount")}</button>
            </div>
          </>
        ) : (
          <div><h2 style={{ margin: "0 0 4px" }}>{mode === "forgot" ? t("resetTitle") : t("sendLink")}</h2>
            {mode === "forgot" && <p className="muted small" style={{ margin: 0 }}>{t("resetBody")}</p>}</div>
        )}

        {mode === "signup" && (
          <div className="auth-field"><label htmlFor="biz"><b>{t("business")}</b></label>
            <input id="biz" required autoComplete="organization" value={business} onChange={(e) => setBusiness(e.target.value)} placeholder={t("businessPh")} /></div>
        )}
        <div className="auth-field"><label htmlFor="email"><b>{t("email")}</b></label>
          <input id="email" type="email" required autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@business.co.tz" /></div>
        {(mode === "signin" || mode === "signup") && (
          <div className="auth-field">
            <div className="auth-label-row"><label htmlFor="pw"><b>{t("password")}</b></label>
              {mode === "signin" && <button type="button" className="link-btn small" onClick={() => go("forgot")}>{t("forgot")}</button>}</div>
            <div className="auth-pw">
              <input id="pw" type={showPw ? "text" : "password"}
                autoComplete={mode === "signup" ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} />
              <button type="button" className="link-btn small" aria-pressed={showPw} onClick={() => setShowPw(!showPw)}>{showPw ? t("hide") : t("show")}</button>
            </div>
            {mode === "signup" && <span className="muted small">{t("pwHint")}</span>}
          </div>
        )}

        <button className="primary" disabled={busy}>
          {busy ? t("wait") : mode === "signin" ? t("signIn") : mode === "signup" ? t("createAccount") : mode === "link" ? t("sendLink") : t("sendReset")}
        </button>
        {err && <p className="err" role="alert" style={{ margin: 0 }}>{err === "LINK" ? t("linkExpired") : err}</p>}
        {canResend && <button type="button" className="small" disabled={busy} onClick={() => resend(email.trim().toLowerCase())}>{t("resend")}</button>}
        {resent && <p className="ok" role="status" style={{ margin: 0 }}>{t("resent")}</p>}

        {mode === "signin" && <button type="button" className="link-btn small" onClick={() => go("link")}>{t("useLink")}</button>}
        {mode === "signup" && <p className="muted small" style={{ margin: 0 }}>{t("terms")} <a href="https://ponditech.com/#terms" target="_blank" rel="noreferrer">{t("termsLink")}</a>.</p>}
        {!tabbed && <button type="button" className="link-btn small" onClick={() => go("signin")}>{mode === "link" ? t("usePassword") : t("back")}</button>}
        <div className="auth-foot">
          <a href="/" className="small muted">{t("home")}</a>
          <a href="/app/admin" className="small muted">{t("staff")}</a>
        </div>
      </form>
    </div>
  );
}

/* ---------- after a reset link ---------- */
export function SetNewPassword({ email, onDone }: { email: string; onDone: () => void }) {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const formRef = usePageEnter<HTMLFormElement>((f) => { enterTiles(select(f, ":scope > *"), { stagger: 0.05 }); });
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr("");
    if (password.length < 8) { shake(formRef.current); return setErr(tr(lang, "short")); }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) { shake(formRef.current); return setErr(friendly(lang, error.message)); }
    setOk(true); setTimeout(onDone, 900);
  }
  return (
    <div className="center">
      <form className="card auth" ref={formRef} onSubmit={submit} noValidate>
        <div className="auth-top"><div className="row"><Logo size={36} /><b className="auth-brand">ItaOS</b></div><LangToggle lang={lang} onChange={setLang} /></div>
        <h2 style={{ margin: 0 }}>{tr(lang, "setTitle")}</h2>
        <p className="muted small" style={{ margin: 0 }}>{tr(lang, "setBody", { e: email })}</p>
        <div className="auth-field"><label htmlFor="npw"><b>{tr(lang, "newPassword")}</b></label>
          <div className="auth-pw"><input id="npw" type={show ? "text" : "password"} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="link-btn small" aria-pressed={show} onClick={() => setShow(!show)}>{show ? tr(lang, "hide") : tr(lang, "show")}</button></div>
          <span className="muted small">{tr(lang, "pwHint")}</span></div>
        <button className="primary" disabled={busy || ok}>{busy ? tr(lang, "wait") : tr(lang, "save")}</button>
        {ok && <p className="ok" role="status" style={{ margin: 0 }}>{tr(lang, "saved")}</p>}
        {err && <p className="err" role="alert" style={{ margin: 0 }}>{err}</p>}
      </form>
    </div>
  );
}

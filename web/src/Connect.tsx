import { useEffect, useState } from "react";
import { supabase, callFn, Workspace } from "./lib";
import { loginForAds, embeddedSignup, metaConfigured } from "./meta";
import ImportChats from "./ImportChats";

type Conn = { id: string; provider: string; external_id: string; label: string | null; status: string; last_sync_at: string | null; last_error: string | null };
type Num = { phone_number_id: string; display_phone: string | null; history_status: string | null; history_requested_at: string | null };

export default function Connect({ ws }: { ws: Workspace }) {
  const [conns, setConns] = useState<Conn[]>([]);
  const [nums, setNums] = useState<Num[]>([]);
  const [accounts, setAccounts] = useState<{ id: string; name: string; currency: string }[] | null>(null);
  const [pending, setPending] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    supabase.from("connections").select("id,provider,external_id,label,status,last_sync_at,last_error").eq("workspace_id", ws.id).then(({ data }) => setConns((data as Conn[]) ?? []));
    supabase.from("wa_numbers").select("phone_number_id,display_phone,history_status,history_requested_at").eq("workspace_id", ws.id).then(({ data }) => setNums((data as Num[]) ?? []));
  }, [ws.id, tick]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setMsg({});
    try { await fn(); } catch (e) { setMsg({ err: (e as Error).message }); }
    setBusy(""); setTick((t) => t + 1);
  };

  const connectAds = () => run("ads", async () => {
    const token = await loginForAds();
    const r = await callFn<{ accounts: any[]; pending_secret: string }>("meta-connect", { action: "ads_accounts", workspace_id: ws.id, access_token: token });
    if (!r.accounts.length) throw new Error("This Facebook account has no ad accounts it can read.");
    setAccounts(r.accounts); setPending(r.pending_secret);
  });
  const pickAccount = (a: { id: string; name: string }) => run("ads", async () => {
    await callFn("meta-connect", { action: "ads_connect", workspace_id: ws.id, pending_secret: pending, ad_account_id: a.id, label: a.name });
    setAccounts(null); setMsg({ ok: `Connected ${a.name}. Pulling the last 30 days of ads now.` });
  });
  const syncNow = () => run("sync", async () => {
    const r = await callFn<{ synced: any[] }>("ads-sync", { workspace_id: ws.id, days: 30 });
    const e = r.synced.find((x) => x.error);
    if (e) throw new Error(e.error);
    setMsg({ ok: `Synced ${r.synced.reduce((s, x) => s + (x.rows ?? 0), 0)} ad-days.` });
  });
  const connectWa = () => run("wa", async () => {
    const s = await embeddedSignup();
    const r = await callFn<{ display_phone: string; syncs: Record<string, string> }>("meta-connect", { action: "wa_connect", workspace_id: ws.id, ...s });
    setMsg({ ok: `WhatsApp ${r.display_phone ?? ""} connected. History: ${r.syncs.history}. Chats from the last 6 months will appear over the next few hours.` });
  });

  const adsConns = conns.filter((c) => c.provider === "meta_ads");
  const waConns = conns.filter((c) => c.provider === "whatsapp");

  return (
    <>
      {!metaConfigured() && <div className="finding warn"><b>Meta app not configured</b><span className="small">Add VITE_META_APP_ID and the two config IDs to the site's environment, then redeploy. See SETUP.md.</span></div>}
      {msg.ok && <p className="ok">{msg.ok}</p>}
      {msg.err && <p className="err">{msg.err}</p>}

      <section className="card">
        <div className="row between"><h2>Facebook & Instagram ads</h2>
          <div className="row">
            {adsConns.length > 0 && <button disabled={!!busy} onClick={syncNow}>{busy === "sync" ? "Syncing…" : "Sync now"}</button>}
            <button className="primary" disabled={!!busy || !metaConfigured()} onClick={connectAds}>{busy === "ads" ? "Connecting…" : adsConns.length ? "Add / reconnect ad account" : "Connect ad account"}</button>
          </div>
        </div>
        <p className="small muted" style={{ margin: 0 }}>Read-only. GrowthOS reads spend and chats started per ad every 3 hours. It never changes your ads.</p>
        {accounts && (
          <div className="card" style={{ background: "var(--paper)" }}>
            <h3>Choose the ad account</h3>
            {accounts.map((a) => <button key={a.id} onClick={() => pickAccount(a)} disabled={!!busy}>{a.name} <span className="muted small">({a.id}, {a.currency})</span></button>)}
          </div>
        )}
        {adsConns.map((c) => <StatusRow key={c.id} c={c} />)}
      </section>

      <section className="card">
        <div className="row between"><h2>WhatsApp Business</h2>
          <button className="primary" disabled={!!busy || !metaConfigured()} onClick={connectWa}>{busy === "wa" ? "Connecting…" : waConns.length ? "Connect another number" : "Connect WhatsApp"}</button>
        </div>
        <p className="small muted" style={{ margin: 0 }}>Keeps working on your phone as before. GrowthOS reads chats (and the last 6 months of history, once) to find where sales are lost. It doesn't send messages.</p>
        {nums.map((n) => (
          <div className="row between small" key={n.phone_number_id}>
            <span><span className="status-dot on" /> {n.display_phone ?? n.phone_number_id}</span>
            <span className="muted">History: {n.history_status ?? "not requested"}</span>
          </div>
        ))}
      </section>
      <ImportChats ws={ws} />
      <RateBox ws={ws} />
      <PasswordBox />
    </>
  );
}

function RateBox({ ws }: { ws: Workspace }) {
  const [rate, setRate] = useState(ws.fx_rate ? String(ws.fx_rate) : "");
  const [msg, setMsg] = useState("");
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const v = rate.trim() === "" ? null : Number(rate.replace(/,/g, ""));
    if (v !== null && !(v > 0)) return setMsg("Enter a number above 0.");
    const { error } = await supabase.from("workspaces").update({ fx_rate: v }).eq("id", ws.id);
    setMsg(error ? error.message : "Saved. Reload the page to apply it.");
  }
  return (
    <form className="card" onSubmit={save}>
      <h2>Exchange rate</h2>
      <p className="small muted" style={{ margin: 0 }}>Only needed when the ad account is billed in another currency (for example US dollars) and sales are in {ws.currency}. Used for return on ad spend.</p>
      <div className="row">
        <label htmlFor="fx">1 unit of ad currency =</label>
        <input id="fx" inputMode="decimal" style={{ width: 120 }} placeholder="e.g. 2600" value={rate} onChange={(e) => setRate(e.target.value)} />
        <span>{ws.currency}</span>
        <button>Save</button>
      </div>
      {msg && <p className={msg.startsWith("Saved") ? "ok" : "err"}>{msg}</p>}
    </form>
  );
}

function PasswordBox() {
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState("");
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (pw.length < 8) return setMsg("Use at least 8 characters.");
    const { error } = await supabase.auth.updateUser({ password: pw });
    setMsg(error ? error.message : "Password changed."); if (!error) setPw("");
  }
  return (
    <form className="card" onSubmit={save}>
      <h2>Your password</h2>
      <div className="row">
        <input type="password" aria-label="New password" autoComplete="new-password" placeholder="New password" value={pw} onChange={(e) => setPw(e.target.value)} />
        <button>Change password</button>
      </div>
      {msg && <p className={msg === "Password changed." ? "ok" : "err"}>{msg}</p>}
    </form>
  );
}

function StatusRow({ c }: { c: Conn }) {
  return (
    <div className="row between small">
      <span><span className={"status-dot " + (c.status === "active" ? "on" : "err")} /> {c.label ?? c.external_id} <span className="muted">({c.external_id})</span></span>
      <span className={c.last_error ? "err" : "muted"}>{c.last_error ?? (c.last_sync_at ? "Last sync " + new Date(c.last_sync_at).toLocaleString("en-GB") : "Waiting for first sync")}</span>
    </div>
  );
}

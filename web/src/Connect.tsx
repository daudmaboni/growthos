import { enterCards, usePageEnter, select } from "./motion";
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
  const pageRef = usePageEnter<HTMLDivElement>((root) => { enterCards(select(root, ":scope > .card, :scope > .finding"), { stagger: 0.07 }); });

  return (
    <div className="shell-grid" ref={pageRef}>
      <p className="small muted" style={{ margin: 0 }}>Exchange rate, language and your password have moved to <a href="#settings">Settings</a>.</p>
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
    </div>
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

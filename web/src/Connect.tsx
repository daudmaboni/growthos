import { enterCards, usePageEnter, select } from "./motion";
import { useEffect, useRef, useState } from "react";
import { supabase, callFn, Workspace, canManage, when, ago } from "./lib";
import { loginForAds, embeddedSignup, metaConfigured } from "./meta";
import ImportChats from "./ImportChats";
import ImportCsv from "./ImportCsv";

type Health = { status: string; events: number; oldest: string | null; newest: string | null; exhausted: number };
type Batch = { id: string; kind: string; file_name: string | null; created_count: number; skipped_count: number; rejected_count: number; created_at: string };

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
  const [d360Key, setD360Key] = useState("");
  const [showD360, setShowD360] = useState(false);
  const [dh, setDh] = useState<{ webhook_url: string; verify_token: string } | null>(null);
  const [health, setHealth] = useState<Health[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const manager = canManage(ws);

  useEffect(() => {
    supabase.from("connections").select("id,provider,external_id,label,status,last_sync_at,last_error").eq("workspace_id", ws.id).then(({ data }) => setConns((data as Conn[]) ?? []));
    supabase.from("wa_numbers").select("phone_number_id,display_phone,history_status,history_requested_at").eq("workspace_id", ws.id).then(({ data }) => setNums((data as Num[]) ?? []));
    supabase.rpc("webhook_health", { p_ws: ws.id }).then(({ data }) => setHealth((data as Health[]) ?? []));
    supabase.from("import_batches").select("id,kind,file_name,created_count,skipped_count,rejected_count,created_at").eq("workspace_id", ws.id).order("created_at", { ascending: false }).limit(10).then(({ data }) => setBatches((data as Batch[]) ?? []));
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

  const connect360 = () => run("d360", async () => {
    await callFn("d360-connect", { workspace_id: ws.id, api_key: d360Key });
    setD360Key(""); setShowD360(false);
    setMsg({ ok: "Connected through 360dialog. The number appears here when its first message arrives; chat history (if you shared it during 360dialog signup) follows over the next few hours." });
  });

  const connectDualhook = () => run("dh", async () => {
    if (dhConns.length && prompt("This cuts off WhatsApp until you paste the new URL and token into Dualhook. Type REPLACE to continue.") !== "REPLACE") return;
    const r = await callFn<{ webhook_url: string; verify_token: string }>("dualhook-connect", { workspace_id: ws.id });
    setDh(r);
  });
  // Dualhook Outbound API key: lets itaOS download the images customers send (payment screenshots).
  const [dhKey, setDhKey] = useState("");
  const [dhKeyLast4, setDhKeyLast4] = useState<string | null>(null);
  useEffect(() => {
    supabase.from("connections").select("meta").eq("workspace_id", ws.id).eq("provider", "whatsapp").eq("meta->>via", "dualhook").maybeSingle()
      .then(({ data }) => setDhKeyLast4((data as any)?.meta?.api_key_last4 ?? null));
  }, [ws.id, busy]);
  const saveDhKey = () => run("dhkey", async () => {
    const r = await callFn<{ images_saved: number; images_failed: number; last_error: string | null }>("dualhook-connect", { workspace_id: ws.id, action: "set_api_key", api_key: dhKey.trim() });
    setDhKey("");
    setMsg(r.images_failed && !r.images_saved
      ? { err: `Key saved, but Dualhook did not return the images: ${r.last_error ?? "unknown error"}` }
      : { ok: `Key saved. ${r.images_saved} image${r.images_saved === 1 ? "" : "s"} from the last 7 days fetched and read${r.images_failed ? `, ${r.images_failed} could not be fetched` : ""}.` });
  });
  const fetchImages = () => run("dhkey", async () => {
    const r = await callFn<{ images_saved: number; images_failed: number; last_error: string | null }>("dualhook-connect", { workspace_id: ws.id, action: "backfill_media" });
    setMsg(r.images_failed && !r.images_saved ? { err: `Could not fetch images: ${r.last_error ?? "unknown error"}` } : { ok: `${r.images_saved} image${r.images_saved === 1 ? "" : "s"} fetched and read${r.images_failed ? `, ${r.images_failed} failed` : ""}.` });
  });

  const replay = () => run("replay", async () => {
    const r = await callFn<{ requeued: number; processed: number; checked: number }>("wa-webhook", { action: "replay", workspace_id: ws.id });
    setMsg({ ok: `Requeued ${r.requeued} events; ${r.processed} of ${r.checked} processed now. The rest retry on the next scheduled run.` });
  });
  const failed = health.find((h) => h.status === "failed");
  const processing = health.find((h) => h.status === "processing");
  const queued = health.find((h) => h.status === "pending");
  const adsConns = conns.filter((c) => c.provider === "meta_ads");
  const waConns = conns.filter((c) => c.provider === "whatsapp");
  const d360Conns = waConns.filter((c) => c.external_id.startsWith("360dialog:"));
  const dhConns = waConns.filter((c) => c.external_id.startsWith("dualhook:"));
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
            <button className="primary" disabled={!!busy || !metaConfigured() || !manager} title={manager ? "" : "Only an owner or admin can connect accounts"} onClick={connectAds}>{busy === "ads" ? "Connecting…" : adsConns.length ? "Add / reconnect ad account" : "Connect ad account"}</button>
          </div>
        </div>
        <p className="small muted" style={{ margin: 0 }}>Read-only. itaOS reads spend and chats started per ad every 3 hours. It never changes your ads.</p>
        {accounts && (
          <div className="card" style={{ background: "var(--paper)" }}>
            <h3>Choose the ad account</h3>
            {accounts.map((a) => <button key={a.id} onClick={() => pickAccount(a)} disabled={!!busy}>{a.name} <span className="muted small">({a.id}, {a.currency})</span></button>)}
          </div>
        )}
        {adsConns.map((c) => (
          <div key={c.id} style={{ display: "grid", gap: 6 }}>
            <StatusRow c={c} />
            {manager && <DisconnectAds c={c} onDone={(text) => { setMsg({ ok: text }); setTick((t) => t + 1); }} onError={(text) => setMsg({ err: text })} last={adsConns.length === 1} />}
          </div>
        ))}
      </section>

      <section className="card">
        <div className="row between"><h2>WhatsApp Business</h2>
          <button className="primary" disabled={!!busy || !metaConfigured() || !manager} title={manager ? "" : "Only an owner or admin can connect accounts"} onClick={connectWa}>{busy === "wa" ? "Connecting…" : waConns.length ? "Connect another number" : "Connect WhatsApp"}</button>
        </div>
        <p className="small muted" style={{ margin: 0 }}>Keeps working on your phone as before. itaOS reads chats (and the last 6 months of history, once) to find where sales are lost. It doesn't send messages.</p>
        {dhConns.map((c) => <StatusRow key={c.id} c={c} waitingText="Waiting for the first message from Meta via Dualhook" />)}
        {manager && (
          <div className="evidence">
            <div className="row between"><b>Connect through Dualhook</b>
              {!dh && !dhConns.length && <button className="small" disabled={!!busy} onClick={connectDualhook}>{busy === "dh" ? "Creating…" : "Use Dualhook"}</button>}
            </div>
            <span className="small muted">Use this while itaOS's own Meta approval is pending. Dualhook is a Meta Tech Provider: the number keeps working in the WhatsApp Business app, and Meta sends chats, ad clicks and history straight to itaOS.</span>
            {dhConns.length > 0 && (
              <div className="dh-key">
                <b className="small">Payment screenshots {dhKeyLast4 ? <span className="ok small">· key saved (…{dhKeyLast4})</span> : <span className="warnt small">· not set up</span>}</b>
                <span className="small muted">To read the images customers send, itaOS downloads them through Dualhook. In Dualhook open <b>Connection → Overview → Outbound API key</b>, create a key (it starts with <code>dh_live_</code>) and paste it here. Images from the last 7 days are fetched right away.</span>
                <div className="row">
                  <input type="password" autoComplete="off" placeholder="dh_live_…" value={dhKey} onChange={(e) => setDhKey(e.target.value)} style={{ flex: 1 }} />
                  <button className="small primary" disabled={!!busy || !dhKey.trim().startsWith("dh_live_")} onClick={saveDhKey}>{busy === "dhkey" ? "Saving…" : dhKeyLast4 ? "Replace key" : "Save key"}</button>
                  {dhKeyLast4 && <button className="small" disabled={!!busy} onClick={fetchImages}>Fetch missed images</button>}
                </div>
              </div>
            )}
            {dh && (
              <>
                <ol className="small" style={{ margin: "4px 0", paddingLeft: 18 }}>
                  <li>In Dualhook, start a new connection and choose <b>Webhook Override</b>. Paste these two values <b>before</b> you open Meta's signup window:</li>
                </ol>
                <label className="small">Webhook URL</label>
                <CopyField value={dh.webhook_url} onError={() => setMsg({ err: "Copy failed. Select the text and copy it by hand." })} />
                <label className="small">Verify token</label>
                <CopyField value={dh.verify_token} onError={() => setMsg({ err: "Copy failed. Select the text and copy it by hand." })} />
                <ol className="small" start={2} style={{ margin: "4px 0", paddingLeft: 18 }}>
                  <li>Continue in Dualhook: choose <b>"Connect your existing WhatsApp Business app"</b>, scan the QR on the phone and <b>allow chat history sharing</b>.</li>
                  <li>The number appears here with its first message; the last 6 months of chats follow over a few hours.</li>
                </ol>
                <span className="small err">Save both values now: itaOS keeps only a fingerprint and can't show them again.</span>
                <div className="row"><button onClick={() => setDh(null)}>Done</button></div>
              </>
            )}
            {!dh && dhConns.length > 0 && (
              <details className="small">
                <summary className="muted">Advanced: replace the webhook URL</summary>
                <span className="small err" style={{ display: "block", margin: "6px 0" }}>Only do this if the URL was leaked. The current URL stops working immediately, and no WhatsApp messages reach itaOS until you paste the new URL and token into Dualhook (Webhook Override → Change).</span>
                <button className="small danger" disabled={!!busy} onClick={connectDualhook}>{busy === "dh" ? "Creating…" : "Replace webhook URL"}</button>
              </details>
            )}
          </div>
        )}
        {d360Conns.map((c) => <StatusRow key={c.id} c={c} waitingText="Waiting for the first message from 360dialog" />)}
        {manager && (d360Conns.length > 0 || dhConns.length === 0) && (
          <div className="evidence">
            <div className="row between"><b>Connect through 360dialog</b>
              {!showD360 && <button className="small" disabled={!!busy} onClick={() => setShowD360(true)}>{d360Conns.length ? "Change API key" : "Use 360dialog"}</button>}
            </div>
            <span className="small muted">Use this while itaOS's own Meta approval is pending. 360dialog is a Meta partner: the number keeps working in the WhatsApp Business app, and itaOS receives the same chats and ad clicks.</span>
            {showD360 && (
              <>
                <ol className="small" style={{ margin: "4px 0", paddingLeft: 18 }}>
                  <li>Sign up at app.360dialog.com and add the number with <b>"Connect your existing WhatsApp Business app"</b> (Coexistence). Allow chat history sharing when the phone asks.</li>
                  <li>In the 360dialog hub, generate an <b>API key</b> for that number.</li>
                  <li>Paste it here. itaOS sets the webhook for you; don't point it anywhere else afterwards.</li>
                </ol>
                <div className="row">
                  <input type="password" autoComplete="off" placeholder="360dialog API key" value={d360Key} onChange={(e) => setD360Key(e.target.value)} style={{ flex: 1 }} />
                  <button className="primary" disabled={!!busy || d360Key.trim().length < 10} onClick={connect360}>{busy === "d360" ? "Connecting…" : "Connect"}</button>
                  <button disabled={!!busy} onClick={() => { setShowD360(false); setD360Key(""); }}>Cancel</button>
                </div>
              </>
            )}
          </div>
        )}
        {nums.length === 0 && <p className="small muted" style={{ margin: 0 }}>Not connected. Until it is, upload chat exports below; the dashboard labels those chats' sources as unknown unless the first message came from an ad.</p>}
        {nums.map((n) => (
          <div className="row between small" key={n.phone_number_id}>
            <span><span className="status-dot on" /> {n.display_phone ?? n.phone_number_id}</span>
            <span className="muted">History: {n.history_status ?? (dhConns.length || d360Conns.length ? "waiting for Meta" : "not requested")}{n.history_requested_at ? ` (requested ${when(n.history_requested_at)})` : ""}</span>
          </div>
        ))}
        {(health.length > 0 || nums.length > 0) && (
          <div className="evidence">
            <div className="row between"><b>Webhook events</b>{manager && (failed?.events || processing?.events) ? <button className="small" disabled={!!busy} onClick={replay}>{busy === "replay" ? "Replaying…" : "Replay failed events"}</button> : null}</div>
            {health.length === 0 ? <span className="small muted">No events received yet.</span> : health.map((h) => (
              <span className="small" key={h.status}><span className={"status-dot " + (h.status === "processed" ? "on" : h.status === "failed" ? "err" : "")} /> {h.status}: {h.events}{h.newest ? ` · latest ${ago(h.newest)}` : ""}{h.exhausted ? ` · ${h.exhausted} gave up after repeated failures (replay to retry)` : ""}</span>
            ))}
            {queued && queued.events > 0 && <span className="small muted">Pending events are picked up by the scheduled job within 3 hours.</span>}
            <span className="small muted">Every event Meta delivers is stored before it is acknowledged, then processed. Failed ones are retried automatically up to 8 times; replaying resets that counter. Counts only — message content never leaves the server here.</span>
          </div>
        )}
      </section>
      <ImportChats ws={ws} />
      <ImportCsv ws={ws} onImported={() => setTick((t) => t + 1)} />
      {batches.length > 0 && (
        <section className="card">
          <h2>Import history</h2>
          <div className="scroll"><table>
            <thead><tr><th>When</th><th>What</th><th>File</th><th className="n">Created</th><th className="n">Skipped</th><th className="n">Rejected</th></tr></thead>
            <tbody>{batches.map((b) => <tr key={b.id}><td className="small">{when(b.created_at)}</td><td>{b.kind}</td><td className="small muted">{b.file_name ?? "–"}</td><td className="n">{b.created_count}</td><td className="n">{b.skipped_count}</td><td className="n">{b.rejected_count}</td></tr>)}</tbody>
          </table></div>
        </section>
      )}
    </div>
  );
}



/** Read-only field + Copy button that visibly confirms the copy on the button itself. */
function CopyField({ value, onError }: { value: string; onError: () => void }) {
  const [state, setState] = useState<"idle" | "done" | "fail">("idle");
  const timer = useRef<number>();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    let ok = false;
    try { await navigator.clipboard.writeText(value); ok = true; }
    catch {
      // Fallback for browsers without the async clipboard API.
      const el = inputRef.current;
      if (el) { el.focus(); el.select(); try { ok = document.execCommand("copy"); } catch { ok = false; } }
    }
    setState(ok ? "done" : "fail");
    if (!ok) onError();
    navigator.vibrate?.(ok ? 12 : [20, 40, 20]);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1800);
  };
  return (
    <div className="row">
      <input ref={inputRef} readOnly value={value} className={state === "done" ? "copy-flash" : ""} style={{ flex: 1 }} onFocus={(e) => e.target.select()} />
      <button type="button" className={`small copy-btn ${state}`} onClick={copy} aria-live="polite">
        {state === "done" ? "Copied ✓" : state === "fail" ? "Failed" : "Copy"}
      </button>
    </div>
  );
}

function StatusRow({ c, waitingText = "Waiting for first sync" }: { c: Conn; waitingText?: string }) {
  return (
    <div className="row between small">
      <span><span className={"status-dot " + (c.status === "active" ? "on" : "err")} /> {c.label ?? c.external_id} <span className="muted">({c.external_id})</span></span>
      <span className={c.last_error ? "err" : "muted"}>{c.last_error ? `Error: ${c.last_error}${c.last_sync_at ? ` · last good sync ${when(c.last_sync_at)}` : ""}` : c.last_sync_at ? "Last successful sync " + when(c.last_sync_at) : waitingText}</span>
    </div>
  );
}

/** Disconnect an ad account: stops syncing and deletes the stored Meta token. Past figures stay unless asked. */
function DisconnectAds({ c, onDone, onError, last }: { c: Conn; onDone: (t: string) => void; onError: (t: string) => void; last: boolean }) {
  const [open, setOpen] = useState(false);
  const [wipe, setWipe] = useState(false);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    const { data, error } = await supabase.rpc("disconnect_ads", { p_conn: c.id, p_delete_data: wipe });
    setBusy(false);
    if (error) return onError(error.message);
    const d = data as { ads_deleted: number; days_deleted: number };
    onDone(`${c.label ?? c.external_id} disconnected. itaOS no longer reads it${wipe && last ? ` and its past ad data was deleted (${d.ads_deleted} ads).` : "; past figures stay in your reports."} You can connect it again any time.`);
  }
  if (!open) return <button className="small linkish" style={{ justifySelf: "start" }} onClick={() => setOpen(true)}>Disconnect this ad account</button>;
  return (
    <div className="dh-key">
      <b className="small">Disconnect {c.label ?? c.external_id}?</b>
      <span className="small muted">itaOS stops reading spend and ad clicks from it right away and deletes its stored Meta access. Your ads on Facebook are not changed.</span>
      {last && <label className="small row" style={{ gap: 6 }}><input type="checkbox" checked={wipe} onChange={(e) => setWipe(e.target.checked)} /> Also delete its past ad data from itaOS (spend, ads list). Chats and sales stay.</label>}
      <div className="row" style={{ gap: 6 }}>
        <button className="small danger" disabled={busy} onClick={go}>{busy ? "Disconnecting…" : "Disconnect"}</button>
        <button className="small" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

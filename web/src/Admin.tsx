// itaOS — Pondi platform admin (/admin)
// Reads only the admin_* RPCs (migrations 0012_platform_admin, 0013_admin_activity, 0023_admin_refresh).
// Fields added in 0023 are optional here, so the page still works against an older database.
// Every RPC re-checks platform_admins server-side; hiding this page is UX, not security.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

/* ================= types ================= */
type Overview = {
  workspaces: number; workspaces_7d: number; users: number; active_users_7d: number;
  messages: number; messages_24h: number; messages_7d: number;
  connections_active: number; connections_error: number;
  failed_events: number; pending_events: number; unrouted_events: number;
  kito_asks_7d: number; kito_tokens_7d: number; kito_errors_7d: number;
  orders_paid: number; generated_at: string;
  // 0023
  orphan_workspaces?: number; sent_itaos_7d?: number; receipts_7d?: number; wa_live?: number; stuck_events?: number;
  kito_reads_24h?: number; kito_read_fails_24h?: number; orders_30d?: number; tick_orders_30d?: number;
  revenue_30d?: Record<string, number>;
};
type WsStatus = 'trial' | 'active' | 'suspended';
type WsRow = {
  id: string; name: string; created_at: string; status: WsStatus; plan: string; note: string | null;
  owner_email: string | null; owner_last_sign_in: string | null; members: number;
  wa_status: string | null; wa_last_sync: string | null; meta_status: string | null; meta_last_sync: string | null;
  last_error: string | null; messages: number; messages_7d: number; last_message_at: string | null;
  conversations: number; orders: number; spend_30d: number | null; spend_currency: string | null;
  kito_asks_30d: number; kito_tokens_30d: number; failed_events: number; pending_events: number;
  // 0023
  wa_via?: string | null; wa_phone?: string | null; send_enabled?: boolean; send_key?: boolean | null;
  last_customer_message_at?: string | null; live_chats?: number; imported_chats?: number;
  sent_itaos_30d?: number; receipts_30d?: number; tick_orders?: number; revenue_30d?: number; revenue_total?: number;
  currency?: string; kito_last_run?: string | null; kito_behind?: number; stuck_events?: number; settings_missing?: string[];
};
type Activity = { days: string[]; messages: number[]; signups: number[]; kito: number[]; per_ws: Record<string, number[]>; sent?: number[]; orders?: number[] };
type ErrRow = { at: string | null; workspace_id: string | null; workspace_name: string | null; source: string; detail: string };
type AuditRow = { at: string; actor_email: string | null; action: string; workspace_name: string | null; details: unknown };
type Detail = {
  workspace: { id: string; name: string; created_at: string; currency: string; timezone: string; language: string;
               fx_rate: number | null; status: WsStatus; plan: string; note: string | null; state_updated_at: string | null;
               unit_cost?: number | null; follow_up_hours?: number | null; send_enabled?: boolean };
  members: { email: string; role: string; joined: string; last_sign_in_at: string | null }[];
  connections: { provider: string; label: string | null; external_id: string; status: string;
                 last_sync_at: string | null; last_error: string | null; created_at: string;
                 via?: string | null; send_key?: boolean | null; send_key_set_at?: string | null; webhook_set_at?: string | null }[];
  wa_numbers: { display_phone: string | null; phone_number_id: string; waba_id: string; coexistence: boolean; history_status: string | null;
                created_at?: string; last_in?: string | null }[];
  events: { status: string; n: number; newest: string }[];
  daily: { day: string; in: number; out: number; itaos?: number }[];
  counts: Record<string, number>;
  kito: { asks_30d: number; input_tokens_30d: number; output_tokens_30d: number; errors_30d: number;
          runs: { ran_at: string; trigger: string; checked: number; failed: number; remaining: number }[];
          reads_24h?: number; fails_24h?: number; behind?: number };
  audit: { at: string; action: string; actor: string | null; details: unknown }[];
  // 0023
  msg_origins?: Record<string, number>;
  sales?: { revenue_30d: number; revenue_total: number; last_paid_at: string | null;
            by_source: { from: string; status: string; n: number; amount: number | null }[] };
  media?: { saved: number; receipts: number; errors: number; last_at: string | null };
  deletions?: { at: string; via: string; chats: number; messages: number; by_origin: Record<string, number>; orders_unlinked: number; by: string | null }[];
  imports?: { at: string; kind: string; created: number; skipped: number; rejected: number }[];
};
type Staff = { email: string; added_at: string; last_sign_in_at: string | null; is_me: boolean };
type Tone = 'ok' | 'warn' | 'bad' | 'idle';
type Health = { tone: Tone; text: string };
type View = 'today' | 'workspaces' | 'errors' | 'audit' | 'staff';
const VIEWS: View[] = ['today', 'workspaces', 'errors', 'audit', 'staff'];

/* ================= helpers ================= */
const nf = new Intl.NumberFormat('en-US');
const fmt = (v: number | null | undefined) => (v == null ? '–' : nf.format(v));
const TZ = 'Africa/Dar_es_Salaam';

function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  if (d < 30) return d === 1 ? 'yesterday' : `${d} days ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: TZ });
}
const stamp = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-GB', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }) : '';
const hoursSince = (iso: string | null) => (iso ? (Date.now() - new Date(iso).getTime()) / 3.6e6 : Infinity);
const plural = (n: number, one: string, many = one + 's') => `${fmt(n)} ${n === 1 ? one : many}`;
const money = (v: number | null | undefined, cur: string | null | undefined) =>
  v == null ? '–' : `${cur === 'USD' ? '$' : (cur ?? '') + ' '}${nf.format(Math.round(v))}`;
const short = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}k` : nf.format(Math.round(v)));
function revenueText(r: Record<string, number> | undefined): string {
  if (!r) return '–';
  const e = Object.entries(r).filter(([, v]) => v);
  if (e.length === 0) return '0';
  return e.map(([c, v]) => `${c === 'USD' ? '$' : c + ' '}${short(v)}`).join(' + ');
}

const TILE = ['#16224A', '#2F6B5E', '#7A4E2D', '#5B3E8C', '#2C5A8C', '#8C3B4E'];
function tileColor(id: string) { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return TILE[h % TILE.length]; }
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';

export function healthOf(w: WsRow): Health {
  if (w.status === 'suspended') return { tone: 'idle', text: 'Suspended: the owner sees a paused screen' };
  if (w.members === 0) return { tone: 'warn', text: 'No owner: sign-up never finished' };
  if (w.failed_events > 0) return { tone: 'bad', text: `${plural(w.failed_events, 'WhatsApp event')} failed to process` };
  if ((w.stuck_events ?? 0) > 0) return { tone: 'bad', text: `${plural(w.stuck_events!, 'WhatsApp event')} stuck mid-processing` };
  if (w.last_error) return { tone: 'bad', text: w.last_error };
  if (w.wa_status && w.wa_status !== 'active') return { tone: 'bad', text: `WhatsApp connection is ${w.wa_status}` };
  if (w.meta_status && w.meta_status !== 'active') return { tone: 'bad', text: `Meta Ads connection is ${w.meta_status}` };
  if (!w.wa_status && !w.meta_status && w.messages === 0) return { tone: 'idle', text: 'Nothing connected yet' };
  if (w.meta_status === 'active' && hoursSince(w.meta_last_sync) > 26) return { tone: 'warn', text: `Ads haven't synced since ${ago(w.meta_last_sync)}` };
  const lastIn = w.last_customer_message_at ?? w.last_message_at;
  if (w.wa_status === 'active' && hoursSince(lastIn) > 72) return { tone: 'warn', text: `No customer messages since ${ago(lastIn)}` };
  if (!w.wa_status && w.messages > 0) return { tone: 'warn', text: "WhatsApp isn't live, only imported chats" };
  if ((w.kito_behind ?? 0) >= 25) return { tone: 'warn', text: `Kito is behind: ${plural(w.kito_behind!, 'chat')} with new messages not read yet` };
  return { tone: 'ok', text: 'Running normally' };
}

const liveChats = (w: WsRow) => w.live_chats ?? w.conversations;
const viaName = (v: string | null | undefined) => (v === 'dualhook' ? 'Dualhook' : v === '360dialog' ? '360dialog' : 'Meta');

// Same order an owner follows on the Connections page today: WhatsApp first (Dualhook), then ads.
const STEPS: { key: string; label: string; done: (w: WsRow) => boolean; hint: string }[] = [
  { key: 'wa', label: 'Go live on WhatsApp', done: (w) => w.wa_status === 'active', hint: 'Number connected (Dualhook, Coexistence)' },
  { key: 'chat', label: 'First live chat', done: (w) => liveChats(w) > 0, hint: 'A real customer chat arrived on WhatsApp' },
  { key: 'meta', label: 'Connect Meta Ads', done: (w) => w.meta_status === 'active', hint: 'Ad account linked and syncing' },
  { key: 'sale', label: 'First recorded sale', done: (w) => w.orders > 0, hint: 'A paid order: ✅ message, Kito, or recorded' },
];
// Extras shown in the drawer: not part of the board, but things an owner can still be missing.
const EXTRAS: { label: string; done: (w: WsRow) => boolean; hint: string }[] = [
  { label: 'Can reply from itaOS', done: (w) => w.wa_status === 'active' && !!w.send_key && w.send_enabled !== false, hint: 'Dualhook API key saved and sending switched on' },
  { label: 'Dashboard numbers set', done: (w) => (w.settings_missing ?? []).length === 0, hint: 'Exchange rate and cost per order, so ROAS and profit show' },
];
const stuckAt = (w: WsRow) => { const i = STEPS.findIndex((s) => !s.done(w)); return i === -1 ? STEPS.length : i; };

function useRpc<T>(supabase: SupabaseClient, fn: string, args: Record<string, unknown> | undefined, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc(fn, args);
    if (error) setError(error.message); else { setError(null); setData(data as T); }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, fn, ...deps]);
  useEffect(() => { void load(); }, [load]);
  return { data, error, loading };
}

/** Use in your nav to show the Admin link only to platform admins. */
export function useIsPlatformAdmin(supabase: SupabaseClient, userId?: string | null): boolean | null {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    if (userId === null) { setOk(false); return; } // signed out
    supabase.rpc('is_platform_admin').then(({ data, error }) => { if (live) setOk(!error && data === true); });
    return () => { live = false; };
  }, [supabase, userId]);
  return ok;
}

function useHashView(): [View, (v: View) => void] {
  const read = (): View => {
    const h = window.location.hash.replace('#', '');
    return VIEWS.includes(h as View) ? (h as View) : 'today';
  };
  const [v, setV] = useState<View>(read);
  useEffect(() => { const on = () => setV(read()); window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on); }, []);
  return [v, (nv: View) => {
    if (nv !== v) { try { window.scrollTo({ top: 0 }); } catch { /* sandboxed frames */ } }
    try { if (window.location.hash !== '#' + nv) window.location.hash = nv; } catch { /* hash may be blocked */ }
    setV(nv);
  }];
}

/* ================= page ================= */
export default function Admin({ supabase, backHref, onSignOut }: { supabase: SupabaseClient; backHref?: string; onSignOut?: () => void }) {
  const isAdmin = useIsPlatformAdmin(supabase);
  const [view, setView] = useHashView();
  const [openWs, setOpenWs] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);

  const ov = useRpc<Overview>(supabase, 'admin_overview', undefined, [tick, isAdmin]);
  const ws = useRpc<WsRow[]>(supabase, 'admin_workspaces', undefined, [tick, isAdmin]);
  const act = useRpc<Activity>(supabase, 'admin_activity', { p_days: 30 }, [tick, isAdmin]);
  const errs = useRpc<ErrRow[]>(supabase, 'admin_errors', { p_limit: 200 }, [tick, isAdmin]);

  if (isAdmin === null) return <Frame><p className="ia-blank">Checking your access…</p></Frame>;
  if (!isAdmin) return (
    <Frame><div className="ia-blank"><h2>This page is for Pondi admins</h2>
      <p>This account doesn't have staff access. Sign out and sign in with your Pondi staff account.</p>
      {onSignOut && <button className="ia-btn primary" onClick={onSignOut}>Sign out</button>}</div></Frame>
  );

  const rows = ws.data ?? [];
  const errors = errs.data ?? [];
  const recentErrors = errors.filter((e) => hoursSince(e.at) < 24 * 7).length;
  const loading = ov.loading || ws.loading;
  const loadError = ov.error || ws.error || act.error;

  return (
    <Frame>
      <aside className="ia-side">
        <div className="ia-brand"><span className="ia-mark">ita.</span><span>Admin</span></div>
        <nav className="ia-nav" aria-label="Admin sections">
          <NavBtn on={view === 'today'} onClick={() => setView('today')} icon={ICON.today}>Today</NavBtn>
          <NavBtn on={view === 'workspaces'} onClick={() => setView('workspaces')} icon={ICON.ws} count={rows.length}>Businesses</NavBtn>
          <NavBtn on={view === 'errors'} onClick={() => setView('errors')} icon={ICON.err} count={recentErrors} hot={recentErrors > 0}>Errors</NavBtn>
          <NavBtn on={view === 'audit'} onClick={() => setView('audit')} icon={ICON.audit}>Audit log</NavBtn>
          <NavBtn on={view === 'staff'} onClick={() => setView('staff')} icon={ICON.staff}>Staff</NavBtn>
        </nav>
        <div className="ia-side-foot">
          <button className="ia-refresh" onClick={refresh} disabled={loading}>{ICON.refresh}{loading ? 'Refreshing' : 'Refresh'}</button>
          <span>Updated {ov.data ? ago(ov.data.generated_at) : '…'}</span>
          {backHref && <a className="ia-back" href={backHref}>Open business app</a>}
          {onSignOut && <button className="ia-back ia-signout" onClick={onSignOut}>Sign out</button>}
          <span className="ia-co">Pondi Technologies</span>
        </div>
      </aside>

      <main className="ia-main">
        {loadError && <div className="ia-alert">Some data didn't load: {loadError}. Try Refresh.</div>}
        {view === 'today' && <Today ov={ov.data} rows={rows} act={act.data} errors={errors} onOpen={setOpenWs} goErrors={() => setView('errors')} />}
        {view === 'workspaces' && <Businesses rows={rows} act={act.data} loading={ws.loading} onOpen={setOpenWs} />}
        {view === 'errors' && <Errors rows={errors} loading={errs.loading} onOpen={setOpenWs} />}
        {view === 'audit' && <Audit supabase={supabase} tick={tick} />}
        {view === 'staff' && <StaffPage supabase={supabase} />}
      </main>

      {openWs && <Drawer supabase={supabase} id={openWs} row={rows.find((r) => r.id === openWs)} onClose={() => setOpenWs(null)} onChanged={refresh}
                         onDeleted={() => { setOpenWs(null); refresh(); }} />}
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="ia"><style>{CSS}</style>{children}</div>;
}

function NavBtn({ on, onClick, icon, count, hot, children }:
  { on: boolean; onClick: () => void; icon: React.ReactNode; count?: number; hot?: boolean; children: React.ReactNode }) {
  return (
    <button className={`ia-navbtn${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined} onClick={onClick}>
      {icon}<span>{children}</span>{count != null && count > 0 && <em className={hot ? 'hot' : ''}>{count}</em>}
    </button>
  );
}

/* ================= today ================= */
type Item = { tone: 'bad' | 'warn' | 'info'; ws: string | null; title: string; body: string; at: string | null };

function buildItems(rows: WsRow[], errors: ErrRow[]): Item[] {
  const out: Item[] = [];
  for (const w of rows) {
    const h = healthOf(w);
    if (h.tone === 'bad' || h.tone === 'warn') out.push({ tone: h.tone, ws: w.id, title: w.name, body: h.text, at: w.last_message_at ?? w.created_at });
    if (w.members === 0) continue; // health already says "No owner"
    if (hoursSince(w.created_at) < 72 && stuckAt(w) === 0)
      out.push({ tone: 'info', ws: w.id, title: `${w.name} just signed up`, body: `${w.owner_email ?? 'Owner'} joined ${ago(w.created_at)} and hasn't connected anything. A quick WhatsApp hello helps.`, at: w.created_at });
    else if (w.status !== 'suspended' && hoursSince(w.owner_last_sign_in) > 24 * 7)
      out.push({ tone: 'warn', ws: w.id, title: `${w.name} has gone quiet`, body: `Owner last signed in ${ago(w.owner_last_sign_in)}.`, at: w.owner_last_sign_in });
    if (w.wa_status === 'active' && w.wa_via === 'dualhook' && w.send_key === false && w.status !== 'suspended')
      out.push({ tone: 'info', ws: w.id, title: `${w.name} can't reply from itaOS yet`, body: 'No Dualhook API key saved on their Connections page, so the Chats inbox is read-only for them.', at: w.wa_last_sync ?? w.created_at });
  }
  for (const e of errors.filter((x) => hoursSince(x.at) < 24 * 7).slice(0, 4)) {
    out.push({ tone: 'bad', ws: e.workspace_id, title: SOURCE[e.source.split(':')[0]!] ?? e.source,
      body: `${e.workspace_name ? e.workspace_name + ': ' : ''}${e.detail.slice(0, 120)}${e.detail.length > 120 ? '…' : ''}`, at: e.at });
  }
  const rank = { bad: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone] || +new Date(b.at ?? 0) - +new Date(a.at ?? 0));
}

const SOURCE: Record<string, string> = {
  'kito-ask': "Kito couldn't answer a question", 'kito-run': 'Kito reading had failures', 'kito-tag': "Kito couldn't read a chat",
  webhook: "WhatsApp events didn't process", stuck: 'WhatsApp events stuck mid-processing', connection: 'A connection broke',
  media: "A customer's photo couldn't be read",
};

function Today({ ov, rows, act, errors, onOpen, goErrors }:
  { ov: Overview | null; rows: WsRow[]; act: Activity | null; errors: ErrRow[]; onOpen: (id: string) => void; goErrors: () => void }) {
  const items = useMemo(() => buildItems(rows, errors), [rows, errors]);
  const needs = items.filter((i) => i.tone !== 'info').length;
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ });

  return (
    <div className="ia-today">
      <header className="ia-hero">
        <p className="ia-date">{today}</p>
        <h1>
          {rows.length ? plural(rows.length, 'business', 'businesses') : 'No businesses'} on itaOS.{' '}
          <span className={needs ? 'ia-need' : 'ia-calm'}>{needs === 0 ? 'Nothing needs you right now.' : needs === 1 ? 'One thing needs a look.' : `${needs} things need a look.`}</span>
        </h1>
      </header>

      <dl className="ia-strip">
        <Stat label="Live on WhatsApp" value={ov?.wa_live != null ? `${fmt(ov.wa_live)}/${fmt(ov.workspaces)}` : fmt(ov?.workspaces)}
              sub={`${fmt(ov?.workspaces_7d)} new this week · ${ov ? `${fmt(ov.active_users_7d)} owners signed in` : ''}`} />
        <Stat label="WhatsApp messages" value={fmt(ov?.messages_7d)} sub={`last 7 days · ${fmt(ov?.messages_24h)} today`} />
        <Stat label="Sales, 30 days" value={revenueText(ov?.revenue_30d)}
              sub={ov?.orders_30d != null ? `${plural(ov.orders_30d, 'paid order')} · ${fmt(ov.tick_orders_30d)} from ✅` : `${fmt(ov?.orders_paid)} paid orders in total`} />
        <Stat label="Replies from itaOS" value={fmt(ov?.sent_itaos_7d)} sub={`last 7 days · ${plural(ov?.receipts_7d ?? 0, 'payment screenshot')} read`} />
        <Stat label="Kito" value={fmt(ov?.kito_reads_24h ?? ov?.kito_asks_7d)}
              sub={ov?.kito_reads_24h != null ? `chats read today · ${fmt(ov.kito_read_fails_24h)} failed · ${fmt(ov.kito_asks_7d)} questions this week`
                                                : `questions this week · ${fmt(ov?.kito_errors_7d)} failed`}
              tone={(ov?.kito_read_fails_24h ?? 0) + (ov?.kito_errors_7d ?? 0) > 0 ? 'warn' : undefined} />
        <Stat label="Message queue" value={fmt((ov?.failed_events ?? 0) + (ov?.stuck_events ?? 0))}
              sub={`failed or stuck · ${fmt(ov?.pending_events)} waiting`} tone={(ov?.failed_events ?? 0) + (ov?.stuck_events ?? 0) > 0 ? 'bad' : undefined} />
      </dl>

      <Board rows={rows} onOpen={onOpen} />

      <div className="ia-split">
        <section className="ia-panel">
          <div className="ia-panel-h"><h2>Activity, last 30 days</h2>
            <div className="ia-key"><i className="k-msg" />WhatsApp messages<i className="k-sign" />New business</div></div>
          {act ? <ActivityChart a={act} /> : <div className="ia-skel" style={{ height: 190 }} />}
        </section>
        <section className="ia-panel">
          <div className="ia-panel-h"><h2>Needs you</h2>{errors.length > 0 && <button className="ia-textbtn" onClick={goErrors}>All errors</button>}</div>
          {items.length === 0
            ? <p className="ia-empty">All quiet. Every business is running normally.</p>
            : <ul className="ia-feed">
                {items.slice(0, 6).map((it, i) => (
                  <li key={i}>
                    <button className={`ia-feeditem t-${it.tone}`} onClick={() => it.ws && onOpen(it.ws)} disabled={!it.ws}>
                      <span className="ia-feeddot" aria-hidden />
                      <span className="ia-feedtxt"><strong>{it.title}</strong><span>{it.body}</span></span>
                      <time title={stamp(it.at)}>{ago(it.at)}</time>
                    </button>
                  </li>
                ))}
              </ul>}
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'bad' | 'warn' }) {
  return <div className={`ia-stat${tone ? ' t-' + tone : ''}`}><dt>{label}</dt><dd>{value}</dd><span>{sub}</span></div>;
}

/* the memorable bit: where each business is stuck */
function Board({ rows, onOpen }: { rows: WsRow[]; onOpen: (id: string) => void }) {
  const cols = [...STEPS.map((s) => s.label), 'Fully set up'];
  const by = cols.map((_, i) => rows.filter((w) => stuckAt(w) === i && w.status !== 'suspended'));
  let n = 0;
  return (
    <section className="ia-board" aria-label="Where each business is stuck">
      <div className="ia-board-h">
        <h2>Where each business is stuck</h2>
        <p>Each business sits on the next setup step it hasn't done yet. Move them all to the right.</p>
      </div>
      <ol className="ia-lanes">
        {cols.map((c, i) => (
          <li key={c} className={`ia-lane${by[i]!.length ? ' has' : ''}${i === STEPS.length ? ' done' : ''}`}>
            <div className="ia-lane-h">
              <div className="ia-lane-top">
                <span className="ia-step">{i < STEPS.length ? i + 1 : '✓'}</span>
                <b className="ia-lane-n">{plural(by[i]!.length, 'business', 'businesses')}</b>
              </div>
              <strong>{c}</strong><small>{i < STEPS.length ? STEPS[i]!.hint : 'Ads, WhatsApp and sales all flowing'}</small>
            </div>
            <div className="ia-chips">
              {by[i]!.map((w) => {
                const h = healthOf(w);
                return (
                  <button key={w.id} className="ia-chip" style={{ animationDelay: `${120 + n++ * 70}ms` }} onClick={() => onOpen(w.id)}>
                    <span className="ia-tile sm" style={{ background: tileColor(w.id) }}>{initials(w.name)}</span>
                    <span className="ia-chiptxt"><strong>{w.name}</strong><small>joined {ago(w.created_at)}</small></span>
                    <span className="ia-ticks" aria-label={`${STEPS.filter((s) => s.done(w)).length} of 4 steps done`}>
                      {STEPS.map((s) => <i key={s.key} className={s.done(w) ? 'on' : ''} title={s.label} />)}
                    </span>
                    {(h.tone === 'bad' || h.tone === 'warn') && <span className={`ia-flag t-${h.tone}`} title={h.text} />}
                  </button>
                );
              })}
              {by[i]!.length === 0 && <span className="ia-lane-empty">Nobody here</span>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ActivityChart({ a }: { a: Activity }) {
  const W = 640, H = 190, P = { l: 30, r: 8, t: 12, b: 30 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const max = Math.max(5, ...a.messages);
  const top = Math.ceil(max / 5) * 5;
  const bw = iw / a.days.length;
  const [hover, setHover] = useState<number | null>(null);
  const total = a.messages.reduce((s, x) => s + x, 0);
  return (
    <div className="ia-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${total} WhatsApp messages and ${a.signups.reduce((s, x) => s + x, 0)} signups in 30 days`}
           onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={P.l} x2={W - P.r} y1={P.t + ih * (1 - f)} y2={P.t + ih * (1 - f)} className="grid" />
            <text x={P.l - 6} y={P.t + ih * (1 - f) + 4} className="ax" textAnchor="end">{Math.round(top * f)}</text>
          </g>
        ))}
        {a.days.map((d, i) => {
          const h = (a.messages[i]! / top) * ih;
          const x = P.l + i * bw;
          return (
            <g key={d} onMouseEnter={() => setHover(i)}>
              <rect x={x} y={P.t} width={bw} height={ih + P.b} fill="transparent" />
              <rect x={x + bw * 0.18} y={P.t + ih - h} width={bw * 0.64} height={Math.max(h, a.messages[i] ? 2 : 0)} rx={2}
                    className={`bar${hover === i ? ' hi' : ''}`} />
              {a.signups[i]! > 0 && <circle cx={x + bw / 2} cy={P.t + ih + 9} r={4.5} className="sign" />}
              {(i % 7 === 2 || i === a.days.length - 1) && (
                <text x={x + bw / 2} y={H - 4} className="ax" textAnchor="middle">
                  {new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="ia-tip" aria-live="polite">
        {hover == null
          ? <>{plural(total, 'message')} in 30 days{a.orders ? ` · ${plural(a.orders.reduce((s, x) => s + x, 0), 'paid order')}` : ''} · {plural(a.kito.reduce((s, x) => s + x, 0), 'Kito question')}</>
          : <>{new Date(a.days[hover] + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}: {plural(a.messages[hover]!, 'message')}
              {a.signups[hover] ? `, ${plural(a.signups[hover]!, 'new business', 'new businesses')}` : ''}
              {a.sent?.[hover] ? `, ${plural(a.sent[hover]!, 'reply', 'replies')} from itaOS` : ''}
              {a.orders?.[hover] ? `, ${plural(a.orders[hover]!, 'paid order')}` : ''}
              {a.kito[hover] ? `, ${plural(a.kito[hover]!, 'Kito question')}` : ''}</>}
      </div>
    </div>
  );
}

/* ================= businesses ================= */
function Spark({ v }: { v: number[] | undefined }) {
  if (!v || v.length === 0) return <span className="ia-faint">–</span>;
  const max = Math.max(1, ...v);
  const any = v.some((x) => x > 0);
  return (
    <svg className="ia-spark" viewBox={`0 0 ${v.length * 6} 24`} aria-label={`${v.reduce((s, x) => s + x, 0)} messages in 14 days`}>
      {v.map((x, i) => <rect key={i} x={i * 6} y={24 - (x / max) * 22 - (any ? 1 : 0)} width={4} height={x ? (x / max) * 22 + 1 : 1.5} rx={1} className={x ? 'on' : ''} />)}
    </svg>
  );
}

function Businesses({ rows, act, loading, onOpen }: { rows: WsRow[]; act: Activity | null; loading: boolean; onOpen: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [f, setF] = useState<'all' | 'attention' | 'live' | 'trial' | 'suspended'>('all');
  const list = useMemo(() => {
    const rank: Record<Tone, number> = { bad: 0, warn: 1, ok: 2, idle: 3 };
    return rows
      .filter((w) => !q || `${w.name} ${w.owner_email ?? ''} ${w.wa_phone ?? ''}`.toLowerCase().includes(q.toLowerCase().replace(/^\+/, '')))
      .filter((w) => f === 'all' ? true : f === 'attention' ? ['bad', 'warn'].includes(healthOf(w).tone) : f === 'live' ? w.wa_status === 'active' : w.status === f)
      .sort((a, b) => rank[healthOf(a).tone] - rank[healthOf(b).tone] || +new Date(b.created_at) - +new Date(a.created_at));
  }, [rows, q, f]);
  const counts = { all: rows.length, attention: rows.filter((w) => ['bad', 'warn'].includes(healthOf(w).tone)).length,
    live: rows.filter((w) => w.wa_status === 'active').length,
    trial: rows.filter((w) => w.status === 'trial').length, suspended: rows.filter((w) => w.status === 'suspended').length };

  return (
    <div>
      <header className="ia-pagehead"><h1>Businesses</h1><p>Everyone using itaOS, sorted so problems come first.</p></header>
      <div className="ia-tools">
        <label className="ia-search">{ICON.search}<input placeholder="Find a business, owner email or WhatsApp number" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <div className="ia-seg" role="radiogroup" aria-label="Filter">
          {(['all', 'attention', 'live', 'trial', 'suspended'] as const).map((k) => (
            <button key={k} role="radio" aria-checked={f === k} className={f === k ? 'on' : ''} onClick={() => setF(k)}>
              {k === 'all' ? 'All' : k === 'attention' ? 'Needs a look' : k === 'live' ? 'Live on WhatsApp' : k[0]!.toUpperCase() + k.slice(1)}<em>{counts[k]}</em>
            </button>
          ))}
        </div>
      </div>
      <div className="ia-tablecard">
        <table className="ia-table">
          <thead><tr>
            <th>Business</th><th>Setup</th><th>Owner</th><th>Messages, 14 days</th>
            <th className="r">Sales 30d</th><th className="r">Ad spend 30d</th><th className="r">Kito 30d</th><th className="r">Joined</th>
          </tr></thead>
          <tbody>
            {loading && rows.length === 0 && <tr><td colSpan={8}><div className="ia-skel" /></td></tr>}
            {!loading && list.length === 0 && <tr><td colSpan={8} className="ia-empty">No business matches that search.</td></tr>}
            {list.map((w) => {
              const h = healthOf(w); const s = stuckAt(w);
              return (
                <tr key={w.id} tabIndex={0} onClick={() => onOpen(w.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(w.id); }}>
                  <td>
                    <div className="ia-bizcell">
                      <span className="ia-tile" style={{ background: tileColor(w.id) }}>{initials(w.name)}</span>
                      <div><strong>{w.name}{w.status !== 'active' && <span className={`ia-badge s-${w.status}`}>{w.status}</span>}</strong>
                        {w.wa_phone && <small className="ia-faint">WhatsApp +{w.wa_phone} · {viaName(w.wa_via)}</small>}
                        <span className={`ia-health t-${h.tone}`}><i />{h.text}</span></div>
                    </div>
                  </td>
                  <td>
                    <div className="ia-ticks lg">{STEPS.map((st) => <i key={st.key} className={st.done(w) ? 'on' : ''} title={`${st.label}: ${st.done(w) ? 'done' : 'not yet'}`} />)}</div>
                    <small className="ia-faint">{s < STEPS.length ? `Next: ${STEPS[s]!.label}` : 'Fully set up'}</small>
                  </td>
                  <td><div className="ia-trunc">{w.owner_email ?? 'No owner'}</div><small className="ia-faint">{w.owner_email ? `signed in ${ago(w.owner_last_sign_in)}` : 'nobody can sign in to it'}</small></td>
                  <td><div className="ia-sparkcell"><Spark v={act?.per_ws[w.id]} /><span>{fmt(w.messages)} total</span></div></td>
                  <td className="r num"><span className="nowrap">{w.revenue_30d != null ? money(w.revenue_30d, w.currency) : fmt(w.orders)}</span><small className="ia-faint">{plural(w.orders, 'paid order')}{w.tick_orders ? ` · ${fmt(w.tick_orders)} ✅` : ''}</small></td>
                  <td className="r num">{money(w.spend_30d, w.spend_currency)}</td>
                  <td className="r num">{fmt(w.kito_asks_30d)}<small className="ia-faint">{w.kito_tokens_30d ? `${fmt(Math.max(1, Math.round(w.kito_tokens_30d / 1000)))}k tokens` : 'no tokens'}</small></td>
                  <td className="r nowrap" title={stamp(w.created_at)}>{ago(w.created_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ================= errors & audit ================= */
function Errors({ rows, loading, onOpen }: { rows: ErrRow[]; loading: boolean; onOpen: (id: string) => void }) {
  const [src, setSrc] = useState('all');
  const sources = useMemo(() => Array.from(new Set(rows.map((e) => e.source.split(':')[0]!))), [rows]);
  const list = rows.filter((e) => src === 'all' || e.source.startsWith(src));
  return (
    <div>
      <header className="ia-pagehead"><h1>Errors</h1><p>Things that failed behind the scenes, newest first.</p></header>
      {sources.length > 1 && (
        <div className="ia-tools"><div className="ia-seg">
          {['all', ...sources].map((s) => <button key={s} className={src === s ? 'on' : ''} onClick={() => setSrc(s)}>{s === 'all' ? 'All' : s}</button>)}
        </div></div>
      )}
      {loading && rows.length === 0 && <div className="ia-skel" />}
      {!loading && list.length === 0 && <div className="ia-panel"><p className="ia-empty">No errors. Messages, syncs and Kito are all processing cleanly.</p></div>}
      <ol className="ia-errlist">
        {list.map((e, i) => (
          <li key={i} className="ia-panel">
            <div className="ia-err-h">
              <strong>{SOURCE[e.source.split(':')[0]!] ?? e.source}</strong>
              {e.workspace_id
                ? <button className="ia-textbtn" onClick={() => onOpen(e.workspace_id!)}>{e.workspace_name ?? 'Open business'}</button>
                : <span className="ia-faint">Not linked to a business</span>}
              <time title={stamp(e.at)}>{ago(e.at)}</time>
            </div>
            <pre>{e.detail}</pre>
            <code className="ia-src">{e.source}</code>
          </li>
        ))}
      </ol>
    </div>
  );
}

const ACTION: Record<string, string> = {
  set_state: 'Changed account settings', requeue_events: 'Retried failed WhatsApp events', set_send: 'Changed replying from itaOS',
  delete_workspace: 'Deleted a business', add_staff: 'Added a staff member', remove_staff: 'Removed a staff member',
};
function describe(action: string, d: any): string {
  if (action === 'set_state' && d?.after) {
    const b = d.before ?? { status: 'active', plan: 'pilot', note: null };
    const parts: string[] = [];
    if (b.status !== d.after.status) parts.push(`status ${b.status} → ${d.after.status}`);
    if ((b.plan ?? 'pilot') !== (d.after.plan || 'pilot')) parts.push(`plan ${b.plan ?? 'pilot'} → ${d.after.plan}`);
    if ((b.note ?? '') !== (d.after.note ?? '')) parts.push('note updated');
    return parts.join(', ') || 'no change';
  }
  if (action === 'requeue_events') return `${d?.requeued ?? 0} sent back to the queue`;
  if (action === 'set_send') return d?.after ? 'switched on' : 'switched off';
  if (action === 'delete_workspace') return `${d?.name ?? 'business'}: ${fmt(d?.chats ?? 0)} chats, ${fmt(d?.messages ?? 0)} messages, ${fmt(d?.orders ?? 0)} orders removed`;
  if (action === 'add_staff' || action === 'remove_staff') return d?.email ?? '';
  return JSON.stringify(d);
}

function Audit({ supabase, tick }: { supabase: SupabaseClient; tick: number }) {
  const { data, error, loading } = useRpc<AuditRow[]>(supabase, 'admin_audit_log', { p_limit: 100 }, [tick]);
  return (
    <div>
      <header className="ia-pagehead"><h1>Audit log</h1><p>Every change made from this admin page, and who made it.</p></header>
      {error && <div className="ia-alert">Couldn't load the audit log: {error}</div>}
      {loading && !data && <div className="ia-skel" />}
      {data && data.length === 0 && <div className="ia-panel"><p className="ia-empty">No admin changes yet. Status, plan, sending, staff and deletions show up here.</p></div>}
      {data && data.length > 0 && (
        <ol className="ia-timeline">
          {data.map((a, i) => (
            <li key={i}><time title={stamp(a.at)}>{ago(a.at)}</time>
              <div><strong>{ACTION[a.action] ?? a.action}</strong>{a.workspace_name && <> for {a.workspace_name}</>}
                <span>{describe(a.action, a.details)} · {a.actor_email}</span></div></li>
          ))}
        </ol>
      )}
    </div>
  );
}

/* ================= drawer ================= */
const ORIGIN: Record<string, string> = {
  history: 'WhatsApp history sync', webhook: 'Live from customers', app_echo: 'Sent from the WhatsApp app',
  itaos: 'Replies sent from itaOS', import: 'Uploaded chat files', api: 'Sent through the API', unknown: 'Unknown',
};
const ORDER_FROM: Record<string, string> = {
  tick: 'Owner’s ✅ message', kito: 'Kito (from a screenshot or chat)', rules: 'Payment words in the chat',
  name_mark: 'Name marked in WhatsApp', import: 'Imported file', manual: 'Recorded by hand',
};

function Drawer({ supabase, id, row, onClose, onChanged, onDeleted }:
  { supabase: SupabaseClient; id: string; row?: WsRow; onClose: () => void; onChanged: () => void; onDeleted: () => void }) {
  const [tick, setTick] = useState(0);
  const { data: d, error, loading } = useRpc<Detail>(supabase, 'admin_workspace_detail', { p_ws: id }, [id, tick]);
  const [status, setStatus] = useState<WsStatus>('active');
  const [plan, setPlan] = useState('pilot');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmSuspend, setConfirmSuspend] = useState(false);
  const [delName, setDelName] = useState('');
  const [delOpen, setDelOpen] = useState(false);

  useEffect(() => { if (d?.workspace) { setStatus(d.workspace.status); setPlan(d.workspace.plan); setNote(d.workspace.note ?? ''); } }, [d]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const w = d?.workspace;
  const dirty = !!w && (status !== w.status || plan !== w.plan || (note.trim() || null) !== (w.note || null));
  const retryable = (d?.events ?? []).filter((e) => e.status === 'failed' || e.status === 'stuck').reduce((s, e) => s + e.n, 0);
  const h = row ? healthOf(row) : null;
  const maxDay = Math.max(1, ...(d?.daily ?? []).map((x) => x.in + x.out));
  const totalIn = (d?.daily ?? []).reduce((s, x) => s + x.in, 0), totalOut = (d?.daily ?? []).reduce((s, x) => s + x.out, 0);
  const totalItaos = (d?.daily ?? []).reduce((s, x) => s + (x.itaos ?? 0), 0);
  const wa = d?.connections.find((c) => c.provider === 'whatsapp');
  const connected = (d?.connections.length ?? 0) > 0 || (d?.wa_numbers.length ?? 0) > 0;
  const hasPhotos = (d?.media?.saved ?? 0) > 0;
  const sendOn = w?.send_enabled !== false;

  async function run(key: string, fn: () => PromiseLike<{ error: { message: string } | null; data?: unknown }>, ok: (data: unknown) => string, fail: string) {
    setBusy(key); setMsg(null);
    const { data, error } = await fn();
    setBusy(null);
    if (error) setMsg({ ok: false, text: `${fail}: ${error.message}` });
    else { setMsg({ ok: true, text: ok(data) }); setTick((t) => t + 1); onChanged(); }
  }
  function save() {
    if (status === 'suspended' && w?.status !== 'suspended' && !confirmSuspend) { setConfirmSuspend(true); return; }
    setConfirmSuspend(false);
    void run('save', () => supabase.rpc('admin_set_workspace_state', { p_ws: id, p_status: status, p_plan: plan, p_note: note }), () => 'Changes saved', 'Not saved');
  }
  const requeue = () => run('requeue', () => supabase.rpc('admin_requeue_events', { p_ws: id }),
    (n) => `${plural(Number(n ?? 0), 'event')} sent back to the queue`, 'Retry failed');
  const toggleSend = () => run('send', () => supabase.rpc('admin_set_send_enabled', { p_ws: id, p_on: !sendOn }),
    () => (sendOn ? 'Replying from itaOS switched off' : 'Replying from itaOS switched on'), 'Not changed');
  async function del() {
    setBusy('delete'); setMsg(null);
    const { error } = await supabase.rpc('admin_delete_workspace', { p_ws: id, p_confirm: delName });
    setBusy(null);
    if (error) setMsg({ ok: false, text: `Not deleted: ${error.message}` });
    else onDeleted();
  }

  return (
    <div className="ia-scrim" onClick={onClose}>
      <aside className="ia-drawer" role="dialog" aria-modal="true" aria-label={`${w?.name ?? 'Business'} details`} onClick={(e) => e.stopPropagation()}>
        <header className="ia-dh">
          <span className="ia-tile lg" style={{ background: tileColor(id) }}>{initials(w?.name ?? row?.name ?? '')}</span>
          <div className="ia-dh-t">
            <h2>{w?.name ?? row?.name ?? 'Loading…'}</h2>
            {w && <p>Joined {stamp(w.created_at)} · {w.language === 'sw' ? 'Kiswahili' : 'English'} · {w.currency}{row?.wa_phone ? ` · WhatsApp +${row.wa_phone}` : ''}</p>}
          </div>
          <button className="ia-x" onClick={onClose} aria-label="Close">{ICON.close}</button>
        </header>
        {h && <div className={`ia-banner t-${h.tone}`}><i />{h.text}</div>}
        {error && <div className="ia-alert">{error}</div>}
        {loading && !d && <div className="ia-dbody"><div className="ia-skel" /><div className="ia-skel" /></div>}

        {d && w && (
          <div className="ia-dbody">
            {row && (
              <section className="ia-dsec">
                <h3>Setup</h3>
                <ol className="ia-check">
                  {STEPS.map((s) => (
                    <li key={s.key} className={s.done(row) ? 'on' : ''}><span>{s.done(row) ? '✓' : ''}</span>
                      <div><strong>{s.label}</strong><small>{s.hint}</small></div></li>
                  ))}
                  {row.wa_via !== undefined && EXTRAS.map((s) => (
                    <li key={s.label} className={s.done(row) ? 'on' : ''}><span>{s.done(row) ? '✓' : ''}</span>
                      <div><strong>{s.label}</strong>
                        <small>{s.label.startsWith('Dashboard') && (row.settings_missing ?? []).length ? `Missing: ${row.settings_missing!.join(', ')}` : s.hint}</small></div></li>
                  ))}
                </ol>
              </section>
            )}

            <section className="ia-dsec">
              <h3>Account</h3>
              <div className="ia-form">
                <div className="ia-field"><span>Status</span>
                  <div className="ia-seg full" role="radiogroup" aria-label="Status">
                    {(['trial', 'active', 'suspended'] as WsStatus[]).map((s) => (
                      <button key={s} role="radio" aria-checked={status === s} className={status === s ? `on s-${s}` : ''} onClick={() => { setStatus(s); setConfirmSuspend(false); }}>{s[0]!.toUpperCase() + s.slice(1)}</button>
                    ))}
                  </div></div>
                <label className="ia-field"><span>Plan</span><input value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="pilot" /></label>
                <label className="ia-field wide"><span>Private note</span>
                  <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Only Pondi staff can see this, e.g. how they found itaOS or what they're paying" /></label>
              </div>
              {confirmSuspend && <p className="ia-confirm">Suspend {w.name}? The owner will see a paused screen and can't send replies. Press Save again to confirm.</p>}
              <div className="ia-actions">
                <button className="ia-btn primary" disabled={!dirty || busy !== null} onClick={save}>{busy === 'save' ? 'Saving…' : confirmSuspend ? 'Confirm suspend' : 'Save changes'}</button>
                {retryable > 0 && <button className="ia-btn" disabled={busy !== null} onClick={requeue}>{busy === 'requeue' ? 'Retrying…' : `Retry ${plural(retryable, 'failed or stuck event')}`}</button>}
                {msg && <span className={msg.ok ? 'ia-ok' : 'ia-bad'} role="status">{msg.text}</span>}
              </div>
              <p className="ia-faint small">Suspended pauses the business app for everyone in it and blocks replies from itaOS. WhatsApp messages keep arriving, so nothing is lost.</p>
            </section>

            <section className="ia-dsec">
              <h3>WhatsApp messages, last 14 days</h3>
              <div className="ia-dbars" role="img" aria-label={`${totalIn} received and ${totalOut} sent in 14 days`}>
                {d.daily.map((x) => (
                  <div key={x.day} title={`${x.day}: ${x.in} received, ${x.out} sent${x.itaos ? ` (${x.itaos} from itaOS)` : ''}`}>
                    <span className="col" style={{ height: `${((x.in + x.out) / maxDay) * 100}%` }}>
                      <i className="s" style={{ flex: x.itaos ?? 0 }} /><i className="o" style={{ flex: x.out - (x.itaos ?? 0) }} /><i className="n" style={{ flex: x.in }} />
                    </span>
                    <small>{new Date(x.day + 'T12:00:00Z').getUTCDate()}</small>
                  </div>
                ))}
              </div>
              <p className="ia-key small"><i className="k-in" />{fmt(totalIn)} from customers<i className="k-out" />{fmt(totalOut - totalItaos)} from the WhatsApp app
                {d.daily[0]?.itaos !== undefined && <><i className="k-itaos" />{fmt(totalItaos)} from itaOS</>}</p>
              {d.msg_origins && Object.keys(d.msg_origins).length > 0 && (
                <ul className="ia-mini">
                  {Object.entries(d.msg_origins).sort((a, b) => b[1] - a[1]).map(([k, n]) => <li key={k}><span>{ORIGIN[k] ?? k}</span><b>{fmt(n)}</b></li>)}
                </ul>
              )}
            </section>

            <section className="ia-dsec">
              <h3>Connections</h3>
              {!connected && <p className="ia-empty left">Nothing connected yet. The owner connects WhatsApp (Dualhook) and Meta Ads from their Connections page.</p>}
              <ul className="ia-conns">
                {d.connections.map((c, i) => (
                  <li key={i}>
                    <span className={`ia-health t-${c.status === 'active' ? 'ok' : 'bad'}`}><i /></span>
                    <div><strong>{c.provider === 'meta_ads' ? 'Meta Ads' : `WhatsApp via ${viaName(c.via)}`}</strong>
                      <small>{c.label ?? c.external_id}{c.provider === 'whatsapp' && c.webhook_set_at ? ` · webhook set ${ago(c.webhook_set_at)}` : ''}</small>
                      {c.provider === 'whatsapp' && c.send_key !== undefined && (
                        <small className={c.send_key ? '' : 'ia-warn'}>{c.send_key ? `Replies: Dualhook API key saved ${ago(c.send_key_set_at)}` : "Replies: no Dualhook API key yet, so they can't reply from itaOS"}</small>
                      )}
                      {c.last_error && <small className="ia-bad">{c.last_error}</small>}</div>
                    <span className="ia-faint">{c.provider === 'meta_ads' ? `synced ${ago(c.last_sync_at)}` : c.status}</span>
                  </li>
                ))}
                {d.wa_numbers.map((n) => (
                  <li key={n.phone_number_id}><span className="ia-health t-ok"><i /></span>
                    <div><strong>{n.display_phone ? `+${n.display_phone}` : n.phone_number_id}</strong>
                      <small>{n.coexistence ? 'Coexistence: the WhatsApp Business app still works' : 'Cloud API'} · history {n.history_status ?? 'not requested'}</small>
                      {n.last_in !== undefined && <small>Last customer message {ago(n.last_in)}</small>}</div>
                    <span className="ia-faint">WABA {n.waba_id}</span></li>
                ))}
              </ul>
              {wa && (
                <div className="ia-row">
                  <div><strong>Reply from itaOS</strong>
                    <small className="ia-faint">{sendOn ? 'On: owners and admins can answer chats inside itaOS (24-hour window).' : 'Off: the Chats inbox is read-only.'} The owner can also change this in Settings.</small></div>
                  <button className="ia-btn" disabled={busy !== null || row?.send_enabled === undefined} onClick={toggleSend}>{busy === 'send' ? 'Saving…' : sendOn ? 'Switch off' : 'Switch on'}</button>
                </div>
              )}
            </section>

            {d.sales && (
              <section className="ia-dsec">
                <h3>Sales</h3>
                <p className="ia-kito"><strong>{money(d.sales.revenue_30d, w.currency)}</strong> in the last 30 days · {money(d.sales.revenue_total, w.currency)} in total
                  {d.sales.last_paid_at && <> · last paid {ago(d.sales.last_paid_at)}</>}</p>
                {d.sales.by_source.length === 0
                  ? <p className="ia-empty left">No orders yet.</p>
                  : <ul className="ia-mini">
                      {d.sales.by_source.map((s, i) => (
                        <li key={i}><span>{ORDER_FROM[s.from] ?? s.from}{s.status !== 'paid' && <em className="ia-badge">{s.status}</em>}</span>
                          <b>{plural(s.n, 'order')} · {money(s.amount ?? 0, w.currency)}</b></li>
                      ))}
                    </ul>}
                {(w.unit_cost == null || (w.fx_rate == null && row?.meta_status)) && (
                  <p className="ia-faint small">Dashboard can't show profit yet: {[w.fx_rate == null && row?.meta_status ? 'exchange rate' : '', w.unit_cost == null ? 'cost per order' : ''].filter(Boolean).join(' and ')} not set. The owner types them on the Dashboard card.</p>
                )}
              </section>
            )}

            <section className="ia-dsec">
              <h3>What's in their account</h3>
              <dl className="ia-counts">
                {([['live_chats', 'Live chats'], ['imported_chats', 'Imported chats'], ['messages', 'Messages'], ['contacts', 'Customers'],
                   ['kito_tagged', 'Chats read by Kito'], ['ads', 'Ads'], ['insight_days', 'Ad-days of data'], ['orders', 'Paid orders'],
                   ['open_tasks', 'Open follow-ups'], ['content_ideas', 'Content ideas']] as const)
                  .filter(([k]) => k in d.counts || !['live_chats', 'imported_chats'].includes(k))
                  .map(([k, l]) => (
                    <div key={k} className={d.counts[k] ? '' : 'zero'}><dd>{fmt(d.counts[k])}</dd><dt>{l}</dt></div>
                  ))}
              </dl>
              {d.media && d.media.saved + d.media.errors > 0 && (
                <p className="ia-faint small" style={{ marginTop: 10 }}>
                  {plural(d.media.saved, 'customer photo')} saved, {plural(d.media.receipts, 'payment screenshot')} read by Kito
                  {d.media.errors ? <span className="ia-bad">, {plural(d.media.errors, 'photo')} couldn't be read</span> : ''}. Last one {ago(d.media.last_at)}.</p>
              )}
            </section>

            <section className="ia-dsec">
              <h3>Kito</h3>
              {d.kito.reads_24h !== undefined && (
                <p className="ia-kito"><strong>{plural(d.kito.reads_24h, 'chat')}</strong> read in the last 24 hours
                  {d.kito.fails_24h ? <span className="ia-bad">, {fmt(d.kito.fails_24h)} failed</span> : ''}.{' '}
                  {(d.kito.behind ?? 0) > 0 ? <span className={(d.kito.behind ?? 0) >= 25 ? 'ia-warn' : ''}>{plural(d.kito.behind!, 'chat')} with new messages still to read.</span> : 'Up to date with new messages.'}</p>
              )}
              <p className="ia-kito"><strong>{plural(d.kito.asks_30d, 'question')}</strong> asked in 30 days, using {fmt(d.kito.input_tokens_30d + d.kito.output_tokens_30d)} tokens
                ({fmt(d.kito.input_tokens_30d)} in, {fmt(d.kito.output_tokens_30d)} out).
                {d.kito.errors_30d > 0 && <span className="ia-bad"> {plural(d.kito.errors_30d, 'question')} failed.</span>}</p>
              {d.kito.runs.length > 0 && (
                <ul className="ia-runs">
                  {d.kito.runs.map((r, i) => <li key={i}><time>{ago(r.ran_at)}</time><span>Read {plural(r.checked, 'chat')}{r.failed ? `, ${r.failed} failed` : ''}{r.remaining ? `, ${r.remaining} left` : ''}</span><small>{r.trigger === 'auto' ? 'automatic, every 15 min' : 'started by owner'}</small></li>)}
                </ul>
              )}
            </section>

            {((d.deletions?.length ?? 0) > 0 || (d.imports?.length ?? 0) > 0) && (
              <section className="ia-dsec">
                <h3>Imports and deletions</h3>
                <ol className="ia-timeline compact">
                  {[...(d.imports ?? []).map((b) => ({ at: b.at, title: `Imported ${b.kind === 'chat' || b.kind === 'chats' ? 'chat files' : b.kind}`,
                       body: `${fmt(b.created)} added, ${fmt(b.skipped)} skipped${b.rejected ? `, ${fmt(b.rejected)} rejected` : ''}` })),
                    ...(d.deletions ?? []).map((x) => ({ at: x.at, title: `Deleted ${plural(x.chats, 'chat')} ${x.via === 'kito' ? 'through Kito' : 'from Chats'}`,
                       body: `${fmt(x.messages)} messages${Object.keys(x.by_origin ?? {}).length ? ` (${Object.entries(x.by_origin).map(([k, n]) => `${n} ${k === 'export' ? 'imported' : k}`).join(', ')})` : ''}${x.orders_unlinked ? `, ${x.orders_unlinked} orders kept but unlinked` : ''} · ${x.by ?? 'unknown'}` }))]
                    .sort((a, b) => +new Date(b.at) - +new Date(a.at)).slice(0, 10)
                    .map((e, i) => <li key={i}><time title={stamp(e.at)}>{ago(e.at)}</time><div><strong>{e.title}</strong><span>{e.body}</span></div></li>)}
                </ol>
              </section>
            )}

            <section className="ia-dsec">
              <h3>People</h3>
              {d.members.length === 0
                ? <p className="ia-empty left">Nobody belongs to this business, so no one can sign in to it. It's safe to delete below.</p>
                : <ul className="ia-people">
                    {d.members.map((m) => <li key={m.email}><span className="ia-trunc">{m.email}</span><span className="ia-badge">{m.role}</span><small className="ia-faint">signed in {ago(m.last_sign_in_at)}</small></li>)}
                  </ul>}
            </section>

            {d.audit.length > 0 && (
              <section className="ia-dsec">
                <h3>Admin changes</h3>
                <ol className="ia-timeline compact">
                  {d.audit.map((a, i) => <li key={i}><time title={stamp(a.at)}>{ago(a.at)}</time><div><strong>{ACTION[a.action] ?? a.action}</strong><span>{describe(a.action, a.details)} · {a.actor}</span></div></li>)}
                </ol>
              </section>
            )}

            <section className="ia-dsec ia-danger">
              <h3>Delete this business</h3>
              {connected || hasPhotos
                ? <p className="ia-faint small">Can't delete while {connected ? 'WhatsApp or Meta Ads is connected (the owner disconnects on their Connections page)' : 'customer photos are stored'}. Suspend it instead.</p>
                : !delOpen
                  ? <button className="ia-btn danger" onClick={() => setDelOpen(true)}>Delete {w.name}…</button>
                  : <div className="ia-form">
                      <label className="ia-field wide"><span>Removes everything in it: {fmt(d.counts.conversations)} chats, {fmt(d.counts.messages)} messages, {fmt(d.counts.orders)} orders and its members' access. Type <b>{w.name}</b> to confirm.</span>
                        <input value={delName} onChange={(e) => setDelName(e.target.value)} placeholder={w.name} autoFocus /></label>
                      <div className="ia-actions wide">
                        <button className="ia-btn danger" disabled={delName !== w.name || busy !== null} onClick={del}>{busy === 'delete' ? 'Deleting…' : 'Delete for good'}</button>
                        <button className="ia-btn" onClick={() => { setDelOpen(false); setDelName(''); }}>Cancel</button>
                      </div>
                    </div>}
            </section>
            <p className="ia-faint small ia-id">Workspace ID {w.id}</p>
          </div>
        )}
      </aside>
    </div>
  );
}

/* ================= staff ================= */
function StaffPage({ supabase }: { supabase: SupabaseClient }) {
  const [tick, setTick] = useState(0);
  const { data, error, loading } = useRpc<Staff[]>(supabase, 'admin_staff', undefined, [tick]);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  async function set(e: string, add: boolean) {
    if (!add && confirm !== e) { setConfirm(e); return; }
    setConfirm(null); setBusy(e); setMsg(null);
    const { error } = await supabase.rpc('admin_set_staff', { p_email: e, p_add: add });
    setBusy(null);
    if (error) setMsg({ ok: false, text: error.message });
    else { setMsg({ ok: true, text: add ? `${e} can now open this page` : `${e} removed` }); setEmail(''); setTick((t) => t + 1); }
  }

  return (
    <div>
      <header className="ia-pagehead"><h1>Staff</h1><p>Pondi people who can open this admin page. They sign in at /app/admin with their own itaOS account.</p></header>
      {error && <div className="ia-alert">{/function .* does not exist|schema cache/i.test(error) ? 'Staff management needs the latest database update (0023_admin_refresh).' : error}</div>}
      {loading && !data && <div className="ia-skel" />}
      {data && (
        <ol className="ia-timeline">
          {data.map((s) => (
            <li key={s.email}><time title={stamp(s.added_at)}>added {ago(s.added_at)}</time>
              <div className="ia-staffrow">
                <div><strong>{s.email}{s.is_me && <span className="ia-badge">you</span>}</strong><span>signed in {ago(s.last_sign_in_at)}</span></div>
                {!s.is_me && <button className={`ia-btn${confirm === s.email ? ' danger' : ''}`} disabled={busy !== null} onClick={() => set(s.email, false)}>{busy === s.email ? 'Removing…' : confirm === s.email ? 'Confirm remove' : 'Remove'}</button>}
              </div></li>
          ))}
        </ol>
      )}
      <form className="ia-panel ia-addstaff" onSubmit={(e) => { e.preventDefault(); if (email.trim()) void set(email.trim(), true); }}>
        <label className="ia-field"><span>Add a staff member</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@ponditech.com" /></label>
        <button className="ia-btn primary" disabled={!email.trim() || busy !== null}>Add</button>
        {msg && <span className={msg.ok ? 'ia-ok' : 'ia-bad'} role="status">{msg.text}</span>}
        <p className="ia-faint small">The person needs an itaOS account first (Create account on the sign-in page, then confirm the email). Staff see every business's counts and settings, never message text.</p>
      </form>
    </div>
  );
}

/* ================= icons ================= */
const sv = (d: string) => <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>;
const ICON = {
  today: sv('M4 13h4l2-6 4 12 2-6h4'),
  ws: sv('M4 7h16M4 12h16M4 17h10'),
  err: sv('M12 8v5M12 16.5v.5M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z'),
  audit: sv('M12 7v5l3 2M21 12a9 9 0 1 1-9-9 9 9 0 0 1 9 9Z'),
  refresh: sv('M20 11a8 8 0 0 0-14.9-3.5M4 4v4h4M4 13a8 8 0 0 0 14.9 3.5M20 20v-4h-4'),
  search: sv('m20 20-4-4m2-5a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z'),
  close: sv('M6 6l12 12M18 6 6 18'),
  staff: sv('M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM21 19v-1a4 4 0 0 0-3-3.9M15 4.1a3 3 0 0 1 0 5.8'),
};

/* ================= styles ================= */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Instrument+Sans:wght@400..700&display=swap');
.ia{--navy:#16224A;--navy2:#22336B;--yellow:#F7C948;--paper:#F1F2F6;--card:#FFFFFF;--ink:#141B34;--muted:#5D6580;--faint:#8D93A8;--line:#E2E5EE;
  --ok:#178A55;--warn:#C46A0B;--bad:#C8372D;--info:#2C5A8C;--r-lg:18px;--r:12px;--r-sm:8px;
  --display:'Bricolage Grotesque',ui-sans-serif,system-ui,sans-serif;--ui:'Instrument Sans',ui-sans-serif,system-ui,sans-serif;
  display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh;background:var(--paper);color:var(--ink);font:14px/1.5 var(--ui);-webkit-font-smoothing:antialiased}
.ia *{box-sizing:border-box}.ia button{font:inherit;color:inherit;cursor:pointer}.ia button:disabled{cursor:default}
.ia :focus-visible{outline:2px solid var(--yellow);outline-offset:2px;border-radius:6px}
.ia h1,.ia h2,.ia h3{font-family:var(--display);margin:0;letter-spacing:-.01em}
.ia-faint{color:var(--faint)}.small{font-size:12.5px}.ia-ok{color:var(--ok);font-weight:600}.ia-bad{color:var(--bad)}
.ia-trunc{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ia-blank{grid-column:1/-1;max-width:420px;margin:18vh auto;text-align:center;color:var(--muted)}.ia-blank h2{font-size:26px;color:var(--ink);margin-bottom:8px}

/* sidebar */
.ia-side{background:var(--navy);color:#C9D0E6;display:flex;flex-direction:column;padding:22px 14px;position:sticky;top:0;height:100vh;height:100dvh;align-self:start}
.ia-brand{display:flex;align-items:center;gap:10px;padding:0 8px 26px;font:600 15px var(--display);color:#fff}
.ia-mark{background:var(--yellow);color:var(--navy);font:800 19px/1 var(--display);letter-spacing:-.04em;padding:9px 9px 10px;border-radius:10px}
.ia-nav{display:grid;gap:2px}
.ia-navbtn{display:flex;align-items:center;gap:11px;background:none;border:0;padding:10px 12px;border-radius:10px;text-align:left;color:#C9D0E6;font-weight:500}
.ia-navbtn span{flex:1}.ia-navbtn:hover{background:rgba(255,255,255,.06);color:#fff}
.ia-navbtn.on{background:rgba(255,255,255,.1);color:#fff}.ia-navbtn.on svg{color:var(--yellow)}
.ia-navbtn em{font-style:normal;font-size:12px;font-weight:600;background:rgba(255,255,255,.12);border-radius:20px;padding:1px 8px;color:#fff}
.ia-navbtn em.hot{background:#E2544A}
.ia-side-foot{margin-top:auto;display:grid;gap:6px;padding:0 8px;font-size:12px;color:#8F99BD}
.ia-refresh{display:flex;align-items:center;gap:8px;justify-content:center;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);color:#fff!important;border-radius:10px;padding:8px;margin-bottom:6px;font-weight:600}
.ia-refresh:hover:not(:disabled){background:rgba(255,255,255,.14)}.ia-refresh:disabled{opacity:.6}
.ia-co{color:#6E79A3}.ia-back{color:#C9D0E6;text-decoration:none;font-weight:600}.ia-back:hover{color:#fff;text-decoration:underline}
.ia-blank .ia-btn{display:inline-block;margin-top:14px;text-decoration:none}.ia-signout{background:none;border:0;padding:0;text-align:left;font:inherit;font-weight:600;cursor:pointer}

/* main */
.ia-main{padding:34px clamp(20px,3.5vw,48px) 60px;min-width:0;max-width:1400px}
.ia-alert{background:#FBEAE8;color:var(--bad);border-radius:var(--r);padding:12px 16px;margin-bottom:18px}
.ia-hero{margin-bottom:26px}
.ia-date{margin:0 0 6px;color:var(--muted);font-weight:500}
.ia-hero h1{font-size:clamp(28px,3.3vw,44px);line-height:1.08;font-weight:700;letter-spacing:-.025em;max-width:24ch}
.ia-need{color:var(--navy);background:linear-gradient(transparent 62%,var(--yellow) 62%,var(--yellow) 92%,transparent 92%);padding:0 2px}
.ia-calm{color:var(--ok)}

.ia-strip{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));background:var(--card);border:1px solid var(--line);border-radius:var(--r-lg);margin:0 0 22px;overflow:hidden}
.ia-stat{padding:16px 18px;border-left:1px solid var(--line)}.ia-stat:first-child{border-left:0}
.ia-stat dt{font-size:12.5px;color:var(--muted);font-weight:500}
.ia-stat dd{margin:2px 0;font:700 28px/1.15 var(--display);font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.ia-stat span{font-size:12px;color:var(--faint)}
.ia-stat.t-bad dd{color:var(--bad)}.ia-stat.t-warn dd{color:var(--warn)}

/* board */
.ia-board{background:var(--navy);color:#fff;border-radius:22px;padding:24px 24px 22px;margin-bottom:22px;position:relative;overflow:hidden}
.ia-board::after{content:'';position:absolute;right:-60px;top:-80px;width:260px;height:260px;border-radius:50%;border:38px solid rgba(247,201,72,.08);pointer-events:none}
.ia-board-h{display:flex;justify-content:space-between;align-items:baseline;gap:20px;flex-wrap:wrap;margin-bottom:18px;position:relative;z-index:1}
.ia-board-h h2{font-size:22px;font-weight:700}.ia-board-h p{margin:0;color:#A9B3D6;max-width:52ch}
.ia-lanes{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;position:relative;z-index:1}
.ia-lanes::before{content:'';position:absolute;left:24px;right:24px;top:21px;height:2px;background:repeating-linear-gradient(90deg,rgba(255,255,255,.22) 0 6px,transparent 6px 12px)}
.ia-lane{position:relative;min-width:0}
.ia-lane-h{margin-bottom:12px;min-height:104px;padding-right:6px}
.ia-lane-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.ia-lane-h strong{display:block;font:700 15px/1.25 var(--display)}.ia-lane-h small{display:block;color:#8F99BD;font-size:12px;line-height:1.35;margin-top:3px}
.ia-step{flex:none;width:44px;height:44px;border-radius:50%;display:grid;place-items:center;font:700 16px var(--display);background:var(--navy);border:2px solid rgba(255,255,255,.22);color:#A9B3D6;position:relative;z-index:1}
.ia-lane.has .ia-step{background:var(--yellow);border-color:var(--yellow);color:var(--navy)}
.ia-lane.done.has .ia-step{background:#2FBF7A;border-color:#2FBF7A;color:#fff}
.ia-lane-n{font:600 12px var(--ui);color:#6E79A3;background:var(--navy);padding:2px 8px;border-radius:20px;position:relative;z-index:1}.ia-lane.has .ia-lane-n{color:var(--navy);background:#fff}
.ia-chips{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;min-height:64px;align-content:start;background:rgba(255,255,255,.04);border-radius:14px;padding:8px}
.ia-lane.has .ia-chips{background:rgba(255,255,255,.07)}
.ia-lane-empty{font-size:12px;color:#6E79A3;padding:14px 6px;text-align:center}
.ia-chip{position:relative;min-width:0;display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:#fff;color:var(--ink)!important;border:0;border-radius:12px;padding:9px 10px;
  box-shadow:0 1px 0 rgba(0,0,0,.08),0 6px 16px -8px rgba(0,0,0,.5);animation:ia-drop .6s cubic-bezier(.22,1,.36,1) both;transition:transform .15s}
.ia-chip:hover{transform:translateY(-1px)}
.ia-chiptxt{flex:1;min-width:0}.ia-chiptxt strong,.ia-chiptxt small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ia-chiptxt strong{font-size:13.5px}.ia-chiptxt small{color:var(--faint);font-size:11.5px}
.ia-flag{position:absolute;top:-3px;right:-3px;width:11px;height:11px;border-radius:50%;border:2px solid #fff}.ia-flag.t-bad{background:var(--bad)}.ia-flag.t-warn{background:var(--warn)}
@keyframes ia-drop{from{opacity:0;transform:translateY(-14px) scale(.96)}}

.ia-tile{flex:none;width:34px;height:34px;border-radius:10px;display:grid;place-items:center;color:#fff;font:700 13px var(--display);letter-spacing:.02em}
.ia-tile.sm{width:28px;height:28px;border-radius:8px;font-size:11px}.ia-tile.lg{width:48px;height:48px;border-radius:14px;font-size:17px}
.ia-ticks{display:flex;gap:3px}.ia-ticks i{width:7px;height:7px;border-radius:2px;background:#DDE1EB}.ia-ticks i.on{background:var(--ok)}
.ia-ticks.lg i{width:22px;height:6px;border-radius:3px}.ia-ticks.lg{margin-bottom:5px}

/* split */
.ia-split{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:22px}
.ia-panel{background:var(--card);border:1px solid var(--line);border-radius:var(--r-lg);padding:20px 22px}
.ia-panel-h{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap}.ia-panel-h h2{font-size:18px;font-weight:700}
.ia-key{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);margin:0}
.ia-key i{width:10px;height:10px;border-radius:3px;display:inline-block;margin-left:10px}.ia-key i:first-child{margin-left:0}
.k-msg{background:var(--navy)}.k-sign{background:var(--yellow);border-radius:50%!important}.k-in{background:var(--navy)}.k-out{background:#A9B3D6}
.ia-chart svg{width:100%;height:auto;display:block}
.ia-chart .grid{stroke:var(--line);stroke-dasharray:3 4}.ia-chart .ax{font:11px var(--ui);fill:var(--faint)}
.ia-chart .bar{fill:var(--navy)}.ia-chart .bar.hi{fill:var(--navy2)}
.ia-chart .sign{fill:var(--yellow);stroke:var(--navy);stroke-width:1.5}
.ia-tip{font-size:12.5px;color:var(--muted);min-height:20px;margin-top:4px}
.ia-textbtn{background:none;border:0;padding:0;color:var(--info)!important;font-weight:600}.ia-textbtn:hover{text-decoration:underline}
.ia-feed{list-style:none;margin:0 -10px;padding:0}
.ia-feeditem{display:flex;gap:12px;align-items:flex-start;width:100%;text-align:left;background:none;border:0;border-radius:12px;padding:10px}
.ia-feeditem:hover:not(:disabled){background:var(--paper)}
.ia-feeddot{flex:none;width:9px;height:9px;border-radius:50%;margin-top:6px}
.t-bad .ia-feeddot{background:var(--bad)}.t-warn .ia-feeddot{background:var(--warn)}.t-info .ia-feeddot{background:var(--info)}
.ia-feedtxt{flex:1;min-width:0}.ia-feedtxt strong{display:block;font-weight:600}.ia-feedtxt span{display:block;color:var(--muted);font-size:13px;line-height:1.4;word-break:break-word}
.ia-feeditem time{font-size:12px;color:var(--faint);white-space:nowrap;padding-top:2px}
.ia-empty{color:var(--muted);text-align:center;padding:26px 10px;margin:0}.ia-empty.left{text-align:left;padding:4px 0}

/* pages */
.ia-pagehead{margin-bottom:20px}.ia-pagehead h1{font-size:34px;font-weight:700;letter-spacing:-.02em}.ia-pagehead p{margin:4px 0 0;color:var(--muted)}
.ia-tools{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.ia-search{display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:0 12px;color:var(--faint);min-width:min(320px,100%)}
.ia-search input{border:0;outline:0;background:none;font:inherit;color:var(--ink);padding:10px 0;flex:1;min-width:0}
.ia-search:focus-within{border-color:var(--navy)}
.ia-seg{display:inline-flex;background:#E4E7EF;border-radius:12px;padding:3px;gap:2px;flex-wrap:wrap}
.ia-seg button{border:0;background:none;padding:7px 12px;border-radius:9px;color:var(--muted)!important;font-weight:500;display:flex;gap:6px;align-items:center}
.ia-seg button.on{background:var(--card);color:var(--ink)!important;box-shadow:0 1px 2px rgba(20,27,52,.12)}
.ia-seg button em{font-style:normal;font-size:11.5px;color:var(--faint)}
.ia-seg.full{display:flex}.ia-seg.full button{flex:1;justify-content:center}
.ia-seg button.on.s-suspended{color:var(--bad)!important}.ia-seg button.on.s-trial{color:var(--warn)!important}.ia-seg button.on.s-active{color:var(--ok)!important}
.ia-tablecard{background:var(--card);border:1px solid var(--line);border-radius:var(--r-lg);overflow-x:auto}
.ia-table{width:100%;border-collapse:collapse;min-width:900px}
.ia-table th{text-align:left;font-size:12.5px;font-weight:500;color:var(--muted);padding:12px 16px;border-bottom:1px solid var(--line);white-space:nowrap}
.ia-table td{white-space:normal;padding:14px 16px;border-bottom:1px solid var(--line);vertical-align:middle}.ia-table tr:last-child td{border-bottom:0}
.ia-table tbody tr{cursor:pointer}.ia-table tbody tr:hover{background:#F7F8FB}
.ia-table td:first-child{min-width:280px}.ia-table .r{text-align:right}.ia-table small{display:block;font-size:12px}.num{font-variant-numeric:tabular-nums}.nowrap{white-space:nowrap}
.ia-bizcell{display:flex;gap:12px;align-items:center}.ia-bizcell strong{display:flex;align-items:center;gap:8px;font-size:14.5px}
.ia-health{display:flex;align-items:baseline;gap:6px;font-size:12.5px;color:var(--muted);margin-top:1px}
.ia-health i{width:8px;height:8px;border-radius:50%;flex:none;background:var(--faint);transform:translateY(-1px)}
.ia-health.t-ok i{background:var(--ok)}.ia-health.t-warn i{background:var(--warn)}.ia-health.t-bad i{background:var(--bad)}.ia-health.t-idle i{background:transparent;border:1.5px solid var(--faint)}
.ia-health.t-bad{color:var(--bad)}
.ia-badge{display:inline-block;font:600 11px var(--ui);padding:2px 8px;border-radius:20px;background:#EDEFF5;color:var(--muted);text-transform:capitalize}
.ia-badge.s-trial{background:#FDF1DD;color:var(--warn)}.ia-badge.s-suspended{background:#FBEAE8;color:var(--bad)}
.ia-sparkcell{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--faint)}
.ia-spark{width:84px;height:24px}.ia-spark rect{fill:#DDE1EB}.ia-spark rect.on{fill:var(--navy)}
.ia-errlist{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.ia-err-h{display:flex;gap:14px;align-items:baseline;flex-wrap:wrap}.ia-err-h strong{font-size:15px}.ia-err-h time{margin-left:auto;color:var(--faint);font-size:12.5px}
.ia-errlist pre{white-space:pre-wrap;word-break:break-word;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--paper);border-radius:10px;padding:10px 12px;margin:10px 0 8px;color:#3A4160}
.ia-src{font-size:11.5px;color:var(--faint)}
.ia-timeline{list-style:none;margin:0;padding:0;background:var(--card);border:1px solid var(--line);border-radius:var(--r-lg)}
.ia-timeline li{display:grid;grid-template-columns:110px 1fr;gap:14px;padding:14px 20px;border-bottom:1px solid var(--line)}.ia-timeline li:last-child{border:0}
.ia-timeline time{color:var(--faint);font-size:12.5px;padding-top:1px}.ia-timeline span{display:block;color:var(--muted);font-size:13px}
.ia-timeline.compact{border:0;background:none}.ia-timeline.compact li{padding:8px 0;grid-template-columns:90px 1fr}
.ia-skel{height:120px;border-radius:var(--r-lg);background:linear-gradient(90deg,#E7E9F0 25%,#F1F2F6 50%,#E7E9F0 75%);background-size:200% 100%;animation:ia-sh 1.3s linear infinite;margin-bottom:12px}
@keyframes ia-sh{to{background-position:-200% 0}}

/* drawer */
.ia-scrim{position:fixed;inset:0;background:rgba(14,20,45,.42);display:flex;justify-content:flex-end;z-index:60;animation:ia-fade .2s ease}
.ia-drawer{width:min(620px,100%);height:100%;background:var(--paper);overflow-y:auto;animation:ia-in .38s cubic-bezier(.22,1,.36,1);box-shadow:-30px 0 60px -20px rgba(14,20,45,.45)}
.ia-dh{display:flex;gap:14px;align-items:center;padding:22px 24px 16px;background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:2}
.ia-dh-t{flex:1;min-width:0}.ia-dh-t h2{font-size:24px;font-weight:700}.ia-dh-t p{margin:2px 0 0;color:var(--muted);font-size:13px}
.ia-x{background:var(--paper);border:0;border-radius:10px;width:36px;height:36px;display:grid;place-items:center;color:var(--muted)!important}.ia-x:hover{color:var(--ink)!important}
.ia-banner{display:flex;align-items:center;gap:10px;padding:10px 24px;font-weight:600;font-size:13.5px}
.ia-banner i{width:9px;height:9px;border-radius:50%;background:currentColor;flex:none}
.ia-banner.t-ok{background:#E3F4EB;color:var(--ok)}.ia-banner.t-warn{background:#FDF1DD;color:var(--warn)}.ia-banner.t-bad{background:#FBEAE8;color:var(--bad)}.ia-banner.t-idle{background:#EDEFF5;color:var(--muted)}
.ia-dbody{padding:18px 24px 40px;display:grid;gap:14px}
.ia-dsec{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px}
.ia-dsec h3{font-size:15px;font-weight:700;margin-bottom:12px}
.ia-check{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:8px}
.ia-check li{display:flex;gap:10px;align-items:flex-start;padding:10px;border-radius:12px;background:var(--paper)}
.ia-check li>span{flex:none;width:22px;height:22px;border-radius:50%;border:2px solid #C9CEDC;display:grid;place-items:center;font-size:12px;font-weight:700;color:#fff}
.ia-check li.on>span{background:var(--ok);border-color:var(--ok)}
.ia-check strong{display:block;font-size:13px}.ia-check small{color:var(--faint);font-size:11.5px;line-height:1.3;display:block}
.ia-check li:not(.on) strong{color:var(--muted)}
.ia-form{display:grid;grid-template-columns:1.4fr 1fr;gap:12px}.ia-form .wide{grid-column:1/-1}
.ia-field{display:grid;gap:6px}.ia-field>span{font-size:12.5px;color:var(--muted);font-weight:500}
.ia-field input,.ia-field textarea{font:inherit;color:var(--ink);background:var(--paper);border:1px solid transparent;border-radius:10px;padding:9px 12px;resize:vertical;width:100%}
.ia-field input:focus,.ia-field textarea:focus{outline:0;border-color:var(--navy);background:#fff}
.ia-confirm{margin:12px 0 0;background:#FBEAE8;color:var(--bad);border-radius:10px;padding:9px 12px;font-weight:500;font-size:13px}
.ia-actions{display:flex;gap:10px;align-items:center;margin:14px 0 8px;flex-wrap:wrap}
.ia-btn{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:9px 16px;font-weight:600}.ia-btn:hover:not(:disabled){border-color:var(--navy)}
.ia-btn.primary{background:var(--navy);color:#fff!important;border-color:var(--navy)}.ia-btn.primary:hover:not(:disabled){background:var(--navy2)}
.ia-btn:disabled{opacity:.4}
.ia-dbars{display:flex;align-items:flex-end;gap:5px;height:110px}
.ia-dbars>div{flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px}
.ia-dbars .col{width:100%;max-width:26px;display:flex;flex-direction:column;border-radius:5px 5px 2px 2px;overflow:hidden;min-height:3px;background:#E4E7EF}
.ia-dbars .n{background:var(--navy)}.ia-dbars .o{background:#A9B3D6}.ia-dbars small{font-size:10.5px;color:var(--faint)}
.ia-conns,.ia-people,.ia-runs{list-style:none;margin:0;padding:0}
.ia-conns li{display:flex;gap:12px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)}.ia-conns li:last-child{border:0}
.ia-conns li>div{flex:1;min-width:0}.ia-conns strong{display:block}.ia-conns small{display:block;color:var(--muted);font-size:12.5px}.ia-conns .ia-faint{font-size:12.5px}
.ia-counts{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin:0}
.ia-counts div{background:var(--paper);border-radius:10px;padding:10px}.ia-counts dd{margin:0;font:700 19px var(--display);font-variant-numeric:tabular-nums}
.ia-counts dt{font-size:11.5px;color:var(--muted);line-height:1.25}.ia-counts .zero dd{color:#B6BBCB}
.ia-kito{margin:0 0 8px;color:var(--muted)}.ia-kito strong{color:var(--ink)}
.ia-runs li{display:flex;gap:12px;font-size:13px;padding:6px 0;border-top:1px solid var(--line)}.ia-runs time{width:90px;color:var(--faint)}.ia-runs span{flex:1}.ia-runs small{color:var(--faint)}
.ia-people li{display:flex;gap:10px;align-items:center;padding:6px 0}.ia-people li .ia-trunc{flex:1}
.ia-id{margin:4px 2px 0;word-break:break-all}
.ia-warn{color:var(--warn)}
.ia-dbars .s{background:var(--yellow)}.k-itaos{background:var(--yellow)}
.ia-mini{list-style:none;margin:12px 0 0;padding:0;display:grid;gap:2px}
.ia-mini li{display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:6px 10px;border-radius:8px;background:var(--paper)}
.ia-mini li span{color:var(--muted);display:flex;gap:8px;align-items:center}.ia-mini li b{font-weight:600;font-variant-numeric:tabular-nums;text-align:right}
.ia-row{display:flex;gap:14px;align-items:center;justify-content:space-between;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
.ia-row strong{display:block;font-size:13.5px}.ia-row small{display:block;font-size:12.5px}
.ia-danger{border-color:#F1C9C4}.ia-danger h3{color:var(--bad)}
.ia-btn.danger{background:var(--bad);border-color:var(--bad);color:#fff!important}.ia-btn.danger:hover:not(:disabled){background:#A92B22}
.ia-actions.wide{grid-column:1/-1;margin:0}
.ia-staffrow{display:flex;gap:12px;align-items:center;justify-content:space-between}.ia-staffrow strong{display:flex;gap:8px;align-items:center}
.ia-addstaff{margin-top:16px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px 12px;align-items:end}.ia-addstaff p,.ia-addstaff [role=status]{grid-column:1/-1;margin:0}
@keyframes ia-fade{from{opacity:0}}@keyframes ia-in{from{transform:translateX(48px);opacity:0}}

@media (max-width:1180px){.ia-strip{grid-template-columns:repeat(3,1fr)}.ia-stat:nth-child(4){border-left:0}.ia-stat:nth-child(n+4){border-top:1px solid var(--line)}
  .ia-lanes{grid-template-columns:repeat(5,minmax(170px,1fr));overflow-x:auto;padding-bottom:6px}.ia-split{grid-template-columns:1fr}}
@media (max-width:820px){.ia{grid-template-columns:minmax(0,1fr);grid-template-rows:auto 1fr;align-content:start}
  .ia-side{position:sticky;top:0;z-index:20;height:auto;align-self:start;flex-direction:row;align-items:center;flex-wrap:wrap;gap:10px 8px;padding:10px 12px 8px}
  .ia-brand{padding:0;flex:1}.ia-mark{font-size:16px;padding:7px 7px 8px;border-radius:8px}
  .ia-side-foot{order:2;margin:0;padding:0;display:flex;align-items:center;gap:12px}.ia-back{font-size:12.5px}.ia-side-foot span{display:none}.ia-refresh{margin:0;padding:6px 12px;font-size:13px}
  .ia-nav{order:3;width:100%;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px}
  .ia-navbtn{flex-direction:column;gap:3px;padding:7px 2px;font-size:12px;text-align:center;position:relative}
  .ia-navbtn span{flex:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
  .ia-navbtn em{position:absolute;top:3px;left:calc(50% + 6px);font-size:10px;padding:0 5px;line-height:16px}
  .ia-main{padding-top:22px}
  .ia-strip{grid-template-columns:repeat(2,1fr)}.ia-stat{border-left:0!important;border-top:1px solid var(--line)}.ia-stat:nth-child(-n+2){border-top:0}
  .ia-lanes{grid-template-columns:repeat(5,minmax(230px,1fr))}.ia-board{padding:20px 16px}
  .ia-check,.ia-form{grid-template-columns:1fr}.ia-counts{grid-template-columns:repeat(2,1fr)}.ia-lanes::before{display:none}}
@media (prefers-reduced-motion:reduce){.ia *{animation:none!important;transition:none!important}}
`;

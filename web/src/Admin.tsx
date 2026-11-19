// itaOS — Pondi platform admin (/admin)
// Reads only the admin_* RPCs (migrations 0012_platform_admin, 0013_admin_activity, 0023_admin_refresh).
// 0031_admin_insights adds Performance, AI usage, Data quality, onboarding days and staff follow-ups (AdminInsights.tsx).
// Fields added in 0023 are optional here, so the page still works against an older database.
// Every RPC re-checks platform_admins server-side; hiding this page is UX, not security.
import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PerformancePage, UsagePage, QualityPage, INSIGHTS_CSS } from './AdminInsights';
import { usageAlerts, type OnboardingRow, type ApiUsage } from './adminInsights';
import { Overview, WsRow, Activity, ErrRow, Staff, View, ago, hoursSince, useRpc, ICON } from "./adminParts";
import { CSS } from "./adminStyles";
import { Today, Businesses, Errors, Audit, StaffPage } from "./AdminPages";
import { Drawer } from "./AdminDrawer";
export { healthOf } from "./adminParts";
/* ================= types ================= */
const VIEWS: View[] = ['today', 'workspaces', 'performance', 'usage', 'quality', 'errors', 'audit', 'staff'];

/* ================= helpers ================= */
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
  // 0031: optional. Older databases just don't show days-on-step, follow-ups or cost alerts.
  const onb = useRpc<OnboardingRow[]>(supabase, 'admin_onboarding', undefined, [tick, isAdmin]);
  const usage = useRpc<ApiUsage>(supabase, 'admin_api_usage', { p_days: 30 }, [tick, isAdmin]);

  if (isAdmin === null) return <Frame><p className="ia-blank">Checking your access…</p></Frame>;
  if (!isAdmin) return (
    <Frame><div className="ia-blank"><h2>This page is for Pondi admins</h2>
      <p>This account doesn't have staff access. Sign out and sign in with your Pondi staff account.</p>
      {onSignOut && <button className="ia-btn primary" onClick={onSignOut}>Sign out</button>}</div></Frame>
  );

  const rows = ws.data ?? [];
  const errors = errs.data ?? [];
  const recentErrors = errors.filter((e) => hoursSince(e.at) < 24 * 7).length;
  const onbBy: Record<string, OnboardingRow> = Object.fromEntries((onb.data ?? []).map((o) => [o.workspace_id, o]));
  const costAlerts = usage.data ? usageAlerts(usage.data) : [];
  const loading = ov.loading || ws.loading;
  const loadError = ov.error || ws.error || act.error;

  return (
    <Frame>
      <aside className="ia-side">
        <div className="ia-brand"><span className="ia-mark">ita.</span><span>Admin</span></div>
        <nav className="ia-nav" aria-label="Admin sections">
          <NavBtn on={view === 'today'} onClick={() => setView('today')} icon={ICON.today}>Today</NavBtn>
          <NavBtn on={view === 'workspaces'} onClick={() => setView('workspaces')} icon={ICON.ws} count={rows.length}>Businesses</NavBtn>
          <NavBtn on={view === 'performance'} onClick={() => setView('performance')} icon={ICON.perf}>Performance</NavBtn>
          <NavBtn on={view === 'usage'} onClick={() => setView('usage')} icon={ICON.usage} count={costAlerts.filter((a) => a.tone !== 'info').length} hot>AI usage</NavBtn>
          <NavBtn on={view === 'quality'} onClick={() => setView('quality')} icon={ICON.quality}>Data quality</NavBtn>
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
        {view === 'today' && <Today ov={ov.data} rows={rows} act={act.data} errors={errors} onOpen={setOpenWs} goErrors={() => setView('errors')}
                                    onb={onbBy} costAlerts={costAlerts} goUsage={() => setView('usage')} />}
        {view === 'workspaces' && <Businesses rows={rows} act={act.data} loading={ws.loading} onOpen={setOpenWs} />}
        {view === 'performance' && <PerformancePage supabase={supabase} tick={tick} onOpen={setOpenWs} />}
        {view === 'usage' && <UsagePage supabase={supabase} tick={tick} />}
        {view === 'quality' && <QualityPage supabase={supabase} tick={tick} onOpen={setOpenWs} />}
        {view === 'errors' && <Errors rows={errors} loading={errs.loading} onOpen={setOpenWs} />}
        {view === 'audit' && <Audit supabase={supabase} tick={tick} />}
        {view === 'staff' && <StaffPage supabase={supabase} />}
      </main>

      {openWs && <Drawer supabase={supabase} id={openWs} row={rows.find((r) => r.id === openWs)} onb={onbBy[openWs]} onClose={() => setOpenWs(null)} onChanged={refresh}
                         onDeleted={() => { setOpenWs(null); refresh(); }} />}
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="ia"><style>{CSS + INSIGHTS_CSS}</style>{children}</div>;
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

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib";
import { hidePreloader } from "./preloader";
import Admin from "./Admin";

/** Pondi platform admin at "/app/admin". Access is enforced in the database (platform_admins + admin_* RPCs). */
export default function AdminPage() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    document.title = "ItaOS Admin";
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => { if (session !== undefined) hidePreloader(); }, [session]);

  if (session === undefined) return <div className="center muted">Loading…</div>;
  if (!session) {
    // Sign in through the normal app, which sends people back here afterwards.
    try { sessionStorage.setItem("itaos-after-login", "/app/admin"); } catch { /* storage unavailable */ }
    location.replace("/app");
    return null;
  }
  return <Admin supabase={supabase} backHref="/app" />;
}

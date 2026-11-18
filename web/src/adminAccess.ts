import { useEffect, useState } from "react";
import { supabase } from "./lib";

/** True when the signed-in user is a Pondi platform admin. Only hides or shows the Admin link; the database enforces access. */
export function useIsPlatformAdmin(userId: string | null): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let live = true;
    if (!userId) { setOk(false); return; }
    supabase.rpc("is_platform_admin").then(({ data, error }) => { if (live) setOk(!error && data === true); });
    return () => { live = false; };
  }, [userId]);
  return ok;
}

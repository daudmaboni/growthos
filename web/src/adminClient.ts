import { createClient } from "@supabase/supabase-js";

/**
 * Supabase client for Pondi staff at /app/admin. It keeps its own sign-in (separate storage key),
 * so a staff session never replaces a business owner's session in the same browser.
 * Access is still enforced in the database: every admin_* function checks platform_admins.
 */
export const staffSupabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
  auth: { storageKey: "itaos-staff-auth", detectSessionInUrl: false },
});

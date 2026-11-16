// Imports owner-confirmed sales against conversations already in this workspace.
// The conversation UUID is workspace-scoped; customer phone numbers are not needed.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });
const admin = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const userClient = (req: Request) => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
  auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
});

type SaleInput = { conversation_id: string; amount: number; currency?: string; occurred_at?: string | null };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const body = await req.json().catch(() => ({}));
  const ws = String(body.workspace_id ?? "");
  if (!ws || !Array.isArray(body.sales) || body.sales.length === 0) return json({ error: "workspace_id and sales are required" }, 400);
  if (body.sales.length > 500) return json({ error: "Import at most 500 rows at a time" }, 400);
  const auth = userClient(req);
  const [{ data: ok, error: membershipError }, { data: user, error: userError }] = await Promise.all([auth.rpc("is_member", { ws }), auth.auth.getUser()]);
  if (membershipError || userError) return json({ error: "could not verify workspace access" }, 500);
  if (!ok || !user.user) return json({ error: "not a member of this workspace" }, 403);

  const db = admin();
  const { data: workspace, error: workspaceError } = await db.from("workspaces").select("currency").eq("id", ws).single();
  if (workspaceError || !workspace) return json({ error: "workspace unavailable" }, 404);
  const inputs = body.sales as SaleInput[];
  const ids = [...new Set(inputs.map((r) => String(r.conversation_id ?? "")))];
  if (ids.length !== inputs.length) return json({ error: "Duplicate conversation IDs are not allowed in one import" }, 400);
  if (inputs.some((r) => !/^[0-9a-f-]{36}$/i.test(r.conversation_id) || !Number.isFinite(Number(r.amount)) || Number(r.amount) <= 0)) {
    return json({ error: "Each row needs a valid conversation ID and an amount greater than zero" }, 400);
  }
  if (inputs.some((r) => r.currency && r.currency.toUpperCase() !== workspace.currency.toUpperCase())) {
    return json({ error: `All rows must use the workspace sales currency (${workspace.currency})` }, 400);
  }
  if (inputs.some((r) => !r.occurred_at || !Number.isFinite(Date.parse(r.occurred_at)))) return json({ error: "Each sale needs a valid occurred_at date" }, 400);

  const { data: conversations, error: lookupError } = await db.from("conversations").select("id").eq("workspace_id", ws).in("id", ids);
  if (lookupError) return json({ error: "could not validate conversation IDs" }, 500);
  const validIds = new Set((conversations ?? []).map((r) => r.id));
  const unknown = ids.filter((id) => !validIds.has(id));
  if (unknown.length) return json({ error: `${unknown.length} conversation ID(s) do not belong to this workspace. No rows were imported.` }, 400);

  const rows = inputs.map((r) => ({
    workspace_id: ws, conversation_id: r.conversation_id, amount: Number(r.amount),
    currency: workspace.currency, occurred_at: new Date(r.occurred_at!).toISOString(),
    provenance: "import", confirmed_by: user.user!.id,
  }));
  const { error } = await db.from("sales").upsert(rows, { onConflict: "conversation_id" });
  if (error) return json({ error: "sales import could not be saved" }, 500);
  return json({ imported: rows.length, currency: workspace.currency });
});

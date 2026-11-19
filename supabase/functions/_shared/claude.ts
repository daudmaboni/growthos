// One door to the Anthropic API for every Edge Function, so each call is logged in public.api_usage
// (workspace, feature, model, tokens incl. cache, outcome, retries, duration). Usage numbers only:
// the prompt, the reply and the API key are never stored. Logging never breaks or slows the call's
// result: a failed log write is printed and ignored.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

import { usageRow, type UsageMeta } from "./usage.ts";
export type { Feature, UsageMeta } from "./usage.ts";

let svc: ReturnType<typeof createClient> | null = null;
const db = () => (svc ??= createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } }));

/**
 * POST /v1/messages. `payload` is the full request body (must include `model`); `stringify` lets a caller
 * keep its own JSON handling. Returns { ok, status, body } and never throws for HTTP errors; a network
 * failure rethrows after it is logged.
 */
export async function claude(key: string, payload: Record<string, unknown>, meta: UsageMeta,
  stringify: (p: unknown) => string = JSON.stringify): Promise<{ ok: boolean; status: number; body: any }> {
  const started = Date.now();
  const model = String(payload.model ?? "unknown");
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: stringify(payload),
    });
  } catch (e) {
    await log(usageRow(meta, model, null, false, null, Date.now() - started, null));
    throw e;
  }
  const body = await res.json().catch(() => ({}));
  await log(usageRow(meta, model, res.status, res.ok, body, Date.now() - started, res.headers.get("request-id")));
  return { ok: res.ok, status: res.status, body };
}

async function log(row: Record<string, unknown>) {
  try {
    const { error } = await db().from("api_usage").insert(row);
    if (error) console.error("api_usage log failed", error.message);
  } catch (e) {
    console.error("api_usage log failed", (e as Error).message);
  }
}

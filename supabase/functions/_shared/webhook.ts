// Pure helpers for webhook durability. No Deno-only imports so the same code is unit-tested in web/.

async function sha256Hex(s: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Every provider item id carried by one webhook change, in a stable order. */
export function itemIds(change: any): string[] {
  const v = change?.value ?? {};
  const ids: string[] = [];
  for (const m of v.messages ?? []) if (m?.id) ids.push(String(m.id));
  for (const m of v.message_echoes ?? []) if (m?.id) ids.push(String(m.id));
  for (const s of v.statuses ?? []) if (s?.id) ids.push(String(s.id));
  for (const h of v.history ?? []) for (const th of h?.threads ?? []) for (const m of th?.messages ?? []) if (m?.id) ids.push(String(m.id));
  for (const s of v.state_sync ?? []) if (s?.contact?.phone_number) ids.push("c:" + String(s.contact.phone_number).replace(/\D/g, ""));
  return [...new Set(ids)].sort();
}

/**
 * Identity of one webhook change. Two deliveries of the same change (provider retries) get the
 * same key; two different changes that happen to share a first message do not, because the key
 * covers every contained item id and the full payload.
 */
export async function eventKey(entryId: string | undefined, change: any): Promise<string> {
  const ids = itemIds(change);
  const payloadHash = await sha256Hex(JSON.stringify(change ?? null));
  return "v2:" + (await sha256Hex([entryId ?? "", change?.field ?? "", ids.join(","), payloadHash].join("|")));
}

/** Error text that is safe to store and show: no message bodies, no phone-like numbers. */
export function safeError(e: unknown, fallback = "webhook processing failed"): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : fallback;
  return (raw || fallback)
    .replace(/\+?\d[\d\s-]{6,}\d/g, "[number]")
    .replace(/\S+@\S+\.\S+/g, "[email]")
    .slice(0, 300);
}

/** Transient failures are retried automatically; anything else waits for a manual replay. */
export function isRetryable(message: string): boolean {
  return /(timeout|timed out|temporar|unavailable|connection|network|too many|rate limit|deadlock|could not (resolve|load|save|persist|claim|mark))/i.test(message);
}

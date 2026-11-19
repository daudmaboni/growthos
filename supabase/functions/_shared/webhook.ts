// Pure helpers for webhook durability. No Deno-only imports so the same code is unit-tested in web/.

export async function sha256Hex(s: string): Promise<string> {
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

// Customer identity. Some WhatsApp users hide their phone number (usernames): Meta then sends only a
// business-scoped user id such as "KE.1858311005179769" in `user_id` / `from_user_id` / `to_user_id`
// and leaves out `wa_id` / `from` / `to`. Fall back to that id so the chat is still saved.

/** The customer a history thread belongs to: phone number when shared, else the user id. */
export function threadPeer(th: any): string | null {
  const v = th?.id ?? th?.context?.wa_id ?? th?.context?.user_id;
  return v ? String(v) : null;
}

/** Who sent a message: phone number when shared, else the user id. */
export function senderId(m: any): string | null {
  const v = m?.from ?? m?.from_user_id;
  return v ? String(v) : null;
}

/** Who a business message (echo) went to: phone number when shared, else the user id. */
export function recipientId(m: any): string | null {
  const v = m?.to ?? m?.to_user_id;
  return v ? String(v) : null;
}

/** Customer key for a `contacts[]` entry of a messages webhook. */
export function contactKey(c: any): string | null {
  const v = c?.wa_id ?? c?.user_id;
  return v ? String(v) : null;
}

/** Direction of a backfilled message: "in" when the customer of the thread sent it. */
export function historyDirection(m: any, th: any): "in" | "out" {
  if (m?.history_context?.from_me === true) return "out";
  const s = senderId(m);
  const customer = [th?.id, th?.context?.wa_id, th?.context?.user_id].filter(Boolean).map(String);
  return s && customer.includes(s) ? "in" : "out";
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

export type NumberHint = { wabaId?: string | null; phoneNumberId?: string | null; displayPhone?: string | null };
export type Envelope = { entry: { id?: string; changes: { field: string; value: any }[] }[] };

/**
 * Turn any webhook body a WhatsApp provider sends into Meta's Cloud API envelope
 * ({ entry: [{ id, changes: [{ field, value }] }] }), so one handler processes them all.
 *  - Meta / 360dialog Cloud API: already in that shape, returned as is.
 *  - 360dialog event shape: { event: "history", data: { id: WABA, metadata, history } }.
 *  - Flat shape: { contacts, messages, statuses } with no metadata. Only usable when the
 *    connection has exactly one known number (`hint`); otherwise it is dropped.
 */
export function normalizeEnvelope(body: any, hint: NumberHint = {}): Envelope {
  if (!body || typeof body !== "object") return { entry: [] };
  if (Array.isArray(body.entry)) return { entry: body.entry.map((e: any) => ({ id: e?.id, changes: Array.isArray(e?.changes) ? e.changes : [] })) };
  if (Array.isArray(body)) return { entry: body.flatMap((b) => normalizeEnvelope(b, hint).entry) };
  if (typeof body.event === "string" && body.data && typeof body.data === "object") {
    const field = body.event === "message_echoes" ? "smb_message_echoes" : body.event;
    return { entry: [{ id: body.data.id ?? hint.wabaId ?? undefined, changes: [{ field, value: withMetadata(body.data, hint) }] }] };
  }
  if (body.messages || body.statuses || body.contacts) {
    return { entry: [{ id: hint.wabaId ?? undefined, changes: [{ field: "messages", value: withMetadata(body, hint) }] }] };
  }
  return { entry: [] };
}

function withMetadata(value: any, hint: NumberHint) {
  if (value?.metadata?.phone_number_id || !hint.phoneNumberId) return value;
  return { ...value, metadata: { ...(value.metadata ?? {}), phone_number_id: hint.phoneNumberId, display_phone_number: hint.displayPhone ?? undefined } };
}

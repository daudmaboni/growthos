import { describe, it, expect } from "vitest";
import { eventKey, itemIds, safeError, isRetryable, threadPeer, senderId, recipientId, contactKey, historyDirection } from "../../supabase/functions/_shared/webhook";

const change = (ids: string[], extra: any = {}) => ({ field: "messages", value: { metadata: { phone_number_id: "pn" }, messages: ids.map((id) => ({ id, from: "255700000001", type: "text", text: { body: "hi" } })), ...extra } });

describe("webhook event identity", () => {
  it("is stable for a provider retry of the same change", async () => {
    expect(await eventKey("e1", change(["m1", "m2"]))).toBe(await eventKey("e1", change(["m1", "m2"])));
  });
  it("differs when batches share only their first message", async () => {
    expect(await eventKey("e1", change(["m1", "m2"]))).not.toBe(await eventKey("e1", change(["m1", "m3"])));
  });
  it("covers every history item, not only the first", async () => {
    const h = (ids: string[]) => ({ field: "history", value: { metadata: { phone_number_id: "pn" }, history: [{ threads: [{ id: "t", messages: ids.map((id) => ({ id })) }] }] } });
    expect(itemIds(h(["a", "b"]))).toEqual(["a", "b"]);
    expect(await eventKey("e", h(["a", "b"]))).not.toBe(await eventKey("e", h(["a", "c"])));
  });
});

describe("safe errors and retry classification", () => {
  it("strips phone numbers and emails from stored errors", () => {
    const e = safeError(new Error("failed for +255 712 345 678 and a@b.co"));
    expect(e).not.toMatch(/712/);
    expect(e).not.toMatch(/a@b\.co/);
  });
  it("retries transient failures and parks permanent ones", () => {
    expect(isRetryable("could not save message")).toBe(true);
    expect(isRetryable("connection reset by peer")).toBe(true);
    expect(isRetryable("WhatsApp number is not connected to a workspace")).toBe(false);
  });
});

import { normalizeEnvelope } from "../../supabase/functions/_shared/webhook";

describe("provider envelopes (360dialog bridge)", () => {
  const meta = { object: "whatsapp_business_account", entry: [{ id: "waba1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "pn1" }, messages: [{ id: "m1" }] } }] }] };
  it("passes Meta's own shape through unchanged", () => {
    expect(normalizeEnvelope(meta).entry[0]).toEqual(meta.entry[0]);
  });
  it("maps 360dialog's event shape onto a Meta change", () => {
    const e = normalizeEnvelope({ id: "ev1", event: "history", data: { id: "waba1", metadata: { phone_number_id: "pn1" }, history: [] } });
    expect(e.entry[0].id).toBe("waba1");
    expect(e.entry[0].changes[0].field).toBe("history");
    expect(e.entry[0].changes[0].value.metadata.phone_number_id).toBe("pn1");
  });
  it("routes a flat payload only when the number is known", () => {
    const flat = { contacts: [], messages: [{ id: "m1", from: "2557", type: "text" }] };
    expect(normalizeEnvelope(flat).entry[0].changes[0].value.metadata).toBeUndefined();
    const e = normalizeEnvelope(flat, { wabaId: "w", phoneNumberId: "pn9" });
    expect(e.entry[0].changes[0].value.metadata.phone_number_id).toBe("pn9");
  });
  it("ignores bodies it does not understand", () => {
    expect(normalizeEnvelope({ hello: 1 }).entry).toEqual([]);
    expect(normalizeEnvelope(null).entry).toEqual([]);
  });
});

describe("customers with a hidden phone number (user id only)", () => {
  // Shapes seen from Meta: thread has only context.user_id; customer messages carry from_user_id.
  const th = {
    context: { user_id: "KE.1858311005179769" },
    messages: [
      { id: "a", type: "text", from_user_id: "KE.1858311005179769", history_context: { status: "pending" } },
      { id: "b", type: "text", from: "255635855825", history_context: { status: "read", from_me: true } },
    ],
  };
  it("keys the thread by the user id when no phone is shared", () => {
    expect(threadPeer(th)).toBe("KE.1858311005179769");
    expect(threadPeer({ id: "255700000001", context: { user_id: "TZ.1" } })).toBe("255700000001");
    expect(threadPeer({})).toBeNull();
  });
  it("tells customer and business messages apart", () => {
    expect(historyDirection(th.messages[0], th)).toBe("in");
    expect(historyDirection(th.messages[1], th)).toBe("out");
    const phoneThread = { id: "255700000001" };
    expect(historyDirection({ from: "255700000001" }, phoneThread)).toBe("in");
    expect(historyDirection({ from: "255635855825" }, phoneThread)).toBe("out");
  });
  it("reads sender, recipient and contact keys from either field", () => {
    expect(senderId({ from: "255700000001" })).toBe("255700000001");
    expect(senderId({ from_user_id: "KE.9" })).toBe("KE.9");
    expect(senderId({})).toBeNull();
    expect(recipientId({ to_user_id: "KE.9" })).toBe("KE.9");
    expect(contactKey({ user_id: "KE.9" })).toBe("KE.9");
    expect(contactKey({ wa_id: "255700000001", user_id: "TZ.1" })).toBe("255700000001");
  });
});

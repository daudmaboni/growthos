import { describe, it, expect } from "vitest";
import { eventKey, itemIds, safeError, isRetryable } from "../../supabase/functions/_shared/webhook";

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

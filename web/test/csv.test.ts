import { describe, it, expect } from "vitest";
import { validateOrder, validateExpense, validateInquiry, markFileDuplicates, normalizePhone, parseDate, parseAmount } from "../../supabase/functions/_shared/csv";
import { parseCsv, autoMap, applyMap, template } from "../src/csv";

describe("CSV parsing and mapping", () => {
  it("handles quotes, embedded commas, CRLF and semicolon files", () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\r\n')).toEqual([["a", "b"], ["x, y", 'he said "hi"']]);
    expect(parseCsv("date;amount\n2026-11-10;45000\n")).toEqual([["date", "amount"], ["2026-11-10", "45000"]]);
  });
  it("auto-maps common headers", () => {
    const m = autoMap(["Tarehe", "Kiasi", "Jina la mteja", "Simu", "Receipt"], "orders");
    expect(m).toMatchObject({ date: 0, amount: 1, phone: 3, ref: 4 });
    const rows = applyMap([["Tarehe", "Kiasi"], ["2026-11-10", "45,000"]], { date: 0, amount: 1 });
    expect(rows).toEqual([{ date: "2026-11-10", amount: "45,000" }]);
  });
  it("templates round-trip through the parser and validator", () => {
    const g = parseCsv(template("orders", "TZS"));
    const row = applyMap(g, autoMap(g[0], "orders"))[0];
    expect(validateOrder(row as any, 0, "TZS").ok).toBe(true);
  });
});

describe("validation", () => {
  it("parses amounts and day-first dates, rejects impossible ones", () => {
    expect(parseAmount("TSh 45,000/=")).toBe(45000);
    expect(parseDate("16/11/2026")?.toISOString()).toBe("2026-11-15T21:00:00.000Z");
    expect(parseDate("31/02/2026")).toBeNull();
    expect(parseDate("nonsense")).toBeNull();
  });
  it("rejects bad orders with row-level reasons", () => {
    expect(validateOrder({ date: "2026-11-10", amount: "abc" }, 0, "TZS")).toMatchObject({ ok: false, reason: expect.stringContaining("amount") });
    expect(validateOrder({ date: "", amount: "1" }, 1, "TZS")).toMatchObject({ ok: false, reason: expect.stringContaining("date") });
    expect(validateOrder({ date: "2026-11-10", amount: "1", currency: "USD" }, 2, "TZS")).toMatchObject({ ok: false, reason: expect.stringContaining("currency") });
    expect(validateOrder({ date: "2026-11-10", amount: "100", discount: "200" }, 3, "TZS")).toMatchObject({ ok: false });
    expect(validateOrder({ date: "2099-01-01", amount: "1" }, 4, "TZS")).toMatchObject({ ok: false });
    expect(validateOrder({ date: "2026-11-10", amount: "1", status: "maybe" }, 5, "TZS")).toMatchObject({ ok: false });
    expect(validateOrder({ date: "2026-11-10", amount: "1", conversation_id: "not-a-uuid" }, 6, "TZS")).toMatchObject({ ok: false });
  });
  it("validates expenses and inquiries", () => {
    expect(validateExpense({ date: "2026-11-10", amount: "6000", category: "Delivery" }, 0, "TZS")).toMatchObject({ ok: true, row: { category: "delivery" } });
    expect(validateExpense({ date: "2026-11-10", amount: "6000", category: "fun" }, 0, "TZS").ok).toBe(false);
    expect(validateInquiry({ date: "2026-11-10" }, 0).ok).toBe(false);
  });
});

describe("deduplication", () => {
  it("dedupes by reference case-insensitively, else by date+amount+customer+product", () => {
    const rows = [
      validateOrder({ ref: "INV-1", date: "2026-11-10", amount: "1000" }, 0, "TZS"),
      validateOrder({ ref: "inv-1", date: "2026-11-11", amount: "9999" }, 1, "TZS"),
      validateOrder({ date: "2026-11-10", amount: "1000", customer_name: "Asha" }, 2, "TZS"),
      validateOrder({ date: "10/11/2026", amount: "1,000", customer_name: "asha" }, 3, "TZS"),
      validateOrder({ date: "2026-11-10", amount: "1000", customer_name: "Juma" }, 4, "TZS"),
    ];
    const out = markFileDuplicates(rows);
    expect(out.map((r) => r.ok)).toEqual([true, false, true, false, true]);
    expect((out[1] as any).duplicate_of).toBe(0);
  });
  it("normalises Tanzanian phone numbers for in-workspace matching only", () => {
    expect(normalizePhone("0712 345 678")).toBe("255712345678");
    expect(normalizePhone("+255 712-345-678")).toBe("255712345678");
    expect(normalizePhone("712345678")).toBe("255712345678");
    expect(normalizePhone("12")).toBeNull();
  });
});

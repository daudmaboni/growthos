import { describe, it, expect } from "vitest";
import { computeFunnel, periodEnding, comparisonOf, delta } from "../src/metrics";
import { conv, order, WS } from "./fixtures";

const period = periodEnding("2026-11-16", 7, "current"); // 2026-11-10 .. 2026-11-16
const base = { ws: WS, period, ads: [], daily: [], orders: [], expenses: [], now: Date.parse("2026-11-16T12:00:00Z") };

describe("periods", () => {
  it("builds an inclusive window and the previous one of the same length", () => {
    expect(period).toMatchObject({ from: "2026-11-10", to: "2026-11-16", days: 7 });
    expect(comparisonOf(period)).toMatchObject({ from: "2026-11-03", to: "2026-11-09" });
  });
});

describe("cohorts and timezone", () => {
  it("assigns a chat to the local (EAT) day it started", () => {
    // 22:30 UTC on 9 Nov is 01:30 on 10 Nov in Dar es Salaam → inside the period
    const late = conv({ started_at: "2026-11-09T22:30:00Z" });
    const early = conv({ started_at: "2026-11-09T20:00:00Z" }); // 23:00 local on the 9th → outside
    const mx = computeFunnel({ ...base, conversations: [late, early] });
    expect(mx.chats.value).toBe(1);
  });
});

describe("confirmed vs inferred", () => {
  it("never counts a payment signal as a sale or as revenue", () => {
    const c = conv({ payment_signal: true, kito_outcome: "sold", outcome: "sold" });
    const mx = computeFunnel({ ...base, conversations: [c] });
    expect(mx.paymentSignals.value).toBe(1);
    expect(mx.unconfirmedSignals.value).toBe(1);
    expect(mx.attributedSales.value).toBe(0);
    expect(mx.revenue.value).toBe(0);
    expect(mx.paymentSignals.provenance).toBe("inferred");
  });
  it("counts net revenue of paid orders by paid date and ignores cancelled ones", () => {
    const o1 = order({ amount: 50000, discount: 5000 });
    const o2 = order({ amount: 30000, refund_amount: 10000 });
    const o3 = order({ status: "cancelled" });
    const o4 = order({ paid_at: "2026-11-01T09:00:00Z" }); // previous period
    const mx = computeFunnel({ ...base, conversations: [], orders: [o1, o2, o3, o4] });
    expect(mx.revenue.value).toBe(65000);
    expect(mx.ordersPaid.value).toBe(2);
    expect(mx.ordersUnlinked.value).toBe(2);
  });
  it("attributes a sale only inside the conversion window", () => {
    const inside = conv({ paid_orders: 1, sale_amount: 40000, first_paid_at: "2026-11-15T00:00:00Z" });
    const outside = conv({ paid_orders: 1, sale_amount: 40000, first_paid_at: "2026-12-20T00:00:00Z" });
    const mx = computeFunnel({ ...base, conversations: [inside, outside] });
    expect(mx.attributedSales.value).toBe(1);
    expect(mx.attributedRevenue.value).toBe(40000);
  });
});

describe("cost metrics", () => {
  const daily = [{ day: "2026-11-12", spend: 20, currency: "USD", impressions: 1000, clicks: 50, messaging_conversations: 10 }];
  it("returns null instead of dividing by zero", () => {
    const mx = computeFunnel({ ...base, conversations: [], daily });
    expect(mx.costPerAttributedSale.value).toBeNull();
    expect(mx.costPerAdChat.value).toBeNull();
    expect(mx.costPerPlatformConversation.value).toBe(2);
  });
  it("cost per attributed sale uses ad chats only, and ROAS converts with the fx rate", () => {
    const sold = conv({ paid_orders: 1, sale_amount: 104000, first_paid_at: "2026-11-12T00:00:00Z" });
    const organicSold = conv({ source: "organic", ad_id: null, paid_orders: 1, sale_amount: 50000, first_paid_at: "2026-11-12T00:00:00Z" });
    const mx = computeFunnel({ ...base, conversations: [sold, organicSold], daily });
    expect(mx.costPerAttributedSale.value).toBe(20);
    expect(mx.returnOnAdSpend.value).toBeCloseTo(104000 / (20 * 2600));
  });
  it("hides ROAS and contribution when the exchange rate is missing", () => {
    const mx = computeFunnel({ ...base, ws: { ...WS, fx_rate: null }, conversations: [], daily, orders: [order()] });
    expect(mx.returnOnAdSpend.value).toBeNull();
    expect(mx.contribution.value).toBeNull();
    expect(mx.contribution.note).toBe("needs exchange rate");
  });
  it("shows contribution only when cost inputs exist", () => {
    const noCost = computeFunnel({ ...base, conversations: [], daily, orders: [order({ amount: 100000 })] });
    expect(noCost.contribution.value).toBeNull();
    const withCost = computeFunnel({ ...base, ws: { ...WS, unit_cost: 20000 }, conversations: [], daily, orders: [order({ amount: 100000 })] });
    expect(withCost.contribution.value).toBe(100000 - 20 * 2600 - 20000);
  });
  it("uses the cost typed on each order, and waits until every order has one", () => {
    const typed = computeFunnel({ ...base, ws: WS, conversations: [], daily, orders: [order({ amount: 100000, cost: 35000 }), order({ id: "o2", amount: 50000, cost: 15000 })] });
    expect(typed.contribution.value).toBe(150000 - 20 * 2600 - 50000);
    const partial = computeFunnel({ ...base, ws: WS, conversations: [], daily, orders: [order({ amount: 100000, cost: 35000 }), order({ id: "o2", amount: 50000 })] });
    expect(partial.contribution.value).toBeNull();
    expect(partial.contribution.note).toBe("needs order costs");
    expect(partial.coverage.ordersMissingCost).toBe(1);
  });
});

describe("delta", () => {
  it("is null when the comparison value is zero or missing", () => {
    expect(delta({ value: 5, provenance: "observed" }, { value: 0, provenance: "observed" })).toBeNull();
    expect(delta({ value: 6, provenance: "observed" }, { value: 4, provenance: "observed" })).toBe(0.5);
  });
});

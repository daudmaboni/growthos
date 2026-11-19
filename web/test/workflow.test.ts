import { describe, it, expect } from "vitest";
import { applyFilters } from "../src/data";
import { weeklySummary } from "../src/summary";
import { computeFunnel, periodEnding } from "../src/metrics";
import { diagnose } from "../src/diagnosis";
import { conv, order, WS } from "./fixtures";

const data = () => ({
  conversations: [conv({ id: "a", source: "ad", ad_id: "ad1" }), conv({ id: "b", source: "ad", ad_id: "ad2" }), conv({ id: "c", source: "organic", ad_id: null })],
  orders: [order({ id: "o1", ad_id: "ad1", conv_source: "ad", product: "Cleanser" }), order({ id: "o2", ad_id: null, conv_source: "organic", product: "Tea" })],
  daily: [{ ad_id: "ad1", day: "2026-11-10", spend: 10, currency: "USD", impressions: 0, clicks: 0, messaging_conversations: 0 },
          { ad_id: "ad2", day: "2026-11-10", spend: 5, currency: "USD", impressions: 0, clicks: 0, messaging_conversations: 0 }],
  ads: [{ ad_id: "ad1", campaign_name: "Nov" } as any, { ad_id: "ad2", campaign_name: "Oct" } as any], adsPrev: [],
});
const campaigns = { ad1: "Nov", ad2: "Oct" };

describe("report filters", () => {
  it("leave everything as is when no filter is set", () => {
    const d = data();
    expect(applyFilters(d, {}, campaigns)).toBe(d);
  });
  it("narrow chats, orders, ads and spend to one campaign", () => {
    const f = applyFilters(data(), { campaign: "Nov" }, campaigns);
    expect(f.conversations.map((c) => c.id)).toEqual(["a"]);
    expect(f.orders.map((o) => o.id)).toEqual(["o1"]);
    expect(f.daily.map((x) => x.ad_id)).toEqual(["ad1"]);
    expect(f.ads.map((x) => x.ad_id)).toEqual(["ad1"]);
  });
  it("drop ad spend for organic chats and filter orders by product only", () => {
    const org = applyFilters(data(), { source: "organic" }, campaigns);
    expect(org.conversations.map((c) => c.id)).toEqual(["c"]);
    expect(org.daily).toEqual([]);
    const prod = applyFilters(data(), { product: "tea" }, campaigns);
    expect(prod.orders.map((o) => o.id)).toEqual(["o2"]);
    expect(prod.conversations).toHaveLength(3);
  });
});

describe("weekly summary", () => {
  it("states results, the top bottleneck with its next step, and that revenue is confirmed only", () => {
    const period = periodEnding("2026-11-16", 7, "current"), prevP = periodEnding("2026-11-09", 7, "current");
    const convs = [...Array(10)].map(() => conv({ stage: "no_reply", first_response_sec: null, last_dir: "in" })).concat([...Array(5)].map(() => conv()));
    const base = { ws: WS, conversations: convs, ads: [], daily: [], orders: [], expenses: [], now: Date.parse("2026-11-16T12:00:00Z") };
    const mx = computeFunnel({ ...base, period }), prev = computeFunnel({ ...base, period: prevP });
    const text = weeklySummary(mx, prev, diagnose(mx, convs, [], WS.timezone), { lang: "en", business: "Kayani", currency: "TZS" });
    expect(text).toMatch(/Kayani/);
    expect(text).toMatch(/Chats: 15/);
    expect(text).toMatch(/10 chats never got a reply\. Next:/);
    expect(text).toMatch(/recorded paid orders only/);
    expect(weeklySummary(mx, prev, [], { lang: "sw", business: "K", currency: "TZS" })).toMatch(/Hakuna tatizo kubwa/);
  });
});

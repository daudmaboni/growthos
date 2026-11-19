import { describe, it, expect } from "vitest";
import { resolveRange, rangeText } from "../src/ranges";
import { comparisonOf } from "../src/metrics";

const today = "2026-11-18"; // a Wednesday
const r = (key: any) => { const p = resolveRange({ key }, today); return [p.from, p.to, p.days]; };

describe("date ranges match Ads Manager", () => {
  it("Last N days end yesterday", () => {
    expect(r("last_30")).toEqual(["2026-10-19", "2026-11-17", 30]); // as in the Ads Manager screenshot
    expect(r("last_7")).toEqual(["2026-11-11", "2026-11-17", 7]);
    expect(r("last_14")).toEqual(["2026-11-04", "2026-11-17", 14]);
    expect(r("last_28")).toEqual(["2026-10-21", "2026-11-17", 28]);
  });
  it("today, yesterday and both", () => {
    expect(r("today")).toEqual([today, today, 1]);
    expect(r("yesterday")).toEqual(["2026-11-17", "2026-11-17", 1]);
    expect(r("today_yesterday")).toEqual(["2026-11-17", today, 2]);
  });
  it("weeks start on Sunday, months on the 1st", () => {
    expect(r("this_week")).toEqual(["2026-11-15", today, 4]);
    expect(r("last_week")).toEqual(["2026-11-08", "2026-11-14", 7]);
    expect(r("this_month")).toEqual(["2026-11-01", today, 18]);
    expect(r("last_month")).toEqual(["2026-10-01", "2026-10-31", 31]);
    expect(resolveRange({ key: "last_month" }, "2026-03-05")).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
  });
  it("custom ranges are ordered and never go past today", () => {
    expect(resolveRange({ key: "custom", from: "2026-11-30", to: "2026-11-10" }, today)).toMatchObject({ from: "2026-11-10", to: today, days: 9 });
  });
  it("comparison is the same number of days just before", () => {
    expect(comparisonOf(resolveRange({ key: "last_7" }, today))).toMatchObject({ from: "2026-11-04", to: "2026-11-10", days: 7 });
  });
  it("labels", () => {
    expect(rangeText(resolveRange({ key: "last_30" }, today), "en")).toBe("19 Oct – 17 Nov 2026");
    expect(rangeText(resolveRange({ key: "today" }, today), "sw")).toBe("18 Nov 2026");
  });
});

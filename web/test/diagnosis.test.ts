import { describe, it, expect } from "vitest";
import { computeFunnel, periodEnding } from "../src/metrics";
import { diagnose } from "../src/diagnosis";
import { conv, WS } from "./fixtures";

const period = periodEnding("2026-11-16", 7, "current");
const run = (convs: any[]) => {
  const mx = computeFunnel({ ws: WS, period, conversations: convs, ads: [], daily: [], orders: [], expenses: [], now: Date.parse("2026-11-16T12:00:00Z") });
  return diagnose(mx, convs, [], WS.timezone);
};

describe("diagnosis", () => {
  it("ranks unanswered chats first when many got no reply, with evidence links", () => {
    const convs = [...Array(10)].map(() => conv({ stage: "no_reply", first_response_sec: null, last_dir: "in" })).concat([...Array(5)].map(() => conv()));
    const f = run(convs);
    expect(f[0].kind).toBe("unanswered");
    expect(f[0].count).toBe(10);
    expect(f[0].sample).toBe(15);
    expect(f[0].conversationIds).toHaveLength(10);
    expect(f[0].hypothesis.en).not.toEqual(f[0].observed.en);
  });
  it("flags inferred payments that were never confirmed", () => {
    const f = run([conv({ payment_signal: true }), conv()]);
    const u = f.find((x) => x.kind === "unconfirmed_signals");
    expect(u?.count).toBe(1);
  });
  it("labels small samples as low confidence", () => {
    const convs = [...Array(3)].map(() => conv({ stage: "no_reply", first_response_sec: null }));
    expect(run(convs).find((x) => x.kind === "unanswered")?.confidence).toBe("low");
  });
  it("does not invent findings on an empty period", () => {
    expect(run([]).filter((f) => f.kind !== "data_gap")).toHaveLength(0);
  });
});

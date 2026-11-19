// Weekly summary: results, bottlenecks and missing data in a few lines the owner can read or send
// on WhatsApp. Built only from the deterministic metrics and the rule-based diagnosis: no AI.
import type { FunnelMetrics } from "./metrics";
import type { Finding } from "./diagnosis";

const n = (v: number | null | undefined) => (v == null || !isFinite(v) ? "–" : Math.round(v).toLocaleString("en-US"));
const ch = (cur: number | null | undefined, prev: number | null | undefined) => {
  if (cur == null || prev == null || !prev) return "";
  const d = Math.round(((cur - prev) / prev) * 100);
  return d === 0 ? " (=)" : ` (${d > 0 ? "+" : ""}${d}%)`;
};

export function weeklySummary(mx: FunnelMetrics, prev: FunnelMetrics, findings: Finding[], o: { lang: "sw" | "en" | string; business: string; currency: string }): string {
  const sw = o.lang === "sw";
  const T = (en: string, s: string) => (sw ? s : en);
  const v = (m: { value: number | null }) => m.value;
  const lines: string[] = [];
  lines.push(`*${o.business}* · ${T("itaOS weekly summary", "Muhtasari wa wiki wa itaOS")} · ${mx.period.from} → ${mx.period.to}`);
  lines.push("");
  lines.push(T("*Results*", "*Matokeo*"));
  lines.push(`• ${T("Chats", "Chats")}: ${n(v(mx.chats))}${ch(v(mx.chats), v(prev.chats))}${v(mx.adChats) ? ` · ${T("from ads", "kutoka matangazo")} ${n(v(mx.adChats))}` : ""}`);
  lines.push(`• ${T("Replied", "Zilijibiwa")}: ${n(v(mx.replied))}${mx.medianFirstReply.value != null ? ` · ${T("median first reply", "wastani wa jibu la kwanza")} ${Math.max(1, Math.round(mx.medianFirstReply.value / 60))} min` : ""}`);
  lines.push(`• ${T("Confirmed paid orders", "Oda zilizolipwa (zimethibitishwa)")}: ${n(v(mx.ordersPaid))}${ch(v(mx.ordersPaid), v(prev.ordersPaid))} · ${T("revenue", "mapato")} ${o.currency} ${n(v(mx.revenue))}${ch(v(mx.revenue), v(prev.revenue))}`);
  if ((v(mx.attributedAdSales) ?? 0) > 0) lines.push(`• ${T("Sales linked to ads (estimate)", "Mauzo yaliyounganishwa na matangazo (makadirio)")}: ${n(v(mx.attributedAdSales))}`);
  if ((v(mx.unconfirmedSignals) ?? 0) > 0) lines.push(`• ${T("Payments detected, not yet confirmed", "Malipo yamegunduliwa, bado hayajathibitishwa")}: ${n(v(mx.unconfirmedSignals))}`);

  const problems = findings.filter((f) => f.severity === "bad" || f.severity === "warn").slice(0, 3);
  lines.push("");
  lines.push(T("*Where customers get stuck*", "*Wateja wanakwama wapi*"));
  if (!problems.length) lines.push(`• ${T("No major leak found this week.", "Hakuna tatizo kubwa wiki hii.")}`);
  for (const f of problems) lines.push(`• ${sw ? f.title.sw : f.title.en}. ${T("Next:", "Fanya:")} ${sw ? f.action.sw : f.action.en}`);

  const gap = findings.find((f) => f.kind === "data_gap");
  if (gap && gap.missing.length) {
    lines.push("");
    lines.push(T("*Missing data*", "*Data inayokosekana*"));
    for (const m of gap.missing.slice(0, 4)) lines.push(`• ${m}`);
  }
  lines.push("");
  lines.push(T("Revenue counts recorded paid orders only. Ad-linked sales are estimates.", "Mapato yanahesabu oda zilizolipwa na kurekodiwa tu. Mauzo ya matangazo ni makadirio."));
  return lines.join("\n");
}

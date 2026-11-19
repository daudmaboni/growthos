// Date ranges, grouped the way Meta Ads Manager groups them, so a figure here can be compared
// with the same range there. Like Ads Manager, "Last N days" ends yesterday (today is still
// in progress) and weeks start on Sunday. All days are local days in the workspace time zone.
import type { Period } from "./metrics";

export type PresetKey =
  | "today" | "yesterday" | "today_yesterday"
  | "last_7" | "last_14" | "last_28" | "last_30" | "last_90"
  | "this_week" | "last_week" | "this_month" | "last_month";
export type RangeSel = { key: PresetKey } | { key: "custom"; from: string; to: string };

export const PRESETS: { key: PresetKey; en: string; sw: string }[] = [
  { key: "today", en: "Today", sw: "Leo" },
  { key: "yesterday", en: "Yesterday", sw: "Jana" },
  { key: "today_yesterday", en: "Today and yesterday", sw: "Leo na jana" },
  { key: "last_7", en: "Last 7 days", sw: "Siku 7 zilizopita" },
  { key: "last_14", en: "Last 14 days", sw: "Siku 14 zilizopita" },
  { key: "last_28", en: "Last 28 days", sw: "Siku 28 zilizopita" },
  { key: "last_30", en: "Last 30 days", sw: "Siku 30 zilizopita" },
  { key: "this_week", en: "This week", sw: "Wiki hii" },
  { key: "last_week", en: "Last week", sw: "Wiki iliyopita" },
  { key: "this_month", en: "This month", sw: "Mwezi huu" },
  { key: "last_month", en: "Last month", sw: "Mwezi uliopita" },
  { key: "last_90", en: "Last 90 days", sw: "Siku 90 zilizopita" },
];

const D = 864e5;
const toDate = (day: string) => new Date(day + "T00:00:00Z");
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => iso(new Date(toDate(day).getTime() + n * D));
export const daysBetween = (from: string, to: string) => Math.round((toDate(to).getTime() - toDate(from).getTime()) / D) + 1;

function span(from: string, to: string, label: string): Period {
  if (from > to) [from, to] = [to, from];
  return { from, to, days: daysBetween(from, to), label };
}

/** The local-day period a selection covers, given today's local date (YYYY-MM-DD). */
export function resolveRange(sel: RangeSel, today: string): Period {
  const yest = addDays(today, -1);
  const dow = toDate(today).getUTCDay(); // 0 = Sunday
  const weekStart = addDays(today, -dow);
  const [y, m] = today.split("-").map(Number);
  const monthStart = `${y}-${String(m).padStart(2, "0")}-01`;
  switch (sel.key) {
    case "custom": return span(sel.from > today ? today : sel.from, sel.to > today ? today : sel.to, "current");
    case "today": return span(today, today, "current");
    case "yesterday": return span(yest, yest, "current");
    case "today_yesterday": return span(yest, today, "current");
    case "last_7": return span(addDays(today, -7), yest, "current");
    case "last_14": return span(addDays(today, -14), yest, "current");
    case "last_28": return span(addDays(today, -28), yest, "current");
    case "last_30": return span(addDays(today, -30), yest, "current");
    case "last_90": return span(addDays(today, -90), yest, "current");
    case "this_week": return span(weekStart, today, "current");
    case "last_week": return span(addDays(weekStart, -7), addDays(weekStart, -1), "current");
    case "this_month": return span(monthStart, today, "current");
    case "last_month": { const end = addDays(monthStart, -1); return span(end.slice(0, 8) + "01", end, "current"); }
  }
}

export function presetLabel(key: RangeSel["key"], lang: "en" | "sw") {
  if (key === "custom") return lang === "sw" ? "Tarehe maalum" : "Custom";
  const p = PRESETS.find((x) => x.key === key)!;
  return lang === "sw" ? p.sw : p.en;
}

const MONTHS = { en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], sw: ["Jan", "Feb", "Mac", "Apr", "Mei", "Jun", "Jul", "Ago", "Sep", "Okt", "Nov", "Des"] };
export function shortDate(day: string, lang: "en" | "sw", withYear = true) {
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[lang][m - 1]}${withYear ? " " + y : ""}`;
}
/** "19 Oct – 17 Nov 2026", or a single day. */
export function rangeText(p: Period, lang: "en" | "sw") {
  if (p.from === p.to) return shortDate(p.from, lang);
  const sameYear = p.from.slice(0, 4) === p.to.slice(0, 4);
  return `${shortDate(p.from, lang, !sameYear)} – ${shortDate(p.to, lang)}`;
}

// The chosen range is remembered per page, plus a short "Recently used" list shared by all pages.
const isSel = (v: any): v is RangeSel =>
  v && (PRESETS.some((p) => p.key === v.key) || (v.key === "custom" && /^\d{4}-\d{2}-\d{2}$/.test(v.from) && /^\d{4}-\d{2}-\d{2}$/.test(v.to)));
export function loadRange(page: string, fallback: RangeSel): RangeSel {
  try { const v = JSON.parse(localStorage.getItem("itaos-range-" + page) ?? "null"); return isSel(v) ? v : fallback; } catch { return fallback; }
}
export function saveRange(page: string, sel: RangeSel) {
  try {
    localStorage.setItem("itaos-range-" + page, JSON.stringify(sel));
    if (sel.key !== "custom") localStorage.setItem("itaos-range-recent", JSON.stringify([sel.key, ...recentRanges().filter((k) => k !== sel.key)].slice(0, 3)));
  } catch { /* storage unavailable */ }
}
export function recentRanges(): PresetKey[] {
  try { const v = JSON.parse(localStorage.getItem("itaos-range-recent") ?? "[]"); return Array.isArray(v) ? v.filter((k) => PRESETS.some((p) => p.key === k)) : []; } catch { return []; }
}

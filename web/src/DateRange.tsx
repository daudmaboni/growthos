// Date range picker modelled on Meta Ads Manager: presets on the left (recently used first),
// a two-month calendar for a custom range, and Cancel / Update so nothing reloads mid-choice.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PRESETS, RangeSel, resolveRange, presetLabel, rangeText, recentRanges, addDays } from "./ranges";

type Lang = "en" | "sw";
const WD = { en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], sw: ["Jpi", "Jtt", "Jnn", "Jtn", "Alh", "Iju", "Jmo"] };
const MON = { en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"], sw: ["Januari", "Februari", "Machi", "Aprili", "Mei", "Juni", "Julai", "Agosti", "Septemba", "Oktoba", "Novemba", "Desemba"] };

const monthOf = (day: string) => day.slice(0, 7);
const PHONE = "(max-width: 860px)";
const isPhone = () => typeof window !== "undefined" && window.matchMedia(PHONE).matches;

/** Freeze the page behind a sheet (iOS-safe: pins the body and restores the scroll position after). */
function lockScroll() {
  const y = window.scrollY, b = document.body.style;
  const prev = { position: b.position, top: b.top, left: b.left, right: b.right, width: b.width, overflow: b.overflow };
  Object.assign(b, { position: "fixed", top: `-${y}px`, left: "0", right: "0", width: "100%", overflow: "hidden" });
  document.documentElement.classList.add("sheet-open");
  return () => { Object.assign(b, prev); document.documentElement.classList.remove("sheet-open"); window.scrollTo(0, y); };
}

const shiftMonth = (ym: string, n: number) => { const [y, m] = ym.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };

export default function DateRange({ value, onChange, today, tz, lang }: { value: RangeSel; onChange: (s: RangeSel) => void; today: string; tz: string; lang: Lang }) {
  const T = (en: string, sw: string) => (lang === "sw" ? sw : en);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<RangeSel>(value);
  const [anchor, setAnchor] = useState<string | null>(null); // first click of a custom range
  const [hover, setHover] = useState<string | null>(null);
  const period = resolveRange(value, today);
  const dp = resolveRange(draft, today);
  const [right, setRight] = useState(monthOf(dp.to)); // month shown on the right
  const box = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [phone, setPhone] = useState(isPhone);
  const [closing, setClosing] = useState(false);
  const recent = useMemo(() => (open ? recentRanges() : []), [open]);

  const show = () => { setDraft(value); setAnchor(null); setRight(monthOf(resolveRange(value, today).to)); setOpen(true); };
  const close = () => {
    setAnchor(null);
    if (!phone) { setOpen(false); return; }
    setClosing(true); // let the sheet slide down before it unmounts
    window.setTimeout(() => { setOpen(false); setClosing(false); }, 240);
  };

  useEffect(() => { const m = window.matchMedia(PHONE); const on = () => setPhone(m.matches); m.addEventListener("change", on); return () => m.removeEventListener("change", on); }, []);
  // On phones the picker is a sheet: blur and freeze everything behind it.
  useLayoutEffect(() => { if (open && phone) return lockScroll(); }, [open, phone]);

  // Drag the sheet's handle down to dismiss it, like an iOS sheet.
  const onGrip = (e: React.PointerEvent) => {
    const el = pop.current; if (!el) return;
    const y0 = e.clientY, t0 = Date.now(); let dy = 0;
    el.style.transition = "none";
    const move = (ev: PointerEvent) => { dy = Math.max(0, ev.clientY - y0); el.style.transform = `translateY(${dy}px)`; };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up);
      el.style.transition = "";
      if (dy > 90 || (dy > 30 && dy / Math.max(1, Date.now() - t0) > 0.5)) { el.style.transform = ""; close(); }
      else el.style.transform = "";
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
  };
  const apply = () => { if (anchor) setDraft({ key: "custom", from: anchor, to: anchor }); onChange(anchor ? { key: "custom", from: anchor, to: anchor } : draft); close(); };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { const t = e.target as Node; if (box.current?.contains(t) || pop.current?.contains(t)) return; close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", onDown); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const pick = (day: string) => {
    if (!anchor) { setAnchor(day); setDraft({ key: "custom", from: day, to: day }); return; }
    setDraft({ key: "custom", from: anchor < day ? anchor : day, to: anchor < day ? day : anchor }); setAnchor(null);
  };
  // While choosing the second end, preview the range up to the hovered day.
  const lo = anchor ? (hover && hover < anchor ? hover : anchor) : dp.from;
  const hi = anchor ? (hover && hover > anchor ? hover : anchor) : dp.to;

  const radio = (key: RangeSel["key"]) => (
    <label className={"dr-opt" + (draft.key === key && !anchor ? " on" : "")} key={key}>
      <input type="radio" name="dr-preset" checked={draft.key === key && !anchor} onChange={() => { const s = { key } as RangeSel; setDraft(s); setAnchor(null); setRight(monthOf(resolveRange(s, today).to)); }} />
      <span>{presetLabel(key, lang)}</span>
    </label>
  );

  const month = (ym: string) => {
    const [y, m] = ym.split("-").map(Number);
    const first = `${ym}-01`, lead = new Date(first + "T00:00:00Z").getUTCDay();
    const len = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: len }, (_, i) => addDays(first, i))];
    return (
      <div className="dr-month" key={ym}>
        <div className="dr-mh">{MON[lang][m - 1]} {y}</div>
        <div className="dr-grid" role="grid">
          {WD[lang].map((w) => <span className="dr-wd" key={w}>{w}</span>)}
          {cells.map((d, i) => {
            if (!d) return <span key={"e" + i} />;
            const future = d > today, inR = d >= lo && d <= hi, edge = d === lo || d === hi;
            return (
              <button type="button" key={d} disabled={future} onClick={() => pick(d)} onMouseEnter={() => setHover(d)}
                className={"dr-day" + (inR ? " in" : "") + (edge ? " edge" : "") + (d === today ? " today" : "")}
                aria-pressed={inR} aria-label={d}>{Number(d.slice(8))}</button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="dr" ref={box}>
      <button type="button" className="dr-trigger" onClick={() => (open ? close() : show())} aria-expanded={open} aria-haspopup="dialog">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
        <span><b>{presetLabel(value.key, lang)}</b><span className="dr-dates">{": " + rangeText(period, lang)}</span></span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform .2s" }}><path d="M5 9l7 7 7-7z" /></svg>
      </button>
      {open && sheet(
        <div className={"dr-pop" + (phone ? " dr-sheet" : "") + (closing ? " closing" : "")} ref={pop} role="dialog" aria-modal={phone || undefined} aria-label={T("Choose dates", "Chagua tarehe")} data-noswipe>
          {phone && <div className="dr-grip" onPointerDown={onGrip} aria-hidden><span /></div>}
          <div className="dr-list">
            {recent.length > 0 && <><div className="dr-h">{T("Recently used", "Ulizotumia karibuni")}</div>{recent.map(radio)}<hr /></>}
            {PRESETS.map((p) => radio(p.key))}
            {radio("custom")}
          </div>
          <div className="dr-cal">
            <div className="dr-nav">
              <button type="button" className="icon" onClick={() => setRight(shiftMonth(right, -1))} aria-label={T("Previous month", "Mwezi uliopita")}>‹</button>
              <button type="button" className="icon" onClick={() => setRight(shiftMonth(right, 1))} disabled={right >= monthOf(today)} aria-label={T("Next month", "Mwezi ujao")}>›</button>
            </div>
            <div className="dr-months" onMouseLeave={() => setHover(null)}>{month(shiftMonth(right, -1))}{month(right)}</div>
            <div className="dr-picked">
              <span className="chip">{anchor ? T("Now pick the end date", "Sasa chagua tarehe ya mwisho") : rangeText(dp, lang)}</span>
              {!anchor && <span className="small muted">{dp.days} {dp.days === 1 ? T("day", "siku") : T("days", "siku")} · {T("compared with the", "ikilinganishwa na")} {dp.days} {T("before", "kabla")}</span>}
            </div>
          </div>
          {/* outside the scroll area's content so it can stay pinned to the bottom of the phone sheet */}
          <div className="dr-foot">
            <span className="small muted">{T("Dates are shown in", "Tarehe ziko kwa saa za")} {tz.replace(/_/g, " ")}</span>
            <div className="row"><button type="button" onClick={close}>{T("Cancel", "Ghairi")}</button><button type="button" className="primary" onClick={apply}>{T("Update", "Sasisha")}</button></div>
          </div>
        </div>
      )}
    </div>
  );

  /** Desktop: drop-down under the button. Phone: a bottom sheet over a blurred, frozen page. */
  function sheet(node: JSX.Element) {
    if (!phone) return node;
    return createPortal(<><div className={"dr-scrim" + (closing ? " closing" : "")} onClick={close} data-noswipe aria-hidden />{node}</>, document.body);
  }
}

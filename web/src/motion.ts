import { useLayoutEffect, useRef } from "react";
/* itaOS motion kit — same recipe as the Amplo dashboard (GSAP 3).
   npm i gsap
   Every helper is a no-op when the user prefers reduced motion. */
import gsap from "gsap";

const reduced = matchMedia("(prefers-reduced-motion: reduce)");
export const prefersReduced = () => reduced.matches;
/** scale a duration/delay to 0 under reduced motion */
const d = (v: number) => (reduced.matches ? 0 : v);

type Targets = gsap.TweenTarget;
const q = <T extends Element = HTMLElement>(root: Element | null, sel: string) =>
  root ? Array.from(root.querySelectorAll<T>(sel)) : [];

/* ---------- page enter ---------- */

/** Cards / panels: fade + lift + slight scale. Amplo uses this for the dashboard grid. */
export function enterCards(targets: Targets, { y = 26, stagger = 0.06, delay = 0 } = {}) {
  const tl = gsap.timeline({ delay: d(delay) });
  tl.fromTo(
    targets,
    { opacity: 0, y, scale: 0.985 },
    { opacity: 1, y: 0, scale: 1, duration: d(0.8), ease: "expo.out", stagger: d(stagger), clearProps: "transform,opacity" },
  );
  return tl;
}

/** Rows, chips, list items: quick fade + small slide. Used for table rows, notifications. */
export function enterRows(targets: Targets, { x = 0, y = 12, stagger = 0.04, delay = 0 } = {}) {
  return gsap.fromTo(
    targets,
    { opacity: 0, x, y },
    { opacity: 1, x: 0, y: 0, duration: d(0.55), ease: "power3.out", stagger: d(stagger), delay: d(delay), clearProps: "transform,opacity" },
  );
}

/** Playful tiles (sign-in card children, empty states): bigger lift + alternate tilt + back ease. */
export function enterTiles(targets: Targets, { delay = 0, stagger = 0.07 } = {}) {
  return gsap.fromTo(
    targets,
    { opacity: 0, y: 40, rotation: (i: number) => (i % 2 ? 2.5 : -2.5), scale: 0.95 },
    { opacity: 1, y: 0, rotation: 0, scale: 1, duration: d(0.85), ease: "back.out(1.4)", stagger: d(stagger), delay: d(delay), clearProps: "transform,opacity" },
  );
}

/** Bars grow from 0 (set transform-origin: bottom for y, left for x in CSS). */
export function growBars(targets: Targets, { axis = "y" as "x" | "y", delay = 0, stagger = 0.03, duration = 0.9 } = {}) {
  const p = axis === "y" ? "scaleY" : "scaleX";
  return gsap.fromTo(targets, { [p]: 0 }, { [p]: 1, duration: d(duration), ease: "expo.out", stagger: d(stagger), delay: d(delay), clearProps: "transform" });
}

/** Pop in (badges, pills, the active-tab pill). */
export function pop(target: Targets, { from = 0.6, delay = 0, stagger = 0.05 } = {}) {
  if (!target || reduced.matches) return;
  gsap.fromTo(target, { scale: from, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.6, ease: "back.out(3)", delay, stagger, overwrite: "auto", clearProps: "transform,opacity" });
}

/* ---------- numbers ---------- */

const counters = new WeakMap<Element, { v: number }>();
/** Animated count-up. `format` turns a number into the displayed text (e.g. TZS formatter). */
export function countTo(
  el: HTMLElement | null,
  to: number,
  format: (n: number) => string,
  { duration = 1.2, delay = 0, from }: { duration?: number; delay?: number; from?: number } = {},
) {
  if (!el) return;
  let s = counters.get(el);
  if (!s) counters.set(el, (s = { v: from ?? 0 }));
  if (from !== undefined) s.v = from;
  gsap.killTweensOf(s);
  if (reduced.matches || !duration || s.v === to) { s.v = to; el.textContent = format(to); return; }
  const st = s;
  el.textContent = format(st.v);
  gsap.to(st, { v: to, duration, delay, ease: "power3.out", onUpdate: () => (el.textContent = format(st.v)), onComplete: () => (el.textContent = format(to)) });
}

/* ---------- feedback ---------- */

/** Flash + bump a value that just changed (new sale, new chat). */
export function flash(el: HTMLElement | null) {
  if (!el) return;
  el.classList.remove("is-flash"); void el.offsetWidth; el.classList.add("is-flash");
  if (!reduced.matches) gsap.fromTo(el, { y: -4, scale: 1.08 }, { y: 0, scale: 1, duration: 0.55, ease: "back.out(2.4)", overwrite: "auto", clearProps: "transform" });
}

/** "+1" style floater above an element. */
export function floatUp(anchor: HTMLElement | null, text: string, tone: "good" | "bad" = "good") {
  if (!anchor || reduced.matches) return;
  const r = anchor.getBoundingClientRect();
  const el = Object.assign(document.createElement("span"), { textContent: text });
  Object.assign(el.style, { position: "fixed", left: `${r.left + r.width / 2}px`, top: `${r.top}px`, font: "600 13px var(--font)", color: `var(--${tone})`, pointerEvents: "none", zIndex: "99" });
  el.setAttribute("aria-hidden", "true");
  document.body.append(el);
  gsap.fromTo(el, { opacity: 0, y: 6, xPercent: -50, scale: 0.9 }, {
    keyframes: [
      { opacity: 1, y: -12, scale: 1, duration: 0.35, ease: "back.out(2)" },
      { opacity: 0, y: -40, duration: 0.8, ease: "power2.in", delay: 0.6 },
    ],
    onComplete: () => el.remove(),
  });
}

/** Horizontal shake for an invalid form. */
export function shake(el: HTMLElement | null) {
  if (!el || reduced.matches) return;
  gsap.fromTo(el, { x: 0 }, { keyframes: { x: [0, -8, 7, -5, 3, 0] }, duration: 0.42, ease: "power2.out", clearProps: "transform" });
}

/** Icon pop (bell, check). */
export function popIcon(el: HTMLElement | null) {
  if (!el || reduced.matches) return;
  gsap.fromTo(el.querySelector("svg") ?? el, { scale: 0.7 }, { scale: 1, duration: 0.55, ease: "back.out(3)", overwrite: true });
}

/* ---------- app shell (run once on first mount) ---------- */

export function enterShell(root: HTMLElement | null) {
  if (!root) return;
  const tl = gsap.timeline();
  const bar = root.querySelector(".topbar");
  if (!bar) return tl;
  tl.fromTo(bar, { y: -24, opacity: 0 }, { y: 0, opacity: 1, duration: d(0.8), ease: "expo.out", clearProps: "transform,opacity" })
    .fromTo(q(root, ".brand, .actions > *"), { opacity: 0, y: -10 }, { opacity: 1, y: 0, duration: d(0.5), ease: "power3.out", stagger: d(0.035), clearProps: "transform,opacity" }, d(0.1))
    .fromTo(root.querySelector("nav.tabs"), { opacity: 0, scale: 0.94 }, { opacity: 1, scale: 1, duration: d(0.7), ease: "back.out(1.6)", clearProps: "transform,opacity" }, d(0.15))
    .fromTo(q(root, "nav.tabs a"), { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: d(0.45), ease: "power3.out", stagger: d(0.035), clearProps: "transform,opacity" }, d(0.3));
  return tl;
}

/* ---------- theme switch: circular wipe from the toggle button ---------- */

export function switchTheme(next: "light" | "dark", fromEl?: HTMLElement | null) {
  const html = document.documentElement;
  const apply = () => { html.dataset.theme = next; try { localStorage.setItem("growthos-theme", next); } catch { /* storage unavailable */ } };
  const svt = (document as any).startViewTransition as undefined | ((cb: () => void) => { ready: Promise<void> });
  if (html.dataset.theme === next) return;
  if (!svt || reduced.matches) { apply(); return; }
  const r = fromEl?.getBoundingClientRect();
  const x = r ? r.left + r.width / 2 : innerWidth - 40;
  const y = r ? r.top + r.height / 2 : 40;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  svt.call(document, apply).ready.then(() => {
    html.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 450, easing: "cubic-bezier(.22,1,.36,1)", pseudoElement: "::view-transition-new(root)" },
    );
  });
}

/* ---------- React hook ---------- */
/** Runs `fn(rootEl)` once on mount inside gsap.context so tweens are cleaned up on unmount. */
export function usePageEnter<T extends HTMLElement = HTMLDivElement>(fn: (root: T) => void, deps: unknown[] = []) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ctx = gsap.context(() => fn(ref.current!), ref);
    return () => ctx.revert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}
export { q as select };

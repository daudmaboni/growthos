/* Page-to-page transition inside the app (not the public homepage).
   Modelled on the Arch Studio site (Rron Berisha, Dribbble): a yellow panel and then a navy panel
   sweep up from the bottom over the page area, the section name rises through a mask, the page
   changes behind them, then the panels lift off the top (navy first, yellow trailing) and the new
   page settles up into place with its headings rising through a mask.
   The top bar / sidebar / bottom menu stay visible above the panels.
   Under "reduce motion" the page simply changes. */
import gsap from "gsap";
import { prefersReduced } from "./motion";

export type Area = { top: number; left: number; right: number; bottom: number };
type Opts = {
  /** do the actual page change; must update the DOM synchronously (use flushSync) */
  swap: () => void;
  /** section name shown on the panel */
  label?: string;
  /** small "02" style number next to the name */
  index?: number;
  /** part of the screen to cover (defaults to the whole window) */
  area?: () => Partial<Area>;
  /** element holding the new page; it settles up after the panels lift */
  stage?: () => HTMLElement | null;
  zIndex?: number;
};

/** Set by the phone swipe gesture: that navigation already animates, so the panels are skipped. */
export const navFlags = { swipe: false };

let root: HTMLDivElement | null = null;
let tl: gsap.core.Timeline | null = null;

function ensureRoot() {
  if (root && root.isConnected) return root;
  if (!document.getElementById("pt-style")) {
    const s = document.createElement("style");
    s.id = "pt-style";
    s.textContent = `
.pt-wipe{position:fixed;pointer-events:none;visibility:hidden;overflow:hidden;contain:strict}
.pt-wipe.on{visibility:visible;pointer-events:auto}
.pt-wipe>i{position:absolute;inset:0;display:block;will-change:clip-path}
.pt-wipe .pt-a{background:var(--pt-accent,#F7C948)}
.pt-wipe .pt-b{background:var(--pt-panel,#16224A);display:grid;place-items:center;padding:24px}
.pt-lab{display:flex;align-items:flex-start;gap:14px;color:#fff;font:600 clamp(30px,6vw,64px)/1.05 'Bricolage Grotesque','Instrument Sans',system-ui,sans-serif;letter-spacing:-.035em;overflow:hidden;padding-bottom:.08em;text-align:left}
.pt-lab small{font:600 12px/1 'Instrument Sans',system-ui,sans-serif;letter-spacing:.14em;color:var(--pt-accent,#F7C948);padding-top:.7em}
.pt-lab span{display:inline-block;will-change:transform}
`;
    document.head.append(s);
  }
  root = document.createElement("div");
  root.className = "pt-wipe";
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = `<i class="pt-a"></i><i class="pt-b"><div class="pt-lab"><small></small><span></span></div></i>`;
  document.body.append(root);
  return root;
}

const SHUT = "inset(100% 0% 0% 0%)"; // nothing showing, waiting below
const FULL = "inset(0% 0% 0% 0%)";
const GONE = "inset(0% 0% 100% 0%)"; // lifted off the top

export function pageTransition({ swap, label = "", index, area, stage, zIndex = 34 }: Opts) {
  if (tl && tl.isActive()) tl.progress(1); // finish any running change first (its swap runs)
  if (prefersReduced() || typeof document === "undefined") { swap(); return; }

  const el = ensureRoot();
  const a = el.children[0] as HTMLElement, b = el.children[1] as HTMLElement;
  const word = b.querySelector("span") as HTMLElement, num = b.querySelector("small") as HTMLElement;
  word.textContent = label;
  num.textContent = index != null ? String(index).padStart(2, "0") : "";
  num.style.display = index != null ? "" : "none";

  const r = { top: 0, left: 0, right: innerWidth, bottom: innerHeight, ...(area?.() ?? {}) };
  Object.assign(el.style, {
    top: `${Math.max(0, r.top)}px`, left: `${Math.max(0, r.left)}px`,
    width: `${Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left))}px`,
    height: `${Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top))}px`,
    zIndex: String(zIndex),
  });
  gsap.set([a, b], { clipPath: SHUT });
  gsap.set(word, { yPercent: 110, opacity: 1 });
  gsap.set(num, { opacity: 0, y: 8 });
  el.classList.add("on");

  tl = gsap.timeline({ onComplete: () => { el.classList.remove("on"); tl = null; } });
  // 1. cover: yellow first, navy right behind it
  tl.to(a, { clipPath: FULL, duration: 0.34, ease: "power3.inOut" }, 0)
    .to(b, { clipPath: FULL, duration: 0.34, ease: "power3.inOut" }, 0.07)
    .to(word, { yPercent: 0, duration: 0.42, ease: "expo.out" }, 0.2)
    .to(num, { opacity: 1, y: 0, duration: 0.3, ease: "power2.out" }, 0.26)
    // 2. change the page behind the panels
    .call(() => {
      window.scrollTo({ top: 0 });
      swap();
      const s = stage?.();
      if (s) {
        gsap.fromTo(s, { y: 70, opacity: 0.4 }, { y: 0, opacity: 1, duration: 0.9, ease: "expo.out", delay: 0.1, clearProps: "transform,opacity" });
        const heads = Array.from(s.querySelectorAll<HTMLElement>("h1, h2")).filter((h) => h.offsetParent).slice(0, 3);
        if (heads.length) gsap.fromTo(heads, { clipPath: "inset(0% 0% 100% 0%)", y: 22 },
          { clipPath: "inset(0% 0% -20% 0%)", y: 0, duration: 0.75, ease: "expo.out", stagger: 0.07, delay: 0.22, clearProps: "clipPath,transform" });
      }
    }, undefined, 0.5)
    // 3. reveal: the name slips up and away, navy lifts, yellow trails
    .to([word, num], { yPercent: -110, opacity: 0, duration: 0.3, ease: "power3.in" }, 0.56)
    .to(b, { clipPath: GONE, duration: 0.52, ease: "expo.inOut" }, 0.62)
    .to(a, { clipPath: GONE, duration: 0.52, ease: "expo.inOut" }, 0.7);
}

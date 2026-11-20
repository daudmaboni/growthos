// Fades out the preloader from index.html once the app knows what to show.
// The first screen shows the liquid ita. loader; it stays until the logo has formed (window.__plFormedAt).
// Later loads show one of the random logo animations.
const MIN_SHOW_MS = 900; // long enough for the logo animation to be seen, short enough not to slow anyone down
let done = false;
type PlWin = Window & { __plFormedAt?: number; __plStop?: () => void };

export function hidePreloader() {
  if (done) return;
  done = true;
  const w = window as PlWin;
  const now = performance.now();
  const wait = Math.max(0, MIN_SHOW_MS - now, Math.min((w.__plFormedAt ?? 0) - now, 3000));
  setTimeout(() => {
    const el = document.getElementById("preloader");
    if (!el) return;
    el.classList.add("is-hidden");
    setTimeout(() => { w.__plStop?.(); el.remove(); }, 500);
  }, wait);
}

// Safety net: never leave the app covered if loading stalls.
setTimeout(hidePreloader, 10000);

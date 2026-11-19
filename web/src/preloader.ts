// Fades out the logo preloader from index.html (one of 16 random animations) once the app knows what to show.
const MIN_SHOW_MS = 900; // long enough for the logo animation to be seen, short enough not to slow anyone down
let done = false;

export function hidePreloader() {
  if (done) return;
  done = true;
  const wait = Math.max(0, MIN_SHOW_MS - performance.now());
  setTimeout(() => {
    const el = document.getElementById("preloader");
    if (!el) return;
    el.classList.add("is-hidden");
    setTimeout(() => el.remove(), 500);
  }, wait);
}

// Safety net: never leave the app covered if loading stalls.
setTimeout(hidePreloader, 10000);

// Fades out the bouncing-dots preloader from index.html once the app knows what to show.
const MIN_SHOW_MS = 900; // long enough for the dots to be seen, short enough not to slow anyone down
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

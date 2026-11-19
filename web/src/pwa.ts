// Phone app (PWA): service worker, "Install itaOS" button, push notifications.
// Supabase is loaded only when needed, so the public homepage stays light.
const db = async () => (await import("./lib")).supabase;

/** Public half of the VAPID key pair. The private half is the VAPID_PRIVATE_KEY Edge Function secret. */
export const VAPID_PUBLIC_KEY = "BKxMcuarzjl5x6fGfsPnmySAi2XKYUl7gj5oD21thQtHPyJXHOm-dIRtjOTbsuuL_yj1DN_QJ58btb7QKMjj2no";

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

/** Called once from main.tsx. Never throws: the app works the same without a service worker. */
export function startPwa() {
  if (!("serviceWorker" in navigator) || import.meta.env.DEV) { keepStatusBarInStep(); return; }
  window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("service worker", e)); });
  // A tapped notification in an open window that the worker can't navigate.
  navigator.serviceWorker.addEventListener("message", (e) => { if (e.data?.type === "open" && typeof e.data.url === "string") location.href = e.data.url; });
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e as InstallEvent; notify(); });
  window.addEventListener("appinstalled", () => { deferred = null; notify(); });
  keepStatusBarInStep();
}

/** The phone's status bar follows the itaOS theme (light/dark), not the system. */
function keepStatusBarInStep() {
  const set = () => {
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", document.documentElement.dataset.theme === "dark" ? "#0d0e10" : "#ffffff");
  };
  set();
  new MutationObserver(set).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

export function onPwaChange(f: () => void) { listeners.add(f); return () => { listeners.delete(f); }; }

export const isInstalled = () =>
  window.matchMedia?.("(display-mode: standalone)").matches || (navigator as any).standalone === true;
export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const canPromptInstall = () => !!deferred;

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  await deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null; notify();
  return outcome === "accepted";
}

// ---- Push ----
export type PushState = "unsupported" | "needs-install" | "blocked" | "off" | "on";

export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return isIOS() && !isInstalled() ? "needs-install" : "unsupported";
  if (Notification.permission === "denied") return "blocked";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

function keyBytes(b64: string) {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** Ask permission, subscribe this device and save it for the workspace. Returns an error message or null. */
export async function turnOnPush(workspaceId: string): Promise<string | null> {
  if (!pushSupported()) return "This browser can't show notifications.";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm === "denied" ? "blocked" : "not-allowed";
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register("/sw.js"));
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) });
  const j = sub.toJSON();
  const supabase = await db();
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) return "Sign in first.";
  const { error } = await supabase.rpc("save_push_subscription", {
    p_workspace: workspaceId, p_endpoint: sub.endpoint, p_p256dh: j.keys?.p256dh ?? "", p_auth: j.keys?.auth ?? "", p_user_agent: navigator.userAgent,
  });
  return error ? error.message : null;
}

export async function turnOffPush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await (await db()).from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
  await sub.unsubscribe();
}

/** Ask the server to send a test notification to this signed-in user's devices. */
export async function sendTestPush(workspaceId: string): Promise<string | null> {
  const { error } = await (await db()).functions.invoke("push-send", { body: { test: true, workspace_id: workspaceId } });
  return error ? error.message : null;
}

// Kito's liquid "thinking" loader: gooey blobs pour into the Kito gem and melt back.
// The engine lives inline in index.html (window.itaLiquid) so the first-screen loader and this share one copy.
import { useEffect, useRef } from "react";

type Liquid = {
  mount: (host: HTMLElement, kind: "ita" | "kito", opts?: { small?: boolean; offset?: number }) => { stop: () => void };
};

/** size "md" for thinking cards, "sm" inline in buttons (replaces the old .kito-spin). */
export function KitoLoader({ size = "md", className = "" }: { size?: "md" | "sm"; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const host = ref.current;
    const lq = (window as unknown as { itaLiquid?: Liquid }).itaLiquid;
    if (!host) return;
    if (!lq) { host.classList.add("kito-spin"); return; } // fallback: the old spinner
    const h = lq.mount(host, "kito", { small: size === "sm", offset: 0.9 });
    return () => h.stop();
  }, [size]);
  return <span ref={ref} className={`kito-lq ${size} ${className}`} aria-hidden />;
}

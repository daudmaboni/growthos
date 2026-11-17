import { useEffect, useState } from "react";

/** ItaOS mark: the "ita." wordmark on a rounded tile. Three colourways that interchange:
 *  white (default, light theme), navy (dark theme), yellow. The tile slowly cycles through
 *  them and flips to the next one on hover or tap. Reduced-motion users get no cycling. */
type Variant = "white" | "navy" | "yellow";
const ORDER: Variant[] = ["white", "navy", "yellow"];
const COLORS: Record<Variant, { bg: string; fg: string; dot: string; edge: string }> = {
  white: { bg: "#ffffff", fg: "#131a2a", dot: "#f5c84c", edge: "#e6e8ec" },
  navy: { bg: "#131a2a", fg: "#ffffff", dot: "#f5c84c", edge: "#131a2a" },
  yellow: { bg: "#f5c84c", fg: "#131a2a", dot: "#131a2a", edge: "#f5c84c" },
};
const ITA = "M18.75 0.0H85.9375V-206.25H18.75ZM52.1484375 -226.3671875C73.828125 -226.3671875 89.2578125 -240.625 89.2578125 -260.3515625C89.2578125 -280.078125 73.828125 -294.140625 52.1484375 -294.140625C30.6640625 -294.140625 15.234375 -280.078125 15.234375 -260.3515625C15.234375 -240.625 30.6640625 -226.3671875 52.1484375 -226.3671875Z M235.3203125 -206.25H192.9375V-262.5H125.5546875V-206.25H90.3984375V-154.296875H125.5546875V-58.0078125C125.5546875 -17.96875 147.8203125 0.0 197.234375 0.0H235.3203125V-51.953125H212.078125C197.0390625 -51.953125 192.9375 -56.0546875 192.9375 -69.3359375V-154.296875H235.3203125Z M307.359375 3.515625C336.4609375 3.515625 355.015625 -6.640625 367.3203125 -28.90625H368.1015625V0.0H433.7265625V-138.8671875C433.7265625 -184.375 400.71875 -210.7421875 340.7578125 -210.7421875C280.9921875 -210.7421875 247.203125 -184.1796875 244.2734375 -139.453125H306.7734375C308.140625 -153.515625 319.6640625 -162.5 338.4140625 -162.5C356.1875 -162.5 367.125 -154.1015625 367.125 -141.796875V-140.8203125C367.125 -128.515625 353.6484375 -125.5859375 316.734375 -122.4609375C272.7890625 -118.9453125 236.65625 -103.90625 236.65625 -57.6171875C236.65625 -16.6015625 266.1484375 3.515625 307.359375 3.515625ZM327.8671875 -40.4296875C311.4609375 -40.4296875 300.328125 -48.046875 300.328125 -60.7421875C300.328125 -74.21875 313.21875 -81.640625 331.1875 -84.375C347.7890625 -87.109375 360.484375 -89.6484375 367.7109375 -92.96875V-74.21875C367.7109375 -53.90625 350.328125 -40.4296875 327.8671875 -40.4296875Z";

const themeVariant = (): Variant => {
  try { return document.documentElement.dataset.theme === "dark" ? "navy" : "white"; } catch { return "white"; }
};
const reducedMotion = () => {
  try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return true; }
};
const nextOf = (v: Variant) => ORDER[(ORDER.indexOf(v) + 1) % ORDER.length];

export default function Logo({ size = 32, variant, cycle = true }: { size?: number; variant?: Variant; cycle?: boolean }) {
  const [v, setV] = useState<Variant>(() => variant ?? themeVariant());

  // Follow the light/dark switch.
  useEffect(() => {
    if (variant) return;
    const mo = new MutationObserver(() => setV(themeVariant()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, [variant]);

  // Slow automatic cycle.
  useEffect(() => {
    if (variant || !cycle || reducedMotion()) return;
    const t = window.setInterval(() => setV(nextOf), 4500);
    return () => window.clearInterval(t);
  }, [variant, cycle]);

  const c = COLORS[v];
  const ease = { transition: "fill .6s ease, stroke .6s ease" };
  return (
    <svg
      width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true"
      style={{ flex: "none", display: "block" }}
      onPointerEnter={() => { if (!variant) setV(nextOf); }}
    >
      <rect x="8" y="8" width="1008" height="1008" rx="224" fill={c.bg} stroke={c.edge} strokeWidth="16" style={ease} />
      <path transform="translate(182 624)" fill={c.fg} d={ITA} style={ease} />
      <circle cx="712" cy="586" r="52" fill={c.dot} style={ease} />
    </svg>
  );
}

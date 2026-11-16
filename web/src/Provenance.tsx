import type { Provenance } from "./metrics";

const LABEL: Record<Provenance, { en: string; sw: string; short: string }> = {
  platform: { en: "Platform-reported (Meta)", sw: "Imeripotiwa na Meta", short: "Meta" },
  observed: { en: "Observed in WhatsApp chats", sw: "Imeonekana kwenye chats", short: "seen" },
  inferred: { en: "Inferred by rules or Kito (not confirmed)", sw: "Imekisiwa na kanuni au Kito (haijathibitishwa)", short: "inferred" },
  confirmed: { en: "Confirmed order recorded by you", sw: "Oda iliyothibitishwa na wewe", short: "confirmed" },
  imported: { en: "Imported from CSV or a provider", sw: "Imeingizwa kutoka CSV au mfumo", short: "imported" },
  matched: { en: "Matched estimate (ad referral + confirmed order)", sw: "Makadirio yaliyounganishwa (referral + oda)", short: "matched" },
  derived: { en: "Derived from the figures above", sw: "Imetokana na takwimu zilizo juu", short: "derived" },
};

export function SourceBadge({ p, lang, compact }: { p: Provenance; lang: "sw" | "en"; compact?: boolean }) {
  const l = LABEL[p];
  if (!l) return null;
  return <span className={"src src-" + p} title={l[lang]} style={compact ? { marginLeft: 6 } : {}}>{compact ? l.short : l[lang]}</span>;
}

export function ProvenanceLegend({ lang }: { lang: "sw" | "en" }) {
  return (
    <details>
      <summary>{lang === "sw" ? "Maana ya alama za vyanzo" : "What the source labels mean"}</summary>
      <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
        {(Object.keys(LABEL) as Provenance[]).map((k) => <div className="small" key={k}><span className={"src src-" + k}>{LABEL[k].short}</span> {LABEL[k][lang]}</div>)}
      </div>
    </details>
  );
}

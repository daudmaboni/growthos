// Report filter bar for Dashboard and Diagnosis: source, campaign, ad, product. Remembered per page.
import { useState } from "react";
import type { Filters, FilterOptions } from "./data";
import { activeFilters } from "./data";

const KEY = (page: string) => "itaos-filters-" + page;
export function useFilters(page: string): [Filters, (f: Filters) => void] {
  const [f, setF] = useState<Filters>(() => { try { return JSON.parse(localStorage.getItem(KEY(page)) ?? "{}") ?? {}; } catch { return {}; } });
  return [f, (n: Filters) => {
    const clean = Object.fromEntries(Object.entries(n).filter(([, v]) => v)) as Filters;
    setF(clean);
    try { localStorage.setItem(KEY(page), JSON.stringify(clean)); } catch { /* storage off */ }
  }];
}

export function FilterBar({ value, onChange, options, lang }: { value: Filters; onChange: (f: Filters) => void; options: FilterOptions; lang: "sw" | "en" | string }) {
  const T = (en: string, sw: string) => (lang === "sw" ? sw : en);
  const ads = value.campaign ? options.ads.filter((a) => a.campaign === value.campaign) : options.ads;
  const on = activeFilters(value);
  return (
    <div className="filterbar" role="group" aria-label={T("Filters", "Vichujio")}>
      <select aria-label={T("Source", "Chanzo")} value={value.source ?? ""} onChange={(e) => onChange({ ...value, source: (e.target.value || undefined) as Filters["source"], ...(e.target.value && e.target.value !== "ad" ? { campaign: undefined, ad: undefined } : {}) })}>
        <option value="">{T("All sources", "Vyanzo vyote")}</option>
        <option value="ad">{T("From ads", "Kutoka matangazo")}</option>
        <option value="organic">{T("Organic", "Bila tangazo")}</option>
        <option value="unknown">{T("Unknown source", "Chanzo hakijulikani")}</option>
      </select>
      {options.campaigns.length > 0 && value.source !== "organic" && value.source !== "unknown" && (
        <select aria-label={T("Campaign", "Kampeni")} value={value.campaign ?? ""} onChange={(e) => onChange({ ...value, campaign: e.target.value || undefined, ad: undefined })}>
          <option value="">{T("All campaigns", "Kampeni zote")}</option>
          {options.campaigns.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      )}
      {ads.length > 0 && value.source !== "organic" && value.source !== "unknown" && (
        <select aria-label={T("Ad", "Tangazo")} value={value.ad ?? ""} onChange={(e) => onChange({ ...value, ad: e.target.value || undefined })}>
          <option value="">{T("All ads", "Matangazo yote")}</option>
          {ads.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      )}
      {options.products.length > 0 && (
        <select aria-label={T("Product", "Bidhaa")} value={value.product ?? ""} onChange={(e) => onChange({ ...value, product: e.target.value || undefined })}>
          <option value="">{T("All products", "Bidhaa zote")}</option>
          {options.products.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      )}
      {on && <button type="button" className="small linkish" onClick={() => onChange({})}>{T("Clear filters", "Ondoa vichujio")}</button>}
      {on && <span className="small muted filternote">{[
        value.product ? T("Product filters orders and revenue only (chats have no product).", "Bidhaa inachuja oda na mapato tu (chats hazina bidhaa).") : "",
        value.source && value.source !== "ad" ? T("No ad spend for non-ad chats.", "Hakuna matumizi ya matangazo kwa chats zisizo za tangazo.") : "",
        value.ad || value.campaign ? T("Ad-linked sales are estimates, not proof the ad caused them.", "Mauzo yaliyounganishwa na tangazo ni makadirio, si uthibitisho.") : "",
      ].filter(Boolean).join(" ")}</span>}
    </div>
  );
}

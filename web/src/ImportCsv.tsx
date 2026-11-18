// Guided CSV import: choose what to import → upload → map columns → check (dry run) →
// review matches → import → summary. Nothing is written until the last step.
import { useMemo, useState } from "react";
import { callFn, Workspace, canEdit, when } from "./lib";
import { parseCsv, autoMap, applyMap, FIELDS, template, Kind } from "./csv";

type Match = { conversation_id: string; contact_name: string | null; confidence: "exact" | "name" | "ambiguous"; started_at: string | null; already_has_order: boolean };
type RowResult = { index: number; status: "ready" | "duplicate" | "rejected"; reason?: string; match?: Match | null; matches?: Match[] };
type Check = { results: RowResult[]; summary: { total: number; ready: number; duplicates: number; rejected: number; matched: number; unmatched: number }; currency: string };
type Done = { created: number; skipped: number; rejected: number; failures: { index: number; reason?: string }[] };

export default function ImportCsv({ ws, onImported }: { ws: Workspace; onImported?: () => void }) {
  const lang = ws.language; const T = (en: string, sw: string) => (lang === "sw" ? sw : en);
  const [kind, setKind] = useState<Kind>("orders");
  const [file, setFile] = useState<File | null>(null);
  const [grid, setGrid] = useState<string[][]>([]);
  const [map, setMap] = useState<Record<string, number>>({});
  const [check, setCheck] = useState<Check | null>(null);
  const [links, setLinks] = useState<Record<string, string | null>>({});
  const [done, setDone] = useState<Done | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const editor = canEdit(ws);
  const step = done ? 5 : check ? 4 : grid.length ? 3 : 1;
  const fields = FIELDS[kind];
  const rows = useMemo(() => (grid.length ? applyMap(grid, map) : []), [grid, map]);
  const missingRequired = fields.filter((f) => f.required && map[f.key] == null).map((f) => f[lang]);

  function reset() { setFile(null); setGrid([]); setMap({}); setCheck(null); setLinks({}); setDone(null); setErr(""); }
  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([template(kind, ws.currency)], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `itaOS-${kind}-template.csv`; a.click(); URL.revokeObjectURL(url);
  }
  async function pick(f?: File) {
    reset(); if (!f) return;
    try {
      const g = parseCsv(await f.text());
      if (g.length < 2) throw new Error(T("The file needs a header row and at least one data row.", "Faili inahitaji mstari wa vichwa na angalau mstari mmoja wa data."));
      if (g.length > 1001) throw new Error(T("Import at most 1000 rows per file.", "Ingiza mistari 1000 kwa faili moja."));
      setFile(f); setGrid(g); setMap(autoMap(g[0], kind));
    } catch (e) { setErr((e as Error).message); }
  }
  async function runCheck() {
    setBusy(true); setErr(""); setCheck(null); setLinks({});
    try {
      const r = await callFn<Check>("csv-import", { workspace_id: ws.id, kind, dry_run: true, rows, file_name: file?.name });
      setCheck(r);
      const l: Record<string, string | null> = {};
      for (const x of r.results) if (x.match?.confidence === "exact") l[String(x.index)] = x.match.conversation_id;
      setLinks(l);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }
  async function runImport() {
    if (!check) return;
    setBusy(true); setErr("");
    try {
      const r = await callFn<Done>("csv-import", { workspace_id: ws.id, kind, dry_run: false, rows, file_name: file?.name, links });
      setDone(r); onImported?.();
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }

  const kinds: [Kind, string][] = [["orders", T("Orders / sales", "Oda / mauzo")], ["expenses", T("Expenses", "Matumizi")], ["inquiries", T("Past inquiries", "Maulizo ya zamani")]];
  return (
    <section className="card">
      <div className="row between"><h2>{T("Import from CSV", "Ingiza kutoka CSV")}</h2>
        <div className="stepper">{[T("Choose", "Chagua"), T("Upload", "Pakia"), T("Map columns", "Panga safu"), T("Check", "Kagua"), T("Import", "Ingiza")].map((s, i) => <span key={s} className={step === i + 1 ? "on" : ""}>{i + 1}. {s}</span>)}</div>
      </div>
      {!editor && <p className="small muted">{T("Viewer role: you can download templates but not import.", "Nafasi ya kutazama: unaweza kupakua violezo lakini si kuingiza.")}</p>}
      <div className="row">
        <div className="seg" role="group">{kinds.map(([k, l]) => <button key={k} type="button" className={kind === k ? "on" : ""} disabled={busy} onClick={() => { setKind(k); reset(); }}>{l}</button>)}</div>
        <button type="button" className="small" onClick={downloadTemplate}>{T("Download template", "Pakua kiolezo")}</button>
      </div>
      <details><summary>{T("Field definitions", "Maana ya safu")}</summary>
        <div className="scroll"><table><thead><tr><th>{T("Field", "Safu")}</th><th></th><th>{T("Meaning", "Maana")}</th></tr></thead>
          <tbody>{fields.map((f) => <tr key={f.key}><td><code>{f.key}</code></td><td className="small">{f.required ? <span className="chip bad">{T("required", "lazima")}</span> : ""}</td><td className="small">{f[lang]} — {f.hint}</td></tr>)}</tbody></table></div>
        <p className="small muted" style={{ margin: "6px 0 0" }}>{T("Rows with a reference that already exists in this workspace are skipped, never overwritten. Phone numbers are used only to find the matching chat inside this workspace and are not stored.", "Mistari yenye namba iliyopo tayari inarukwa, haibadilishwi. Namba za simu hutumika tu kutafuta chat ndani ya workspace hii na hazihifadhiwi.")}</p>
      </details>
      <label className="small">{T("Choose a CSV file", "Chagua faili ya CSV")} <input type="file" accept=".csv,text/csv" disabled={busy || !editor} onChange={(e) => pick(e.target.files?.[0])} /></label>
      {err && <p className="err small" style={{ margin: 0 }}>{err}</p>}

      {grid.length > 0 && !done && (
        <>
          <div><h3>{T("Map columns", "Panga safu")}</h3><span className="small muted">{file?.name} · {grid.length - 1} {T("rows", "mistari")}. {T("We guessed from the headers; fix anything wrong.", "Tumekisia kutoka vichwa; sahihisha kama kuna kosa.")}</span></div>
          <div className="map">
            {fields.map((f) => (
              <label key={f.key}>{f[lang]}{f.required ? " *" : ""}
                <select value={map[f.key] ?? ""} disabled={busy} onChange={(e) => { const v = e.target.value; const m = { ...map }; if (v === "") delete m[f.key]; else m[f.key] = Number(v); setMap(m); setCheck(null); }}>
                  <option value="">{T("— not in file —", "— haipo —")}</option>
                  {grid[0].map((h, i) => <option key={i} value={i}>{h || `(${T("column", "safu")} ${i + 1})`}</option>)}
                </select>
              </label>
            ))}
          </div>
          <div className="scroll"><table>
            <thead><tr>{fields.filter((f) => map[f.key] != null).map((f) => <th key={f.key}>{f.key}</th>)}</tr></thead>
            <tbody>{rows.slice(0, 5).map((r, i) => <tr key={i}>{fields.filter((f) => map[f.key] != null).map((f) => <td key={f.key} className="small">{f.key === "phone" ? (r[f.key] ? "•••" : "") : r[f.key] ?? ""}</td>)}</tr>)}</tbody>
          </table></div>
          {missingRequired.length > 0 && <p className="err small" style={{ margin: 0 }}>{T("Map these required fields first: ", "Panga safu hizi za lazima kwanza: ")}{missingRequired.join(", ")}</p>}
          <div className="row"><button type="button" className="primary" disabled={busy || !editor || missingRequired.length > 0 || !rows.length} onClick={runCheck}>{busy && !check ? T("Checking…", "Inakagua…") : T("Check rows (nothing is saved yet)", "Kagua mistari (hakuna kinachohifadhiwa bado)")}</button></div>
        </>
      )}

      {check && !done && (
        <>
          <div><h3>{T("Check results", "Matokeo ya ukaguzi")}</h3>
            <span className="small muted">{check.summary.ready} {T("ready", "tayari")} · {check.summary.duplicates} {T("already imported", "zipo tayari")} · {check.summary.rejected} {T("rejected", "zimekataliwa")}{kind !== "expenses" ? ` · ${check.summary.matched} ${T("matched to a chat", "zimeunganishwa na chat")} · ${check.summary.unmatched} ${T("unmatched", "hazijaunganishwa")}` : ""}</span></div>
          <div className="scroll" style={{ maxHeight: 360 }}><table>
            <thead><tr><th>#</th><th>{T("Status", "Hali")}</th><th>{T("Row", "Mstari")}</th>{kind !== "expenses" && <th>{T("Chat match", "Chat")}</th>}</tr></thead>
            <tbody>{check.results.map((x) => {
              const r = rows[x.index] ?? {};
              const summary = kind === "expenses" ? `${r.date ?? ""} · ${r.category ?? ""} · ${r.amount ?? ""}` : kind === "orders" ? `${r.date ?? ""} · ${r.amount ?? ""} · ${r.customer_name ?? r.product ?? ""}` : `${r.date ?? ""} · ${r.customer_name ?? ""}`;
              const chosen = links[String(x.index)];
              return (
                <tr key={x.index}>
                  <td className="rank">{x.index + 1}</td>
                  <td><span className={"rowstat " + x.status}>{x.status}</span>{x.reason && <div className="small muted">{x.reason}</div>}</td>
                  <td className="small">{summary}</td>
                  {kind !== "expenses" && <td className="small">
                    {x.status === "ready" && (x.matches?.length ? (
                      <select value={chosen ?? ""} onChange={(e) => setLinks({ ...links, [String(x.index)]: e.target.value || null })} style={{ padding: "3px 8px" }}>
                        <option value="">{kind === "inquiries" ? T("— create new —", "— tengeneza mpya —") : T("— don't link —", "— usiunganishe —")}</option>
                        {x.matches.map((m) => <option key={m.conversation_id} value={m.conversation_id}>{m.contact_name ?? "?"} · {m.started_at ? when(m.started_at) : ""} · {m.confidence === "exact" ? T("phone match", "simu inalingana") : m.confidence === "name" ? T("name match", "jina linalingana") : T("one of several", "mojawapo")}{m.already_has_order ? T(" · has an order", " · ina oda") : ""}</option>)}
                      </select>
                    ) : <span className="muted">{kind === "inquiries" ? T("new chat will be created", "chat mpya itatengenezwa") : T("no chat found; order stays unlinked", "hakuna chat; oda itabaki bila chat")}</span>)}
                    {x.status === "ready" && x.match?.confidence !== "exact" && (x.matches?.length ?? 0) > 0 && <div className="small warnt">{T("Uncertain match: review before linking", "Uhakika mdogo: kagua kabla ya kuunganisha")}</div>}
                  </td>}
                </tr>
              );
            })}</tbody>
          </table></div>
          <div className="row">
            <button type="button" className="primary" disabled={busy || !check.summary.ready} onClick={runImport}>{busy ? T("Importing…", "Inaingiza…") : T(`Import ${check.summary.ready} rows`, `Ingiza mistari ${check.summary.ready}`)}</button>
            <button type="button" className="small" disabled={busy} onClick={reset}>{T("Start over", "Anza upya")}</button>
          </div>
        </>
      )}

      {done && (
        <div className="finding good">
          <b>{T(`Imported ${done.created} ${kind}`, `${done.created} zimeingizwa`)}</b>
          <span className="small">{done.skipped} {T("skipped (already there or failed)", "zimerukwa (zipo au zimeshindikana)")} · {done.rejected} {T("rejected", "zimekataliwa")}.{done.failures.length ? " " + done.failures.slice(0, 5).map((f) => `#${f.index + 1}: ${f.reason}`).join("; ") : ""}</span>
          <span className="small"><a href="#chats">{T("See them in Chats →", "Ziona kwenye Chats →")}</a> · <button className="small" style={{ padding: 0, border: 0, background: "none", color: "var(--accent)" }} onClick={reset}>{T("Import another file", "Ingiza faili nyingine")}</button></span>
        </div>
      )}
    </section>
  );
}

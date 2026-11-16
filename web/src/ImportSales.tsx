import { useState } from "react";
import { callFn, supabase, Workspace } from "./lib";

type SaleRow = { conversation_id: string; amount: number; currency: string; occurred_at: string };

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], value = "", quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"' && value.length === 0) quoted = true;
    else if (ch === ",") { row.push(value); value = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(value); value = "";
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
    } else value += ch;
  }
  row.push(value);
  if (row.some((cell) => cell.trim())) rows.push(row);
  if (quoted) throw new Error("This CSV has an unclosed quoted value.");
  return rows;
}

function csvCell(value: string) { return `"${value.replace(/"/g, '""')}"`; }

export default function ImportSales({ ws, onImported }: { ws: Workspace; onImported?: () => void }) {
  const [rows, setRows] = useState<SaleRow[]>([]);
  const [rowErrors, setRowErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function downloadTemplate() {
    setBusy(true); setError(""); setMessage("");
    const collected: any[] = [];
    for (let start = 0; start < 5000; start += 1000) {
      const { data, error: queryError } = await supabase.from("conversation_outcomes")
        .select("id,contact_name,started_at,sale_amount,sale_provenance")
        .eq("workspace_id", ws.id).order("started_at", { ascending: false }).range(start, start + 999);
      if (queryError) { setError("Could not prepare the workspace conversation template."); setBusy(false); return; }
      collected.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    const lines: (string | number | null)[][] = [["conversation_id", "customer_name", "chat_started_at", "amount", "currency", "occurred_at"]];
    for (const r of collected) lines.push([r.id, r.contact_name ?? "", r.started_at ?? "", "", ws.currency, ""]);
    const csv = lines.map((line) => line.map((v) => csvCell(String(v))).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = "growthos-sales-import.csv"; a.click(); URL.revokeObjectURL(url);
    setMessage(`Prepared ${collected.length} recent conversation rows. Fill amount and occurred_at for confirmed purchases; names are included for your reference. This file contains no phone numbers.`);
    setBusy(false);
  }

  async function selectFile(file?: File) {
    setRows([]); setRowErrors([]); setError(""); setMessage("");
    if (!file) return;
    try {
      const grid = parseCsv(await file.text());
      if (grid.length < 2) throw new Error("The CSV needs a header and at least one sale row.");
      const headers = grid[0].map((x) => x.trim().toLowerCase());
      const required = ["conversation_id", "amount", "occurred_at"];
      const missing = required.filter((key) => !headers.includes(key));
      if (missing.length) throw new Error(`Missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`);
      const idx = (key: string) => headers.indexOf(key);
      const parsed: SaleRow[] = [], errors: string[] = [];
      grid.slice(1).forEach((cells, i) => {
        const get = (key: string) => cells[idx(key)]?.trim() ?? "";
        const conversation_id = get("conversation_id"), amountText = get("amount"), amount = Number(amountText.replace(/,/g, ""));
        const occurred_at = get("occurred_at"), currency = (get("currency") || ws.currency).toUpperCase();
        if (!amountText && !occurred_at) return; // Blank template rows are intentionally skipped.
        if (!/^[0-9a-f-]{36}$/i.test(conversation_id)) errors.push(`Row ${i + 2}: invalid conversation_id.`);
        else if (!Number.isFinite(amount) || amount <= 0) errors.push(`Row ${i + 2}: amount must be greater than zero.`);
        else if (!occurred_at || !Number.isFinite(Date.parse(occurred_at))) errors.push(`Row ${i + 2}: provide a valid occurred_at date.`);
        else if (currency !== ws.currency) errors.push(`Row ${i + 2}: currency must match workspace currency (${ws.currency}).`);
        else parsed.push({ conversation_id, amount, currency, occurred_at: new Date(occurred_at).toISOString() });
      });
      const seen = new Set<string>();
      for (const row of parsed) {
        if (seen.has(row.conversation_id)) errors.push("Duplicate conversation_id in the selected file.");
        seen.add(row.conversation_id);
      }
      setRows(parsed); setRowErrors(errors);
      if (parsed.length > 500) { setRows([]); throw new Error("Import at most 500 sales per file. Split this file and import it in batches."); }
    } catch (e) { setError((e as Error).message); }
  }

  async function importRows() {
    if (!rows.length || rowErrors.length) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await callFn<{ imported: number; currency: string }>("sales-import", { workspace_id: ws.id, sales: rows });
      setMessage(`Imported ${result.imported} confirmed sales in ${result.currency}.`);
      setRows([]); setRowErrors([]); onImported?.();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  return (
    <details className="card" style={{ marginTop: 12 }}>
      <summary>Import confirmed sales (CSV)</summary>
      <p className="small muted">Use this to add historical sales to chats already in this workspace. Fill amount and occurred_at only for confirmed purchases; completely blank rows are skipped. One sale per conversation is supported. Imported sales are treated as business-confirmed. The CSV is processed in your browser and the matched sale data is sent to GrowthOS; customer phone numbers are not required.</p>
      <div className="row">
        <button type="button" disabled={busy} onClick={downloadTemplate}>{busy ? "Preparing…" : "Download conversation template"}</button>
        <label className="small">Choose completed CSV <input type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => selectFile(e.target.files?.[0])} /></label>
      </div>
      {rows.length > 0 && <p className="small">Ready to import {rows.length} sale rows. Existing sales for those conversations will be updated.</p>}
      {rowErrors.length > 0 && <div className="err small">{rowErrors.slice(0, 8).map((e) => <div key={e}>{e}</div>)}{rowErrors.length > 8 && <div>And {rowErrors.length - 8} more row errors.</div>}</div>}
      {message && <p className="ok small">{message}</p>}
      {error && <p className="err small">{error}</p>}
      <button type="button" className="primary" disabled={busy || !rows.length || !!rowErrors.length} onClick={importRows}>{busy ? "Importing…" : `Import ${rows.length || "sales"}`}</button>
    </details>
  );
}

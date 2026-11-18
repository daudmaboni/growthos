// Browser-side CSV parsing and column mapping for the guided importer. Pure; unit-tested.
export type Kind = "orders" | "expenses" | "inquiries";

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], value = "", quoted = false;
  text = text.replace(/^﻿/, "");
  const sep = detectSeparator(text);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"' && value.length === 0) quoted = true;
    else if (ch === sep) { row.push(value); value = ""; }
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

function detectSeparator(text: string): string {
  const head = text.split(/\r?\n/, 1)[0] ?? "";
  const counts = [",", ";", "\t"].map((s) => [s, (head.match(new RegExp(s === "\t" ? "\t" : "\\" + s, "g")) ?? []).length] as const);
  return counts.sort((a, b) => b[1] - a[1])[0][1] > 0 ? counts.sort((a, b) => b[1] - a[1])[0][0] : ",";
}

export const csvCell = (value: string) => `"${String(value).replace(/"/g, '""')}"`;

/** Canonical fields per kind, with a label and whether they are required. */
export const FIELDS: Record<Kind, { key: string; en: string; sw: string; required?: boolean; hint: string }[]> = {
  orders: [
    { key: "ref", en: "Order reference", sw: "Namba ya oda", hint: "Receipt / invoice / M-Pesa code. Stops the same order being imported twice." },
    { key: "date", en: "Date", sw: "Tarehe", required: true, hint: "2026-11-16 or 16/11/2026" },
    { key: "amount", en: "Amount", sw: "Kiasi", required: true, hint: "Gross amount before discount" },
    { key: "discount", en: "Discount", sw: "Punguzo", hint: "Optional" },
    { key: "currency", en: "Currency", sw: "Sarafu", hint: "Must match the workspace currency" },
    { key: "status", en: "Status", sw: "Hali", hint: "paid (default), pending, refunded, cancelled" },
    { key: "fulfillment", en: "Delivery status", sw: "Hali ya usafirishaji", hint: "not_shipped, shipped, delivered, returned" },
    { key: "product", en: "Product", sw: "Bidhaa", hint: "Optional" },
    { key: "customer_name", en: "Customer name", sw: "Jina la mteja", hint: "Used to suggest a chat match" },
    { key: "phone", en: "Customer phone", sw: "Simu ya mteja", hint: "Used only to find the chat in this workspace; never stored" },
    { key: "conversation_id", en: "itaOS chat id", sw: "Kitambulisho cha chat", hint: "Optional, from a itaOS export" },
    { key: "notes", en: "Notes", sw: "Maelezo", hint: "Optional" },
  ],
  expenses: [
    { key: "ref", en: "Reference", sw: "Namba", hint: "Stops the same expense being imported twice" },
    { key: "date", en: "Date", sw: "Tarehe", required: true, hint: "2026-11-16 or 16/11/2026" },
    { key: "category", en: "Category", sw: "Aina", hint: "product, delivery, packaging, staff, ads_other, other" },
    { key: "amount", en: "Amount", sw: "Kiasi", required: true, hint: "" },
    { key: "currency", en: "Currency", sw: "Sarafu", hint: "Must match the workspace currency" },
    { key: "note", en: "Note", sw: "Maelezo", hint: "Optional" },
  ],
  inquiries: [
    { key: "ref", en: "Reference", sw: "Namba", hint: "Optional; stops duplicates" },
    { key: "date", en: "Date", sw: "Tarehe", required: true, hint: "When the customer first wrote" },
    { key: "customer_name", en: "Customer name", sw: "Jina la mteja", required: true, hint: "" },
    { key: "phone", en: "Customer phone", sw: "Simu ya mteja", hint: "Only used to detect an existing chat; never stored" },
    { key: "source", en: "Source", sw: "Chanzo", hint: "ad, organic or unknown" },
    { key: "source_label", en: "Source label", sw: "Lebo ya chanzo", hint: "e.g. the lead batch or post name" },
    { key: "note", en: "Note", sw: "Maelezo", hint: "Optional" },
  ],
};

const SYNONYMS: Record<string, string[]> = {
  ref: ["ref", "reference", "order_id", "order id", "orderid", "invoice", "receipt", "receipt no", "transaction", "txn", "code", "namba"],
  date: ["date", "paid_at", "paid at", "order_date", "order date", "tarehe", "day", "created", "created_at", "timestamp", "time"],
  amount: ["amount", "total", "price", "kiasi", "bei", "value", "paid", "revenue", "sum", "gross"],
  discount: ["discount", "punguzo"],
  currency: ["currency", "sarafu", "cur"],
  status: ["status", "hali", "payment_status", "payment status"],
  fulfillment: ["fulfillment", "fulfilment", "delivery", "delivery_status", "delivery status", "shipping"],
  product: ["product", "item", "items", "bidhaa", "sku", "description"],
  customer_name: ["customer", "customer_name", "customer name", "name", "jina", "mteja", "client", "buyer", "contact"],
  phone: ["phone", "simu", "whatsapp", "number", "msisdn", "mobile", "tel", "telephone", "phone_number", "phone number"],
  conversation_id: ["conversation_id", "conversation id", "chat_id", "chat id", "itaos id"],
  notes: ["notes", "note", "maelezo", "comment", "comments", "remarks"],
  note: ["note", "notes", "maelezo", "comment", "description", "remarks"],
  category: ["category", "aina", "type", "kind"],
  source: ["source", "chanzo", "channel"],
  source_label: ["source_label", "source label", "campaign", "batch", "lebo", "post", "label"],
};

/** Best-guess mapping from CSV headers to canonical fields. Returns {field: columnIndex}. */
export function autoMap(headers: string[], kind: Kind): Record<string, number> {
  const norm = headers.map((h) => h.trim().toLowerCase().replace(/[^a-z0-9_ ]/g, ""));
  const out: Record<string, number> = {};
  const used = new Set<number>();
  for (const f of FIELDS[kind]) {
    const syns = [f.key, ...(SYNONYMS[f.key] ?? [])];
    let idx = norm.findIndex((h, i) => !used.has(i) && syns.includes(h));
    if (idx < 0) idx = norm.findIndex((h, i) => !used.has(i) && syns.some((s) => s.length > 3 && h.includes(s)));
    if (idx >= 0) { out[f.key] = idx; used.add(idx); }
  }
  return out;
}

export function applyMap(grid: string[][], map: Record<string, number>): Record<string, string>[] {
  return grid.slice(1).map((cells) => {
    const r: Record<string, string> = {};
    for (const [k, i] of Object.entries(map)) { const v = cells[i]?.trim(); if (v) r[k] = v; }
    return r;
  }).filter((r) => Object.keys(r).length > 0);
}

export function template(kind: Kind, currency: string): string {
  const header = FIELDS[kind].map((f) => f.key);
  const example: Record<Kind, string[]> = {
    orders: ["INV-001", "2026-11-10", "45000", "0", currency, "paid", "delivered", "KayaPower 1 box", "Asha", "", "", "paid via M-Pesa"],
    expenses: ["EXP-001", "2026-11-10", "delivery", "6000", currency, "Boda to Mbezi"],
    inquiries: ["", "2026-11-09", "Juma", "", "ad", "Nov TTS leads", "asked for price"],
  };
  return [header, example[kind]].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

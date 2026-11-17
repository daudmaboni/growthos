// Guided CSV import for orders, expenses and historical inquiries.
// The browser maps columns and sends canonical rows. `dry_run: true` validates, finds duplicates
// and proposes chat matches without writing anything. The final call writes only rows the user
// kept, with provenance csv_import and an import batch for the audit trail.
// Phone numbers in the file are used to look up contacts inside this workspace only and are
// never stored, logged or returned.
import { admin, userClient, json, cors } from "../_shared/db.ts";
import {
  Kind, OrderRow, ExpenseRow, InquiryRow, validateOrder, validateExpense, validateInquiry, markFileDuplicates, normalizePhone,
} from "../_shared/csv.ts";

const MAX_ROWS = 1000;

type Match = { conversation_id: string; contact_name: string | null; confidence: "exact" | "name" | "ambiguous"; started_at: string | null; already_has_order: boolean };
type RowResult = { index: number; status: "ready" | "duplicate" | "rejected" | "created" | "skipped"; reason?: string; match?: Match | null; matches?: Match[] };

async function sha(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const body = await req.json().catch(() => ({}));
  const ws = String(body.workspace_id ?? "");
  const kind = String(body.kind ?? "") as Kind;
  const dryRun = body.dry_run !== false;
  if (!ws || !["orders", "expenses", "inquiries"].includes(kind)) return json({ error: "workspace_id and kind are required" }, 400);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return json({ error: "No rows to import." }, 400);
  if (rows.length > MAX_ROWS) return json({ error: `Import at most ${MAX_ROWS} rows at a time.` }, 400);

  const auth = userClient(req);
  const [{ data: canEdit, error: roleError }, { data: user, error: userError }] = await Promise.all([auth.rpc("can_edit", { ws }), auth.auth.getUser()]);
  if (roleError || userError) return json({ error: "could not verify workspace access" }, 500);
  if (!canEdit || !user.user) return json({ error: "You need an editor role in this workspace to import." }, 403);
  const uid = user.user.id;

  const db = admin();
  const { data: workspace, error: wsError } = await db.from("workspaces").select("currency").eq("id", ws).single();
  if (wsError || !workspace) return json({ error: "workspace unavailable" }, 404);
  const currency = workspace.currency;

  // ---------- validate ----------
  const validated = kind === "orders" ? markFileDuplicates(rows.map((r: OrderRow, i: number) => validateOrder(r, i, currency)))
    : kind === "expenses" ? markFileDuplicates(rows.map((r: ExpenseRow, i: number) => validateExpense(r, i, currency)))
    : markFileDuplicates(rows.map((r: InquiryRow, i: number) => validateInquiry(r, i)));
  const results: RowResult[] = [];
  const good = validated.filter((v) => v.ok) as Extract<typeof validated[number], { ok: true }>[];
  for (const v of validated) if (!v.ok) results.push({ index: v.index, status: "rejected", reason: v.reason });

  // ---------- duplicates against what is already stored (never overwrite) ----------
  const refs = good.map((v) => v.dedupe_key.startsWith("ref:") ? (v.row as any).ref : "auto:" + v.dedupe_key.slice(5));
  const table = kind === "orders" ? "orders" : kind === "expenses" ? "expenses" : null;
  const existingRefs = new Set<string>();
  if (table) {
    for (let i = 0; i < refs.length; i += 200) {
      const { data, error } = await db.from(table).select("external_ref").eq("workspace_id", ws).in("external_ref", refs.slice(i, i + 200));
      if (error) return json({ error: "could not check existing records" }, 500);
      for (const r of data ?? []) if (r.external_ref) existingRefs.add(r.external_ref);
    }
  } else {
    const keys = await Promise.all(good.map((v) => sha(ws + "|" + v.dedupe_key)));
    for (let i = 0; i < keys.length; i += 200) {
      const { data, error } = await db.from("contacts").select("wa_id").eq("workspace_id", ws).in("wa_id", keys.slice(i, i + 200).map((k) => "csv:" + k));
      if (error) return json({ error: "could not check existing records" }, 500);
      for (const r of data ?? []) existingRefs.add(r.wa_id);
    }
    good.forEach((v, i) => { (v as any).csv_key = "csv:" + keys[i]; });
  }

  // ---------- chat matching (orders and inquiries) ----------
  const matchByIndex = new Map<number, { match: Match | null; matches: Match[] }>();
  if (kind !== "expenses") {
    const phones = new Map<string, number[]>();
    const names = new Map<string, number[]>();
    const givenIds = new Map<string, number[]>();
    for (const v of good) {
      const r = v.row as OrderRow;
      if (r.conversation_id) givenIds.set(r.conversation_id, [...(givenIds.get(r.conversation_id) ?? []), v.index]);
      const p = normalizePhone(r.phone);
      if (p) phones.set(p, [...(phones.get(p) ?? []), v.index]);
      else if (r.customer_name) names.set(r.customer_name.toLowerCase(), [...(names.get(r.customer_name.toLowerCase()) ?? []), v.index]);
    }
    const convFor = async (filter: (q: any) => any) => {
      const { data, error } = await filter(db.from("conversation_outcomes").select("id,contact_id,contact_name,started_at,paid_orders").eq("workspace_id", ws)).limit(500);
      if (error) throw new Error("match lookup failed");
      return (data ?? []) as { id: string; contact_id: string; contact_name: string | null; started_at: string | null; paid_orders: number }[];
    };
    const toMatch = (c: { id: string; contact_name: string | null; started_at: string | null; paid_orders: number }, confidence: Match["confidence"]): Match =>
      ({ conversation_id: c.id, contact_name: c.contact_name, confidence, started_at: c.started_at, already_has_order: c.paid_orders > 0 });
    try {
      if (givenIds.size) {
        const found = await convFor((q) => q.in("id", [...givenIds.keys()]));
        const byId = new Map(found.map((c) => [c.id, c]));
        for (const [id, idxs] of givenIds) for (const i of idxs) {
          const c = byId.get(id);
          if (!c) { results.push({ index: i, status: "rejected", reason: "conversation_id does not belong to this workspace" }); matchByIndex.set(i, { match: null, matches: [] }); }
          else matchByIndex.set(i, { match: toMatch(c, "exact"), matches: [toMatch(c, "exact")] });
        }
      }
      if (phones.size) {
        const { data: contacts, error } = await db.from("contacts").select("id,wa_id").eq("workspace_id", ws).in("wa_id", [...phones.keys()]);
        if (error) throw new Error("match lookup failed");
        const contactIds = (contacts ?? []).map((c) => c.id);
        const convs = contactIds.length ? await convFor((q) => q.in("contact_id", contactIds)) : [];
        const byContact = new Map<string, typeof convs>();
        for (const c of convs) byContact.set(c.contact_id, [...(byContact.get(c.contact_id) ?? []), c]);
        for (const c of contacts ?? []) {
          const list = byContact.get(c.id) ?? [];
          for (const i of phones.get(c.wa_id) ?? []) {
            if (matchByIndex.has(i)) continue;
            if (list.length === 1) matchByIndex.set(i, { match: toMatch(list[0], "exact"), matches: list.map((x) => toMatch(x, "exact")) });
            else if (list.length > 1) matchByIndex.set(i, { match: null, matches: list.map((x) => toMatch(x, "ambiguous")) });
          }
        }
      }
      if (names.size) {
        const wanted = [...names.keys()];
        const found = await convFor((q) => q.not("contact_name", "is", null));
        for (const c of found) {
          const key = (c.contact_name ?? "").toLowerCase().replace(/✅/g, "").trim();
          if (!wanted.includes(key)) continue;
          for (const i of names.get(key) ?? []) {
            const cur = matchByIndex.get(i) ?? { match: null, matches: [] };
            cur.matches.push(toMatch(c, "name"));
            matchByIndex.set(i, cur);
          }
        }
        for (const [, idxs] of names) for (const i of idxs) {
          const cur = matchByIndex.get(i);
          if (cur && !cur.match && cur.matches.length === 1) cur.match = { ...cur.matches[0], confidence: "name" };
        }
      }
    } catch { return json({ error: "could not match rows to chats" }, 500); }
  }

  const rejectedIdx = new Set(results.filter((r) => r.status === "rejected").map((r) => r.index));
  for (const v of good) {
    if (rejectedIdx.has(v.index)) continue;
    const ref = kind === "inquiries" ? (v as any).csv_key : refs[good.indexOf(v)];
    const m = matchByIndex.get(v.index);
    if (existingRefs.has(ref)) results.push({ index: v.index, status: "duplicate", reason: "already imported (same reference)", match: m?.match ?? null, matches: m?.matches ?? [] });
    else results.push({ index: v.index, status: "ready", match: m?.match ?? null, matches: m?.matches ?? [] });
  }
  results.sort((a, b) => a.index - b.index);
  const summary = () => ({
    total: rows.length,
    ready: results.filter((r) => r.status === "ready").length,
    duplicates: results.filter((r) => r.status === "duplicate").length,
    rejected: results.filter((r) => r.status === "rejected").length,
    matched: results.filter((r) => r.match).length,
    unmatched: results.filter((r) => r.status === "ready" && !r.match).length,
  });
  if (dryRun) return json({ dry_run: true, currency, results, summary: summary() });

  // ---------- write (only rows marked ready; links only where the user confirmed them) ----------
  const confirmedLinks: Record<string, string | null> = body.links ?? {};   // row index -> conversation_id (or null to leave unlinked)
  const readyIdx = new Set(results.filter((r) => r.status === "ready").map((r) => r.index));
  const { data: batch, error: batchError } = await db.from("import_batches").insert({ workspace_id: ws, kind, file_name: String(body.file_name ?? "").slice(0, 120), created_by: uid }).select("id").single();
  if (batchError || !batch) return json({ error: "could not start the import batch" }, 500);
  let created = 0, skipped = 0;
  const failures: RowResult[] = [];
  const allowedIds = new Set<string>();
  for (const r of results) for (const m of r.matches ?? []) allowedIds.add(m.conversation_id);
  for (const r of results) if (r.match) allowedIds.add(r.match.conversation_id);

  for (const v of good) {
    if (!readyIdx.has(v.index)) { if (!rejectedIdx.has(v.index)) skipped++; continue; }
    const i = good.indexOf(v);
    try {
      if (kind === "orders") {
        const r = v.row as OrderRow & { amount: number; discount: number; date: string };
        let link = confirmedLinks[String(v.index)];
        if (link === undefined) link = results.find((x) => x.index === v.index)?.match?.confidence === "exact" ? results.find((x) => x.index === v.index)!.match!.conversation_id : null;
        if (link && !allowedIds.has(link)) throw new Error("link not offered for this row");
        const { error } = await db.from("orders").insert({
          workspace_id: ws, conversation_id: link ?? null, amount: r.amount, discount: r.discount, currency, status: r.status,
          fulfillment_status: r.fulfillment ?? "not_applicable", product: r.product ?? null, notes: r.notes ?? null,
          occurred_at: r.date, paid_at: r.status === "paid" ? r.date : null, provenance: "csv_import",
          external_ref: refs[i], import_batch_id: batch.id, created_by: uid, updated_by: uid,
        });
        if (error) throw new Error(error.code === "23505" ? "already imported" : "could not save order");
      } else if (kind === "expenses") {
        const r = v.row as ExpenseRow & { amount: number; date: string; category: string };
        const { error } = await db.from("expenses").insert({
          workspace_id: ws, day: r.date.slice(0, 10), category: r.category, amount: r.amount, currency, note: r.note ?? null,
          external_ref: refs[i], import_batch_id: batch.id, created_by: uid,
        });
        if (error) throw new Error(error.code === "23505" ? "already imported" : "could not save expense");
      } else {
        const r = v.row as InquiryRow & { date: string; customer_name: string; source: string };
        const res = results.find((x) => x.index === v.index);
        const choice = confirmedLinks[String(v.index)];
        // Skip when the user kept a match (the chat already exists here); create only when they chose "create new" or nothing matched.
        if (choice || (choice === undefined && res?.match)) { skipped++; continue; }
        const key = (v as any).csv_key as string;
        const { data: c, error: e1 } = await db.from("contacts").upsert({ workspace_id: ws, wa_id: key, name: r.customer_name }, { onConflict: "workspace_id,wa_id" }).select("id").single();
        if (e1 || !c) throw new Error("could not save inquiry");
        const { error: e2 } = await db.from("conversations").upsert({
          workspace_id: ws, contact_id: c.id, phone_number_id: "import", started_at: r.date, last_message_at: r.date,
          source: r.source, source_label: r.source_label ?? null, label: "new", stage: "no_reply", auto_outcome: "lost", analyzed_at: new Date().toISOString(),
        }, { onConflict: "workspace_id,contact_id,phone_number_id", ignoreDuplicates: true });
        if (e2) throw new Error("could not save inquiry");
      }
      created++;
    } catch (e) {
      failures.push({ index: v.index, status: "skipped", reason: String((e as Error).message).slice(0, 120) });
    }
  }
  const s = summary();
  const finalSummary = { ...s, created, skipped: skipped + failures.length };
  await db.from("import_batches").update({ created_count: created, skipped_count: skipped + failures.length, rejected_count: s.rejected, summary: finalSummary }).eq("id", batch.id);
  return json({ dry_run: false, batch_id: batch.id, created, skipped: skipped + failures.length, rejected: s.rejected, failures, currency });
});

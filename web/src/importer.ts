// Parses WhatsApp "Export chat" files (.txt, or .zip from iPhone) in the browser.
import JSZip from "jszip";

export type ParsedMsg = { t: number; sender: string; text: string };
export type ParsedChat = { file: string; title: string; msgs: ParsedMsg[] };

// Android: 13/11/2026, 21:03 - Name: text     iOS: [13/11/2026, 21:03:45] Name: text
const RE_ANDROID = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?\s+[-–]\s+(.*)$/;
const RE_IOS = /^\[(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?\]\s+(.*)$/;
const SYSTEM = /end-to-end encrypted|security code (changed|ilibadilika)|is a contact|joined using|created group|usimbaji fiche/i;
const AD_PREFILL = /(naweza kupata maelezo zaidi|can i get more info|more info(rmation)? (on|about) this|nataka kujua zaidi kuhusu hili|i'?m interested in this|nimeona tangazo|i saw your ad)/i;

export function parseWhatsApp(text: string, fileName: string): ParsedChat {
  text = text.replace(/^﻿/, "").replace(/[‎‏‪-‮]/g, "").replace(/ /g, " ");
  const raw: { p: string[]; rest: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(RE_IOS) || line.match(RE_ANDROID);
    if (m) raw.push({ p: m.slice(1, 8), rest: m[8] });
    else if (raw.length && line.trim()) raw[raw.length - 1].rest += "\n" + line;
  }
  // day/month order: default D/M (Tanzania); switch to M/D only if the data proves it
  let dm = true;
  if (raw.some((r) => +r.p[1] > 12)) dm = false;
  if (raw.some((r) => +r.p[0] > 12)) dm = true;
  const msgs: ParsedMsg[] = [];
  for (const r of raw) {
    const [a, b, yy, hh, mm, ss, ap] = r.p;
    const d = dm ? +a : +b, mo = dm ? +b : +a;
    let y = +yy; if (y < 100) y += 2000;
    let H = +hh;
    if (ap) { const pm = /p/i.test(ap); if (pm && H < 12) H += 12; if (!pm && H === 12) H = 0; }
    const t = new Date(y, mo - 1, d, H, +mm, +(ss || 0)).getTime();
    const idx = r.rest.indexOf(": ");
    if (idx < 0 || isNaN(t)) continue; // system line
    const body = r.rest.slice(idx + 2).trim();
    if (SYSTEM.test(body)) continue;
    msgs.push({ t, sender: r.rest.slice(0, idx).trim(), text: body });
  }
  const title = (fileName.match(/WhatsApp Chat (?:with|na|-)\s*(.+?)(?:\.txt|\.zip)?$/i) || [])[1] || "";
  return { file: fileName, title: title.trim(), msgs };
}

export async function readFiles(files: File[]): Promise<ParsedChat[]> {
  const out: ParsedChat[] = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      const zip = await JSZip.loadAsync(f);
      for (const name of Object.keys(zip.files)) {
        if (!/\.txt$/i.test(name) || zip.files[name].dir) continue;
        const base = name.split("/").pop()!;
        const label = /^_chat\.txt$/i.test(base) ? f.name.replace(/\.zip$/i, ".txt") : base;
        out.push(parseWhatsApp(await zip.files[name].async("string"), label));
      }
    } else out.push(parseWhatsApp(await f.text(), f.name));
  }
  return out.filter((c) => c.msgs.length > 0);
}

/** The business is the sender that appears in the most chats. */
export function guessBusiness(chats: ParsedChat[]): string {
  const count: Record<string, number> = {};
  for (const c of chats) for (const s of new Set(c.msgs.map((m) => m.sender))) count[s] = (count[s] || 0) + 1;
  const ranked = Object.entries(count).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return "";
  if (chats.length === 1) {
    const other = ranked.find(([s]) => s.toLowerCase() !== chats[0].title.toLowerCase());
    return other ? other[0] : ranked[0][0];
  }
  return ranked[0][0];
}

export function senders(chats: ParsedChat[]): [string, number][] {
  const count: Record<string, number> = {};
  for (const c of chats) for (const s of new Set(c.msgs.map((m) => m.sender))) count[s] = (count[s] || 0) + 1;
  return Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 40);
}

export function toPayload(chat: ParsedChat, business: string) {
  const customer = chat.title || chat.msgs.find((m) => m.sender !== business)?.sender || chat.file;
  const firstIn = chat.msgs.find((m) => m.sender !== business);
  return {
    name: customer,
    from_ad: !!(firstIn && AD_PREFILL.test(firstIn.text)),
    messages: chat.msgs.map((m) => ({ direction: m.sender === business ? "out" : "in", sent_at: new Date(m.t).toISOString(), body: m.text })),
  };
}

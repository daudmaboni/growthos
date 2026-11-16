import { useState } from "react";
import { callFn, Workspace } from "./lib";
import { readFiles, guessBusiness, senders, toPayload, ParsedChat } from "./importer";

export default function ImportChats({ ws }: { ws: Workspace }) {
  const [chats, setChats] = useState<ParsedChat[]>([]);
  const [business, setBusiness] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    setMsg({}); setChats([]);
    if (!files.length) return;
    try {
      const parsed = await readFiles(files);
      if (!parsed.length) throw new Error("No messages found in these files. Use WhatsApp's own \"Export chat\" file (.txt or .zip).");
      setChats(parsed); setBusiness(guessBusiness(parsed));
    } catch (err) { setMsg({ err: (err as Error).message }); }
  }

  async function upload() {
    setBusy(true); setMsg({});
    let imported = 0, messages = 0;
    try {
      const payload = chats.map((c) => toPayload(c, business));
      for (let i = 0; i < payload.length; i += 5) {
        setProgress(`Uploading ${Math.min(i + 5, payload.length)} of ${payload.length}…`);
        const r = await callFn<{ imported: number; messages: number }>("chat-import", { workspace_id: ws.id, chats: payload.slice(i, i + 5) });
        imported += r.imported; messages += r.messages;
      }
      setMsg({ ok: `Imported ${imported} chats (${messages} messages). Open the Dashboard or Chats to see them.` });
      setChats([]);
    } catch (err) {
      setMsg({ err: `${(err as Error).message}${imported ? ` (${imported} chats were imported before the error.)` : ""}` });
    }
    setBusy(false); setProgress("");
  }

  const total = chats.reduce((s, c) => s + c.msgs.length, 0);
  const oneSided = chats.filter((c) => !c.msgs.some((m) => m.sender === business)).length;

  return (
    <section className="card">
      <h2>Upload WhatsApp chats</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Use this until WhatsApp is connected. In each chat: ⋮ → More → Export chat → Without media. Pick many files at once.
        Uploading the same chat again updates it and doesn't create a duplicate.
      </p>
      <input type="file" id="chatfiles" aria-label="WhatsApp chat export files" accept=".txt,.zip,text/plain,application/zip" multiple onChange={pick} disabled={busy} />
      {chats.length > 0 && (
        <>
          <div className="row">
            <label htmlFor="bizsender"><b>Which sender is the business?</b></label>
            <select id="bizsender" value={business} onChange={(e) => setBusiness(e.target.value)} disabled={busy}>
              {senders(chats).map(([s, n]) => <option key={s} value={s}>{s} (in {n} chat{n > 1 ? "s" : ""})</option>)}
            </select>
          </div>
          <p className="small" style={{ margin: 0 }}>
            {chats.length} chats, {total} messages ready.
            {oneSided > 0 && <span className="err"> {oneSided} chat{oneSided > 1 ? "s have" : " has"} no message from "{business}". Check the sender above.</span>}
          </p>
          <div className="row">
            <button className="primary" onClick={upload} disabled={busy || !business}>{busy ? progress || "Uploading…" : `Import ${chats.length} chats`}</button>
          </div>
        </>
      )}
      {msg.ok && <p className="ok">{msg.ok}</p>}
      {msg.err && <p className="err">{msg.err}</p>}
    </section>
  );
}

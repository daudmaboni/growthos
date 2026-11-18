// Content intelligence foundation. The Meta app has no content/insights permissions yet, so
// this view says so plainly and offers a manual path: record posts and their engagement, link
// them to inquiries through the source label, and keep content ideas as editable drafts.
import { useEffect, useMemo, useState } from "react";
import { enterCards, enterRows, usePageEnter, select } from "./motion";
import { supabase, callFn, Workspace, fmt, when, canEdit, localDay } from "./lib";

type Post = { id: string; platform: string; posted_at: string; caption: string | null; format: string | null; theme: string | null; hook: string | null; offer: string | null; reach: number | null; impressions: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; link_clicks: number | null; source_label: string | null; source: string };
type Idea = { id: string; title: string; draft: string | null; theme: string | null; hook: string | null; offer: string | null; format: string | null; planned_for: string | null; status: "draft" | "planned" | "used" | "dropped"; source: string; updated_at: string };
type Link = { source_label: string; chats: number; sold: number; revenue: number };

const engagement = (p: Post) => (p.likes ?? 0) + (p.comments ?? 0) * 2 + (p.shares ?? 0) * 3 + (p.saves ?? 0) * 3;
const engRate = (p: Post) => (p.reach ? engagement(p) / p.reach : null);

export default function Content({ ws }: { ws: Workspace }) {
  const lang = ws.language; const T = (en: string, sw: string) => (lang === "sw" ? sw : en);
  const [posts, setPosts] = useState<Post[]>([]);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [tick, setTick] = useState(0);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const editor = canEdit(ws);
  const refresh = () => setTick((t) => t + 1);

  useEffect(() => {
    let live = true;
    Promise.all([
      supabase.from("content_posts").select("*").eq("workspace_id", ws.id).order("posted_at", { ascending: false }).limit(200),
      supabase.from("content_ideas").select("*").eq("workspace_id", ws.id).neq("status", "dropped").order("planned_for", { ascending: true, nullsFirst: false }).limit(100),
      supabase.from("conversation_outcomes").select("source_label,paid_orders,sale_amount").eq("workspace_id", ws.id).not("source_label", "is", null).limit(5000),
    ]).then(([p, i, c]) => {
      if (!live) return;
      const e = p.error || i.error || c.error; if (e) setErr(e.message);
      setPosts((p.data as Post[]) ?? []); setIdeas((i.data as Idea[]) ?? []);
      const agg: Record<string, Link> = {};
      for (const r of (c.data as any[]) ?? []) { const k = r.source_label; agg[k] = agg[k] ?? { source_label: k, chats: 0, sold: 0, revenue: 0 }; agg[k].chats++; if (Number(r.paid_orders) > 0) { agg[k].sold++; agg[k].revenue += Number(r.sale_amount ?? 0); } }
      setLinks(Object.values(agg)); setLoading(false);
    });
    return () => { live = false; };
  }, [ws.id, tick]);

  const ranked = useMemo(() => [...posts].sort((a, b) => (engRate(b) ?? -1) - (engRate(a) ?? -1) || engagement(b) - engagement(a)), [posts]);
  const byTheme = useMemo(() => {
    const t: Record<string, { posts: number; eng: number; reach: number; chats: number; sold: number }> = {};
    for (const p of posts) { const k = p.theme || T("(no theme)", "(hakuna mada)"); t[k] = t[k] ?? { posts: 0, eng: 0, reach: 0, chats: 0, sold: 0 }; t[k].posts++; t[k].eng += engagement(p); t[k].reach += p.reach ?? 0; const l = links.find((x) => x.source_label === p.source_label); if (l) { t[k].chats += l.chats; t[k].sold += l.sold; } }
    return Object.entries(t).sort((a, b) => b[1].eng - a[1].eng);
  }, [posts, links, lang]);
  const linkCoverage = posts.length ? posts.filter((p) => p.source_label && links.some((l) => l.source_label === p.source_label)).length / posts.length : null;

  const pageRef = usePageEnter<HTMLDivElement>((root) => { if (loading) return; enterCards(select(root, ":scope > .card, .hero"), { stagger: 0.06 }); enterRows(select(root, "table tbody tr"), { delay: 0.3, stagger: 0.03 }); }, [loading]);

  async function askIdeas() {
    setBusy(true); setErr("");
    try {
      const r = await callFn<{ ideas: { title: string; draft: string; theme: string; hook: string; offer: string; format: string; based_on: string }[] }>("kito", { workspace_id: ws.id, action: "content_ideas" });
      if (!r.ideas.length) throw new Error(T("Kito returned no ideas.", "Kito hakurudisha mawazo."));
      const { data: user } = await supabase.auth.getUser();
      const { error } = await supabase.from("content_ideas").insert(r.ideas.map((i) => ({ workspace_id: ws.id, title: i.title, draft: `${i.draft}\n\n(${T("Based on", "Kwa msingi wa")}: ${i.based_on})`, theme: i.theme || null, hook: i.hook || null, offer: i.offer || null, format: i.format || null, source: "kito", status: "draft", created_by: user.user?.id })));
      if (error) throw error;
      refresh();
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }

  if (loading) return <div className="skeletons" aria-busy="true"><div className="skeleton" style={{ minHeight: 90 }} /><div className="skeleton" style={{ minHeight: 300 }} /></div>;
  return (
    <div className="shell-grid" ref={pageRef}>
      <div className="hero">
        <div style={{ display: "grid", gap: 4 }}><h2>{T("Content", "Maudhui")}</h2><div className="sub"><span>{posts.length} {T("posts recorded", "machapisho yaliyorekodiwa")}</span><span>{ideas.length} {T("ideas", "mawazo")}</span></div></div>
      </div>
      {err && <p className="err">{err}</p>}
      <div className="finding warn">
        <b>{T("Facebook / Instagram content is not connected", "Maudhui ya Facebook / Instagram hayajaunganishwa")}</b>
        <span className="small">{T("The Meta app only has ad-reading and WhatsApp permissions, so post performance cannot be pulled automatically yet. Record posts here (or import them from a CSV export of Meta Business Suite) and itaOS will compare them with inquiries and confirmed sales. Nothing on this page is published to Meta.", "App ya Meta ina ruhusa za matangazo na WhatsApp tu, kwa hiyo utendaji wa machapisho hauwezi kuvutwa moja kwa moja bado. Rekodi machapisho hapa na itaOS italinganisha na maulizo na mauzo. Hakuna kinachochapishwa Meta kutoka hapa.")}</span>
      </div>

      <section className="card">
        <div className="row between"><h2>{T("Posts and engagement", "Machapisho na mwitikio")}</h2>{editor && <button className="small primary" onClick={() => setAdding(!adding)}>{adding ? T("Close", "Funga") : T("Record a post", "Rekodi chapisho")}</button>}</div>
        <span className="small muted">{T("Engagement score = likes + 2×comments + 3×(shares + saves). Rate = score ÷ reach. Engagement is not sales: the sales columns come only from chats whose source label matches the post's label.", "Alama ya mwitikio = likes + 2×maoni + 3×(shares + saves). Kiwango = alama ÷ reach. Mwitikio si mauzo: safu za mauzo zinatoka kwenye chats zenye lebo inayolingana na chapisho.")}{linkCoverage != null ? ` · ${T("link coverage", "ukamilifu wa uhusiano")}: ${Math.round(linkCoverage * 100)}%` : ""}</span>
        {adding && <PostForm ws={ws} onDone={() => { setAdding(false); refresh(); }} />}
        {ranked.length === 0 ? <div className="empty">{T("No posts recorded yet.", "Hakuna machapisho bado.")}</div> : (
          <div className="scroll"><table>
            <thead><tr><th>#</th><th>{T("Post", "Chapisho")}</th><th>{T("Theme / hook / offer", "Mada / hook / ofa")}</th><th className="n">Reach</th><th className="n">{T("Score", "Alama")}</th><th className="n">{T("Rate", "Kiwango")}</th><th className="n">{T("Chats (matched)", "Chats")}</th><th className="n">{T("Sold (confirmed)", "Mauzo")}</th></tr></thead>
            <tbody>{ranked.map((p, i) => {
              const l = p.source_label ? links.find((x) => x.source_label === p.source_label) : undefined;
              return (
                <tr key={p.id}>
                  <td className="rank">{String(i + 1).padStart(2, "0")}</td>
                  <td><b>{(p.caption ?? "").slice(0, 60) || p.format || "–"}</b><div className="small muted">{p.platform} · {localDay(p.posted_at, ws.timezone)} · {p.format ?? ""}{p.source_label ? ` · ${T("label", "lebo")}: ${p.source_label}` : ""} · {p.source}</div></td>
                  <td className="small">{[p.theme, p.hook, p.offer].filter(Boolean).join(" / ") || "–"}</td>
                  <td className="n">{fmt(p.reach)}</td><td className="n">{fmt(engagement(p))}</td><td className="n">{engRate(p) == null ? "–" : (engRate(p)! * 100).toFixed(1) + "%"}</td>
                  <td className="n">{l ? fmt(l.chats) : <span className="muted">–</span>}</td><td className="n">{l ? <b>{fmt(l.sold)}</b> : <span className="muted">–</span>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
        {byTheme.length > 0 && (
          <><h3>{T("By theme", "Kwa mada")}</h3>
            <div className="scroll"><table><thead><tr><th>{T("Theme", "Mada")}</th><th className="n">{T("Posts", "Machapisho")}</th><th className="n">{T("Score", "Alama")}</th><th className="n">Reach</th><th className="n">{T("Chats", "Chats")}</th><th className="n">{T("Sold", "Mauzo")}</th></tr></thead>
              <tbody>{byTheme.map(([k, v]) => <tr key={k}><td>{k}</td><td className="n">{v.posts}</td><td className="n">{fmt(v.eng)}</td><td className="n">{fmt(v.reach)}</td><td className="n">{fmt(v.chats)}</td><td className="n">{fmt(v.sold)}</td></tr>)}</tbody></table></div></>
        )}
      </section>

      <section className="card">
        <div className="row between"><h2>{T("Content ideas and calendar", "Mawazo na kalenda ya maudhui")}</h2>
          <div className="row">{editor && <button className="small" disabled={busy} onClick={askIdeas}>{busy ? "…" : T("Ask Kito for ideas (drafts)", "Muombe Kito mawazo (rasimu)")}</button>}{editor && <IdeaAdd ws={ws} onDone={refresh} />}</div>
        </div>
        <span className="small muted">{T("Ideas are editable drafts based on your business profile and recorded patterns. Nothing is published automatically.", "Mawazo ni rasimu zinazoweza kuhaririwa. Hakuna kinachochapishwa moja kwa moja.")}</span>
        {ideas.length === 0 ? <div className="empty">{T("No ideas yet.", "Hakuna mawazo bado.")}</div> : <div className="queue">{ideas.map((i) => <IdeaCard key={i.id} i={i} ws={ws} editor={editor} onChange={refresh} />)}</div>}
      </section>
    </div>
  );
}

function PostForm({ ws, onDone }: { ws: Workspace; onDone: () => void }) {
  const lang = ws.language; const T = (en: string, sw: string) => (lang === "sw" ? sw : en);
  const [f, setF] = useState({ platform: "facebook", posted_at: localDay(new Date(), ws.timezone), caption: "", format: "", theme: "", hook: "", offer: "", reach: "", likes: "", comments: "", shares: "", saves: "", link_clicks: "", source_label: "" });
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const n = (v: string) => (v.trim() === "" ? null : Number(v.replace(/[^\d]/g, "")));
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr("");
    const { data: user } = await supabase.auth.getUser();
    const { error } = await supabase.from("content_posts").insert({
      workspace_id: ws.id, platform: f.platform, posted_at: new Date(f.posted_at + "T12:00:00+03:00").toISOString(), caption: f.caption.trim() || null, format: f.format.trim() || null, theme: f.theme.trim() || null, hook: f.hook.trim() || null, offer: f.offer.trim() || null,
      reach: n(f.reach), likes: n(f.likes), comments: n(f.comments), shares: n(f.shares), saves: n(f.saves), link_clicks: n(f.link_clicks), source_label: f.source_label.trim() || null, source: "manual", created_by: user.user?.id,
    });
    setBusy(false); if (error) setErr(error.message); else onDone();
  }
  const up = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="card" style={{ background: "var(--paper)", gap: 8 }} onSubmit={save}>
      <div className="map">
        <label>{T("Platform", "Jukwaa")}<select value={f.platform} onChange={up("platform")}><option value="facebook">Facebook</option><option value="instagram">Instagram</option><option value="other">{T("Other", "Nyingine")}</option></select></label>
        <label>{T("Date", "Tarehe")}<input type="date" required value={f.posted_at} onChange={up("posted_at")} /></label>
        <label>{T("Format", "Umbo")}<input placeholder="reel / image / carousel / story" value={f.format} onChange={up("format")} /></label>
        <label style={{ gridColumn: "1 / -1" }}>{T("Caption (first line is enough)", "Maneno (mstari wa kwanza unatosha)")}<input value={f.caption} onChange={up("caption")} /></label>
        <label>{T("Theme", "Mada")}<input value={f.theme} onChange={up("theme")} /></label>
        <label>{T("Hook", "Hook")}<input value={f.hook} onChange={up("hook")} /></label>
        <label>{T("Offer", "Ofa")}<input value={f.offer} onChange={up("offer")} /></label>
        <label>Reach<input inputMode="numeric" value={f.reach} onChange={up("reach")} /></label>
        <label>Likes<input inputMode="numeric" value={f.likes} onChange={up("likes")} /></label>
        <label>{T("Comments", "Maoni")}<input inputMode="numeric" value={f.comments} onChange={up("comments")} /></label>
        <label>Shares<input inputMode="numeric" value={f.shares} onChange={up("shares")} /></label>
        <label>Saves<input inputMode="numeric" value={f.saves} onChange={up("saves")} /></label>
        <label>{T("Link clicks", "Mibofyo")}<input inputMode="numeric" value={f.link_clicks} onChange={up("link_clicks")} /></label>
        <label>{T("Source label (matches chats' source label)", "Lebo ya chanzo (inalingana na lebo ya chats)")}<input value={f.source_label} onChange={up("source_label")} /></label>
      </div>
      {err && <span className="err small">{err}</span>}
      <div className="row"><button className="small primary" disabled={busy}>{T("Save post", "Hifadhi chapisho")}</button></div>
    </form>
  );
}

function IdeaAdd({ ws, onDone }: { ws: Workspace; onDone: () => void }) {
  const lang = ws.language; const T = (en: string, sw: string) => (lang === "sw" ? sw : en);
  return <button className="small" onClick={async () => {
    const title = prompt(T("Idea title", "Kichwa cha wazo")); if (!title?.trim()) return;
    const { data: user } = await supabase.auth.getUser();
    await supabase.from("content_ideas").insert({ workspace_id: ws.id, title: title.trim().slice(0, 120), source: "manual", created_by: user.user?.id });
    onDone();
  }}>{T("+ Add idea", "+ Ongeza wazo")}</button>;
}

function IdeaCard({ i, ws, editor, onChange }: { i: Idea; ws: Workspace; editor: boolean; onChange: () => void }) {
  const lang = ws.language; const T = (en: string, sw: string) => (lang === "sw" ? sw : en);
  const [draft, setDraft] = useState(i.draft ?? "");
  const [planned, setPlanned] = useState(i.planned_for ?? "");
  const [busy, setBusy] = useState(false);
  const patch = async (p: Partial<Idea>) => { setBusy(true); await supabase.from("content_ideas").update(p).eq("id", i.id).eq("workspace_id", ws.id); setBusy(false); onChange(); };
  return (
    <div className="qitem">
      <div><b>{i.title}</b><div className="small muted">{[i.format, i.theme, i.hook].filter(Boolean).join(" · ")} · {i.source === "kito" ? T("drafted by Kito", "rasimu ya Kito") : T("yours", "yako")} · <span className={"pill " + (i.status === "used" ? "sold" : i.status === "planned" ? "open" : "")}>{i.status}</span></div>
        {editor && <label className="small muted" style={{ display: "block", marginTop: 6 }}>{T("Planned for", "Imepangwa")} <input type="date" value={planned} disabled={busy} onChange={(e) => { setPlanned(e.target.value); patch({ planned_for: e.target.value || null, status: e.target.value ? "planned" : i.status }); }} /></label>}
      </div>
      <div><div className="draft-label">{T("Draft — not published", "Rasimu — haijachapishwa")}</div><textarea value={draft} disabled={!editor || busy} onChange={(e) => setDraft(e.target.value)} />
        {editor && <div className="row" style={{ gap: 6, marginTop: 6 }}><button className="small" disabled={busy || draft === (i.draft ?? "")} onClick={() => patch({ draft })}>{T("Save draft", "Hifadhi")}</button><button className="small" disabled={!draft} onClick={() => navigator.clipboard.writeText(draft).catch(() => {})}>{T("Copy", "Nakili")}</button></div>}
      </div>
      {editor && <div className="row" style={{ gap: 6, flexDirection: "column", alignItems: "stretch" }}>
        <button className="small primary" disabled={busy} onClick={() => patch({ status: "used" })}>{T("Mark used", "Imetumika")}</button>
        <button className="small" disabled={busy} onClick={() => patch({ status: "dropped" })}>{T("Drop", "Ondoa")}</button>
      </div>}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import Logo from "./Logo";
import { hidePreloader } from "./preloader";
import "./home.css";

/** Public homepage at "/". The app itself lives at "/app". */
const APP = "/app";

export default function Home() {
  const root = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    hidePreloader();
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    // Reveal sections as they scroll into view.
    const els = root.current?.querySelectorAll<HTMLElement>("[data-reveal]") ?? [];
    let io: IntersectionObserver | undefined;
    if ("IntersectionObserver" in window && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      io = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io!.unobserve(e.target); }
      }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
      els.forEach((el) => io!.observe(el));
    } else els.forEach((el) => el.classList.add("in"));

    return () => { window.removeEventListener("scroll", onScroll); io?.disconnect(); };
  }, []);

  const close = () => setMenu(false);

  return (
    <div className="hp" ref={root}>
      <header className={"hp-nav" + (scrolled ? " solid" : "")}>
        <div className="hp-wrap hp-nav-in">
          <a href="/" className="hp-brand" aria-label="GrowthOS home"><Logo size={32} /><span>GrowthOS</span></a>
          <nav className={"hp-links" + (menu ? " open" : "")} aria-label="Main">
            <a href="#services" onClick={close}>Services</a>
            <a href="#how" onClick={close}>How it works</a>
            <a href="#kito" onClick={close}>Kito AI</a>
            <a href="#trust" onClick={close}>Why GrowthOS</a>
            <a href={APP} className="hp-signin-m">Sign in</a>
          </nav>
          <div className="hp-nav-cta">
            <a href={APP} className="hp-signin">Sign in</a>
            <a href={APP} className="hp-btn hp-btn-sm">Get started</a>
            <button className="hp-burger" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><span /><span /></button>
          </div>
        </div>
      </header>

      <main>
        {/* HERO */}
        <section className="hp-hero">
          <div className="hp-glow" aria-hidden="true" />
          <div className="hp-wrap hp-hero-in">
            <div className="hp-hero-copy" data-reveal>
              <span className="hp-pill"><i className="hp-live" />Ads → WhatsApp → Sales intelligence</span>
              <h1>Know which ads bring <em>paying customers</em>, not just chats.</h1>
              <p className="hp-lead">GrowthOS connects your Meta ads and WhatsApp Business, reads every conversation, and shows you exactly where money is made and where customers drop off — in Kiswahili and English.</p>
              <div className="hp-ctas">
                <a href={APP} className="hp-btn">Get started <Arrow /></a>
                <a href="#how" className="hp-btn hp-btn-ghost">See how it works</a>
              </div>
              <ul className="hp-ticks">
                <li><Check />Built for businesses selling on WhatsApp</li>
                <li><Check />Kiswahili & English</li>
              </ul>
            </div>

            <div className="hp-mock" data-reveal aria-hidden="true">
              <div className="hp-mock-bar"><i /><i /><i /><span>GrowthOS · Dashboard</span></div>
              <div className="hp-mock-body">
                <div className="hp-kpis">
                  <Kpi label="Ad spend" value="TSh 1.2M" delta="This week" />
                  <Kpi label="Chats from ads" value="486" delta="+18%" up />
                  <Kpi label="Paid orders" value="73" delta="+11%" up />
                  <Kpi label="Revenue" value="TSh 4.9M" delta="+22%" up />
                </div>
                <div className="hp-chart">
                  <div className="hp-chart-h"><b>Chats → paid orders</b><span>Last 8 weeks</span></div>
                  <div className="hp-bars">
                    {[38, 52, 44, 61, 57, 72, 66, 84].map((h, i) => (
                      <span key={i} style={{ ["--h" as any]: h + "%", ["--d" as any]: i * 70 + "ms" }}><i style={{ height: Math.round(h * 0.42) + "%" }} /></span>
                    ))}
                  </div>
                </div>
                <div className="hp-insight">
                  <span className="hp-spark">✦</span>
                  <div><b>Kito:</b> 14 customers received your Lipa namba but haven't paid. Most came from the "Offer ya Wiki" ad.</div>
                </div>
              </div>
              <p className="hp-sample">Sample data</p>
            </div>
          </div>
        </section>

        {/* STRIP */}
        <section className="hp-strip">
          <div className="hp-wrap hp-strip-in" data-reveal>
            <span>Works with</span>
            <b>Meta Ads Manager</b><b>WhatsApp Business</b><b>Facebook & Instagram</b><b>CSV orders & expenses</b>
          </div>
        </section>

        {/* SERVICES */}
        <section className="hp-sec" id="services">
          <div className="hp-wrap">
            <div className="hp-head" data-reveal>
              <span className="hp-eyebrow">What we do</span>
              <h2>Everything between your ad and the payment</h2>
              <p>Most businesses can see clicks and chats. GrowthOS shows what happens after — who replied, who got a price, who paid, and which ad brought them.</p>
            </div>
            <div className="hp-grid">
              {SERVICES.map((s, i) => (
                <article className="hp-card" key={s.t} data-reveal style={{ ["--d" as any]: (i % 3) * 80 + "ms" }}>
                  <span className="hp-ico">{s.i}</span>
                  <h3>{s.t}</h3>
                  <p>{s.d}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* HOW IT WORKS */}
        <section className="hp-sec hp-alt" id="how">
          <div className="hp-wrap">
            <div className="hp-head" data-reveal>
              <span className="hp-eyebrow">How it works</span>
              <h2>Up and running in three steps</h2>
            </div>
            <ol className="hp-steps">
              {STEPS.map((s, i) => (
                <li key={s.t} data-reveal style={{ ["--d" as any]: i * 100 + "ms" }}>
                  <span className="hp-num">0{i + 1}</span>
                  <h3>{s.t}</h3>
                  <p>{s.d}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* KITO */}
        <section className="hp-sec" id="kito">
          <div className="hp-wrap hp-split">
            <div data-reveal>
              <span className="hp-eyebrow">Meet Kito</span>
              <h2>Your AI analyst that speaks like your customers</h2>
              <p className="hp-p">Kito works in the background, reading and labelling every chat. Ask it anything about your business in plain Kiswahili or English — it answers with real numbers from your data and links you straight to the chats behind them.</p>
              <ul className="hp-list">
                <li><Check />Labels every chat: price asked, Lipa namba sent, paid, lost</li>
                <li><Check />Finds customers who need a follow-up</li>
                <li><Check />Drafts replies for you — nothing is sent without you</li>
              </ul>
            </div>
            <div className="hp-chat" data-reveal aria-hidden="true">
              <div className="hp-msg me">Nani nilimtumia Lipa namba lakini hajalipa?</div>
              <div className="hp-msg kito">
                <b>Wateja 14</b> walitumiwa Lipa namba wiki hii lakini hawajalipa. 9 kati yao walitoka tangazo la <b>"Offer ya Wiki"</b>.
                <div className="hp-chips"><span>Fungua chats</span><span>Andaa ujumbe wa kufuatilia</span></div>
              </div>
              <div className="hp-msg me">Which ads bring paying customers?</div>
              <div className="hp-msg kito typing"><i /><i /><i /></div>
            </div>
          </div>
        </section>

        {/* TRUST */}
        <section className="hp-sec hp-alt" id="trust">
          <div className="hp-wrap">
            <div className="hp-head" data-reveal>
              <span className="hp-eyebrow">Why GrowthOS</span>
              <h2>Numbers you can trust and act on</h2>
            </div>
            <div className="hp-grid hp-grid-4">
              {TRUST.map((s, i) => (
                <div className="hp-trust" key={s.t} data-reveal style={{ ["--d" as any]: i * 70 + "ms" }}>
                  <h3>{s.t}</h3><p>{s.d}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="hp-sec">
          <div className="hp-wrap">
            <div className="hp-cta" data-reveal>
              <h2>Stop guessing which ads work.</h2>
              <p>Connect your ads and WhatsApp and see where your sales really come from.</p>
              <a href={APP} className="hp-btn">Get started <Arrow /></a>
            </div>
          </div>
        </section>
      </main>

      <footer className="hp-foot">
        <div className="hp-wrap hp-foot-in">
          <div className="hp-brand"><Logo size={28} /><span>GrowthOS</span></div>
          <p>A product of Pondi Technologies · Dar es Salaam, Tanzania</p>
          <nav><a href="/privacy.html">Privacy</a><a href={APP}>Sign in</a></nav>
        </div>
        <div className="hp-wrap hp-copy">© {new Date().getFullYear()} Pondi Technologies. All rights reserved.</div>
      </footer>
    </div>
  );
}

function Kpi({ label, value, delta, up }: { label: string; value: string; delta: string; up?: boolean }) {
  return <div className="hp-kpi"><span>{label}</span><b>{value}</b><small className={up ? "up" : ""}>{delta}</small></div>;
}
function Arrow() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>; }
function Check() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>; }
function I({ d }: { d: string }) { return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>; }

const SERVICES = [
  { t: "Ad-to-sale tracking", d: "Link every WhatsApp chat back to the Meta ad that started it, and see cost per chat, cost per sale and return on ad spend.", i: <I d="M3 3v18h18M7 15l4-4 3 3 6-7" /> },
  { t: "WhatsApp chat intelligence", d: "Every conversation is read and labelled automatically — who asked the price, who got your Lipa namba, who paid and who went quiet.", i: <I d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5A8 8 0 1 1 21 12z" /> },
  { t: "Ask Kito, your AI analyst", d: "Ask any question about your sales in Kiswahili or English and get answers backed by your own numbers and chats.", i: <I d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9zM19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" /> },
  { t: "Weekly sales diagnosis", d: "Find the bottleneck: unanswered chats, slow replies, price objections, payment friction or missed follow-ups.", i: <I d="M3 12h4l3-8 4 16 3-8h4" /> },
  { t: "Follow-ups & actions", d: "A follow-up queue for your team with ready-made reply drafts, so warm customers don't go cold.", i: <I d="M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9" /> },
  { t: "Content performance", d: "Track which posts and themes bring real inquiries and sales, and plan your next content with ideas from Kito.", i: <I d="M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5" /> },
];

const STEPS = [
  { t: "Connect your accounts", d: "Link your Meta ad account and WhatsApp Business number in a few clicks. Your existing WhatsApp keeps working as normal." },
  { t: "Kito reads and labels", d: "GrowthOS syncs your ad results and chats, and Kito labels every conversation from first message to payment." },
  { t: "See what pays, then act", d: "Your dashboard shows which ads bring paying customers, where sales stall, and who to follow up with today." },
];

const TRUST = [
  { t: "Confirmed revenue only", d: "Revenue comes from orders you confirm — never guessed from chat messages alone." },
  { t: "Every number explained", d: "Each figure shows where it came from, so you know what's measured and what's estimated." },
  { t: "You stay in control", d: "Kito drafts replies but never sends them. Your team decides what goes to customers." },
  { t: "Secure by design", d: "Access tokens are stored encrypted, and each business only ever sees its own data." },
];

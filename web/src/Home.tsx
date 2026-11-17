import { useEffect, useState, type ReactNode } from "react";
import Logo from "./Logo";
import { hidePreloader } from "./preloader";
import "./home.css";

/** Public homepage at "/". The app itself lives at "/app". */
const APP = "/app";

export default function Home() {
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    hidePreloader();
    document.documentElement.classList.add("hp-page");
    return () => document.documentElement.classList.remove("hp-page");
  }, []);
  useEffect(() => { document.body.style.overflow = menu ? "hidden" : ""; }, [menu]);

  const go = () => setMenu(false);

  return (
    <div className="hp">
      <header className="hp-bar">
        <div className="hp-w hp-bar-in">
          <a href="/" className="hp-logo" aria-label="GrowthOS home"><Logo size={30} /><span>GrowthOS</span></a>
          <nav className="hp-nav" aria-label="Main">
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="#mission">About</a>
            <a href={APP}>Log in</a>
            <a href={APP} className="hp-pill hp-pill-sm">Get started</a>
          </nav>
          <button className="hp-burger" onClick={() => setMenu(true)} aria-label="Open menu"><span /><span /></button>
        </div>
      </header>

      {/* Full-screen mobile menu */}
      <div className={"hp-menu" + (menu ? " open" : "")} aria-hidden={!menu}>
        <div className="hp-w hp-bar-in">
          <a href="/" className="hp-logo" onClick={go}><Logo size={30} /><span>GrowthOS</span></a>
          <button className="hp-x" onClick={go} aria-label="Close menu">✕</button>
        </div>
        <nav>
          <a href="/" onClick={go}>Home</a>
          <a href="#features" onClick={go}>Features</a>
          <a href="#how" onClick={go}>How it works</a>
          <a href="#mission" onClick={go}>About</a>
          <a href={APP}>Log in</a>
          <a href={APP}>Get started</a>
        </nav>
      </div>

      <main>
        {/* HERO */}
        <section className="hp-hero">
          <div className="hp-w hp-hero-in">
            <div className="hp-hero-txt">
              <h1>Know which ads <u>actually</u> make you money</h1>
              <p>Your ads bring chats on WhatsApp. GrowthOS shows you which of those chats became paying customers, and which ad brought them.</p>
              <a href={APP} className="hp-pill">Get started <span aria-hidden="true">→</span></a>
              <small>Works in Kiswahili and English</small>
            </div>

            <div className="hp-hero-art" aria-hidden="true">
              <Phone>
                <div className="ph-top"><b>Mama Neema</b><span>online</span></div>
                <div className="ph-tag">From ad · <b>Offer ya Wiki</b></div>
                <div className="ph-b in">Habari, bei ya hii ni ngapi?</div>
                <div className="ph-b out">Ni TSh 35,000. Unataka ngapi?</div>
                <div className="ph-b in">Nitachukua mbili 🙏</div>
                <div className="ph-b out">Sawa, Lipa namba: 5XXXXX</div>
                <div className="ph-b in">Nimetuma ✅</div>
              </Phone>
              <div className="hp-float f1"><span className="dot g" />Paid · <b>TSh 70,000</b></div>
              <div className="hp-float f2"><span className="dot y" />Kito: <b>Lipa namba sent</b></div>
              <div className="hp-float f3">Ad → Sale<b>3 days</b></div>
            </div>
          </div>
        </section>

        {/* INTRO */}
        <section className="hp-intro">
          <div className="hp-w">
            <h2>Built for businesses that sell on WhatsApp 🇹🇿</h2>
            <p>If your customers find you through Facebook and Instagram ads, then talk to you on WhatsApp before they pay, GrowthOS was made for you.</p>
          </div>
        </section>

        {/* FEATURES */}
        <section id="features" className="hp-feats">
          <Feature
            tone="mint"
            title="See which ad brought each customer"
            text="Every chat that starts from an ad is linked back to that ad. So instead of just seeing clicks, you see real sales and what each sale cost you."
            art={
              <div className="hp-card-stack">
                <AdRow name="Offer ya Wiki" chats="214" paid="38" good />
                <AdRow name="Video ya Mteja" chats="131" paid="21" good />
                <AdRow name="Picha ya Bidhaa" chats="96" paid="4" />
              </div>
            }
          />
          <Feature
            flip
            tone="butter"
            title="Kito reads your chats, so you don't have to"
            text="Kito, our AI assistant, goes through your WhatsApp chats in the background and marks each customer: asked the price, got your Lipa namba, paid, or went quiet."
            art={
              <Phone>
                <div className="ph-top"><b>Chats</b><span>today</span></div>
                <ChatRow n="Juma K." m="Nimetuma pesa" t="Paid" c="g" />
                <ChatRow n="Asha M." m="Ngoja kidogo..." t="Lipa namba sent" c="y" />
                <ChatRow n="Peter" m="Bei gani?" t="Asked price" c="b" />
                <ChatRow n="Neema S." m="Asante, nitarudi" t="Went quiet" c="r" />
                <ChatRow n="Hamisi" m="Mko wapi?" t="Asked location" c="b" />
              </Phone>
            }
          />
          <Feature
            tone="blush"
            title="Know who to follow up with today"
            text="Customers who got your Lipa namba but never paid are money left on the table. GrowthOS lists them for you, with a reply already written. You decide what to send."
            art={
              <div className="hp-card-stack">
                <div className="hp-fu-h">Follow up today <span>14</span></div>
                <FollowUp n="Asha M." d="Lipa namba sent 2 days ago" />
                <FollowUp n="Baraka J." d="Asked for delivery to Arusha" />
                <FollowUp n="Rehema" d="Said she'll pay Friday" />
              </div>
            }
          />
          <Feature
            flip
            tone="sky"
            title="Ask questions like you'd ask a person"
            text="Ask Kito anything about your business in Kiswahili or English. It answers from your own numbers and takes you straight to the chats behind them."
            art={
              <Phone>
                <div className="ph-top"><b>Kito</b><span>AI assistant</span></div>
                <div className="ph-b out">Tangazo gani linaleta wateja wanaolipa?</div>
                <div className="ph-b in">"Offer ya Wiki" — wateja 38 wamelipa kutoka chats 214. Ni bora mara 3 kuliko "Picha ya Bidhaa".</div>
                <div className="ph-chip">Fungua chats 38 →</div>
              </Phone>
            }
          />
        </section>

        {/* MISSION */}
        <section id="mission" className="hp-mission">
          <div className="hp-w">
            <p className="hp-mission-k">Our mission</p>
            <h2>Help every business in Tanzania see where its sales <u>really</u> come from.</h2>
            <p className="hp-mission-p">Too many good businesses spend on ads and hope. We think you should know. GrowthOS is built in Dar es Salaam by Pondi Technologies, for the way people here actually buy.</p>
          </div>
        </section>

        {/* HOW */}
        <section id="how" className="hp-how">
          <div className="hp-w">
            <h2>No coding needed. Set up in minutes.</h2>
            <ol>
              <li><b>1</b><div><h3>Connect your ad account</h3><p>Log in with Facebook and pick the ad account you use.</p></div></li>
              <li><b>2</b><div><h3>Connect your WhatsApp</h3><p>Your number keeps working on your phone exactly as before.</p></div></li>
              <li><b>3</b><div><h3>Watch the numbers come in</h3><p>Kito starts reading new chats and your dashboard fills up.</p></div></li>
            </ol>
          </div>
        </section>

        {/* CTA */}
        <section className="hp-end">
          <div className="hp-w">
            <h2>Stop guessing. Start knowing.</h2>
            <a href={APP} className="hp-pill hp-pill-dark">Get started <span aria-hidden="true">→</span></a>
          </div>
        </section>
      </main>

      <footer className="hp-foot">
        <div className="hp-w">
          <a href="/" className="hp-logo dark"><Logo size={28} /><span>GrowthOS</span></a>
          <nav>
            <a href={APP}>Log in</a>
            <a href={APP}>Get started</a>
            <a href="#features">Features</a>
            <a href="/privacy.html">Privacy Policy</a>
          </nav>
          <p>© {new Date().getFullYear()} Pondi Technologies · Dar es Salaam, Tanzania</p>
        </div>
      </footer>
    </div>
  );
}

function Phone({ children }: { children: ReactNode }) {
  return <div className="ph"><div className="ph-notch" /><div className="ph-scr">{children}</div></div>;
}

function Feature({ title, text, art, tone, flip }: { title: string; text: string; art: ReactNode; tone: string; flip?: boolean }) {
  return (
    <div className={"hp-feat" + (flip ? " flip" : "")}>
      <div className="hp-w hp-feat-in">
        <div className={"hp-feat-art " + tone}>{art}</div>
        <div className="hp-feat-txt"><h2>{title}</h2><p>{text}</p></div>
      </div>
    </div>
  );
}

function AdRow({ name, chats, paid, good }: { name: string; chats: string; paid: string; good?: boolean }) {
  return (
    <div className="hp-ad">
      <div className="hp-ad-thumb" />
      <div className="hp-ad-n"><b>{name}</b><span>{chats} chats</span></div>
      <div className={"hp-ad-p" + (good ? " good" : "")}>{paid} paid</div>
    </div>
  );
}

function ChatRow({ n, m, t, c }: { n: string; m: string; t: string; c: string }) {
  return (
    <div className="ph-row">
      <div className="ph-av">{n[0]}</div>
      <div className="ph-row-t"><b>{n}</b><span>{m}</span></div>
      <i className={"ph-lab " + c}>{t}</i>
    </div>
  );
}

function FollowUp({ n, d }: { n: string; d: string }) {
  return (
    <div className="hp-fu">
      <div className="ph-av">{n[0]}</div>
      <div className="hp-fu-t"><b>{n}</b><span>{d}</span></div>
      <span className="hp-fu-btn">Reply</span>
    </div>
  );
}

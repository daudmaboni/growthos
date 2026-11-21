// Dashboard "What to fix this week": one card per problem, built for a busy owner on a phone.
// Big number → one plain line → its own button → a plain urgency tag. The detail (what we saw, what
// to try, how sure we are) sits behind "Why?" so the card stays short. Same findings as the Diagnosis page.
import type { Finding } from "./diagnosis";

type Lang = "en" | "sw";
const chatsLink = (ids: string[]) => (ids.length ? "#chats/ids=" + ids.slice(0, 100).join(",") : "#chats");

function shape(f: Finding, lang: Lang) {
  const sw = lang === "sw";
  const T = (en: string, s: string) => (sw ? s : en);
  const n = f.count;
  const one = n === 1;
  const ids = chatsLink(f.conversationIds);
  switch (f.kind) {
    case "unanswered": return { num: n, line: T(one ? "chat never got a reply" : "chats never got a reply", "chats hazijajibiwa kabisa"), cta: T("Reply now", "Jibu sasa"), href: ids };
    case "slow_reply": return { num: n, line: T(one ? "customer waited over an hour for your first reply" : "customers waited over an hour for your first reply", "wateja walisubiri zaidi ya saa kupata jibu la kwanza"), cta: T("See who", "Waone"), href: ids };
    case "low_intent": return { num: `${f.sample ? Math.round((n / f.sample) * 100) : 0}%`, line: T("of ad chats never asked the price", "ya chats za matangazo hazikuuliza bei"), cta: T("See the chats", "Ona chats"), href: ids };
    case "price_objection": return { num: n, line: T(one ? "customer stopped after hearing the price" : "customers stopped after hearing the price", "wateja waliishia baada ya kusikia bei"), cta: T(`Open the ${n} chats`, `Fungua chats ${n}`), href: ids };
    case "no_follow_up": return { num: n, line: T(one ? "interested customer is waiting for your reply" : "interested customers are waiting for your reply", "wateja wenye nia wanasubiri jibu lako"), cta: T("Reply now", "Jibu sasa"), href: "#actions" };
    case "payment_friction": return { num: n, line: T(one ? "customer got your payment number but didn't pay" : "customers got your payment number but didn't pay", "wateja walipewa namba ya malipo lakini hawakulipa"), cta: T("Send a reminder", "Tuma ukumbusho"), href: ids };
    case "unconfirmed_signals": return { num: n, line: T(one ? "customer paid but the sale isn't recorded" : "customers paid but the sales aren't recorded", "wateja walilipa lakini mauzo hayajarekodiwa"), cta: T(one ? "Record the sale" : "Record the sales", "Rekodi mauzo"), href: ids };
    case "fulfillment": return { num: n, line: T("orders had delivery trouble or were returned", "oda zilikwama kwenye usafirishaji au zilirudishwa"), cta: T("See them", "Ziona"), href: ids };
    case "data_gap": return { num: n, line: T(one ? "number on this page is missing information" : "numbers on this page are missing information", "takwimu kwenye ukurasa huu zinakosa taarifa"), cta: T("Fill it in", "Jaza"), href: "#settings" };
    default: return { num: "✓", line: T("No big problem this week", "Hakuna tatizo kubwa wiki hii"), cta: null as string | null, href: "" };
  }
}

const urgency = (f: Finding, sw: boolean) =>
  f.severity === "bad" ? { cls: "today", text: sw ? "Fanya leo" : "Do today" }
  : f.severity === "warn" ? { cls: "week", text: sw ? "Wiki hii" : "This week" }
  : f.severity === "good" ? { cls: "good", text: sw ? "Safi" : "All good" }
  : { cls: "later", text: sw ? "Ukipata nafasi" : "When you can" };

const sure = (c: Finding["confidence"], sw: boolean) =>
  c === "high" ? (sw ? "Tuna uhakika" : "We're sure about this") : c === "medium" ? (sw ? "Tuna uhakika kiasi" : "Fairly sure") : (sw ? "Bado data ni chache" : "Not much data yet");

export default function FixList({ findings, lang }: { findings: Finding[]; lang: Lang }) {
  const sw = lang === "sw";
  return (
    <div className="fix-list">
      {findings.map((f) => {
        const s = shape(f, lang), u = urgency(f, sw);
        return (
          <article className="fix" key={f.kind}>
            <div className="fix-top">
              <span className={"fix-num " + u.cls}>{s.num}</span>
              <span className={"fix-tag " + u.cls}>{u.text}</span>
            </div>
            <p className="fix-line">{s.line}</p>
            <div className="fix-acts">
              {s.cta && <a className="fix-btn" href={s.href}>{s.cta}</a>}
              <details className="fix-why">
                <summary>{sw ? "Kwa nini?" : "Why?"}</summary>
                <p>{f.observed[lang]}</p>
                <p><b>{sw ? "Jaribu" : "Try"}:</b> {f.action[lang]}</p>
                <p className="fix-sure">{sure(f.confidence, sw)}</p>
              </details>
            </div>
          </article>
        );
      })}
    </div>
  );
}

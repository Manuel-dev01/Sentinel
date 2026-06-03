/**
 * Mock issuer SOCIAL/STATUS-FEED page — the SECOND LLM Parse Website target for the demo.
 *
 * SentinelOracle runs a sequential two-source investigation: it scrapes the stable's
 * `homepageUrl` (the formal incident page at /issuer/incident) AND, if a distinct
 * `socialUrl` is registered, a second Parse-Website call over THIS page. The Oracle
 * merges both disclosures into the classify prompt so the verdict rests on two
 * independent web sources agreeing — not one.
 *
 * This page deliberately reads like a status/social feed (short, timestamped posts)
 * rather than a formal disclosure, so the two sources are genuinely distinct in tone
 * while corroborating the same cause. Parse-Website needs RENDERED HTML, not JSON
 * (established M6 finding) — hence a real page, not an API route.
 *
 * `?incident=<scenario>` mirrors the incident page so the same demo can switch causes
 * without redeploying. Register this URL as the stable's `socialUrl` in deploy.ts.
 */

type Scenario = "exploit" | "bank-run" | "regulatory" | "glitch" | "pegged";

type Post = { time: string; text: string };

const FEEDS: Record<Scenario, { handle: string; pinned: string; posts: Post[] }> = {
  exploit: {
    handle: "@usdc_status",
    pinned: "CONFIRMED: redemption contract exploited. Funds affected. Mints/redemptions halted.",
    posts: [
      { time: "00:02", text: "We are aware of irregular outflows from the reserve vault and are investigating." },
      { time: "00:09", text: "Confirmed: an attacker drained reserves via a reentrancy bug in the redemption contract." },
      { time: "00:14", text: "This is a smart-contract exploit, not a market sell-off. ~90% of backing is gone." },
      { time: "00:21", text: "All minting and redemptions paused. A full post-mortem will follow." },
    ],
  },
  "bank-run": {
    handle: "@usdc_status",
    pinned: "Redemption volume is far above normal. Peg under pressure from a run. Reserves solvent long-term.",
    posts: [
      { time: "00:03", text: "Seeing a sharp spike in redemption requests this hour." },
      { time: "00:11", text: "This is a liquidity/bank-run dynamic — demand exceeds instantly-available reserves." },
      { time: "00:18", text: "New mints paused while we source liquidity. No contract exploit; backing is intact." },
    ],
  },
  regulatory: {
    handle: "@usdc_status",
    pinned: "We received a regulatory enforcement order. Reviewing a wind-down of US operations.",
    posts: [
      { time: "00:05", text: "The issuing entity has received an enforcement action from regulators." },
      { time: "00:13", text: "This is a regulatory matter. Reserves are not impaired by this order." },
      { time: "00:20", text: "Assessing impact on US-facing operations; updates to follow." },
    ],
  },
  glitch: {
    handle: "@usdc_status",
    pinned: "Brief oracle feed inconsistency caused a transient deviation. Peg already recovering.",
    posts: [
      { time: "00:01", text: "Monitoring a short-lived price deviation across venues." },
      { time: "00:06", text: "Root cause is a technical glitch in an oracle feed, not reserves." },
      { time: "00:08", text: "Peg is recovering to tolerance. Reserves fully intact." },
    ],
  },
  pegged: {
    handle: "@usdc_status",
    pinned: "Operating normally. Peg within tolerance.",
    posts: [{ time: "00:00", text: "No incident. Reserves fully accounted for and the peg holds." }],
  },
};

function pick(input: string | undefined): Scenario {
  switch (input) {
    case "bank-run":
    case "regulatory":
    case "glitch":
    case "pegged":
      return input;
    default:
      return "exploit";
  }
}

// Dynamic so `?incident=<scenario>` is honored at request time (see /issuer/incident for why).
export const dynamic = "force-dynamic";

export default async function IssuerSocialPage({
  searchParams,
}: {
  searchParams: Promise<{ incident?: string }>;
}) {
  const { incident } = await searchParams;
  const scenario = pick(incident);
  const feed = FEEDS[scenario];

  return (
    <main
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        maxWidth: 640,
        margin: "0 auto",
        padding: "48px 24px",
        lineHeight: 1.55,
      }}
    >
      <header style={{ borderBottom: "1px solid #ccc", paddingBottom: 16, marginBottom: 20 }}>
        <p style={{ letterSpacing: 2, fontSize: 12, color: "#888", margin: 0 }}>USD COIN (USDC) · STATUS FEED</p>
        <h1 style={{ fontSize: 22, margin: "8px 0 0" }}>{feed.handle}</h1>
        <p
          style={{
            marginTop: 12,
            padding: "8px 12px",
            border: "1px solid #c00",
            background: "#fff5f5",
            color: "#c00",
            fontSize: 13,
            fontWeight: 700,
          }}
        >
          PINNED · {feed.pinned}
        </p>
      </header>
      <section style={{ display: "grid", gap: 14 }}>
        {feed.posts.map((p, i) => (
          <article key={i} style={{ borderBottom: "1px solid #eee", paddingBottom: 12 }}>
            <p style={{ margin: 0, fontSize: 12, color: "#999" }}>
              {feed.handle} · T+{p.time}
            </p>
            <p style={{ margin: "4px 0 0" }}>{p.text}</p>
          </article>
        ))}
      </section>
      <footer style={{ marginTop: 40, fontSize: 12, color: "#999" }}>
        <p>
          Mock issuer status feed for the Sentinel demo (Somnia Agentathon). It is the SECOND source
          the LLM Parse Website agent reads during the two-source on-chain investigation, distinct
          from the formal disclosure at <b>/issuer/incident</b>. Scenario: <b>{scenario}</b>.
        </p>
      </footer>
    </main>
  );
}

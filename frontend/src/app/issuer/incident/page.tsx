/**
 * Mock issuer incident page — the LLM Parse Website (Agent #2) target for the demo.
 *
 * The SentinelOracle's investigate stage scrapes the registered stable's `homepageUrl`
 * and runs `IParseWebsiteAgent.ExtractString` over it to pull an incident disclosure.
 * This page presents an unambiguous smart-contract-exploit statement so the downstream
 * LLM Inference classifier (Agent #3) reaches deterministic subcommittee consensus on
 * `SMART_CONTRACT_EXPLOIT`.
 *
 * `?incident=<scenario>` mirrors the JSON route's scenarios so the same demo can show a
 * different cause (bank-run / regulatory / glitch) without redeploying.
 *
 * Deploy with the rest of `frontend/` to Vercel; set the resulting URL as ISSUER_PAGE_URL
 * (root .env) so deploy.ts registers it as the stable's homepageUrl.
 */

type Scenario = "exploit" | "bank-run" | "regulatory" | "glitch" | "pegged";

const DISCLOSURES: Record<Scenario, { title: string; status: string; body: string }> = {
  exploit: {
    title: "Security Incident — Reserve Vault Exploited",
    status: "INCIDENT — FUNDS AFFECTED",
    body:
      "Our stablecoin reserve vault was drained via a reentrancy exploit in the redemption " +
      "contract. Approximately 90% of backing reserves were lost. Minting and redemptions are " +
      "paused while we investigate. This is a smart-contract exploit, not a market event.",
  },
  "bank-run": {
    title: "Liquidity Notice — Redemption Surge",
    status: "INCIDENT — REDEMPTIONS PAUSED",
    body:
      "Coordinated redemption volume has exceeded immediately available reserves. The peg is " +
      "under pressure from a bank run. We have paused new mints and are sourcing liquidity to " +
      "stabilize redemptions. Reserves remain solvent on a longer horizon.",
  },
  regulatory: {
    title: "Regulatory Notice — Enforcement Action",
    status: "INCIDENT — OPERATIONS UNDER REVIEW",
    body:
      "The issuing entity has received a regulatory enforcement order. A wind-down of US-facing " +
      "operations is under review. This is a regulatory action; reserves are not impaired.",
  },
  glitch: {
    title: "Status Notice — Oracle Feed Inconsistency",
    status: "MONITORING — PEG RECOVERING",
    body:
      "A brief oracle feed inconsistency between primary and secondary venues caused a transient " +
      "deviation. This is a technical glitch; the peg is already recovering and reserves are intact.",
  },
  pegged: {
    title: "Status — Operating Normally",
    status: "OK",
    body: "No incident. The peg holds within tolerance and all reserves are accounted for.",
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

// Must be dynamic so the `?incident=<scenario>` query param is honored at request time — the
// operator scenario switch re-points the agent's URL per cause. force-static would prerender one
// version and ignore the param (every scenario would render the default), which is exactly the bug
// that made every classification come back SMART_CONTRACT_EXPLOIT.
export const dynamic = "force-dynamic";

export default async function IssuerIncidentPage({
  searchParams,
}: {
  searchParams: Promise<{ incident?: string }>;
}) {
  const { incident } = await searchParams;
  const scenario = pick(incident);
  const d = DISCLOSURES[scenario];

  return (
    <main
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        maxWidth: 720,
        margin: "0 auto",
        padding: "48px 24px",
        lineHeight: 1.6,
      }}
    >
      <header style={{ borderBottom: "1px solid #ccc", paddingBottom: 16, marginBottom: 24 }}>
        <p style={{ letterSpacing: 2, fontSize: 12, color: "#888", margin: 0 }}>USD COIN (USDC) · ISSUER STATUS</p>
        <h1 style={{ fontSize: 26, margin: "8px 0 0" }}>{d.title}</h1>
        <p
          style={{
            display: "inline-block",
            marginTop: 12,
            padding: "4px 10px",
            border: "1px solid #c00",
            color: "#c00",
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          {d.status}
        </p>
      </header>
      <article>
        <p>{d.body}</p>
      </article>
      <footer style={{ marginTop: 40, fontSize: 12, color: "#999" }}>
        <p>
          This is a mock issuer page for the Sentinel demo (Somnia Agentathon). It is the target the
          LLM Parse Website agent reads during the on-chain investigation. Scenario: <b>{scenario}</b>.
        </p>
      </footer>
    </main>
  );
}

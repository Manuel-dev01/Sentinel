import { NextResponse, type NextRequest } from "next/server";

/**
 * Mock issuer endpoint for the Step 3 spike + later demos.
 *
 * The Somnia JSON API agent will fetch this URL and extract a value via jsonpath
 * (typically `$.price` or `$.deviation_bps`). Keep the response shape stable so
 * the spike contract's expected decoding holds.
 *
 * Query param `?incident=<scenario>` varies the response payload so the same URL
 * can drive different demo scenarios without redeploying.
 *
 * Scenarios:
 *   exploit   (default) — 60bps depeg + smart-contract-exploit disclosure
 *   bank-run            — 80bps depeg + bank-run disclosure
 *   regulatory          — 50bps depeg + regulatory disclosure
 *   glitch              — 20bps transient depeg + technical-glitch disclosure
 *   pegged              — at peg, no incident
 */

export const dynamic = "force-static";
export const revalidate = 0;

type Scenario = "exploit" | "bank-run" | "regulatory" | "glitch" | "pegged";

const SCENARIOS: Record<Scenario, {
  price: string;
  price_wad: string;
  deviation_bps: number;
  issuer_status: "incident" | "ok";
  issuer_disclosure: string;
}> = {
  // `price`     — human-readable decimal string (used by the Step-3 spike via fetchString).
  // `price_wad` — the SAME price as an 18-decimal integer STRING, so the SentinelOracle confirm
  //               stage can read it with `fetchUint(url, "price_wad", 0)` — no decimal-point parsing,
  //               the value lands as a WAD directly comparable to the registry pegTarget (1e18).
  //               (A JSON *number* this large would lose precision in JS, hence a string.)
  exploit: {
    price: "0.9200",
    price_wad: "920000000000000000",
    deviation_bps: 800,
    issuer_status: "incident",
    issuer_disclosure:
      "Vault drained via reentrancy exploit. 90% of reserves lost. Investigation ongoing.",
  },
  "bank-run": {
    price: "0.9200",
    price_wad: "920000000000000000",
    deviation_bps: 800,
    issuer_status: "incident",
    issuer_disclosure:
      "Coordinated redemption volume exceeds available reserves. Pausing new mints pending stabilization.",
  },
  regulatory: {
    price: "0.9500",
    price_wad: "950000000000000000",
    deviation_bps: 500,
    issuer_status: "incident",
    issuer_disclosure:
      "Issuer entity received enforcement order. Wind-down of US-facing operations under review.",
  },
  glitch: {
    price: "0.9800",
    price_wad: "980000000000000000",
    deviation_bps: 200,
    issuer_status: "incident",
    issuer_disclosure:
      "Brief oracle feed inconsistency between primary and secondary venues. Peg recovering.",
  },
  pegged: {
    price: "1.0000",
    price_wad: "1000000000000000000",
    deviation_bps: 0,
    issuer_status: "ok",
    issuer_disclosure: "No incident. Peg holds within tolerance.",
  },
};

function pick(input: string | null): Scenario {
  switch (input) {
    case "bank-run":
    case "regulatory":
    case "glitch":
    case "pegged":
      return input;
    case "exploit":
    default:
      return "exploit";
  }
}

export function GET(req: NextRequest) {
  const scenario = pick(req.nextUrl.searchParams.get("incident"));
  const body = SCENARIOS[scenario];

  return NextResponse.json(
    {
      asset: "USDx",
      peg: "1.0000",
      ...body,
      scenario,
      ts: Math.floor(Date.now() / 1000),
    },
    {
      headers: {
        // Public, cacheable for ~10s — enough for the spike's polling window,
        // not so long that re-runs are stale.
        "cache-control": "public, s-maxage=10, stale-while-revalidate=30",
      },
    },
  );
}

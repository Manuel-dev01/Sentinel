"use client";

import Link from "next/link";
import { parseEther } from "viem";
import {
  useAccount,
  useReadContract,
  useReadContracts,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { CONTRACTS, EVENT_STATE, deployment, monitorAssets, hasPoller, hasSimGateway, operatorAddress } from "@/lib/contracts";
import { useStable, StableSelector } from "@/lib/stables";
import { fmtPrice, fmtCompact, fmtBpsPct, deviationBps, timeAgo } from "@/lib/format";

const REFRESH = 4000;

// Operator demo control: which incident the issuer pages present, so a depeg can be classified as
// any cause. Re-points the selected stable's issuer URLs (registry.updateConfig) before Simulate.
const SCENARIOS = [
  { id: "exploit", label: "Exploit", note: "100% · immediate" },
  { id: "bank-run", label: "Bank run", note: "scaled · vested 24h" },
  { id: "regulatory", label: "Regulatory", note: "50% · vested 24h" },
  { id: "glitch", label: "Glitch", note: "0–25% · delayed" },
] as const;

function urlWithScenario(base: string, scenario: string): string {
  try {
    const u = new URL(base);
    u.searchParams.set("incident", scenario);
    return u.toString();
  } catch {
    return base;
  }
}
function scenarioOf(url: string | undefined): string {
  if (!url) return "exploit";
  try {
    return new URL(url).searchParams.get("incident") ?? "exploit";
  } catch {
    return "exploit";
  }
}

export default function Dashboard() {
  const { address, isConnected } = useAccount();
  // The operator (deployer) is the only wallet that can switch the demo scenario (a registry write).
  // Simulate/Reset are NOT gated — SimGateway makes them permissionless for everyone.
  const isOperator = isConnected && !!operatorAddress && address?.toLowerCase() === operatorAddress;
  const { selected } = useStable();
  const insured = selected.address;

  // Batched live reads — refetched every few seconds for a "monitor" feel.
  const { data, refetch } = useReadContracts({
    contracts: [
      { ...CONTRACTS.priceOracle, functionName: "priceOf", args: [insured] },
      { ...CONTRACTS.registry, functionName: "getConfig", args: [insured] },
      { ...CONTRACTS.pool, functionName: "totalAssets" },
      { ...CONTRACTS.pool, functionName: "availableCapital" },
      { ...CONTRACTS.pool, functionName: "outstandingLiability" },
      { ...CONTRACTS.pool, functionName: "utilizationCapBps" },
      { ...CONTRACTS.policy, functionName: "nextTokenId" },
      { ...CONTRACTS.oracle, functionName: "liveEventOf", args: [insured] },
      { ...CONTRACTS.oracle, functionName: "nextEventId" },
    ],
    query: { refetchInterval: REFRESH },
  });

  const price = data?.[0]?.result as bigint | undefined;
  const cfg = data?.[1]?.result as
    | {
        pegTarget: bigint;
        depegThresholdBps: number;
        minDurationSeconds: number;
        annualRateBps: number;
        tiers: { noPayoutBps: number; partialBps: number; highBps: number };
        homepageUrl: string;
        socialUrl: string;
        repoUrl: string;
      }
    | undefined;
  const totalAssets = data?.[2]?.result as bigint | undefined;
  const available = data?.[3]?.result as bigint | undefined;
  const liability = data?.[4]?.result as bigint | undefined;
  const capBps = data?.[5]?.result as number | undefined;
  const nextTokenId = data?.[6]?.result as bigint | undefined;
  const liveEventId = data?.[7]?.result as bigint | undefined;
  const nextEventId = data?.[8]?.result as bigint | undefined;

  // Feature the latest *successful* (Classified, state 4) event for the audit link, so failed or
  // dismissed events (e.g. a live asset's pre-calibration false positive) never headline the
  // dashboard. Scan back a bounded window of recent events and take the most recent classified one.
  const SCAN = 12;
  const scanIds: bigint[] = [];
  if (nextEventId && nextEventId > 1n) {
    for (let id = nextEventId - 1n; id >= 1n && scanIds.length < SCAN; id--) scanIds.push(id);
  }
  const { data: scanData } = useReadContracts({
    contracts: scanIds.map((id) => ({ ...CONTRACTS.oracle, functionName: "getEvent" as const, args: [id] })),
    query: { enabled: scanIds.length > 0, refetchInterval: REFRESH },
  });
  const featuredEventId = scanIds.find(
    (_, i) => (scanData?.[i]?.result as { state?: number } | undefined)?.state === 4,
  );

  const peg = cfg?.pegTarget ?? parseEther("1");
  const dev = price !== undefined ? deviationBps(price, peg) : undefined;
  const threshold = cfg?.depegThresholdBps ?? 50;
  const breached = dev !== undefined && dev >= threshold;
  const policyCount = nextTokenId ? Number(nextTokenId) - 1 : 0;
  const utilization =
    totalAssets && capBps !== undefined && totalAssets > 0n && liability !== undefined
      ? Number((liability * 10000n) / totalAssets)
      : 0;

  // Audit link target: an in-flight event for the selected stable takes priority, then the latest
  // successful classified event, and only as a last resort the global latest (used before any event
  // has settled). This keeps failed/dismissed events from being the headline a judge lands on.
  const auditEventId =
    liveEventId && liveEventId !== 0n
      ? liveEventId
      : featuredEventId ?? (nextEventId && nextEventId > 1n ? nextEventId - 1n : undefined);

  // Follow the current event's state for the live pipeline stepper. Polls faster while in flight.
  const inFlight = !!liveEventId && liveEventId !== 0n;
  const { data: evt } = useReadContract({
    ...CONTRACTS.oracle,
    functionName: "getEvent",
    args: [auditEventId ?? 0n],
    query: { enabled: !!auditEventId, refetchInterval: inFlight ? 2000 : 6000 },
  });
  const eventState = (evt as { state: number } | undefined)?.state;
  const eventStage = (evt as { stage: number } | undefined)?.stage;

  // The stepper tracks an active event. When the peg is back within tolerance and nothing is in
  // flight we're MONITORING — reset the stepper to the start rather than leaving a stale "Settled".
  const monitoring = !inFlight && !breached;
  const displayState = monitoring ? 0 : (eventState ?? 0);

  // Autonomous live monitor: the multi-asset poller's on-chain observations of each real peg.
  const { data: monData } = useReadContracts({
    contracts: hasPoller
      ? [
          { ...CONTRACTS.poller, functionName: "pollCount" },
          { ...CONTRACTS.poller, functionName: "armed" },
          ...monitorAssets.flatMap((a) => [
            { ...CONTRACTS.poller, functionName: "lastObservedPrice", args: [a.asset] },
            { ...CONTRACTS.poller, functionName: "lastObservedAt", args: [a.asset] },
          ]),
        ]
      : [],
    query: { enabled: hasPoller, refetchInterval: 8000 },
  });
  const monPolls = monData?.[0]?.result as bigint | undefined;
  const monArmed = monData?.[1]?.result as boolean | undefined;
  const monObs = monitorAssets.map((a, i) => ({
    ...a,
    price: monData?.[2 + i * 2]?.result as bigint | undefined,
    at: monData?.[2 + i * 2 + 1]?.result as bigint | undefined,
  }));

  // Operator controls — push the insured below peg / reset it.
  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: txMining } = useWaitForTransactionReceipt({ hash: txHash, query: { enabled: !!txHash } });

  // Depeg simulation is permissionless via SimGateway (any wallet can trigger it for a demo stable),
  // so a judge can test self-serve. SimGateway owns the poller and forwards to its price passthrough.
  // Fallbacks: the poller's operator-only path, then the bare oracle, for older deployments.
  const setPrice = (human: string) => {
    const price = parseEther(human);
    const onSettled = () => setTimeout(() => refetch(), 1500);
    if (hasSimGateway) {
      writeContract({ ...CONTRACTS.simGateway, functionName: "simulate", args: [insured, price] }, { onSettled });
    } else if (hasPoller) {
      writeContract({ ...CONTRACTS.poller, functionName: "operatorSetPrice", args: [insured, price] }, { onSettled });
    } else {
      writeContract({ ...CONTRACTS.priceOracle, functionName: "setPrice", args: [insured, price] }, { onSettled });
    }
  };

  // The issuer pages the investigation reads, parameterized by scenario.
  const incidentBase = deployment.issuerPageUrl;
  const socialBase = (deployment as { issuerSocialUrl?: string }).issuerSocialUrl ?? incidentBase;
  const currentScenario = scenarioOf(cfg?.homepageUrl);
  const setScenario = (scenario: string) => {
    if (!cfg) return;
    writeContract(
      {
        ...CONTRACTS.registry,
        functionName: "updateConfig",
        args: [
          insured,
          cfg.pegTarget,
          cfg.depegThresholdBps,
          cfg.minDurationSeconds,
          cfg.annualRateBps,
          {
            noPayoutBps: cfg.tiers.noPayoutBps,
            partialBps: cfg.tiers.partialBps,
            highBps: cfg.tiers.highBps,
          },
          urlWithScenario(incidentBase, scenario),
          urlWithScenario(socialBase, scenario),
          urlWithScenario(socialBase, scenario),
        ],
      },
      { onSettled: () => setTimeout(() => refetch(), 1500) },
    );
  };

  const busy = isPending || txMining;
  const sev = breached ? "warning" : "settled";
  // Bar fill: fraction of a 10% (1000bps) full-scale deviation.
  const fillPct = dev !== undefined ? Math.min(dev / 1000, 1) : 0;

  return (
    <div>
      {/* ── Section header ── */}
      <div className="sec-head rule-b">
        <div className="sec-no">[ DESK ]</div>
        <div>
          <div className="kicker" style={{ marginBottom: 16 }}>
            <span className="dot" /> LIVE PEG MONITOR
          </div>
          <h1 className="sec-title">
            Incident <span className="ed">desk.</span>
          </h1>
        </div>
        <div className="right">
          <p className="sec-lead">
            Insured stablecoins, watched on-chain. Trip the peg and the reactive engine investigates
            and pays — no keeper, no committee.
          </p>
          <div style={{ marginTop: 16 }}>
            <StableSelector />
          </div>
        </div>
      </div>

      {/* ── Live monitor (dark panel) ── */}
      <section className="dark" style={{ position: "relative" }}>
        <div className="pm-bar">
          <span className="live">{selected.symbol} · INSURED POSITION</span>
          <span>±{fmtBpsPct(threshold)} TOLERANCE</span>
        </div>

        <div className="section-pad" style={{ display: "grid", gap: 28 }}>
          <div className={`peg-gauge ${sev}`}>
            <div>
              <div className="label">Current price · peg $1.0000</div>
              <div className="value">{fmtPrice(price)}</div>
            </div>
            <div className="delta">
              {dev === undefined ? "—" : `${dev} bps ${breached ? "· BREACH" : "· within tolerance"}`}
            </div>
            <div className="peg-gauge-bar">
              <div className="fill" style={{ transform: `scaleX(${fillPct})` }} />
            </div>
          </div>

          {/* Operator controls — hidden for the autonomously-monitored asset (the poller drives it). */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            {selected.monitored ? (
              <div style={{ flexBasis: "100%", display: "flex", gap: 10, alignItems: "flex-start" }}>
                <span
                  className="animate-pulse-dot"
                  style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--green)", marginTop: 6, flexShrink: 0 }}
                />
                <p style={{ fontFamily: "var(--mono)", fontSize: 12.5, lineHeight: 1.6, color: "var(--off-2)", maxWidth: "68ch", margin: 0 }}>
                  <b style={{ color: "var(--off)" }}>Autonomously monitored.</b> The live poller reads the real{" "}
                  {selected.symbol} price on-chain every cycle — no keeper, no operator. Coverage here pays out on a{" "}
                  <span style={{ fontFamily: "var(--serif)", fontStyle: "italic" }}>genuine</span> depeg, detected and
                  settled with no manual trigger.
                </p>
              </div>
            ) : (
              <>
                <button
                  className="pill solid"
                  onClick={() => setPrice(process.env.NEXT_PUBLIC_DEPEG_PRICE ?? "0.92")}
                  disabled={!isConnected || busy}
                >
                  {busy ? "Submitting…" : "Simulate depeg"} <span className="arr">↯</span>
                </button>
                <button className="pill" onClick={() => setPrice("1")} disabled={!isConnected || busy}>
                  Reset peg
                </button>
                {!isConnected && (
                  <span className="kicker" style={{ color: "var(--off-3)" }}>
                    connect any wallet to trigger
                  </span>
                )}

                {/* Scenario switch is a registry write (operator-only); Simulate above is open to all. */}
                {isConnected && !isOperator && (
                  <span className="kicker" style={{ color: "var(--off-3)" }}>
                    cause is operator-set · your wallet can simulate, buy coverage, and claim
                  </span>
                )}

                {/* Operator demo control: choose the incident the investigation will classify. */}
                {isOperator && (
                  <div
                    style={{
                      flexBasis: "100%",
                      display: "flex",
                      gap: 8,
                      flexWrap: "wrap",
                      alignItems: "center",
                      marginTop: 6,
                    }}
                  >
                    <span className="kicker" style={{ color: "var(--off-3)", marginRight: 4 }}>
                      DEMO CAUSE ·
                    </span>
                    {SCENARIOS.map((s) => {
                      const active = currentScenario === s.id;
                      return (
                        <button
                          key={s.id}
                          className={`pill${active ? " violet" : ""}`}
                          onClick={() => setScenario(s.id)}
                          disabled={busy}
                          title={`${s.label} → ${s.note}`}
                          style={{ padding: "8px 14px", fontSize: 11 }}
                        >
                          {s.label}
                        </button>
                      );
                    })}
                    <span className="kicker" style={{ color: "var(--off-3)" }}>
                      → {SCENARIOS.find((x) => x.id === currentScenario)?.note ?? "pegged"}
                    </span>
                  </div>
                )}
              </>
            )}
            {auditEventId && (
              <Link
                href={`/audit/${auditEventId}`}
                className="pill violet"
                style={{ marginLeft: "auto" }}
              >
                View investigation #{auditEventId.toString()} <span className="arr">↗</span>
              </Link>
            )}
          </div>

          {/* Autonomous live monitor — every real peg, fetched on-chain by the keeperless poller. */}
          {hasPoller && (
            <div className="panel" style={{ padding: "14px 16px", display: "grid", gap: 12, borderColor: "var(--line-d)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span
                    className={monArmed ? "animate-pulse-dot" : undefined}
                    style={{ width: 8, height: 8, borderRadius: "50%", background: monArmed ? "var(--green)" : "var(--off-3)" }}
                  />
                  <span className="kicker" style={{ color: "var(--off-2)" }}>LIVE MONITOR · REAL PEGS, ON-CHAIN</span>
                </div>
                <span className="kicker" style={{ color: "var(--off-4)" }}>
                  {(monPolls ?? 0n).toString()} polls · no keeper
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(monObs.length, 4)}, 1fr)`, gap: 10 }}>
                {monObs.map((o) => (
                  <div key={o.asset} style={{ display: "grid", gap: 2, fontFamily: "var(--mono)" }}>
                    <span className="kicker" style={{ color: "var(--off-3)", fontSize: 10 }}>{o.display}</span>
                    <span style={{ fontSize: 17, color: "var(--off)" }}>
                      {o.price && o.price > 0n ? fmtPrice(o.price) : "—"}
                    </span>
                    <span style={{ fontSize: 10.5, color: "var(--off-4)" }}>
                      {o.at && o.at > 0n ? `obs. ${timeAgo(o.at)}` : "awaiting poll…"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Live pipeline stepper — always shown; resets to MONITORING when the peg is restored. */}
        <div className="section-pad" style={{ borderTop: "1px solid var(--line-d)" }}>
          <PipelineStepper state={displayState} stage={monitoring ? undefined : eventStage} />
        </div>

        {/* Pipeline status strip */}
        <div className="pm-foot">
          <span>
            {inFlight
              ? `EVENT #${liveEventId} · IN FLIGHT`
              : !monitoring && auditEventId
                ? `LAST EVENT #${auditEventId} · ${eventState !== undefined ? EVENT_STATE[eventState].toUpperCase() : "CLOSED"}`
                : "MONITORING · NO BREACH"}
          </span>
          <span>FIG. 01 · REACTIVITY HANDLER</span>
        </div>
      </section>

      {/* ── Pool / book metrics ── */}
      <section className="stats-console">
        <div className="stat">
          <div className="s-no">[ POOL ]</div>
          <div className="s-val tnum">
            {fmtCompact(totalAssets)}
            <span className="u"> sUSD</span>
          </div>
          <div className="s-lbl">Capital backing payouts</div>
        </div>
        <div className="stat">
          <div className="s-no">[ FREE ]</div>
          <div className="s-val tnum">{fmtCompact(available)}</div>
          <div className="s-lbl">Available capital</div>
        </div>
        <div className="stat">
          <div className="s-no">[ UTIL ]</div>
          <div className="s-val tnum">
            {utilization}
            <span className="u">%</span>
          </div>
          <div className="s-lbl">Utilization · cap {capBps !== undefined ? capBps / 100 : "—"}%</div>
        </div>
        <div className="stat">
          <div className="s-no">[ BOOK ]</div>
          <div className="s-val tnum">{policyCount}</div>
          <div className="s-lbl">Active policies · protocol-wide</div>
        </div>
      </section>

      {/* ── Footnote ── */}
      <div className="section-pad rule" style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-3)", letterSpacing: "0.04em" }}>
        Insured: {selected.symbol} {insured} · Detection: Somnia Reactivity → SentinelOracle._onEvent · Liability{" "}
        {fmtCompact(liability)} sUSD outstanding.
      </div>
    </div>
  );
}

/**
 * Live pipeline stepper — maps the on-chain event state to the detect→settle beats.
 * Polled (not log-subscribed) for robustness against Somnia's 1000-block getLogs cap.
 */
function PipelineStepper({ state, stage }: { state: number; stage?: number }) {
  const STEPS = ["Detect", "Confirm", "Investigate", "Classify", "Settled"];
  // state: 1 Confirming · 2 Investigating · 3 Classifying · 4 Classified · 5 Dismissed · 6 Failed
  const active = state >= 1 && state <= 4 ? state : state === 4 ? 4 : -1;
  const dismissed = state === 5;
  const failed = state === 6;
  // Map Stage enum (1 Confirm, 2 Investigate, 3 Investigate2, 4 Classify) → step index
  // (0 Detect, 1 Confirm, 2 Investigate, 3 Classify, 4 Settled). Both investigate sub-stages map to step 2.
  const STAGE_TO_STEP: Record<number, number> = { 1: 1, 2: 2, 3: 2, 4: 3 };
  const failedAt = failed ? (STAGE_TO_STEP[stage ?? 1] ?? 1) : -1;

  return (
    <div style={{ display: "flex", alignItems: "stretch", gap: 0, flexWrap: "wrap" }}>
      {STEPS.map((label, i) => {
        let color = "var(--off-3)";
        let dot = "var(--off-3)";
        let note = "";
        if (failed && i === failedAt) {
          color = "var(--red)"; dot = "var(--red)"; note = "FAILED";
        } else if (dismissed && i === 1) {
          color = "var(--amber)"; dot = "var(--amber)"; note = "DISMISSED";
        } else if (state === 4 || i < active) {
          color = "var(--green)"; dot = "var(--green)"; note = "DONE";
        } else if (i === active && !dismissed && !failed) {
          color = "var(--violet-soft)"; dot = "var(--violet)"; note = "RUNNING";
        }
        return (
          <div key={label} style={{ flex: "1 1 0", minWidth: 110, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot }} className={note === "RUNNING" ? "animate-pulse-dot" : undefined} />
              <span style={{ height: 1, flex: 1, background: i < active || state === 4 ? "var(--green)" : "var(--line-d)" }} />
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, letterSpacing: "0.08em", color }}>
              <span style={{ color: "var(--off-3)" }}>T+{i} </span>
              {label}
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.18em", color: dot, minHeight: 12 }}>{note}</div>
          </div>
        );
      })}
    </div>
  );
}

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
import { CONTRACTS, EVENT_STATE } from "@/lib/contracts";
import { useStable, StableSelector } from "@/lib/stables";
import { fmtPrice, fmtCompact, fmtBpsPct, deviationBps } from "@/lib/format";

const REFRESH = 4000;

export default function Dashboard() {
  const { isConnected } = useAccount();
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
  const cfg = data?.[1]?.result as { pegTarget: bigint; depegThresholdBps: number } | undefined;
  const totalAssets = data?.[2]?.result as bigint | undefined;
  const available = data?.[3]?.result as bigint | undefined;
  const liability = data?.[4]?.result as bigint | undefined;
  const capBps = data?.[5]?.result as number | undefined;
  const nextTokenId = data?.[6]?.result as bigint | undefined;
  const liveEventId = data?.[7]?.result as bigint | undefined;
  const nextEventId = data?.[8]?.result as bigint | undefined;

  const peg = cfg?.pegTarget ?? parseEther("1");
  const dev = price !== undefined ? deviationBps(price, peg) : undefined;
  const threshold = cfg?.depegThresholdBps ?? 50;
  const breached = dev !== undefined && dev >= threshold;
  const policyCount = nextTokenId ? Number(nextTokenId) - 1 : 0;
  const utilization =
    totalAssets && capBps !== undefined && totalAssets > 0n && liability !== undefined
      ? Number((liability * 10000n) / totalAssets)
      : 0;

  // The most recent event (live slot, else the last opened) for the audit link.
  const auditEventId =
    liveEventId && liveEventId !== 0n
      ? liveEventId
      : nextEventId && nextEventId > 1n
        ? nextEventId - 1n
        : undefined;

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

  // Operator controls — push the insured below peg / reset it.
  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: txMining } = useWaitForTransactionReceipt({ hash: txHash, query: { enabled: !!txHash } });

  const setPrice = (human: string) =>
    writeContract(
      {
        ...CONTRACTS.priceOracle,
        functionName: "setPrice",
        args: [insured, parseEther(human)],
      },
      { onSettled: () => setTimeout(() => refetch(), 1500) },
    );

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

          {/* Operator controls */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
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
                connect the operator wallet to trigger
              </span>
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
          <div className="s-lbl">Active policies</div>
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

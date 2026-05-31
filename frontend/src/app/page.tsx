"use client";

import Link from "next/link";
import { parseEther } from "viem";
import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { CONTRACTS, INSURED, EVENT_STATE } from "@/lib/contracts";
import { fmtPrice, fmtCompact, fmtBpsPct, deviationBps } from "@/lib/format";

const REFRESH = 4000;

export default function Dashboard() {
  const { isConnected } = useAccount();

  // Batched live reads — refetched every few seconds for a "monitor" feel.
  const { data, refetch } = useReadContracts({
    contracts: [
      { ...CONTRACTS.priceOracle, functionName: "priceOf", args: [INSURED] },
      { ...CONTRACTS.registry, functionName: "getConfig", args: [INSURED] },
      { ...CONTRACTS.pool, functionName: "totalAssets" },
      { ...CONTRACTS.pool, functionName: "availableCapital" },
      { ...CONTRACTS.pool, functionName: "outstandingLiability" },
      { ...CONTRACTS.pool, functionName: "utilizationCapBps" },
      { ...CONTRACTS.policy, functionName: "nextTokenId" },
      { ...CONTRACTS.oracle, functionName: "liveEventOf", args: [INSURED] },
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

  // Operator controls — push the insured below peg / reset it.
  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: txMining } = useWaitForTransactionReceipt({ hash: txHash, query: { enabled: !!txHash } });

  const setPrice = (human: string) =>
    writeContract(
      {
        ...CONTRACTS.priceOracle,
        functionName: "setPrice",
        args: [INSURED, parseEther(human)],
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
            One insured stablecoin, watched on-chain. Trip the peg and the reactive engine investigates
            and pays — no keeper, no committee.
          </p>
        </div>
      </div>

      {/* ── Live monitor (dark panel) ── */}
      <section className="dark" style={{ position: "relative" }}>
        <div className="pm-bar">
          <span className="live">USDx · INSURED POSITION</span>
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

        {/* Pipeline status strip */}
        <div className="pm-foot">
          <span>
            {liveEventId && liveEventId !== 0n
              ? `EVENT #${liveEventId} · IN FLIGHT`
              : auditEventId
                ? `LAST EVENT #${auditEventId} · CLOSED`
                : "NO ACTIVE EVENT"}
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
        Insured: {INSURED} · Detection: Somnia Reactivity → SentinelOracle._onEvent · Liability{" "}
        {fmtCompact(liability)} sUSD outstanding.
      </div>
    </div>
  );
}

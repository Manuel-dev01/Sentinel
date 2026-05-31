"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { decodeAbiParameters } from "viem";
import { useReadContracts } from "wagmi";
import { CONTRACTS, EVENT_STATE, CAUSE, STAGE, RESPONSE_STATUS, AGENT_LABELS } from "@/lib/contracts";
import { fmtWad, fmtPrice, fmtBpsPct, shortAddr, timeAgo } from "@/lib/format";

type Receipt = {
  stage: number;
  requestId: bigint;
  agentId: bigint;
  validator: `0x${string}`;
  status: number;
  result: `0x${string}`;
  executionCost: bigint;
  receiptId: bigint;
  timestamp: bigint;
};

const STAGE_TITLE: Record<number, string> = {
  1: "Confirm — price basket",
  2: "Investigate — issuer disclosure",
  3: "Investigate — status feed",
  4: "Classify — root cause",
};

function decodeResult(stage: number, hex: string): string {
  if (!hex || hex === "0x") return "—";
  try {
    if (stage === 1) {
      const [v] = decodeAbiParameters([{ type: "uint256" }], hex as `0x${string}`);
      return fmtPrice(v as bigint);
    }
    const [s] = decodeAbiParameters([{ type: "string" }], hex as `0x${string}`);
    return (s as string) || "(empty)";
  } catch {
    return `${hex.slice(0, 18)}…`;
  }
}

export default function AuditPage() {
  const params = useParams<{ eventId: string }>();
  const eventId = (() => {
    try {
      return BigInt(params.eventId);
    } catch {
      return 0n;
    }
  })();

  const { data, isLoading } = useReadContracts({
    contracts: [
      { ...CONTRACTS.oracle, functionName: "getEvent", args: [eventId] },
      { ...CONTRACTS.oracle, functionName: "getReceipts", args: [eventId] },
      { ...CONTRACTS.treasury, functionName: "verdicts", args: [eventId] },
    ],
    query: { refetchInterval: 4000 },
  });

  const ev = data?.[0]?.result as
    | {
        stable: `0x${string}`;
        detectedPrice: bigint;
        confirmedPrice: bigint;
        deviationBps: bigint;
        triggeredAt: bigint;
        state: number;
        stage: number;
        pendingRequestId: bigint;
        cause: number;
        disclosure: string;
        disclosure2: string;
      }
    | undefined;
  const receipts = (data?.[1]?.result as Receipt[] | undefined) ?? [];
  const verdict = data?.[2]?.result as
    | readonly [`0x${string}`, number, bigint, bigint, boolean]
    | undefined;

  const notFound = !isLoading && data?.[0]?.status === "failure";

  // Group receipts by requestId, ordered by stage.
  const groups = (() => {
    const byReq = new Map<string, Receipt[]>();
    for (const r of receipts) {
      const k = r.requestId.toString();
      if (!byReq.has(k)) byReq.set(k, []);
      byReq.get(k)!.push(r);
    }
    return [...byReq.values()].sort((a, b) => a[0].stage - b[0].stage);
  })();

  const stateName = ev ? EVENT_STATE[ev.state] : "—";
  const causeName = ev ? CAUSE[ev.cause] : "UNKNOWN";
  const stateBadge =
    ev?.state === 4 ? "ok" : ev?.state === 5 ? "idle" : ev?.state === 6 ? "bad" : "violet";

  return (
    <div>
      {/* ── Header ── */}
      <div className="sec-head rule-b">
        <div className="sec-no">[ PROOF ]</div>
        <div>
          <div className="kicker" style={{ marginBottom: 16 }}>
            <span className="dot" /> PROOF, ON-CHAIN
          </div>
          <h1 className="sec-title">
            Investigation <span className="ed">#{eventId.toString()}</span>
          </h1>
        </div>
        <div className="right">
          <p className="sec-lead">
            Every validator vote, persisted on-chain and read back with a single call. Three
            independent machines agreed on <em>why</em> — and anyone can verify it.
          </p>
        </div>
      </div>

      {notFound ? (
        <div className="empty">
          No investigation found for event #{eventId.toString()}. Trigger one from the{" "}
          <Link href="/" className="ed">
            dashboard
          </Link>
          .
        </div>
      ) : (
        <>
          {/* ── Verdict summary (dark) ── */}
          <section className="dark">
            <div className="pm-bar">
              <span className="live">VERDICT</span>
              <span>EVENT #{eventId.toString()}</span>
            </div>
            <div className="section-pad" style={{ display: "grid", gap: 24 }}>
              <div className={`peg-gauge ${ev?.state === 6 ? "warning" : "settled"}`}>
                <div>
                  <div className="label">Classification</div>
                  <div className="value" style={{ fontSize: "clamp(34px,5vw,68px)" }}>
                    {causeName.replace(/_/g, " ")}
                  </div>
                </div>
                <div className="delta">
                  <span className={`badge ${stateBadge}`}>{stateName}</span>
                </div>
              </div>
              <div className="vp-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14 }}>
                <Meta k="Insured" v={shortAddr(ev?.stable)} />
                <Meta k="Deviation" v={ev ? fmtBpsPct(ev.deviationBps) : "—"} />
                <Meta k="Detected price" v={fmtPrice(ev?.detectedPrice)} />
                <Meta k="Basket price" v={fmtPrice(ev?.confirmedPrice)} />
              </div>
              {verdict?.[4] && (
                <div className="kicker" style={{ color: "var(--green)" }}>
                  ◆ Verdict recorded with the Treasury · payout matrix applied
                </div>
              )}
            </div>
          </section>

          {/* ── Disclosure evidence (two independent web sources) ── */}
          {(ev?.disclosure || ev?.disclosure2) && (
            <section className="section-pad rule-b" style={{ display: "grid", gap: 20 }}>
              {ev?.disclosure && (
                <div>
                  <div className="field-label" style={{ marginBottom: 10 }}>Issuer disclosure (source #1 · homepage)</div>
                  <p style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 20, lineHeight: 1.5, maxWidth: "62ch" }}>
                    “{ev.disclosure}”
                  </p>
                </div>
              )}
              {ev?.disclosure2 && (
                <div>
                  <div className="field-label" style={{ marginBottom: 10 }}>Status feed (source #2 · social)</div>
                  <p style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 20, lineHeight: 1.5, maxWidth: "62ch" }}>
                    “{ev.disclosure2}”
                  </p>
                </div>
              )}
            </section>
          )}

          {/* ── Per-stage receipts ── */}
          <section>
            {isLoading && groups.length === 0 ? (
              <div className="empty">Loading on-chain receipts…</div>
            ) : groups.length === 0 ? (
              <div className="empty">No agent receipts recorded yet — the pipeline may still be in flight.</div>
            ) : (
              groups.map((votes) => {
                const r0 = votes[0];
                const agent = AGENT_LABELS[r0.agentId.toString()] ?? `Agent ${r0.agentId}`;
                const successCount = votes.filter((v) => v.status === 2).length;
                const COMMITTEE = 3;
                // Tiered consensus: Confirm (stage 1) + Classify (stage 4) sign the payout → require 3/3.
                // The Parse-Website investigate stages (2,3) gather evidence → 2-of-3 majority.
                const required = r0.stage === 1 || r0.stage === 4 ? 3 : 2;
                // Largest set of byte-identical Success votes (the agreeing quorum).
                const success = votes.filter((v) => v.status === 2);
                const agreedCount = success.reduce(
                  (max, v) => Math.max(max, success.filter((x) => x.result === v.result).length),
                  0,
                );
                const agreed = agreedCount >= required;
                const stamp = agreed
                  ? `${agreedCount}/${COMMITTEE} CONSENSUS`
                  : successCount === 0
                    ? "FAILED"
                    : "NO QUORUM";
                const stampClass = agreed ? "violet" : "amber";
                return (
                  <div key={r0.requestId.toString()} className="section-pad rule-b" style={{ position: "relative" }}>
                    <div className={`r-stamp ${stampClass}`} aria-hidden="true" style={{ position: "absolute", top: 24, right: 32 }}>
                      {stamp}
                    </div>
                    <div className="kicker" style={{ marginBottom: 8 }}>
                      STAGE {r0.stage} · {agent}
                    </div>
                    <h2 className="sec-title" style={{ fontSize: "clamp(24px,3vw,40px)", marginBottom: 6 }}>
                      {STAGE_TITLE[r0.stage] ?? STAGE[r0.stage]}
                    </h2>
                    <div className="muted" style={{ fontFamily: "var(--mono)", fontSize: 12, marginBottom: 20 }}>
                      request #{r0.requestId.toString()} · {successCount}/{votes.length} validators returned Success ·{" "}
                      {timeAgo(r0.timestamp)}
                    </div>

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: `repeat(${Math.min(votes.length, 3)}, 1fr)`,
                        gap: 12,
                      }}
                    >
                      {votes.map((v, i) => {
                        const ok = v.status === 2;
                        return (
                          <div key={i} className="panel" style={{ padding: 16, display: "grid", gap: 10 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                              <span className="muted" style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
                                {shortAddr(v.validator)}
                              </span>
                              <span className={`badge ${ok ? "ok" : "bad"}`}>{RESPONSE_STATUS[v.status]}</span>
                            </div>
                            <div style={{ fontFamily: "var(--mono)", fontSize: 13, wordBreak: "break-word" }}>
                              {decodeResult(v.stage, v.result)}
                            </div>
                            <div className="muted" style={{ fontFamily: "var(--mono)", fontSize: 10.5, letterSpacing: "0.08em" }}>
                              cost {fmtWad(v.executionCost, 4)} STT
                              {v.receiptId !== 0n ? ` · receipt ${v.receiptId.toString()}` : ""}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            )}
          </section>

          <div className="section-pad" style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-3)" }}>
            Receipts read on-chain via <span className="ed">SentinelOracle.getReceipts</span> — no
            indexer, no backend.{" "}
            <Link href="/" className="ed">
              ← back to desk
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <div className="vp-node" style={{ border: "1px solid var(--line-d)", padding: 14 }}>
      <div className="id" style={{ fontSize: 10.5, letterSpacing: "0.14em", color: "var(--off-3)", textTransform: "uppercase" }}>
        {k}
      </div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 14, color: "var(--off)" }}>{v}</div>
    </div>
  );
}

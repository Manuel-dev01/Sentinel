"use client";

import { useState } from "react";
import { parseEther, maxUint256 } from "viem";
import {
  useAccount,
  useReadContracts,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import type { Abi } from "viem";
import { CONTRACTS, STABLES } from "@/lib/contracts";
import { fmtWad, fmtCompact } from "@/lib/format";

export default function LiquidityPage() {
  const { address, isConnected } = useAccount();
  const [depositAmt, setDepositAmt] = useState("");
  const [withdrawAmt, setWithdrawAmt] = useState("");

  const { data: g, refetch: refetchG } = useReadContracts({
    contracts: [
      { ...CONTRACTS.pool, functionName: "totalAssets" },
      { ...CONTRACTS.pool, functionName: "availableCapital" },
      { ...CONTRACTS.pool, functionName: "outstandingLiability" },
      { ...CONTRACTS.pool, functionName: "utilizationCapBps" },
      { ...CONTRACTS.pool, functionName: "totalShares" },
      { ...CONTRACTS.pool, functionName: "convertToAssets", args: [parseEther("1")] },
      { ...CONTRACTS.registry, functionName: "getConfig", args: [STABLES[0].address] },
    ],
    query: { refetchInterval: 5000 },
  });

  // The pool is shared across all insured stables, so a live event on ANY stable locks withdrawals.
  // Dynamic per-stable array uses a loosely-typed abi (wagmi can't infer a spread tuple).
  const { data: liveEvents } = useReadContracts({
    contracts: STABLES.map((s) => ({
      address: CONTRACTS.oracle.address,
      abi: CONTRACTS.oracle.abi as Abi,
      functionName: "liveEventOf",
      args: [s.address],
    })),
    query: { refetchInterval: 5000 },
  });

  const { data: u, refetch: refetchU } = useReadContracts({
    contracts: [
      { ...CONTRACTS.pool, functionName: "sharesOf", args: [address ?? "0x0000000000000000000000000000000000000000"] },
      { ...CONTRACTS.capital, functionName: "balanceOf", args: [address ?? "0x0000000000000000000000000000000000000000"] },
      { ...CONTRACTS.capital, functionName: "allowance", args: [address ?? "0x0", CONTRACTS.pool.address] },
    ],
    query: { enabled: !!address, refetchInterval: 5000 },
  });

  const totalAssets = (g?.[0]?.result as bigint) ?? 0n;
  const available = (g?.[1]?.result as bigint) ?? 0n;
  const liability = (g?.[2]?.result as bigint) ?? 0n;
  const capBps = (g?.[3]?.result as number) ?? 0;
  const totalShares = (g?.[4]?.result as bigint) ?? 0n;
  const navPerShare = (g?.[5]?.result as bigint) ?? parseEther("1");
  const cfg = g?.[6]?.result as { annualRateBps: number } | undefined;
  // The pool locks if any stable has a live (non-terminal) event.
  const liveEventId =
    (liveEvents ?? []).map((r) => (r?.result as bigint) ?? 0n).find((id) => id !== 0n) ?? 0n;

  // Estimated LP yield: annual premium income from active coverage ÷ pool capital.
  // premium/yr ≈ outstandingLiability × annualRateBps; APY ≈ that / totalAssets (WADs cancel → bps).
  const annualRateBps = cfg?.annualRateBps ?? 0;
  const apyPct =
    totalAssets > 0n ? Number((liability * BigInt(annualRateBps)) / totalAssets) / 100 : 0;

  const myShares = (u?.[0]?.result as bigint) ?? 0n;
  const myBalance = (u?.[1]?.result as bigint) ?? 0n;
  const allowance = (u?.[2]?.result as bigint) ?? 0n;

  // Local share math mirrors the contract's virtual +1 offset.
  const sharesForAssets = (assets: bigint) => (assets * (totalShares + 1n)) / (totalAssets + 1n);
  const assetsForShares = (shares: bigint) => (shares * (totalAssets + 1n)) / (totalShares + 1n);
  const myValue = assetsForShares(myShares);

  const locked = liveEventId !== 0n;
  const utilization = totalAssets > 0n ? Number((liability * 10000n) / totalAssets) : 0;

  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: mining } = useWaitForTransactionReceipt({ hash: txHash, query: { enabled: !!txHash } });
  const busy = isPending || mining;
  const after = () => setTimeout(() => { refetchG(); refetchU(); }, 1500);

  let depositWei = 0n;
  try { depositWei = depositAmt ? parseEther(depositAmt) : 0n; } catch { depositWei = 0n; }
  let withdrawWei = 0n;
  try { withdrawWei = withdrawAmt ? parseEther(withdrawAmt) : 0n; } catch { withdrawWei = 0n; }
  const needApprove = depositWei > 0n && allowance < depositWei;

  const faucet = () =>
    writeContract({ ...CONTRACTS.capital, functionName: "mint", args: [address!, parseEther("1000000")] }, { onSettled: after });
  const onDeposit = () => {
    if (needApprove) {
      writeContract({ ...CONTRACTS.capital, functionName: "approve", args: [CONTRACTS.pool.address, maxUint256] }, { onSettled: after });
    } else {
      writeContract({ ...CONTRACTS.pool, functionName: "deposit", args: [depositWei, address!] }, { onSettled: () => { setDepositAmt(""); after(); } });
    }
  };
  const onWithdraw = () => {
    const shares = withdrawWei > 0n ? sharesForAssets(withdrawWei) : 0n;
    if (shares === 0n) return;
    writeContract({ ...CONTRACTS.pool, functionName: "redeem", args: [shares, address!] }, { onSettled: () => { setWithdrawAmt(""); after(); } });
  };

  return (
    <div>
      <div className="sec-head rule-b">
        <div className="sec-no">[ LP ]</div>
        <div>
          <div className="kicker" style={{ marginBottom: 16 }}>
            <span className="dot" /> LIQUIDITY
          </div>
          <h1 className="sec-title">
            Back the <span className="ed">book.</span>
          </h1>
        </div>
        <div className="right">
          <p className="sec-lead">
            Deposit capital, earn the premiums, take the tail risk. Shares mint at NAV; withdrawals
            lock while an event is settling.
          </p>
        </div>
      </div>

      {/* Pool metrics */}
      <section className="stats-console">
        <div className="stat">
          <div className="s-no">[ NAV ]</div>
          <div className="s-val tnum">{fmtWad(navPerShare, 4)}</div>
          <div className="s-lbl">Assets per share</div>
        </div>
        <div className="stat">
          <div className="s-no">[ TVL ]</div>
          <div className="s-val tnum">{fmtCompact(totalAssets)}<span className="u"> sUSD</span></div>
          <div className="s-lbl">Total pool capital</div>
        </div>
        <div className="stat">
          <div className="s-no">[ APY ]</div>
          <div className="s-val tnum">{apyPct.toFixed(2)}<span className="u">%</span></div>
          <div className="s-lbl">Est. yield · active coverage</div>
        </div>
        <div className="stat">
          <div className="s-no">[ UTIL ]</div>
          <div className="s-val tnum">{utilization}<span className="u">%</span></div>
          <div className="s-lbl">of {capBps / 100}% cap</div>
        </div>
      </section>

      {/* Withdrawal lock banner */}
      {locked && (
        <div className="section-pad rule-b" style={{ background: "var(--paper-2)" }}>
          <span className="badge warn">WITHDRAWALS LOCKED</span>{" "}
          <span className="muted" style={{ fontFamily: "var(--mono)", fontSize: 13 }}>
            Event #{liveEventId.toString()} is in flight — capital backing a settling event can&apos;t be drawn down.
          </span>
        </div>
      )}

      {/* Deposit / Withdraw */}
      <section className="grid-2">
        {/* Deposit */}
        <div className="section-pad" style={{ display: "grid", gap: 18 }}>
          <h2 className="sec-title" style={{ fontSize: "clamp(22px,2.4vw,32px)" }}>Deposit</h2>
          <div className="field">
            <label className="field-label">Amount · sUSD</label>
            <div className="input-row">
              <input className="input" inputMode="decimal" placeholder="0.0" value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} />
              <span className="input-suffix">sUSD</span>
            </div>
          </div>
          <div className="kv"><span className="k">Wallet balance</span><span className="v">{fmtWad(myBalance)} sUSD</span></div>
          <div className="kv"><span className="k">You receive</span><span className="v">≈ {fmtWad(sharesForAssets(depositWei))} shares</span></div>
          {isConnected ? (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button className="pill solid full" onClick={onDeposit} disabled={busy || depositWei === 0n}>
                {busy ? "Submitting…" : needApprove ? "Approve sUSD" : "Deposit"}
              </button>
              <button className="pill" onClick={faucet} disabled={busy}>Faucet · mint 1M sUSD</button>
            </div>
          ) : (
            <span className="muted kicker">connect a wallet to deposit</span>
          )}
        </div>

        {/* Withdraw */}
        <div className="section-pad" style={{ display: "grid", gap: 18 }}>
          <h2 className="sec-title" style={{ fontSize: "clamp(22px,2.4vw,32px)" }}>Withdraw</h2>
          <div className="field">
            <label className="field-label">Amount · sUSD</label>
            <div className="input-row">
              <input className="input" inputMode="decimal" placeholder="0.0" value={withdrawAmt} onChange={(e) => setWithdrawAmt(e.target.value)} />
              <span className="input-suffix">sUSD</span>
            </div>
          </div>
          <div className="kv"><span className="k">Your position</span><span className="v">{fmtWad(myValue)} sUSD · {fmtWad(myShares)} shares</span></div>
          <div className="kv"><span className="k">Available now</span><span className="v">{fmtCompact(available)} sUSD</span></div>
          <div className="kv"><span className="k">Pool exposure</span><span className="v">{fmtCompact(liability)} sUSD outstanding</span></div>
          {isConnected ? (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button className="pill full" onClick={onWithdraw} disabled={busy || withdrawWei === 0n || locked}>
                {busy ? "Submitting…" : locked ? "Locked" : "Withdraw"}
              </button>
              <button className="pill" onClick={() => setWithdrawAmt(fmtWad(myValue, 6))} disabled={myShares === 0n}>Max</button>
            </div>
          ) : (
            <span className="muted kicker">connect a wallet to withdraw</span>
          )}
        </div>
      </section>
    </div>
  );
}

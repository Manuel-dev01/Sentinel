"use client";

import { useState } from "react";
import { parseEther, maxUint256 } from "viem";
import {
  useAccount,
  useReadContract,
  useReadContracts,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { CONTRACTS, INSURED, POLICY_STATUS } from "@/lib/contracts";
import { fmtWad, fmtBpsPct } from "@/lib/format";
import { CrossChainFund } from "@/components/CrossChainFund";

const DAY = 86_400;
const ZERO = "0x0000000000000000000000000000000000000000" as const;

type Policy = {
  holder: `0x${string}`;
  stable: `0x${string}`;
  notional: bigint;
  premiumPaid: bigint;
  start: bigint;
  term: bigint;
  minAge: bigint;
  status: number;
};

export default function PoliciesPage() {
  const { address, isConnected } = useAccount();
  const [notional, setNotional] = useState("100000");
  const [termDays, setTermDays] = useState("365");

  let notionalWei = 0n;
  try { notionalWei = notional ? parseEther(notional) : 0n; } catch { notionalWei = 0n; }
  const termSec = BigInt((Number(termDays) || 0) * DAY);

  const { data: premium } = useReadContract({
    ...CONTRACTS.policy,
    functionName: "quote",
    args: [INSURED, notionalWei, termSec],
    query: { enabled: notionalWei > 0n && termSec > 0n },
  });
  const premiumWei = (premium as bigint) ?? 0n;

  const { data: meta, refetch: refetchMeta } = useReadContracts({
    contracts: [
      { ...CONTRACTS.registry, functionName: "getConfig", args: [INSURED] },
      { ...CONTRACTS.policy, functionName: "nextTokenId" },
      { ...CONTRACTS.capital, functionName: "balanceOf", args: [address ?? ZERO] },
      { ...CONTRACTS.capital, functionName: "allowance", args: [address ?? ZERO, CONTRACTS.policy.address] },
      { ...CONTRACTS.oracle, functionName: "nextEventId" },
    ],
    query: { refetchInterval: 6000 },
  });
  const cfg = meta?.[0]?.result as { annualRateBps: number } | undefined;
  const nextTokenId = (meta?.[1]?.result as bigint) ?? 1n;
  const myBalance = (meta?.[2]?.result as bigint) ?? 0n;
  const allowance = (meta?.[3]?.result as bigint) ?? 0n;
  const nextEventId = (meta?.[4]?.result as bigint) ?? 1n;

  // The most recent event — used to find a classified verdict to claim against.
  const lastEventId = nextEventId > 1n ? nextEventId - 1n : 0n;
  const { data: evData, refetch: refetchEv } = useReadContracts({
    contracts: [
      { ...CONTRACTS.oracle, functionName: "getEvent", args: [lastEventId] },
      { ...CONTRACTS.treasury, functionName: "verdicts", args: [lastEventId] },
    ],
    query: { enabled: lastEventId > 0n, refetchInterval: 6000 },
  });
  const lastEvent = evData?.[0]?.result as { state: number; stable: `0x${string}` } | undefined;
  const verdict = evData?.[1]?.result as readonly [string, number, bigint, bigint, boolean] | undefined;
  // A claimable event exists when the last event is Classified for our insured stable + verdict recorded.
  const claimEventId =
    lastEvent && lastEvent.state === 4 && lastEvent.stable.toLowerCase() === INSURED.toLowerCase() && verdict?.[4]
      ? lastEventId
      : 0n;

  // Scan minted token ids for the holder's policies.
  const ids = Array.from({ length: Math.max(0, Number(nextTokenId) - 1) }, (_, i) => BigInt(i + 1));
  const { data: scan, refetch: refetchScan } = useReadContracts({
    contracts: ids.flatMap((id) => [
      { ...CONTRACTS.policy, functionName: "policies", args: [id] },
      { ...CONTRACTS.policy, functionName: "ownerOf", args: [id] },
    ]),
    query: { enabled: ids.length > 0 },
  });

  const myPolicies = ids
    .map((id, i) => {
      const p = scan?.[i * 2]?.result as unknown as
        | [`0x${string}`, `0x${string}`, bigint, bigint, bigint, bigint, bigint, number]
        | undefined;
      const owner = scan?.[i * 2 + 1]?.result as `0x${string}` | undefined;
      if (!p || !owner) return null;
      const pol: Policy = {
        holder: p[0], stable: p[1], notional: p[2], premiumPaid: p[3],
        start: p[4], term: p[5], minAge: p[6], status: p[7],
      };
      return { id, owner, pol };
    })
    .filter((x): x is { id: bigint; owner: `0x${string}`; pol: Policy } =>
      !!x && !!address && x.owner.toLowerCase() === address.toLowerCase());

  // Per-policy payout quote + vesting for the claimable event.
  const { data: claimData, refetch: refetchClaim } = useReadContracts({
    contracts: myPolicies.flatMap(({ id }) => [
      { ...CONTRACTS.treasury, functionName: "quotePayout", args: [claimEventId, id] },
      { ...CONTRACTS.treasury, functionName: "vestings", args: [claimEventId, id] },
    ]),
    query: { enabled: claimEventId > 0n && myPolicies.length > 0, refetchInterval: 6000 },
  });

  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: mining } = useWaitForTransactionReceipt({ hash: txHash, query: { enabled: !!txHash } });
  const busy = isPending || mining;
  const after = () => setTimeout(() => { refetchMeta(); refetchScan(); refetchEv(); refetchClaim(); }, 1500);

  const needApprove = premiumWei > 0n && allowance < premiumWei;
  const faucet = () =>
    writeContract({ ...CONTRACTS.capital, functionName: "mint", args: [address!, parseEther("10000")] }, { onSettled: after });
  const onBuy = () => {
    if (needApprove) {
      writeContract({ ...CONTRACTS.capital, functionName: "approve", args: [CONTRACTS.policy.address, maxUint256] }, { onSettled: after });
    } else {
      writeContract({ ...CONTRACTS.policy, functionName: "buy", args: [INSURED, notionalWei, termSec] }, { onSettled: after });
    }
  };
  const settle = (tokenId: bigint) =>
    writeContract({ ...CONTRACTS.treasury, functionName: "settle", args: [claimEventId, tokenId] }, { onSettled: after });
  const claimVested = (tokenId: bigint) =>
    writeContract({ ...CONTRACTS.treasury, functionName: "claimVested", args: [claimEventId, tokenId] }, { onSettled: after });

  const statusBadge = (s: number) => (s === 1 ? "ok" : s === 2 ? "warn" : s === 3 ? "violet" : "idle");

  return (
    <div>
      <div className="sec-head rule-b">
        <div className="sec-no">[ COVER ]</div>
        <div>
          <div className="kicker" style={{ marginBottom: 16 }}>
            <span className="dot" /> COVERAGE
          </div>
          <h1 className="sec-title">
            Insure a <span className="ed">position.</span>
          </h1>
        </div>
        <div className="right">
          <p className="sec-lead">
            Pick a notional and a term. Premium is priced from the stablecoin&apos;s risk parameters.
            A covered depeg pays out per the on-chain matrix — no claim to file.
          </p>
        </div>
      </div>

      <section className="grid-2">
        {/* Quote / buy */}
        <div className="section-pad" style={{ display: "grid", gap: 18 }}>
          <h2 className="sec-title" style={{ fontSize: "clamp(22px,2.4vw,32px)" }}>Quote</h2>
          <div className="field">
            <label className="field-label">Notional · USDC exposure</label>
            <div className="input-row">
              <input className="input" inputMode="decimal" value={notional} onChange={(e) => setNotional(e.target.value)} />
              <span className="input-suffix">USDC</span>
            </div>
          </div>
          <div className="field">
            <label className="field-label">Term · days</label>
            <div className="input-row">
              <input className="input" inputMode="numeric" value={termDays} onChange={(e) => setTermDays(e.target.value)} />
              <span className="input-suffix">days</span>
            </div>
          </div>
          <div className="kv"><span className="k">Annual rate</span><span className="v">{cfg ? fmtBpsPct(cfg.annualRateBps) : "—"}</span></div>
          <div className="kv"><span className="k">Premium</span><span className="v">{fmtWad(premiumWei)} sUSD</span></div>
          <div className="kv"><span className="k">Wallet balance</span><span className="v">{fmtWad(myBalance)} sUSD</span></div>
          {isConnected ? (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button className="pill solid full" onClick={onBuy} disabled={busy || premiumWei === 0n}>
                {busy ? "Submitting…" : needApprove ? "Approve sUSD" : "Buy coverage"}
              </button>
              <button className="pill" onClick={faucet} disabled={busy}>Faucet · mint 10K sUSD</button>
            </div>
          ) : (
            <span className="muted kicker">connect a wallet to buy coverage</span>
          )}
        </div>

        {/* Policy NFTs */}
        <div className="section-pad" style={{ display: "grid", gap: 16, alignContent: "start" }}>
          <h2 className="sec-title" style={{ fontSize: "clamp(22px,2.4vw,32px)" }}>Your policies</h2>
          {!isConnected ? (
            <span className="muted kicker">connect a wallet to see your coverage</span>
          ) : myPolicies.length === 0 ? (
            <div className="muted" style={{ fontFamily: "var(--mono)", fontSize: 13 }}>No policies yet.</div>
          ) : (
            myPolicies.map(({ id, pol }, i) => {
              const payout = claimData?.[i * 2]?.result as bigint | undefined;
              const vesting = claimData?.[i * 2 + 1]?.result as readonly [bigint, bigint, boolean] | undefined;
              const nowS = BigInt(Math.floor(Date.now() / 1000));
              const claimable = claimEventId > 0n && pol.stable.toLowerCase() === INSURED.toLowerCase();
              return (
                <div key={id.toString()} className="panel" style={{ padding: 18, display: "grid", gap: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span className="kicker">POLICY #{id.toString()}</span>
                    <span className={`badge ${statusBadge(pol.status)}`}>{POLICY_STATUS[pol.status]}</span>
                  </div>
                  <div className="kv"><span className="k">Notional</span><span className="v">{fmtWad(pol.notional)} USDC</span></div>
                  <div className="kv"><span className="k">Premium paid</span><span className="v">{fmtWad(pol.premiumPaid)} sUSD</span></div>
                  <div className="kv"><span className="k">Term</span><span className="v">{(Number(pol.term) / DAY).toFixed(0)} days</span></div>

                  {/* Claim affordance — driven by the classified event for this stable */}
                  {claimable && pol.status === 1 && (
                    <>
                      <div className="kv"><span className="k">Payout due</span><span className="v">{fmtWad(payout)} sUSD</span></div>
                      <button className="pill solid full" onClick={() => settle(id)} disabled={busy}>
                        {busy ? "Submitting…" : `Claim payout · event #${claimEventId}`}
                      </button>
                    </>
                  )}
                  {claimable && pol.status === 2 && vesting && (
                    vesting[2] ? (
                      <span className="badge violet">VESTED PAYOUT CLAIMED</span>
                    ) : nowS >= vesting[1] ? (
                      <button className="pill solid full" onClick={() => claimVested(id)} disabled={busy}>
                        {busy ? "Submitting…" : `Claim vested · ${fmtWad(vesting[0])} sUSD`}
                      </button>
                    ) : (
                      <div className="kv">
                        <span className="k">Vesting</span>
                        <span className="v">
                          {fmtWad(vesting[0])} sUSD · releasable {new Date(Number(vesting[1]) * 1000).toLocaleString()}
                        </span>
                      </div>
                    )
                  )}
                  {pol.status === 3 && <span className="badge violet">PAID</span>}
                </div>
              );
            })
          )}
        </div>
      </section>

      <CrossChainFund blurb="Fund premiums from any chain." />
    </div>
  );
}

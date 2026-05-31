import { formatUnits } from "viem";

/** Format an 18-decimal WAD bigint as a human string with `dp` decimals (grouped). */
export function fmtWad(v: bigint | undefined, dp = 2): string {
  if (v === undefined) return "—";
  const n = Number(formatUnits(v, 18));
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Compact money, e.g. 1,000,000 -> "1.00M". */
export function fmtCompact(v: bigint | undefined): string {
  if (v === undefined) return "—";
  const n = Number(formatUnits(v, 18));
  return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
}

/** A WAD price as a $ string (4 dp, peg precision). */
export function fmtPrice(v: bigint | undefined): string {
  if (v === undefined) return "—";
  return `$${fmtWad(v, 4)}`;
}

/** bps integer -> percent string, e.g. 800 -> "8.00%". */
export function fmtBpsPct(bps: bigint | number | undefined): string {
  if (bps === undefined) return "—";
  return `${(Number(bps) / 100).toFixed(2)}%`;
}

/** Shorten an address: 0x1234…abcd. */
export function shortAddr(a: string | undefined): string {
  if (!a) return "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** Deviation in bps between a price and a peg target (both WAD). */
export function deviationBps(price: bigint, peg: bigint): number {
  if (peg === 0n) return 0;
  const diff = price > peg ? price - peg : peg - price;
  return Number((diff * 10_000n) / peg);
}

/** Relative time-ago from a unix-seconds timestamp. */
export function timeAgo(unixSeconds: number | bigint | undefined): string {
  if (unixSeconds === undefined) return "—";
  const s = Math.floor(Date.now() / 1000) - Number(unixSeconds);
  if (s < 0) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

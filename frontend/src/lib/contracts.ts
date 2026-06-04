import { addresses, abis, chainId, deployment, stables } from "./generated";

/**
 * Typed contract registry for the app. Addresses come from the generated deployment
 * (auto-synced by `node script/gen-frontend.mjs` after each deploy); each can be overridden
 * via a NEXT_PUBLIC_* env var. Env refs are written out literally so Next inlines them at build.
 */
const A = addresses;

export const CONTRACTS = {
  registry: {
    address: (process.env.NEXT_PUBLIC_REGISTRY_ADDRESS ?? A.registry) as `0x${string}`,
    abi: abis.SentinelRegistry,
  },
  pool: {
    address: (process.env.NEXT_PUBLIC_POOL_ADDRESS ?? A.pool) as `0x${string}`,
    abi: abis.SentinelPool,
  },
  policy: {
    address: (process.env.NEXT_PUBLIC_POLICY_ADDRESS ?? A.policy) as `0x${string}`,
    abi: abis.SentinelPolicy,
  },
  treasury: {
    address: (process.env.NEXT_PUBLIC_TREASURY_ADDRESS ?? A.treasury) as `0x${string}`,
    abi: abis.SentinelTreasury,
  },
  oracle: {
    address: (process.env.NEXT_PUBLIC_ORACLE_ADDRESS ?? A.oracle) as `0x${string}`,
    abi: abis.SentinelOracle,
  },
  priceOracle: {
    address: (process.env.NEXT_PUBLIC_PRICE_ORACLE_ADDRESS ?? A.priceOracle) as `0x${string}`,
    abi: abis.MockPriceOracle,
  },
  capital: {
    address: (process.env.NEXT_PUBLIC_CAPITAL_ADDRESS ?? A.capital) as `0x${string}`,
    abi: abis.MockStable,
  },
  insured: {
    address: (process.env.NEXT_PUBLIC_INSURED_ADDRESS ?? A.insured) as `0x${string}`,
    abi: abis.MockStable,
  },
  // Autonomous price poller. Owns MockPriceOracle, so operator price writes (Simulate/Reset) route
  // through `operatorSetPrice`. Optional — only present once the poller is deployed.
  poller: {
    address: (process.env.NEXT_PUBLIC_POLLER_ADDRESS ??
      (A as { poller?: string }).poller ??
      "0x0000000000000000000000000000000000000000") as `0x${string}`,
    abi: abis.PriceFeedPoller,
  },
} as const;

export { chainId, deployment };

/** One autonomously-monitored live asset (real price + real two-source investigation). */
export type MonitorAsset = {
  asset: `0x${string}`;
  symbol: string;
  display: string; // e.g. "USDC·live"
  policyTokenId: string;
  url: string;
  selector: string;
};
/** Autonomous-monitor metadata (the multi-asset poller + the live assets it polls), or null. */
export type MonitorInfo = {
  poller: `0x${string}`;
  pollIntervalSeconds: number;
  assets: readonly MonitorAsset[];
};
export const monitor = (deployment as { monitor?: MonitorInfo | null }).monitor ?? null;
export const monitorAssets: readonly MonitorAsset[] = monitor?.assets ?? [];
export const hasPoller =
  !!monitor &&
  monitorAssets.length > 0 &&
  CONTRACTS.poller.address !== "0x0000000000000000000000000000000000000000";

/** Insured stablecoins registered at deploy time (synced by gen-frontend.mjs from the artifact). */
export type Stable = {
  address: `0x${string}`;
  symbol: string;
  name: string;
  annualRateBps: number;
  /** Autonomously price-monitored by the live poller (USDC·live) — no operator trigger. */
  monitored?: boolean;
};

const baseStables: readonly Stable[] = (stables as readonly Stable[]).length
  ? (stables as readonly Stable[])
  : [{ address: CONTRACTS.insured.address, symbol: "USDx", name: "Insured", annualRateBps: 50 }];

/**
 * All insurable stablecoins shown in the UI: the operator-triggered demo stables plus the
 * autonomously-monitored USDC·live (real coverage, driven only by the poller — flagged `monitored`
 * so the dashboard hides the operator Simulate/scenario controls for it).
 */
export const STABLES: readonly Stable[] = [
  ...baseStables,
  ...monitorAssets.map((a) => ({
    address: a.asset,
    symbol: a.display,
    name: `${a.display} (autonomous)`,
    annualRateBps: 50,
    monitored: true,
  })),
];

/** Default / primary insured stablecoin (the simulate-depeg target). */
export const INSURED = baseStables[0].address;

// ─────────────────────────── enum mirrors (order is contract-significant) ───────────────────────────

/** SentinelOracle.EventState */
export const EVENT_STATE = [
  "None",
  "Confirming",
  "Investigating",
  "Classifying",
  "Classified",
  "Dismissed",
  "Failed",
] as const;
export type EventStateName = (typeof EVENT_STATE)[number];

/** SentinelOracle.Stage — Investigate2 is the second Parse-Website source (status feed). */
export const STAGE = ["None", "Confirm", "Investigate", "Investigate2", "Classify"] as const;
export type StageName = (typeof STAGE)[number];

/** Classification.Cause */
export const CAUSE = [
  "UNKNOWN",
  "SMART_CONTRACT_EXPLOIT",
  "BANK_RUN",
  "REGULATORY",
  "TECHNICAL_GLITCH",
] as const;
export type CauseName = (typeof CAUSE)[number];

/** IAgentPlatform.ResponseStatus */
export const RESPONSE_STATUS = ["None", "Pending", "Success", "Failed", "TimedOut"] as const;
export type ResponseStatusName = (typeof RESPONSE_STATUS)[number];

/** SentinelPolicy.Status */
export const POLICY_STATUS = ["None", "Active", "Claimable", "Claimed", "Expired"] as const;
export type PolicyStatusName = (typeof POLICY_STATUS)[number];

/** Human label + agent id for the three pipeline agents (for the audit screen). */
export const AGENT_LABELS: Record<string, string> = {
  "13174292974160097713": "JSON API",
  "12875401142070969085": "LLM Parse Website",
  "12847293847561029384": "LLM Inference",
};

// ─────────────────────────── explorer helpers ───────────────────────────

const EXPLORER = "https://shannon-explorer.somnia.network";
export const explorerTx = (h: string) => `${EXPLORER}/tx/${h}`;
export const explorerAddress = (a: string) => `${EXPLORER}/address/${a}`;

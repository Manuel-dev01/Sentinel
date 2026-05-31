import { addresses, abis, chainId, deployment } from "./generated";

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
} as const;

export { chainId, deployment };

/** The single insured stablecoin in the MVP (the one that depegs). */
export const INSURED = CONTRACTS.insured.address;

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

/** SentinelOracle.Stage */
export const STAGE = ["None", "Confirm", "Investigate", "Classify"] as const;
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

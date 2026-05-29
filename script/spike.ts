/**
 * Phase-0 / Step-3 spike runner.
 *
 * Two contracts, one session, two on-chain agent round-trips:
 *   1. SpikeJsonApi   — fetches MOCK_ISSUER_URL via the JSON API agent
 *   2. SpikeLlmInference — classifies a depeg disclosure via Qwen3-30B
 *
 * Reads config from .env (gitignored). Prints a structured summary at the end
 * and writes docs/spike-results.md so we have a reproducible artifact.
 *
 *   pnpm spike:fire     # = hardhat run script/spike.ts --network somniaTestnet
 */

import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

// ---------- ENUMS (mirror IAgentPlatform.ResponseStatus) ----------
const RS = ["None", "Pending", "Success", "Failed", "TimedOut"] as const;
type ResponseStatusName = (typeof RS)[number];

const PLATFORM_ADDRESS_TESTNET = "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776";
const SUB_COMMITTEE_SIZE = 3;

/** The classification prompt — minimal, deterministic-friendly. */
const CLASSIFICATION_PROMPT = [
  "You are a deterministic classifier. Output exactly one token from this set,",
  "with no whitespace, punctuation, or explanation:",
  "",
  "SMART_CONTRACT_EXPLOIT",
  "BANK_RUN",
  "REGULATORY",
  "TECHNICAL_GLITCH",
  "UNKNOWN",
  "",
  "Event description:",
  "USDx stablecoin vault drained via reentrancy exploit. 90% of reserves lost. Price moved from $1.00 to $0.94.",
  "",
  "Output:",
].join("\n");

function ensureEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "" || v.includes("...")) {
    throw new Error(`Missing or placeholder env var: ${name}. Edit .env and re-run.`);
  }
  return v.trim();
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function explorerTx(hash: string): string {
  const base = process.env.SOMNIA_EXPLORER_URL ?? "https://shannon-explorer.somnia.network/";
  return `${base.replace(/\/$/, "")}/tx/${hash}`;
}

function explorerAddr(a: string): string {
  const base = process.env.SOMNIA_EXPLORER_URL ?? "https://shannon-explorer.somnia.network/";
  return `${base.replace(/\/$/, "")}/address/${a}`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Median (for executionCost summary). */
function median(xs: bigint[]): bigint {
  if (xs.length === 0) return 0n;
  const sorted = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2n : sorted[mid];
}

type ReceiptRow = {
  validator: string;
  result: string;
  resultDecoded?: string;
  status: ResponseStatusName;
  executionCost: bigint;
  receipt: bigint;
};

async function pollFor(
  contract: any,
  eventName: string,
  requestId: bigint,
  desiredCount: number,
  timeoutMs: number,
): Promise<ReceiptRow[]> {
  const deadline = Date.now() + timeoutMs;
  const filter = contract.filters[eventName](requestId);
  let lastSeen = 0;
  while (Date.now() < deadline) {
    const events = await contract.queryFilter(filter, -10_000);
    if (events.length !== lastSeen) {
      console.log(`  · received ${events.length}/${desiredCount} ${eventName} event(s)`);
      lastSeen = events.length;
    }
    if (events.length >= desiredCount) {
      return events.map((e: any) => ({
        validator: e.args.validator,
        result: e.args.result, // bytes
        status: RS[Number(e.args.status)] ?? `Unknown(${e.args.status})`,
        executionCost: e.args.executionCost as bigint,
        receipt: e.args.receipt as bigint,
      }));
    }
    await sleep(5_000);
  }
  // Timeout — return whatever we have
  const events = await contract.queryFilter(filter, -10_000);
  return events.map((e: any) => ({
    validator: e.args.validator,
    result: e.args.result,
    status: RS[Number(e.args.status)] ?? `Unknown(${e.args.status})`,
    executionCost: e.args.executionCost as bigint,
    receipt: e.args.receipt as bigint,
  }));
}

function decodeMaybeString(bytesHex: string): string | undefined {
  try {
    // Try abi-decoded string first (the docs format for string return)
    const [decoded] = ethers.AbiCoder.defaultAbiCoder().decode(["string"], bytesHex);
    return String(decoded);
  } catch {
    // Fall back to raw UTF-8
    try {
      return ethers.toUtf8String(bytesHex);
    } catch {
      return undefined;
    }
  }
}

function summarize(rows: ReceiptRow[]): {
  consensus: string | null;
  medianCost: bigint;
  unique: Set<string>;
} {
  const decoded = rows.map((r) => {
    const d = decodeMaybeString(r.result);
    return d ?? r.result.slice(0, 64);
  });
  const unique = new Set(decoded);
  const consensus = unique.size === 1 ? [...unique][0] : null;
  const medianCost = median(rows.map((r) => r.executionCost));
  // Backfill decoded result on rows for the report
  rows.forEach((r, i) => (r.resultDecoded = decoded[i]));
  return { consensus, medianCost, unique };
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════");
  console.log(" SENTINEL · Phase-0 · Step-3 SPIKE");
  console.log("══════════════════════════════════════════════════════════════\n");

  // ---------- ENV VALIDATION ----------
  const mockUrl = ensureEnv("MOCK_ISSUER_URL");
  const llmAgentIdRaw = ensureEnv("AGENT_ID_LLM_INFERENCE");
  ensureEnv("DEPLOYER_PRIVATE_KEY");
  console.log(`Network:           ${network.name}`);
  console.log(`Mock issuer URL:   ${mockUrl}`);
  console.log(`LLM Agent ID:      ${llmAgentIdRaw} (Qwen3-30B per user)`);

  // Sanity: probe the mock URL once
  try {
    const probe = await fetch(mockUrl, { cache: "no-store" });
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
    const j = await probe.json();
    console.log(`Mock URL probe OK: ${JSON.stringify(j).slice(0, 120)}…\n`);
  } catch (e) {
    throw new Error(
      `Could not reach MOCK_ISSUER_URL (${mockUrl}). Deploy frontend/ to Vercel first.\n  ${e}`,
    );
  }

  const [signer] = await ethers.getSigners();
  const startBalance = await ethers.provider.getBalance(signer.address);
  console.log(`Signer:            ${signer.address}`);
  console.log(`Start balance:     ${ethers.formatEther(startBalance)} STT`);
  if (startBalance < ethers.parseEther("0.8")) {
    console.warn(`⚠ balance < 0.8 STT — proceeding but the spike may run short`);
  }
  console.log();

  // ---------- STAGE A: JSON API ----------
  console.log("─── Stage A · JSON API ───────────────────────────────────────");
  const SpikeJsonApi = await ethers.getContractFactory("SpikeJsonApi");
  const spikeJson = await SpikeJsonApi.deploy(PLATFORM_ADDRESS_TESTNET);
  await spikeJson.waitForDeployment();
  const jsonAddr = await spikeJson.getAddress();
  console.log(`Deployed:          ${jsonAddr}`);
  console.log(`Explorer:          ${explorerAddr(jsonAddr)}`);

  const platformAbi = [
    "function getRequestDeposit() view returns (uint256)",
  ];
  const platform = new ethers.Contract(PLATFORM_ADDRESS_TESTNET, platformAbi, signer);
  const floor: bigint = await platform.getRequestDeposit();
  console.log(`Floor deposit:     ${ethers.formatEther(floor)} STT`);

  // Send: floor + per-agent (0.04) × subSize (3) = ~0.12 + 0.12 = 0.24 STT, with cushion → 0.25
  const jsonValue = floor + ethers.parseEther("0.04") * BigInt(SUB_COMMITTEE_SIZE);
  const jsonValueWithCushion = jsonValue + ethers.parseEther("0.02");
  console.log(`Sending msg.value: ${ethers.formatEther(jsonValueWithCushion)} STT`);

  const fireTx = await spikeJson.fire(mockUrl, "$.price", { value: jsonValueWithCushion });
  const fireRec = await fireTx.wait();
  console.log(`fire() tx:         ${fireTx.hash}`);
  console.log(`                   ${explorerTx(fireTx.hash)}`);
  const jsonReqId: bigint = await spikeJson.lastRequestId();
  console.log(`requestId:         ${jsonReqId.toString()}`);
  console.log(`Polling for JsonApiReceipt events (up to 120s)…`);

  const jsonRows = await pollFor(spikeJson, "JsonApiReceipt", jsonReqId, SUB_COMMITTEE_SIZE, 120_000);
  console.log(`Received ${jsonRows.length} response(s).\n`);
  const jsonSummary = summarize(jsonRows);

  // ---------- STAGE B: LLM INFERENCE ----------
  let llmAddr = "";
  let llmTxHash = "";
  let llmReqId = 0n;
  let llmRows: ReceiptRow[] = [];
  let llmSummary: { consensus: string | null; medianCost: bigint; unique: Set<string> } | null = null;
  const jsonSuccessCount = jsonRows.filter((r) => r.status === "Success").length;

  if (jsonSuccessCount === 0) {
    console.log("─── Stage B skipped — JSON API returned no Success responses ───\n");
  } else {
    console.log("─── Stage B · LLM Inference ──────────────────────────────────");
    const SpikeLlmInference = await ethers.getContractFactory("SpikeLlmInference");
    const spikeLlm = await SpikeLlmInference.deploy(PLATFORM_ADDRESS_TESTNET);
    await spikeLlm.waitForDeployment();
    llmAddr = await spikeLlm.getAddress();
    console.log(`Deployed:          ${llmAddr}`);
    console.log(`Explorer:          ${explorerAddr(llmAddr)}`);

    // LLM Inference per-agent ≈ 0.07; send floor + 0.10*3 + cushion → enough headroom
    const llmValue = floor + ethers.parseEther("0.10") * BigInt(SUB_COMMITTEE_SIZE);
    const llmValueWithCushion = llmValue + ethers.parseEther("0.05");
    console.log(`Sending msg.value: ${ethers.formatEther(llmValueWithCushion)} STT`);

    const llmTx = await spikeLlm.fire(CLASSIFICATION_PROMPT, { value: llmValueWithCushion });
    await llmTx.wait();
    llmTxHash = llmTx.hash;
    console.log(`fire() tx:         ${llmTxHash}`);
    console.log(`                   ${explorerTx(llmTxHash)}`);
    llmReqId = await spikeLlm.lastRequestId();
    console.log(`requestId:         ${llmReqId.toString()}`);
    console.log(`Polling for InferenceReceipt events (up to 180s)…`);

    llmRows = await pollFor(spikeLlm, "InferenceReceipt", llmReqId, SUB_COMMITTEE_SIZE, 180_000);
    console.log(`Received ${llmRows.length} response(s).\n`);
    llmSummary = summarize(llmRows);
  }

  // ---------- SUMMARY ----------
  const endBalance = await ethers.provider.getBalance(signer.address);
  const spent = startBalance - endBalance;
  console.log("══════════════════════════════════════════════════════════════");
  console.log(" SUMMARY");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`JSON API consensus:     ${jsonSummary.consensus ?? "(none)"}`);
  console.log(`JSON API median cost:   ${ethers.formatEther(jsonSummary.medianCost)} STT/validator`);
  console.log(`JSON API distinct vals: ${jsonSummary.unique.size}`);
  if (llmSummary) {
    console.log(`LLM consensus:          ${llmSummary.consensus ?? "(none)"}`);
    console.log(`LLM median cost:        ${ethers.formatEther(llmSummary.medianCost)} STT/validator`);
    console.log(`LLM distinct vals:      ${llmSummary.unique.size}`);
  }
  console.log(`Total spent:            ${ethers.formatEther(spent)} STT`);
  console.log(`End balance:            ${ethers.formatEther(endBalance)} STT`);

  // ---------- DOCS ARTIFACT ----------
  const lines: string[] = [];
  const ts = new Date().toISOString();
  lines.push(`# Spike Results — ${ts}`);
  lines.push("");
  lines.push(`Step 3 of [[Phase 0]]. Two on-chain agent round-trips, one session.`);
  lines.push("");
  lines.push(`- Network: ${network.name}`);
  lines.push(`- Mock issuer URL: ${mockUrl}`);
  lines.push(`- Signer: \`${signer.address}\``);
  lines.push(`- Start balance: ${ethers.formatEther(startBalance)} STT`);
  lines.push(`- End balance:   ${ethers.formatEther(endBalance)} STT`);
  lines.push(`- Total spent:   **${ethers.formatEther(spent)} STT**`);
  lines.push("");
  lines.push(`## Stage A — JSON API`);
  lines.push(`- Contract: [\`${jsonAddr}\`](${explorerAddr(jsonAddr)})`);
  lines.push(`- \`fire()\` tx: [\`${fireTx.hash}\`](${explorerTx(fireTx.hash)})`);
  lines.push(`- requestId: \`${jsonReqId.toString()}\``);
  lines.push(`- Floor deposit returned by platform: ${ethers.formatEther(floor)} STT`);
  lines.push(`- Sent \`msg.value\`: ${ethers.formatEther(jsonValueWithCushion)} STT`);
  lines.push(`- Consensus: **${jsonSummary.consensus ?? "NONE"}**`);
  lines.push(`- Median executionCost: ${ethers.formatEther(jsonSummary.medianCost)} STT/validator`);
  lines.push(`- Validators that responded:`);
  for (const r of jsonRows) {
    lines.push(
      `  - \`${r.validator}\` · status=**${r.status}** · cost=${ethers.formatEther(r.executionCost)} STT · result=\`${r.resultDecoded ?? r.result.slice(0, 64)}\``,
    );
  }
  lines.push("");
  if (llmSummary) {
    lines.push(`## Stage B — LLM Inference (Qwen3-30B)`);
    lines.push(`- Contract: [\`${llmAddr}\`](${explorerAddr(llmAddr)})`);
    lines.push(`- \`fire()\` tx: [\`${llmTxHash}\`](${explorerTx(llmTxHash)})`);
    lines.push(`- requestId: \`${llmReqId.toString()}\``);
    lines.push(`- Consensus: **${llmSummary.consensus ?? "NONE"}**`);
    lines.push(`- Median executionCost: ${ethers.formatEther(llmSummary.medianCost)} STT/validator`);
    lines.push(`- Validators that responded:`);
    for (const r of llmRows) {
      lines.push(
        `  - \`${r.validator}\` · status=**${r.status}** · cost=${ethers.formatEther(r.executionCost)} STT · result=\`${r.resultDecoded ?? r.result.slice(0, 64)}\``,
      );
    }
    lines.push("");
    lines.push(`Prompt used:`);
    lines.push("```");
    lines.push(CLASSIFICATION_PROMPT);
    lines.push("```");
  } else {
    lines.push(`## Stage B — LLM Inference (skipped)`);
    lines.push(`JSON API stage returned 0 successful responses — LLM Inference was not fired.`);
  }
  lines.push("");
  lines.push(`## Verdict`);
  const aOk = jsonSummary.consensus !== null && jsonSummary.unique.size === 1 && jsonRows.length === SUB_COMMITTEE_SIZE;
  const bOk = llmSummary !== null && llmSummary.consensus !== null && llmSummary.unique.size === 1 && llmRows.length === SUB_COMMITTEE_SIZE;
  if (aOk && bOk) {
    lines.push(`✅ **Both agents reached consensus.** Pivot risk #1 (LLM determinism) is cleared empirically.`);
  } else if (aOk && !bOk && llmSummary) {
    lines.push(`⚠ **JSON API consensus OK, LLM consensus FAILED.** This is the principal pivot risk firing — see CLAUDE.md §20.`);
  } else if (!aOk) {
    lines.push(`❌ **JSON API did not reach 3-of-3 consensus.** Investigate before further on-chain spend.`);
  } else {
    lines.push(`⚠ Mixed result. Inspect the per-validator rows above.`);
  }

  const docsDir = path.join(__dirname, "..", "docs");
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
  const out = path.join(docsDir, "spike-results.md");
  fs.writeFileSync(out, lines.join("\n") + "\n");
  console.log(`\nResults written to ${path.relative(process.cwd(), out)}\n`);
}

main().catch((err) => {
  console.error("\n✖ Spike failed:");
  console.error(err);
  process.exitCode = 1;
});

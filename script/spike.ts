/**
 * Phase-0 / Step-3 spike runner.
 *
 * Two contracts, one session, two on-chain agent round-trips:
 *   1. SpikeJsonApi   — fetches MOCK_ISSUER_URL via the JSON API agent
 *   2. SpikeLlmInference — classifies a depeg disclosure via Qwen3-30B
 *
 * Polls CONTRACT VIEW STATE (not eth_getLogs) for results — Somnia's RPC caps
 * getLogs at a 1000-block range, so we read responsesFor()/callbackSeen() directly.
 *
 * Resumable: set SPIKE_JSON_ADDR + SPIKE_JSON_REQ (and/or SPIKE_LLM_ADDR +
 * SPIKE_LLM_REQ) to attach to an already-deployed+fired contract instead of
 * deploying and firing again. Lets us recover a request whose poll crashed.
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

const PLATFORM_ADDRESS_TESTNET = "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776";
const SUB_COMMITTEE_SIZE = 3;

/** The Classification enum (mirrors CLAUDE.md §5). Passed as `allowedValues` so the model is
 *  constrained to return exactly one — the key to subcommittee consensus. */
const CLASSIFICATION_VALUES = [
  "SMART_CONTRACT_EXPLOIT",
  "BANK_RUN",
  "REGULATORY",
  "TECHNICAL_GLITCH",
  "UNKNOWN",
];

/** The classification prompt — just the event; the allowed set is enforced by `allowedValues`. */
const CLASSIFICATION_PROMPT = [
  "Classify the root cause of this stablecoin depeg event.",
  "",
  "Event: USDx stablecoin vault drained via reentrancy exploit. 90% of reserves lost. Price moved from $1.00 to $0.94.",
].join("\n");

function ensureEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "" || v.includes("...")) {
    throw new Error(`Missing or placeholder env var: ${name}. Edit .env and re-run.`);
  }
  return v.trim();
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
  status: string;
  executionCost: bigint;
  receipt: bigint;
};

/** Map the on-chain Response[] (from responsesFor view) to ReceiptRow[]. */
function mapResponses(responses: readonly any[]): ReceiptRow[] {
  return responses.map((r: any) => ({
    validator: r.validator,
    result: r.result,
    status: RS[Number(r.status)] ?? `Unknown(${r.status})`,
    executionCost: r.executionCost as bigint,
    receipt: r.receipt as bigint,
  }));
}

/**
 * Poll the contract's view state for the callback result.
 * Reads responsesFor()/callbackSeen() — no eth_getLogs, so no block-range cap.
 */
async function pollFor(
  contract: any,
  requestId: bigint,
  desiredCount: number,
  timeoutMs: number,
): Promise<{ rows: ReceiptRow[]; finalized: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = -1;
  while (Date.now() < deadline) {
    const finalized: boolean = await contract.callbackSeen(requestId);
    const responses = await contract.responsesFor(requestId);
    if (responses.length !== lastSeen) {
      console.log(
        `  · stored ${responses.length}/${desiredCount} response(s)${finalized ? " · finalized" : ""}`,
      );
      lastSeen = responses.length;
    }
    if (finalized && responses.length >= 1) {
      return { rows: mapResponses(responses), finalized: true };
    }
    await sleep(5_000);
  }
  const responses = await contract.responsesFor(requestId);
  const finalized: boolean = await contract.callbackSeen(requestId);
  return { rows: mapResponses(responses), finalized };
}

function decodeMaybeString(bytesHex: string): string | undefined {
  if (!bytesHex || bytesHex === "0x") return "";
  try {
    const [decoded] = ethers.AbiCoder.defaultAbiCoder().decode(["string"], bytesHex);
    return String(decoded);
  } catch {
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
  console.log(`Start balance:     ${ethers.formatEther(startBalance)} STT\n`);

  const platformAbi = ["function getRequestDeposit() view returns (uint256)"];
  const platform = new ethers.Contract(PLATFORM_ADDRESS_TESTNET, platformAbi, signer);
  const floor: bigint = await platform.getRequestDeposit();

  // ---------- STAGE A: JSON API ----------
  console.log("─── Stage A · JSON API ───────────────────────────────────────");
  const SpikeJsonApi = await ethers.getContractFactory("SpikeJsonApi");
  let spikeJson: any;
  let jsonAddr: string;
  let jsonFireTxHash = "(reused — not fired this run)";
  let jsonReqId: bigint;

  const reuseJsonAddr = process.env.SPIKE_JSON_ADDR?.trim();
  const reuseJsonReq = process.env.SPIKE_JSON_REQ?.trim();
  if (reuseJsonAddr && reuseJsonReq) {
    spikeJson = SpikeJsonApi.attach(reuseJsonAddr);
    jsonAddr = reuseJsonAddr;
    jsonReqId = BigInt(reuseJsonReq);
    console.log(`Reusing:           ${jsonAddr}`);
    console.log(`requestId:         ${jsonReqId.toString()} (from env)`);
  } else {
    spikeJson = await SpikeJsonApi.deploy(PLATFORM_ADDRESS_TESTNET);
    await spikeJson.waitForDeployment();
    jsonAddr = await spikeJson.getAddress();
    console.log(`Deployed:          ${jsonAddr}`);
    console.log(`Explorer:          ${explorerAddr(jsonAddr)}`);
    console.log(`Floor deposit:     ${ethers.formatEther(floor)} STT`);

    const jsonValue = floor + ethers.parseEther("0.04") * BigInt(SUB_COMMITTEE_SIZE) + ethers.parseEther("0.02");
    console.log(`Sending msg.value: ${ethers.formatEther(jsonValue)} STT`);
    const fireTx = await spikeJson.fire(mockUrl, "price", { value: jsonValue });
    await fireTx.wait();
    jsonFireTxHash = fireTx.hash;
    console.log(`fire() tx:         ${jsonFireTxHash}`);
    console.log(`                   ${explorerTx(jsonFireTxHash)}`);
    jsonReqId = await spikeJson.lastRequestId();
    console.log(`requestId:         ${jsonReqId.toString()}`);
  }

  console.log(`Polling contract state for JSON API result (up to 180s)…`);
  const { rows: jsonRows, finalized: jsonFinalized } = await pollFor(spikeJson, jsonReqId, SUB_COMMITTEE_SIZE, 180_000);
  console.log(`Finalized: ${jsonFinalized} · ${jsonRows.length} response(s).\n`);
  const jsonSummary = summarize(jsonRows);
  const jsonSuccessCount = jsonRows.filter((r) => r.status === "Success").length;

  // ---------- STAGE B: LLM INFERENCE ----------
  let llmAddr = "";
  let llmFireTxHash = "(reused — not fired this run)";
  let llmReqId = 0n;
  let llmRows: ReceiptRow[] = [];
  let llmSummary: { consensus: string | null; medianCost: bigint; unique: Set<string> } | null = null;
  let llmFinalized = false;

  const reuseLlmAddr = process.env.SPIKE_LLM_ADDR?.trim();
  const reuseLlmReq = process.env.SPIKE_LLM_REQ?.trim();

  if (jsonSuccessCount === 0 && !(reuseLlmAddr && reuseLlmReq)) {
    console.log("─── Stage B skipped — JSON API returned no Success responses ───\n");
  } else {
    console.log("─── Stage B · LLM Inference ──────────────────────────────────");
    const SpikeLlmInference = await ethers.getContractFactory("SpikeLlmInference");
    let spikeLlm: any;

    if (reuseLlmAddr && reuseLlmReq) {
      spikeLlm = SpikeLlmInference.attach(reuseLlmAddr);
      llmAddr = reuseLlmAddr;
      llmReqId = BigInt(reuseLlmReq);
      console.log(`Reusing:           ${llmAddr}`);
      console.log(`requestId:         ${llmReqId.toString()} (from env)`);
    } else {
      spikeLlm = await SpikeLlmInference.deploy(PLATFORM_ADDRESS_TESTNET);
      await spikeLlm.waitForDeployment();
      llmAddr = await spikeLlm.getAddress();
      console.log(`Deployed:          ${llmAddr}`);
      console.log(`Explorer:          ${explorerAddr(llmAddr)}`);

      const llmValue = floor + ethers.parseEther("0.10") * BigInt(SUB_COMMITTEE_SIZE) + ethers.parseEther("0.05");
      console.log(`Sending msg.value: ${ethers.formatEther(llmValue)} STT`);
      const llmTx = await spikeLlm.fire(CLASSIFICATION_PROMPT, CLASSIFICATION_VALUES, { value: llmValue });
      await llmTx.wait();
      llmFireTxHash = llmTx.hash;
      console.log(`fire() tx:         ${llmFireTxHash}`);
      console.log(`                   ${explorerTx(llmFireTxHash)}`);
      llmReqId = await spikeLlm.lastRequestId();
      console.log(`requestId:         ${llmReqId.toString()}`);
    }

    console.log(`Polling contract state for LLM result (up to 240s)…`);
    const res = await pollFor(spikeLlm, llmReqId, SUB_COMMITTEE_SIZE, 240_000);
    llmRows = res.rows;
    llmFinalized = res.finalized;
    console.log(`Finalized: ${llmFinalized} · ${llmRows.length} response(s).\n`);
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
  lines.push(`Step 3 of Phase 0. Two on-chain agent round-trips on Somnia testnet.`);
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
  lines.push(`- \`fire()\` tx: ${jsonFireTxHash.startsWith("0x") ? `[\`${jsonFireTxHash}\`](${explorerTx(jsonFireTxHash)})` : jsonFireTxHash}`);
  lines.push(`- requestId: \`${jsonReqId.toString()}\``);
  lines.push(`- Floor deposit: ${ethers.formatEther(floor)} STT`);
  lines.push(`- Finalized: ${jsonFinalized}`);
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
    lines.push(`- \`fire()\` tx: ${llmFireTxHash.startsWith("0x") ? `[\`${llmFireTxHash}\`](${explorerTx(llmFireTxHash)})` : llmFireTxHash}`);
    lines.push(`- requestId: \`${llmReqId.toString()}\``);
    lines.push(`- Finalized: ${llmFinalized}`);
    lines.push(`- Consensus: **${llmSummary.consensus ?? "NONE"}**`);
    lines.push(`- Median executionCost: ${ethers.formatEther(llmSummary.medianCost)} STT/validator`);
    lines.push(`- Validators that responded:`);
    for (const r of llmRows) {
      lines.push(
        `  - \`${r.validator}\` · status=**${r.status}** · cost=${ethers.formatEther(r.executionCost)} STT · result=\`${r.resultDecoded ?? r.result.slice(0, 64)}\``,
      );
    }
    lines.push("");
    lines.push(`Prompt used (allowedValues: ${CLASSIFICATION_VALUES.join(", ")}):`);
    lines.push("```");
    lines.push(CLASSIFICATION_PROMPT);
    lines.push("```");
  } else {
    lines.push(`## Stage B — LLM Inference (skipped)`);
    lines.push(`JSON API stage returned 0 successful responses — LLM Inference was not fired.`);
  }
  lines.push("");
  lines.push(`## Verdict`);
  // Success = finalized, every responding validator agreed (1 distinct value), and that
  // value came back with Success status. The subcommittee finalizes on majority, so a 2/2
  // identical-Success result is a pass — we do NOT hard-require all 3 to report.
  const aAllSuccess = jsonRows.length > 0 && jsonRows.every((r) => r.status === "Success");
  const bAllSuccess = llmRows.length > 0 && llmRows.every((r) => r.status === "Success");
  const aOk = jsonFinalized && jsonSummary.consensus !== null && jsonSummary.unique.size === 1 && aAllSuccess;
  const bOk =
    llmSummary !== null && llmFinalized && llmSummary.consensus !== null && llmSummary.unique.size === 1 && bAllSuccess;
  if (aOk && bOk) {
    lines.push(`✅ **Both agents reached consensus.** Pivot risk #1 (LLM determinism) cleared empirically.`);
  } else if (aOk && llmSummary && !bOk) {
    lines.push(
      `⚠ **JSON API consensus OK; LLM stage not yet passing.** Validators agreed (determinism holds) but status was not Success — likely the LLM method signature / payload. Inspect rows above.`,
    );
  } else if (aOk && !llmSummary) {
    lines.push(`✅ **JSON API reached consensus.** LLM stage not run this session.`);
  } else if (!aOk) {
    lines.push(`❌ **JSON API did not reach a Success consensus.** Investigate before further on-chain spend.`);
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

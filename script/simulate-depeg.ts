/**
 * M6 — Demo trigger. Pushes USDC below its peg and watches the autonomous pipeline run
 * to SETTLED, then settles the demo policy and prints the timeline.
 *
 * Flow:
 *   1. setPrice(USDC, depegPrice) on MockPriceOracle  -> emits PriceUpdated.
 *   2. Somnia Reactivity invokes SentinelOracle._onEvent (no keeper) -> event opens (Confirming).
 *   3. Agent #1 JSON-API confirms the basket -> Investigating.
 *   4. Agent #2 Parse Website reads the issuer page -> Classifying.
 *   5. Agent #3 LLM Inference classifies -> Classified + treasury.recordVerdict.
 *   6. We call treasury.settle(eventId, tokenId): exploit pays 100% immediately.
 *
 * Polls CONTRACT VIEW STATE (oracle.getEvent / liveEventOf), not eth_getLogs (Somnia caps
 * getLogs at 1000 blocks). Reads addresses from deployments/<network>.json (deploy.ts output).
 *
 *   pnpm simulate:depeg   # = hardhat run script/simulate-depeg.ts --network somniaTestnet
 *
 * Optional env: DEPEG_PRICE (default 0.92), POLL_TIMEOUT_SECONDS (default 600).
 */

import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

// Mirrors SentinelOracle.EventState.
const STATE = ["None", "Confirming", "Investigating", "Classifying", "Classified", "Dismissed", "Failed"] as const;
// Mirrors Classification.Cause.
const CAUSE = ["UNKNOWN", "SMART_CONTRACT_EXPLOIT", "BANK_RUN", "REGULATORY", "TECHNICAL_GLITCH"] as const;

function explorerTx(h: string): string {
  const base = process.env.SOMNIA_EXPLORER_URL ?? "https://shannon-explorer.somnia.network/";
  return `${base.replace(/\/$/, "")}/tx/${h}`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function loadDeployment(): any {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`No deployment artifact at ${file}. Run \`pnpm deploy:testnet\` first.`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Read SentinelOracle.getEvent(eventId).
 * NOTE: ethers v6 BaseContract has its own `getEvent(name)` (event accessor), which shadows our
 * Solidity view of the same name — calling `oracle.getEvent(id)` directly would hit the ethers
 * helper, not the chain. Route through getFunction(...) to invoke the actual contract method.
 */
async function getEvent(oracle: any, eventId: bigint): Promise<any> {
  return oracle.getFunction("getEvent").staticCall(eventId);
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════");
  console.log(" SENTINEL · M6 · SIMULATE DEPEG");
  console.log("══════════════════════════════════════════════════════════════\n");

  const dep = loadDeployment();
  const c = dep.contracts;
  const tokenId = BigInt(dep.demoTokenId);
  const depegPrice = ethers.parseEther(process.env.DEPEG_PRICE?.trim() || "0.92");
  const timeoutMs = Number(process.env.POLL_TIMEOUT_SECONDS?.trim() || "600") * 1000;

  const [signer] = await ethers.getSigners();
  console.log(`Network:        ${network.name}`);
  console.log(`Operator:       ${signer.address}`);
  console.log(`Insured (USDC): ${c.insured}`);
  console.log(`Oracle:         ${c.oracle}`);
  console.log(`Demo policy:    #${tokenId.toString()}\n`);

  const priceOracle = await ethers.getContractAt("MockPriceOracle", c.priceOracle);
  // Once the poller is deployed it OWNS MockPriceOracle, so operator price writes route through it.
  const poller = c.poller ? await ethers.getContractAt("PriceFeedPoller", c.poller) : null;
  const setAssetPrice = (asset: string, price: bigint) =>
    poller ? poller.operatorSetPrice(asset, price) : priceOracle.setPrice(asset, price);
  const oracle = await ethers.getContractAt("SentinelOracle", c.oracle);
  const treasury = await ethers.getContractAt("SentinelTreasury", c.treasury);
  const policy = await ethers.getContractAt("SentinelPolicy", c.policy);
  const capital = await ethers.getContractAt("MockStable", c.capital);

  // ───────────────────────── trigger ─────────────────────────
  console.log("─── Trigger: push USDC below peg ─────────────────────────────");
  const t0 = Date.now();
  const setTx = await setAssetPrice(c.insured, depegPrice);
  await setTx.wait();
  console.log(`setPrice(USDC, ${ethers.formatEther(depegPrice)}) tx: ${explorerTx(setTx.hash)}`);
  console.log("Reactivity will invoke SentinelOracle._onEvent (no keeper). Watching…\n");

  // ───────────────────────── wait for detection ─────────────────────────
  const deadline = Date.now() + timeoutMs;
  let eventId = 0n;
  while (Date.now() < deadline) {
    eventId = await oracle.liveEventOf(c.insured);
    if (eventId !== 0n) break;
    // After a terminal state the live slot frees; also check nextEventId as a fallback.
    const next = await oracle.nextEventId();
    if (next > 1n) {
      eventId = next - 1n;
      const ev = await getEvent(oracle, eventId);
      if (Number(ev.state) !== 0) break;
    }
    await sleep(4_000);
  }
  if (eventId === 0n) throw new Error("Detection never fired — check Oracle funding + subscription (arm).");
  console.log(`Detected — eventId ${eventId.toString()} opened.\n`);

  // ───────────────────────── follow the state machine ─────────────────────────
  console.log("─── Pipeline ─────────────────────────────────────────────────");
  let lastState = -1;
  let finalState = 0;
  while (Date.now() < deadline) {
    const ev = await getEvent(oracle, eventId);
    const s = Number(ev.state);
    if (s !== lastState) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  [${elapsed.padStart(6)}s] ${STATE[s] ?? s}` + (s === 2 ? "  (basket corroborated)" : ""));
      if (s === 2 && ev.confirmedPrice > 0n) {
        console.log(`           basket price ${ethers.formatEther(ev.confirmedPrice)} · deviation ${ev.deviationBps}bps`);
      }
      if (s === 3 && ev.disclosure) {
        console.log(`           disclosure: "${ev.disclosure.slice(0, 100)}${ev.disclosure.length > 100 ? "…" : ""}"`);
      }
      lastState = s;
    }
    // Terminal states: Classified(4), Dismissed(5), Failed(6).
    if (s >= 4) {
      finalState = s;
      break;
    }
    await sleep(4_000);
  }

  if (finalState === 0) throw new Error("Pipeline did not reach a terminal state within the timeout.");
  if (finalState === 5) {
    console.log("\n⚠ Event DISMISSED — basket did not corroborate the depeg. No payout.");
    return;
  }
  if (finalState === 6) {
    console.log("\n⚠ Event FAILED — a stage agent failed/timed out. Operator can call oracle.retry(eventId).");
    return;
  }

  // ───────────────────────── classified — show verdict ─────────────────────────
  const ev = await getEvent(oracle, eventId);
  const cause = Number(ev.cause);
  console.log(`\n─── Classified ───────────────────────────────────────────────`);
  console.log(`  cause:      ${CAUSE[cause] ?? cause}`);
  console.log(`  deviation:  ${ev.deviationBps}bps`);
  const verdict = await treasury.verdicts(eventId);
  console.log(`  verdict recorded with Treasury: exists=${verdict.exists}\n`);

  // ───────────────────────── settle the policy ─────────────────────────
  console.log("─── Settle policy ────────────────────────────────────────────");
  const quoted: bigint = await treasury.quotePayout(eventId, tokenId);
  console.log(`  quoted payout for policy #${tokenId.toString()}: ${ethers.formatEther(quoted)} sUSD`);
  const holder = await policy.ownerOf(tokenId);
  const balBefore = await capital.balanceOf(holder);
  const settleTx = await treasury.settle(eventId, tokenId);
  await settleTx.wait();
  console.log(`  settle() tx: ${explorerTx(settleTx.hash)}`);

  const pol = await policy.getPolicy(tokenId);
  const status = Number(pol.status); // 3 = Claimed (immediate), 2 = Claimable (vested scheduled)
  if (status === 3) {
    const paid = (await capital.balanceOf(holder)) - balBefore;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  IMMEDIATE payout: ${ethers.formatEther(paid)} sUSD -> ${holder}`);
    console.log(`\n✅ SETTLED in ${elapsed}s (detect -> classify -> pay).`);
  } else {
    const vest = await treasury.vestings(eventId, tokenId);
    const when = new Date(Number(vest.releaseAt) * 1000).toISOString();
    console.log(`  VESTED payout scheduled: ${ethers.formatEther(vest.amount)} sUSD, releasable at ${when}`);
    console.log(`  Run treasury.claimVested(${eventId}, ${tokenId}) after that time.`);
    console.log(`\n✅ CLASSIFIED + vesting scheduled (non-exploit class vests to deter farming).`);
  }

  // ───────────────────────── artifact ─────────────────────────
  const outFile = path.join(__dirname, "..", "docs", "demo-run.md");
  const lines = [
    `# Demo Run — ${new Date().toISOString()}`,
    "",
    `- Network: ${network.name}`,
    `- eventId: ${eventId.toString()}`,
    `- Trigger price: ${ethers.formatEther(depegPrice)} (peg $1.0000)`,
    `- Classification: **${CAUSE[cause] ?? cause}**`,
    `- Deviation: ${ev.deviationBps}bps`,
    `- Policy #${tokenId.toString()} status: ${status === 3 ? "Claimed (immediate)" : "Claimable (vested)"}`,
    `- Quoted payout: ${ethers.formatEther(quoted)} sUSD`,
    `- setPrice tx: ${explorerTx(setTx.hash)}`,
    `- settle tx: ${explorerTx(settleTx.hash)}`,
    "",
  ];
  fs.writeFileSync(outFile, lines.join("\n"));
  console.log(`\nRun summary written to ${path.relative(process.cwd(), outFile)}\n`);
}

main().catch((err) => {
  console.error("\n✖ Simulate failed:");
  console.error(err);
  process.exitCode = 1;
});

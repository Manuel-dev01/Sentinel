/**
 * Phase-0 / Step-4 / M0 — Reactivity micro-spike runner.
 *
 * Proves the Somnia Reactivity round-trip end-to-end on testnet:
 *   deploy MockPriceOracle + SpikeReactivity
 *   → fund the handler with ≥32 STT (subscription-owner minimum)
 *   → arm() (subscribe to PriceUpdated)
 *   → push a price via MockPriceOracle.setPrice
 *   → poll the handler's view state until _onEvent fires (no off-chain keeper)
 *
 * Appends a result block to docs/spike-results.md.
 *
 *   pnpm spike:reactivity   # = hardhat run script/spike-reactivity.ts --network somniaTestnet
 */

import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

const MIN_OWNER_BALANCE = ethers.parseEther("32"); // SomniaExtensions.SUBSCRIPTION_OWNER_MINIMUM_BALANCE
const FUND_AMOUNT = ethers.parseEther("33"); // a little over the minimum
const DEMO_ASSET = "0x000000000000000000000000000000000000dEaD";
const DEPEG_PRICE = ethers.parseEther("0.94"); // $0.94, a 6% depeg
const POLL_TIMEOUT_MS = 180_000;

function explorerTx(hash: string): string {
  const base = process.env.SOMNIA_EXPLORER_URL ?? "https://shannon-explorer.somnia.network/";
  return `${base.replace(/\/$/, "")}/tx/${hash}`;
}
function explorerAddr(a: string): string {
  const base = process.env.SOMNIA_EXPLORER_URL ?? "https://shannon-explorer.somnia.network/";
  return `${base.replace(/\/$/, "")}/address/${a}`;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("══════════════════════════════════════════════════════════════");
  console.log(" SENTINEL · M0 · REACTIVITY MICRO-SPIKE");
  console.log("══════════════════════════════════════════════════════════════\n");

  const [signer] = await ethers.getSigners();
  const startBalance = await ethers.provider.getBalance(signer.address);
  console.log(`Network:        ${network.name}`);
  console.log(`Signer:         ${signer.address}`);
  console.log(`Start balance:  ${ethers.formatEther(startBalance)} STT`);
  if (startBalance < FUND_AMOUNT + ethers.parseEther("1")) {
    throw new Error(`Need > ${ethers.formatEther(FUND_AMOUNT)} STT to fund the subscription owner. Top up.`);
  }
  console.log();

  // 1. Deploy MockPriceOracle (owned by signer)
  const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
  const oracle = await MockPriceOracle.deploy(signer.address);
  await oracle.waitForDeployment();
  const oracleAddr = await oracle.getAddress();
  console.log(`MockPriceOracle: ${oracleAddr}`);

  // 2. Deploy SpikeReactivity
  const SpikeReactivity = await ethers.getContractFactory("SpikeReactivity");
  const spike = await SpikeReactivity.deploy();
  await spike.waitForDeployment();
  const spikeAddr = await spike.getAddress();
  console.log(`SpikeReactivity: ${spikeAddr}`);
  console.log(`                 ${explorerAddr(spikeAddr)}`);

  // 3. Fund the handler so it meets the subscription-owner minimum (32 STT)
  console.log(`\nFunding handler with ${ethers.formatEther(FUND_AMOUNT)} STT…`);
  const fundTx = await signer.sendTransaction({ to: spikeAddr, value: FUND_AMOUNT });
  await fundTx.wait();
  const handlerBalance = await ethers.provider.getBalance(spikeAddr);
  console.log(`Handler balance: ${ethers.formatEther(handlerBalance)} STT (min ${ethers.formatEther(MIN_OWNER_BALANCE)})`);

  // 4. Arm the subscription
  console.log(`\nArming subscription on PriceUpdated…`);
  const armTx = await spike.arm(oracleAddr);
  await armTx.wait();
  console.log(`arm() tx:        ${armTx.hash}`);
  console.log(`                 ${explorerTx(armTx.hash)}`);
  const subId: bigint = await spike.subscriptionId();
  console.log(`subscriptionId:  ${subId.toString()}`);

  const beforeCount: bigint = await spike.eventCount();

  // 5. Push a price (this is what the subscription is watching)
  console.log(`\nPushing depeg price ${ethers.formatEther(DEPEG_PRICE)} for asset ${DEMO_ASSET}…`);
  const setTx = await oracle.setPrice(DEMO_ASSET, DEPEG_PRICE);
  await setTx.wait();
  console.log(`setPrice() tx:   ${setTx.hash}`);
  console.log(`                 ${explorerTx(setTx.hash)}`);

  // 6. Poll the handler view state for the callback (no eth_getLogs — view reads only)
  console.log(`\nPolling for _onEvent (up to ${POLL_TIMEOUT_MS / 1000}s)…`);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let fired = false;
  let count = beforeCount;
  while (Date.now() < deadline) {
    count = await spike.eventCount();
    if (count > beforeCount) {
      fired = true;
      break;
    }
    await sleep(5_000);
  }

  const lastAsset: string = await spike.lastAsset();
  const lastPrice: bigint = await spike.lastPrice();
  const lastTs: bigint = await spike.lastTimestamp();
  const endBalance = await ethers.provider.getBalance(signer.address);

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log(" RESULT");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`_onEvent fired:  ${fired}`);
  console.log(`eventCount:      ${count.toString()}`);
  console.log(`lastAsset:       ${lastAsset}`);
  console.log(`lastPrice:       ${ethers.formatEther(lastPrice)}`);
  console.log(`lastTimestamp:   ${lastTs.toString()}`);
  const assetOk = lastAsset.toLowerCase() === DEMO_ASSET.toLowerCase();
  const priceOk = lastPrice === DEPEG_PRICE;
  console.log(`asset matches:   ${assetOk}`);
  console.log(`price matches:   ${priceOk}`);
  console.log(`Signer spent:    ${ethers.formatEther(startBalance - endBalance)} STT (incl. 33 locked in handler)`);

  // 7. Append to docs/spike-results.md
  const pass = fired && assetOk && priceOk;
  const ts = new Date().toISOString();
  const lines = [
    ``,
    `---`,
    ``,
    `# M0 Reactivity Micro-Spike — ${ts}`,
    ``,
    `Proves the Somnia Reactivity round-trip: a price-feed event invokes the handler on-chain, no keeper.`,
    ``,
    `- Network: ${network.name}`,
    `- MockPriceOracle: [\`${oracleAddr}\`](${explorerAddr(oracleAddr)})`,
    `- SpikeReactivity (handler): [\`${spikeAddr}\`](${explorerAddr(spikeAddr)})`,
    `- subscriptionId: \`${subId.toString()}\``,
    `- arm() tx: [\`${armTx.hash}\`](${explorerTx(armTx.hash)})`,
    `- setPrice() tx: [\`${setTx.hash}\`](${explorerTx(setTx.hash)})`,
    `- Handler funded: ${ethers.formatEther(FUND_AMOUNT)} STT (min ${ethers.formatEther(MIN_OWNER_BALANCE)})`,
    ``,
    `## Result`,
    `- \`_onEvent\` fired: **${fired}**`,
    `- eventCount: ${count.toString()}`,
    `- decoded asset: \`${lastAsset}\` (match: ${assetOk})`,
    `- decoded price: ${ethers.formatEther(lastPrice)} (match: ${priceOk})`,
    ``,
    pass
      ? `✅ **Reactivity round-trip works.** Pushing a price triggered \`_onEvent\` with the correct decoded payload, with no off-chain keeper. The last Phase-0 platform unknown is cleared; SentinelOracle can rely on Reactivity for detection.`
      : `❌ **Reactivity round-trip did NOT complete cleanly.** \`_onEvent\` did not fire (or payload mismatch) within ${POLL_TIMEOUT_MS / 1000}s. Consider the CLAUDE.md §20 fallback: a thin TS watcher calling the contract. Inspect subscription state before proceeding.`,
    ``,
  ];
  const out = path.join(__dirname, "..", "docs", "spike-results.md");
  fs.appendFileSync(out, lines.join("\n"));
  console.log(`\nAppended to docs/spike-results.md`);

  if (!pass) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\n✖ Reactivity spike failed:");
  console.error(err);
  process.exitCode = 1;
});

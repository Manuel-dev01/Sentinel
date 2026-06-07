/**
 * Poller health check. Reports balance, armed status, poll count, and last observed prices.
 * Optionally tops up and re-arms if needed.
 *
 *   pnpm hardhat run script/health-check.ts --network somniaTestnet
 *
 * Optional env:
 *   TOPUP_THRESHOLD_STT  — if poller balance is below this, top up (default 40)
 *   TOPUP_AMOUNT_STT     — how much to send (default 10)
 *   AUTO_FIX             — set to "true" to auto-topup and re-arm (default: report only)
 */

import { ethers, network } from "hardhat";

const POLLER = "0xA12a1285076512B922Fd2B478E0278764a1066B5";
const SUBSCRIPTION_MIN = ethers.parseEther("32");

async function main() {
  const poller = await ethers.getContractAt("PriceFeedPoller", POLLER);
  const [signer] = await ethers.getSigners();

  const bal = await ethers.provider.getBalance(POLLER);
  const deployerBal = await ethers.provider.getBalance(signer.address);
  const armed: boolean = await poller.armed();
  const pollCount: bigint = await poller.pollCount();
  const subId: bigint = await poller.cronSubscriptionId();
  const feedCount: bigint = await poller.feedCount();
  const interval: bigint = await poller.pollIntervalSeconds();

  const topupThreshold = ethers.parseEther(process.env.TOPUP_THRESHOLD_STT?.trim() || "40");
  const topupAmount = ethers.parseEther(process.env.TOPUP_AMOUNT_STT?.trim() || "10");
  const autoFix = process.env.AUTO_FIX?.trim() === "true";

  console.log("═══ PriceFeedPoller Health Check ═══\n");
  console.log(`Poller:     ${POLLER}`);
  console.log(`Balance:    ${ethers.formatEther(bal)} STT`);
  console.log(`Armed:      ${armed}`);
  console.log(`Subscription: ${subId.toString()}`);
  console.log(`Feeds:      ${feedCount.toString()} assets, every ${interval.toString()}s`);
  console.log(`Poll count: ${pollCount.toString()}`);
  console.log(`Deployer:   ${ethers.formatEther(deployerBal)} STT\n`);

  // Read last observed prices
  const feedList = await poller.feeds();
  for (const f of feedList) {
    const price = await poller.lastObservedPrice(f.asset);
    const at = await poller.lastObservedAt(f.asset);
    const symbol = f.asset; // just show address
    if (price > 0n) {
      const date = new Date(Number(at) * 1000);
      console.log(`  ${symbol} → $${ethers.formatEther(price)} at ${date.toISOString()}`);
    }
  }

  // Health assessment
  let needsAction = false;
  const issues: string[] = [];

  if (bal < SUBSCRIPTION_MIN) {
    issues.push(`CRITICAL: balance ${ethers.formatEther(bal)} STT is below 32 STT subscription minimum`);
    needsAction = true;
  } else if (bal < topupThreshold) {
    issues.push(`WARNING: balance ${ethers.formatEther(bal)} STT is below ${ethers.formatEther(topupThreshold)} STT threshold`);
    needsAction = true;
  }

  if (!armed) {
    issues.push("CRITICAL: poller is NOT armed — cron is not running");
    needsAction = true;
  }

  if (pollCount === 0n) {
    issues.push("WARNING: poll count is 0 — no polls have completed yet");
  }

  if (issues.length > 0) {
    console.log("\n── Issues ──");
    for (const i of issues) console.log(`  ⚠ ${i}`);
  } else {
    console.log("\n── Status: HEALTHY ──");
  }

  // Auto-fix if enabled
  if (needsAction && autoFix) {
    console.log("\n── Auto-fix ──");

    if (bal < topupThreshold && deployerBal >= topupAmount + ethers.parseEther("1")) {
      console.log(`  Topping up ${ethers.formatEther(topupAmount)} STT...`);
      const tx = await signer.sendTransaction({ to: POLLER, value: topupAmount });
      await tx.wait();
      const newBal = await ethers.provider.getBalance(POLLER);
      console.log(`  ✓ new balance: ${ethers.formatEther(newBal)} STT`);
    } else if (bal < topupThreshold) {
      console.log(`  ✗ deployer has ${ethers.formatEther(deployerBal)} STT — not enough to top up`);
    }

    const newBal = await ethers.provider.getBalance(POLLER);
    if (!armed && newBal >= SUBSCRIPTION_MIN) {
      console.log("  Re-arming...");
      const tx = await poller.arm();
      await tx.wait();
      console.log(`  ✓ armed · subscription ${(await poller.cronSubscriptionId()).toString()}`);
    }
  } else if (needsAction && !autoFix) {
    console.log("\n  Set AUTO_FIX=true to auto-topup and re-arm.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

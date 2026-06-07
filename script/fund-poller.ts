/**
 * Top up the PriceFeedPoller with STT so it can maintain its Reactivity subscription (≥32 STT)
 * and fund agent request deposits.
 *
 * The poller needs ≥32 STT just to hold the subscription; agent requests cost ~0.03–0.10 STT
 * per validator per tick, and the poller dispatches 4 feeds per tick.
 *
 *   pnpm hardhat run script/fund-poller.ts --network somniaTestnet
 */

import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

const POLLER = "0xA12a1285076512B922Fd2B478E0278764a1066B5";
const TOPUP = ethers.parseEther(process.env.POLLER_TOPUP_STT?.trim() || "10"); // default +10 STT

async function main() {
  const [signer] = await ethers.getSigners();
  const deployerBal = await ethers.provider.getBalance(signer.address);
  const pollerBal = await ethers.provider.getBalance(POLLER);

  console.log("═══ PriceFeedPoller STT Top-Up ═══\n");
  console.log(`Deployer: ${signer.address}  (${ethers.formatEther(deployerBal)} STT)`);
  console.log(`Poller:   ${POLLER}`);
  console.log(`  current balance: ${ethers.formatEther(pollerBal)} STT`);
  console.log(`  top-up amount:   ${ethers.formatEther(TOPUP)} STT`);

  if (deployerBal < TOPUP + ethers.parseEther("1")) {
    throw new Error(`Deployer has ${ethers.formatEther(deployerBal)} STT — not enough for ${ethers.formatEther(TOPUP)} top-up + gas.`);
  }

  const tx = await signer.sendTransaction({ to: POLLER, value: TOPUP });
  await tx.wait();

  const newBal = await ethers.provider.getBalance(POLLER);
  console.log(`\n  ✓ sent ${ethers.formatEther(TOPUP)} STT`);
  console.log(`  new balance: ${ethers.formatEther(newBal)} STT`);

  // Check if the poller is still armed
  const poller = await ethers.getContractAt("PriceFeedPoller", POLLER);
  const armed = await poller.armed();
  const subId = await poller.cronSubscriptionId();
  console.log(`\n  armed: ${armed}`);
  console.log(`  cron subscription: ${subId.toString()}`);

  if (!armed) {
    console.log("\n  ⚠ Poller is NOT armed — the cron has been disarmed.");
    console.log("  Run `await poller.arm()` to re-arm it.");
  }

  if (newBal < ethers.parseEther("32")) {
    console.log(`\n  ⚠ Balance still below 32 STT subscription minimum. Consider a larger top-up.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

/**
 * Re-arm the PriceFeedPoller's Reactivity cron after it was disarmed (likely due to low balance).
 *
 *   pnpm hardhat run script/rearm-poller.ts --network somniaTestnet
 */

import { ethers } from "hardhat";

const POLLER = "0xA12a1285076512B922Fd2B478E0278764a1066B5";

async function main() {
  const poller = await ethers.getContractAt("PriceFeedPoller", POLLER);
  const [signer] = await ethers.getSigners();

  console.log("═══ Re-arm PriceFeedPoller ═══\n");
  console.log(`Operator: ${signer.address}`);
  console.log(`Poller:   ${POLLER}`);

  const armed = await poller.armed();
  const bal = await ethers.provider.getBalance(POLLER);
  console.log(`Balance:  ${ethers.formatEther(bal)} STT`);
  console.log(`Armed:    ${armed}`);

  if (armed) {
    console.log("\nAlready armed — nothing to do.");
    return;
  }

  if (bal < ethers.parseEther("32")) {
    throw new Error(`Balance ${ethers.formatEther(bal)} STT is below 32 STT minimum. Fund the poller first.`);
  }

  const tx = await poller.arm();
  await tx.wait();
  const subId = await poller.cronSubscriptionId();
  console.log(`\n  ✓ armed · cron subscription ${subId.toString()}`);
  console.log("  Live price polling will resume on the next tick.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

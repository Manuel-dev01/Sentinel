/**
 * Keep the autonomous monitor alive (operator op, no redeploy):
 *   Refuel the multi-asset PriceFeedPoller above the 32-STT subscription-owner floor, set the poll
 *   interval, and re-arm the cron. The poller self-disarms once its spendable balance above 32 STT
 *   runs out, so re-run this before a demo or whenever `armed` reads false.
 *
 *   pnpm hardhat run script/tune-monitor.ts --network somniaTestnet
 *
 * Optional env: POLLER_TOPUP_STT (default 40), POLL_INTERVAL (default 600).
 *
 * The investigation sources for each live asset are set at deploy time (deploy-poller-v2.ts) and
 * USDC-live is repointed to real Circle sources there, so this script no longer touches registry
 * config; it is purely the refuel-and-arm keepalive.
 */

import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

const TOPUP = ethers.parseEther(process.env.POLLER_TOPUP_STT?.trim() || "40");
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL?.trim() || "600");
const FLOOR = ethers.parseEther("32"); // SUBSCRIPTION_OWNER_MINIMUM_BALANCE

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  const mon = dep.monitor;
  if (!mon?.poller) throw new Error("No `monitor.poller` in the deployment artifact — run deploy-poller-v2.ts first.");

  const [signer] = await ethers.getSigners();
  const poller = await ethers.getContractAt("PriceFeedPoller", mon.poller);

  console.log("─── Refuel + re-arm the multi-asset poller ───");
  const balBefore = await ethers.provider.getBalance(mon.poller);
  await (await signer.sendTransaction({ to: mon.poller, value: TOPUP })).wait();
  const balAfter = await ethers.provider.getBalance(mon.poller);
  console.log(`  balance ${ethers.formatEther(balBefore)} → ${ethers.formatEther(balAfter)} STT`);

  await (await poller.setPollInterval(POLL_INTERVAL)).wait();
  console.log(`  poll interval → ${POLL_INTERVAL}s`);

  if (!(await poller.armed())) {
    await (await poller.arm()).wait();
    console.log(`  re-armed · cron ${(await poller.cronSubscriptionId()).toString()}`);
  } else {
    console.log("  already armed");
  }

  const buffer = balAfter - FLOOR;
  console.log(
    `\nDone. Monitor runs until the spendable balance above 32 STT is exhausted (~${ethers.formatEther(
      buffer,
    )} STT buffer). Re-run before a demo to top up.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

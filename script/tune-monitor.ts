/**
 * Tune the autonomous monitor on the LIVE deployment (operator ops, no redeploy):
 *   D) Re-point USDC·live's investigation to REAL Circle/USDC sources (so a genuine depeg reads real
 *      evidence instead of the mock issuer pages).
 *   E) Keep the monitor alive: refuel the poller above the 32-STT subscription floor, stretch the poll
 *      interval, and re-arm the cron (it self-disarmed once its spendable buffer ran out).
 *
 *   pnpm hardhat run script/tune-monitor.ts --network somniaTestnet
 *
 * Optional env: MONITOR_HOMEPAGE_URL, MONITOR_SOCIAL_URL, POLLER_TOPUP_STT (default 10),
 *               POLL_INTERVAL (default 300).
 */

import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

// Real USDC issuer sources (HTML; status.circle.com is where Circle posts peg/reserve incidents).
const HOMEPAGE = process.env.MONITOR_HOMEPAGE_URL?.trim() || "https://status.circle.com";
const SOCIAL = process.env.MONITOR_SOCIAL_URL?.trim() || "https://www.circle.com/en/usdc";
const TOPUP = ethers.parseEther(process.env.POLLER_TOPUP_STT?.trim() || "10");
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL?.trim() || "300");

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  const mon = dep.monitor;
  if (!mon) throw new Error("No `monitor` in the deployment artifact — run deploy-poller.ts first.");

  const [signer] = await ethers.getSigners();
  const registry = await ethers.getContractAt("SentinelRegistry", dep.contracts.registry);
  const poller = await ethers.getContractAt("PriceFeedPoller", mon.poller);

  console.log("─── D) Re-point USDC·live investigation to real Circle sources ───");
  const cfg = await registry.getConfig(mon.asset);
  await (
    await registry.updateConfig(
      mon.asset,
      cfg.pegTarget,
      cfg.depegThresholdBps,
      cfg.minDurationSeconds,
      cfg.annualRateBps,
      { noPayoutBps: cfg.tiers.noPayoutBps, partialBps: cfg.tiers.partialBps, highBps: cfg.tiers.highBps },
      HOMEPAGE,
      SOCIAL,
      SOCIAL,
    )
  ).wait();
  console.log(`  homepage=${HOMEPAGE}  social=${SOCIAL}\n`);

  console.log("─── E) Refuel + re-arm the poller ───");
  const balBefore = await ethers.provider.getBalance(mon.poller);
  await (await signer.sendTransaction({ to: mon.poller, value: TOPUP })).wait();
  const balAfter = await ethers.provider.getBalance(mon.poller);
  console.log(`  balance ${ethers.formatEther(balBefore)} → ${ethers.formatEther(balAfter)} STT`);

  await (await poller.setPollInterval(POLL_INTERVAL)).wait();
  console.log(`  poll interval → ${POLL_INTERVAL}s`);

  const armed = await poller.armed();
  if (!armed) {
    await (await poller.arm()).wait();
    console.log(`  re-armed · cron ${(await poller.cronSubscriptionId()).toString()}`);
  } else {
    console.log("  already armed");
  }
  console.log(
    `\nDone. Monitor runs until the spendable balance above 32 STT is exhausted (~${ethers.formatEther(
      balAfter - ethers.parseEther("32"),
    )} STT buffer). Re-run before a demo to top up.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

/**
 * Calibrate the LIVE assets so they only fire on a GENUINE depeg, not normal market wobble.
 *
 * Real stablecoins drift (FRAX ~$0.99, USDT/DAI a few bps off) — the 50-bps demo threshold makes the
 * autonomous poller open an event on every tick, draining the Oracle's agent budget. Fix: widen the
 * live assets' depeg threshold to 2% (200 bps) and require it SUSTAINED (10 min), so only a real,
 * significant, persistent depeg triggers. Also refuel the Oracle's agent budget.
 *
 *   pnpm hardhat run script/calibrate-live.ts --network somniaTestnet
 *
 * Optional env: LIVE_THRESHOLD_BPS (default 200), LIVE_MIN_DURATION (default 600),
 *               ORACLE_TOPUP_STT (default 15).
 */

import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

const THRESHOLD = Number(process.env.LIVE_THRESHOLD_BPS?.trim() || "200"); // 2%
const MIN_DURATION = Number(process.env.LIVE_MIN_DURATION?.trim() || "600"); // sustained 10 min
const ORACLE_TOPUP = ethers.parseEther(process.env.ORACLE_TOPUP_STT?.trim() || "15");

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  const c = dep.contracts;
  const [signer] = await ethers.getSigners();
  const registry = await ethers.getContractAt("SentinelRegistry", c.registry);

  console.log(`─── Widen live thresholds → ${THRESHOLD} bps, sustained ${MIN_DURATION}s ───`);
  for (const a of dep.monitor.assets) {
    const cfg = await registry.getConfig(a.asset);
    await (
      await registry.updateConfig(
        a.asset,
        cfg.pegTarget,
        THRESHOLD,
        MIN_DURATION,
        cfg.annualRateBps,
        { noPayoutBps: cfg.tiers.noPayoutBps, partialBps: cfg.tiers.partialBps, highBps: cfg.tiers.highBps },
        cfg.homepageUrl,
        cfg.socialUrl,
        cfg.repoUrl,
      )
    ).wait();
    console.log(`  ${a.display}: threshold ${cfg.depegThresholdBps} → ${THRESHOLD} bps`);
  }

  console.log(`\n─── Refuel Oracle agent budget ───`);
  const before = await ethers.provider.getBalance(c.oracle);
  await (await signer.sendTransaction({ to: c.oracle, value: ORACLE_TOPUP })).wait();
  const after = await ethers.provider.getBalance(c.oracle);
  console.log(`  oracle ${ethers.formatEther(before)} → ${ethers.formatEther(after)} STT`);
  console.log("\nDone. Live assets now fire only on a real, sustained 2% depeg.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
